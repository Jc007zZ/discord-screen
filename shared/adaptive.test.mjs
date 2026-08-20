import assert from 'node:assert/strict';
import { createAdaptiveController } from './adaptive.mjs';

let now = 10_000;
const realNow = Date.now;
Date.now = () => now;

const applied = [];
const controller = createAdaptiveController({
  initialBitrate: 8_000_000,
  targetFps: 60,
  onApply: (value) => applied.push(value),
});

controller.pressure('encoder');
assert.equal(controller.bitrate, 6_000_000);
now += 1_000;
controller.pressure('encoder');
assert.equal(controller.bitrate, 6_000_000, 'cooldown impede quedas consecutivas');

now += 8_000;
for (let i = 0; i < 5; i++) {
  now += 3_100;
  controller.tick({ encoderQueueSize: 0, bufferedAmount: 0, encodedFps: 60, targetFps: 60 });
}
assert(controller.bitrate > 6_000_000, 'recupera depois de estabilidade');
assert(controller.bitrate <= 8_000_000, 'nunca ultrapassa o teto escolhido');

controller.reset(5_000_000, 30);
assert.equal(controller.bitrate, 5_000_000);
assert.equal(applied.at(-1), 5_000_000);

Date.now = realNow;
console.log('PASS  degradação, cooldown, recuperação e novo teto');
