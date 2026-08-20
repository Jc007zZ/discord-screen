export const BOTTLENECKS = {
  HEALTHY: 'HEALTHY',
  CAPTURE_LIMITED: 'CAPTURE LIMITED',
  ENCODER_LIMITED: 'ENCODER LIMITED',
  NETWORK_LIMITED: 'NETWORK LIMITED',
  VIEWER_LIMITED: 'VIEWER LIMITED',
};

/** Classifica objetivamente onde o pipeline está perdendo desempenho. */
export function identifyBottleneck(sample = {}, targetFps = 60) {
  const target = targetFps || 60;
  if ((sample.encoderQueueSize ?? 0) >= 3) return BOTTLENECKS.ENCODER_LIMITED;
  if (sample.captureFps >= target * 0.9 && sample.encodedFps > 0 && sample.encodedFps < target * 0.7) {
    return BOTTLENECKS.ENCODER_LIMITED;
  }
  if (sample.captureFps > 0 && sample.captureFps < target * 0.7) return BOTTLENECKS.CAPTURE_LIMITED;
  if ((sample.bufferedAmount ?? 0) > 2 * 1024 * 1024) return BOTTLENECKS.NETWORK_LIMITED;
  if (sample.feedback?.worstRenderedFps > 0 && sample.feedback.worstRenderedFps < target * 0.7) {
    return BOTTLENECKS.VIEWER_LIMITED;
  }
  return BOTTLENECKS.HEALTHY;
}
