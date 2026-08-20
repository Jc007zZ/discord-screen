import assert from 'node:assert/strict';
import { codecCandidates } from './broadcaster.js';

const codecs = (preferencia) => codecCandidates(preferencia).map((item) => item.codec);

assert.deepEqual(codecs('h264'), ['avc1.42E01E', 'avc1.42E01E']);
assert.deepEqual(codecs('vp8'), ['vp8']);
assert.deepEqual(codecs('vp9'), ['vp09.00.10.08']);
assert.deepEqual(codecs('auto'), ['avc1.42E01E', 'avc1.42E01E', 'vp8', 'vp09.00.10.08']);
assert.deepEqual(codecs('desconhecido'), codecs('auto'));

console.log('PASS  seleção e fallback de codecs');
