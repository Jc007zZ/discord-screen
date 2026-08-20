const MIN_BITRATE = 500_000;
const DOWN_FACTOR = 0.75;
const UP_FACTOR = 1.1;
const DOWN_COOLDOWN_MS = 2_000;
const UP_COOLDOWN_MS = 3_000;
const STABLE_TICKS_REQUIRED = 5;
const MAX_QUEUE_TO_UP = 2;
const MAX_BUFFERED_TO_UP = 1.5 * 1024 * 1024;
const MIN_ENCODE_FPS_RATIO = 0.75;

/**
 * Reduz rapidamente o bitrate sob pressão e o recupera devagar depois de uma
 * sequência estável. O valor escolhido pela pessoa permanece como teto.
 */
export function createAdaptiveController({ initialBitrate, targetFps = 60, onApply, onChange }) {
  let currentBitrate = initialBitrate;
  let lastDownAt = 0;
  let lastUpAt = 0;
  let stableTicks = 0;

  const clamp = (value) => Math.max(MIN_BITRATE, Math.min(initialBitrate, Math.round(value)));

  function apply(value) {
    const next = clamp(value);
    if (next === currentBitrate) return false;
    currentBitrate = next;
    onApply?.(next);
    return true;
  }

  function onPressure(source) {
    const now = Date.now();
    if (now - lastDownAt < DOWN_COOLDOWN_MS || currentBitrate <= MIN_BITRATE) return false;
    lastDownAt = now;
    lastUpAt = now;
    stableTicks = 0;
    const changed = apply(currentBitrate * DOWN_FACTOR);
    if (changed) {
      onChange?.(
        `Rede/encoder sob pressão (${source}) — bitrate ${(currentBitrate / 1e6).toFixed(1)} Mbps. ` +
          'Recupera sozinho quando estabilizar.'
      );
    }
    return changed;
  }

  function onTick(sample = {}) {
    const now = Date.now();
    if (now - lastDownAt < DOWN_COOLDOWN_MS * 3 || now - lastUpAt < UP_COOLDOWN_MS) return;
    if ((sample.encoderQueueSize ?? 0) >= MAX_QUEUE_TO_UP) return;
    if ((sample.bufferedAmount ?? 0) > MAX_BUFFERED_TO_UP) return;
    const expected = sample.targetFps || targetFps;
    if (sample.encodedFps > 0 && sample.encodedFps < expected * MIN_ENCODE_FPS_RATIO) return;
    if (sample.feedback?.congestedViewers > 0) return;

    stableTicks++;
    if (stableTicks < STABLE_TICKS_REQUIRED) return;
    if (currentBitrate >= initialBitrate) {
      stableTicks = 0;
      return;
    }
    stableTicks = 0;
    lastUpAt = now;
    const changed = apply(currentBitrate * UP_FACTOR);
    if (changed) {
      onChange?.(`Qualidade recuperada — bitrate ${(currentBitrate / 1e6).toFixed(1)} Mbps.`);
    }
    return changed;
  }

  return {
    onPressure,
    onTick,
    reset(nextInitial, nextTargetFps = targetFps) {
      initialBitrate = nextInitial;
      targetFps = nextTargetFps;
      currentBitrate = nextInitial;
      lastDownAt = 0;
      lastUpAt = 0;
      stableTicks = 0;
      onApply?.(currentBitrate);
    },
    get currentBitrate() {
      return currentBitrate;
    },
    get initialBitrate() {
      return initialBitrate;
    },
    _clamp: clamp,
    _apply: apply,
  };
}
