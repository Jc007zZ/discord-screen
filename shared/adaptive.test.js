import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAdaptiveController } from './adaptive.mjs';

function fresh(initialBitrate = 12_000_000) {
  const applied = [];
  const changes = [];
  const controller = createAdaptiveController({
    initialBitrate,
    targetFps: 60,
    onApply: (value) => applied.push(value),
    onChange: (message) => changes.push(message),
  });
  return { controller, applied, changes };
}

describe('controle adaptativo de bitrate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-19T12:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('reduz 25%, respeita o cooldown e nunca passa do piso', () => {
    const { controller } = fresh();
    controller.onPressure('encoder');
    expect(controller.currentBitrate).toBe(9_000_000);
    vi.advanceTimersByTime(1_000);
    controller.onPressure('encoder');
    expect(controller.currentBitrate).toBe(9_000_000);

    const { controller: floor } = fresh(600_000);
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(3_000);
      floor.onPressure('encoder');
    }
    expect(floor.currentBitrate).toBe(500_000);
  });

  it('recupera gradualmente sem ultrapassar o teto escolhido', () => {
    const { controller, changes } = fresh();
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(3_000);
      controller.onPressure('encoder');
    }
    for (let i = 0; i < 120; i++) {
      vi.advanceTimersByTime(1_000);
      controller.onTick({ encoderQueueSize: 0, bufferedAmount: 0, encodedFps: 60, targetFps: 60 });
    }
    expect(controller.currentBitrate).toBe(12_000_000);
    expect(changes.some((message) => message.includes('recuperada'))).toBe(true);
  });

  it.each([
    ['fila do encoder', { encoderQueueSize: 4, bufferedAmount: 0, encodedFps: 60 }],
    ['buffer de rede', { encoderQueueSize: 0, bufferedAmount: 2 * 1024 * 1024, encodedFps: 60 }],
    ['FPS codificado', { encoderQueueSize: 0, bufferedAmount: 0, encodedFps: 30 }],
    ['feedback do espectador', { encoderQueueSize: 0, bufferedAmount: 0, encodedFps: 60, feedback: { congestedViewers: 1 } }],
  ])('não recupera sob pressão de %s', (_name, sample) => {
    const { controller } = fresh();
    vi.advanceTimersByTime(3_000);
    controller.onPressure('encoder');
    vi.advanceTimersByTime(10_000);
    const before = controller.currentBitrate;
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(1_000);
      controller.onTick({ targetFps: 60, ...sample });
    }
    expect(controller.currentBitrate).toBe(before);
  });

  it('redefine o teto e aplica imediatamente a nova escolha', () => {
    const { controller, applied } = fresh(10_000_000);
    vi.advanceTimersByTime(3_000);
    controller.onPressure('encoder');
    controller.reset(15_000_000, 30);
    expect(controller.currentBitrate).toBe(15_000_000);
    expect(controller.initialBitrate).toBe(15_000_000);
    expect(applied.at(-1)).toBe(15_000_000);
  });
});
