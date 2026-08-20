import { describe, expect, it } from 'vitest';
import { contentHintFor, MODES, PROFILES, resolveProfile } from './broadcast-mode.mjs';

describe('modos de conteúdo', () => {
  it('traduz o modo para o contentHint correto', () => {
    expect(contentHintFor('motion')).toBe('motion');
    expect(contentHintFor('text')).toBe('text');
    expect(contentHintFor('auto')).toBeNull();
    expect(contentHintFor('desconhecido')).toBeNull();
    expect(MODES).toEqual(['auto', 'motion', 'text']);
  });

  it('mantém quatro perfis explícitos por modo', () => {
    expect(Object.values(PROFILES).every((mode) => mode.options.length === 4)).toBe(true);
    expect(PROFILES.motion.options[0].bitrate).toBeGreaterThanOrEqual(PROFILES.text.options[0].bitrate);
  });

  it('resolve perfil, contentHint e fallbacks', () => {
    expect(resolveProfile('motion', 0)).toMatchObject({ mode: 'motion', contentHint: 'motion', fps: 60, width: 1920 });
    expect(resolveProfile('auto', 99).fps).toBe(60);
    expect(resolveProfile('inválido', 0).mode).toBe('auto');
    expect(resolveProfile('text', 3)).toMatchObject({ bitrate: 3_000_000, fps: 30 });
  });
});
