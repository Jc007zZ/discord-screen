import assert from 'node:assert/strict';
import { BOTTLENECKS, identifyBottleneck } from './bottleneck.mjs';

assert.equal(identifyBottleneck({ captureFps: 60, encodedFps: 60 }), BOTTLENECKS.HEALTHY);
assert.equal(identifyBottleneck({ captureFps: 30, encodedFps: 30 }, 60), BOTTLENECKS.CAPTURE_LIMITED);
assert.equal(identifyBottleneck({ captureFps: 60, encodedFps: 30 }, 60), BOTTLENECKS.ENCODER_LIMITED);
assert.equal(identifyBottleneck({ encoderQueueSize: 4 }), BOTTLENECKS.ENCODER_LIMITED);
assert.equal(identifyBottleneck({ captureFps: 60, encodedFps: 60, bufferedAmount: 3 * 1024 * 1024 }), BOTTLENECKS.NETWORK_LIMITED);
assert.equal(identifyBottleneck({ captureFps: 60, encodedFps: 60, feedback: { worstRenderedFps: 20 } }), BOTTLENECKS.VIEWER_LIMITED);
console.log('PASS  classificação dos gargalos do pipeline');
