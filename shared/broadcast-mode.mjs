export const MODES = ['auto', 'motion', 'text'];

export function contentHintFor(mode) {
  if (mode === 'motion') return 'motion';
  if (mode === 'text') return 'text';
  return null;
}

export const PROFILES = {
  auto: {
    label: 'Automático',
    contentHint: null,
    options: [
      { label: '1080p · 60 fps', width: 1920, height: 1080, fps: 60, bitrate: 10_000_000 },
      { label: '1080p · 30 fps', width: 1920, height: 1080, fps: 30, bitrate: 6_500_000 },
      { label: '720p · 60 fps', width: 1280, height: 720, fps: 60, bitrate: 6_000_000 },
      { label: '720p · 30 fps', width: 1280, height: 720, fps: 30, bitrate: 4_000_000 },
    ],
  },
  motion: {
    label: 'Jogos / Movimento',
    contentHint: 'motion',
    options: [
      { label: '1080p · 60 fps', width: 1920, height: 1080, fps: 60, bitrate: 12_000_000 },
      { label: '1080p · 30 fps', width: 1920, height: 1080, fps: 30, bitrate: 8_000_000 },
      { label: '720p · 60 fps', width: 1280, height: 720, fps: 60, bitrate: 7_000_000 },
      { label: '720p · 30 fps', width: 1280, height: 720, fps: 30, bitrate: 5_000_000 },
    ],
  },
  text: {
    label: 'Texto / Trabalho',
    contentHint: 'text',
    options: [
      { label: '1080p · 60 fps', width: 1920, height: 1080, fps: 60, bitrate: 8_000_000 },
      { label: '1080p · 30 fps', width: 1920, height: 1080, fps: 30, bitrate: 5_000_000 },
      { label: '720p · 60 fps', width: 1280, height: 720, fps: 60, bitrate: 5_000_000 },
      { label: '720p · 30 fps', width: 1280, height: 720, fps: 30, bitrate: 3_000_000 },
    ],
  },
};

export function resolveProfile(mode, index) {
  const resolved = PROFILES[mode] ? mode : 'auto';
  const selected = PROFILES[resolved];
  const option = selected.options[index] ?? selected.options[0];
  return { mode: resolved, contentHint: selected.contentHint, ...option };
}
