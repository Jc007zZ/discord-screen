import assert from 'node:assert/strict';
import { createAdaptiveController } from './adaptive.mjs';

let now = 10_000;
const realNow = Date.now;
Date.now = () => now;

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

const { controller } = fresh();
controller.onPressure('encoder');
assert.equal(controller.currentBitrate, 9_000_000, 'pressão reduz 25%');
now += 1_000;
controller.onPressure('encoder');
assert.equal(controller.currentBitrate, 9_000_000, 'cooldown impede quedas consecutivas');

const { controller: floor } = fresh(600_000);
for (let i = 0; i < 10; i++) {
  now += 3_000;
  floor.onPressure('encoder');
}
assert.equal(floor.currentBitrate, 500_000, 'respeita o piso absoluto');

const { controller: recovery, changes } = fresh();
for (let i = 0; i < 3; i++) {
  now += 3_000;
  recovery.onPressure('encoder');
}
for (let i = 0; i < 120; i++) {
  now += 1_000;
  recovery.onTick({ encoderQueueSize: 0, bufferedAmount: 0, encodedFps: 60, targetFps: 60 });
}
assert.equal(recovery.currentBitrate, 12_000_000, 'recupera devagar até o teto escolhido');
assert(changes.some((message) => message.includes('recuperada')), 'avisa quando recupera qualidade');

for (const [name, sample] of [
  ['fila do encoder', { encoderQueueSize: 4, bufferedAmount: 0, encodedFps: 60 }],
  ['buffer de rede', { encoderQueueSize: 0, bufferedAmount: 2 * 1024 * 1024, encodedFps: 60 }],
  ['FPS codificado', { encoderQueueSize: 0, bufferedAmount: 0, encodedFps: 30 }],
  ['feedback do espectador', { encoderQueueSize: 0, bufferedAmount: 0, encodedFps: 60, feedback: { congestedViewers: 1 } }],
]) {
  const { controller: blocked } = fresh();
  now += 3_000;
  blocked.onPressure('encoder');
  now += 10_000;
  const before = blocked.currentBitrate;
  for (let i = 0; i < 20; i++) {
    now += 1_000;
    blocked.onTick({ targetFps: 60, ...sample });
  }
  assert.equal(blocked.currentBitrate, before, `${name} impede recuperação`);
}

const { controller: reset, applied } = fresh(10_000_000);
now += 3_000;
reset.onPressure('encoder');
reset.reset(15_000_000, 30);
assert.equal(reset.currentBitrate, 15_000_000, 'reset atualiza o teto');
assert.equal(reset.initialBitrate, 15_000_000, 'expõe o novo teto');
assert.equal(applied.at(-1), 15_000_000, 'aplica o bitrate redefinido');

Date.now = realNow;
console.log('PASS  degradação, cooldown, recuperação e novo teto');
