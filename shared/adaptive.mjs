const MIN_BITRATE = 500_000;
const DOWN_FACTOR = 0.75;
const UP_FACTOR = 1.1;
const DOWN_COOLDOWN_MS = 2_000;
const UP_COOLDOWN_MS = 3_000;
const STABLE_TICKS_REQUIRED = 5;

/**
 * Reduz rapidamente o bitrate sob pressão e o recupera devagar depois de uma
 * sequência estável. O valor escolhido pela pessoa permanece como teto.
 */
export function createAdaptiveController({ initialBitrate, targetFps = 60, onApply, onChange }) {
  let ceiling = initialBitrate;
  let current = initialBitrate;
  let lastDownAt = 0;
  let lastUpAt = 0;
  let stableTicks = 0;

  const clamp = (value) => Math.max(MIN_BITRATE, Math.min(ceiling, Math.round(value)));

  function apply(value) {
    const next = clamp(value);
    if (next === current) return false;
    current = next;
    onApply?.(next);
    return true;
  }

  function pressure(source) {
    const now = Date.now();
    if (now - lastDownAt < DOWN_COOLDOWN_MS || current <= MIN_BITRATE) return false;
    lastDownAt = now;
    lastUpAt = now;
    stableTicks = 0;
    const changed = apply(current * DOWN_FACTOR);
    if (changed) {
      onChange?.(
        `Transmissão sob pressão (${source}); bitrate reduzido para ${(current / 1e6).toFixed(1)} Mb/s. ` +
          'A qualidade será recuperada automaticamente quando estabilizar.'
      );
    }
    return changed;
  }

  function tick(sample = {}) {
    const now = Date.now();
    if (now - lastDownAt < DOWN_COOLDOWN_MS * 3 || now - lastUpAt < UP_COOLDOWN_MS) return;
    if ((sample.encoderQueueSize ?? 0) >= 2) return void (stableTicks = 0);
    if ((sample.bufferedAmount ?? 0) > 1.5 * 1024 * 1024) return void (stableTicks = 0);
    const expected = sample.targetFps || targetFps;
    if (sample.encodedFps > 0 && sample.encodedFps < expected * 0.75) {
      stableTicks = 0;
      return;
    }

    stableTicks++;
    if (stableTicks < STABLE_TICKS_REQUIRED) return;
    stableTicks = 0;
    lastUpAt = now;
    if (apply(current * UP_FACTOR)) {
      onChange?.(`Qualidade recuperada para ${(current / 1e6).toFixed(1)} Mb/s.`);
    }
  }

  return {
    pressure,
    tick,
    reset(nextCeiling, nextTargetFps = targetFps) {
      ceiling = nextCeiling;
      targetFps = nextTargetFps;
      current = nextCeiling;
      lastDownAt = 0;
      lastUpAt = 0;
      stableTicks = 0;
      onApply?.(current);
    },
    get bitrate() {
      return current;
    },
  };
}
