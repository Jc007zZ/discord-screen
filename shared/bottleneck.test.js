import { describe, expect, it } from 'vitest';
import { BOTTLENECKS, identifyBottleneck } from './bottleneck.mjs';

describe('classificação dos gargalos do pipeline', () => {
  it('mantém saudável quando todas as etapas acompanham o alvo', () => {
    expect(identifyBottleneck({ captureFps: 60, encodedFps: 60 })).toBe(BOTTLENECKS.HEALTHY);
  });

  it.each([
    ['captura', { captureFps: 30, encodedFps: 30 }, BOTTLENECKS.CAPTURE_LIMITED],
    ['encoder por FPS', { captureFps: 60, encodedFps: 30 }, BOTTLENECKS.ENCODER_LIMITED],
    ['encoder por fila', { encoderQueueSize: 4 }, BOTTLENECKS.ENCODER_LIMITED],
    ['rede', { captureFps: 60, encodedFps: 60, bufferedAmount: 3 * 1024 * 1024 }, BOTTLENECKS.NETWORK_LIMITED],
    ['viewer', { captureFps: 60, encodedFps: 60, feedback: { worstRenderedFps: 20 } }, BOTTLENECKS.VIEWER_LIMITED],
  ])('identifica limitação de %s', (_name, sample, expected) => {
    expect(identifyBottleneck(sample, 60)).toBe(expected);
  });
});
