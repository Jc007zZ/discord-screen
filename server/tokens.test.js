/**
 * Os tokens são a única prova de que quem fala é quem diz ser: não há sessão
 * no servidor, e um token forjado entra em qualquer sala. Por isso o que se
 * testa aqui não é o caminho feliz, é a recusa.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { signToken, verifyToken } from './tokens.js';

const SEGREDO = process.env.SESSION_SECRET;
const AMBIENTE = { ...process.env };

/**
 * Uma instância nova do módulo, para os cenários que dependem do ambiente: o
 * segredo é lido na primeira assinatura e guardado até o fim do processo. O
 * ambiente precisa continuar de pé enquanto o teste roda, não só até o
 * import, porque quem o lê é a assinatura e não o corpo do módulo.
 */
async function carregar(env = {}) {
  vi.resetModules();
  process.env = { ...AMBIENTE };
  for (const [chave, valor] of Object.entries(env)) {
    if (valor === undefined) delete process.env[chave];
    else process.env[chave] = valor;
  }
  return import('./tokens.js');
}

afterEach(() => {
  process.env = { ...AMBIENTE };
});

describe('signToken e verifyToken', () => {
  it('devolve o payload que assinou', async () => {
    const token = signToken({ scope: 'room', room: 'abc', uid: '42' });

    expect(verifyToken(token)).toMatchObject({ scope: 'room', room: 'abc', uid: '42' });
  });

  it('produz duas partes separadas por ponto', async () => {
    expect(signToken({ a: 1 }).split('.')).toHaveLength(2);
  });

  it('não expira quando nenhum prazo foi pedido', async () => {
    expect(verifyToken(signToken({ a: 1 }))).not.toHaveProperty('exp');
  });

  it('carimba exp quando o prazo foi pedido', async () => {
    const agora = Math.floor(Date.now() / 1000);

    expect(verifyToken(signToken({ a: 1 }, 60)).exp).toBeGreaterThanOrEqual(agora + 59);
  });

  it('recusa um token cujo prazo já passou', async () => {
    vi.useFakeTimers();
    try {
      const token = signToken({ a: 1 }, 60);
      vi.advanceTimersByTime(61_000);
      expect(verifyToken(token)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('verifyToken recusa', () => {
  it.each([
    ['o que não é texto', 123],
    ['nulo', null],
    ['texto sem ponto', 'semponto'],
    ['assinatura vazia', 'corpo.'],
    ['corpo vazio', '.assinatura'],
  ])('%s', async (_nome, entrada) => {
    expect(verifyToken(entrada)).toBeNull();
  });

  it('um corpo adulterado, porque a assinatura deixa de bater', async () => {
    const [, assinatura] = signToken({ uid: 'alice' }).split('.');
    const outroCorpo = Buffer.from(JSON.stringify({ uid: 'bob' })).toString('base64url');

    expect(verifyToken(`${outroCorpo}.${assinatura}`)).toBeNull();
  });

  it('uma assinatura de tamanho diferente, sem chamar a comparação', async () => {
    const [corpo] = signToken({ uid: 'alice' }).split('.');

    // timingSafeEqual lança quando os tamanhos divergem; o tamanho é conferido
    // antes justamente para a recusa sair como null e não como exceção.
    expect(verifyToken(`${corpo}.curta`)).toBeNull();
  });

  it('uma assinatura com caractere não-ASCII do mesmo tamanho, sem lançar', async () => {
    const [corpo, assinatura] = signToken({ uid: 'alice' }).split('.');
    // Mesmo número de caracteres, mas "é" ocupa dois bytes: a conferência de
    // tamanho passava e o timingSafeEqual lançava, derrubando o processo
    // quando vinha pelo upgrade do WebSocket.
    const adulterada = `${corpo}.é${assinatura.slice(1)}`;

    expect(adulterada.split('.')[1]).toHaveLength(assinatura.length);
    expect(verifyToken(adulterada)).toBeNull();
  });

  it('um token assinado com outro segredo', async () => {
    const outro = await carregar({ SESSION_SECRET: 'outro-segredo-completamente-diferente' });
    const alheio = outro.signToken({ uid: 'alice' });

    expect(verifyToken(alheio)).toBeNull();
  });

  it('um corpo bem assinado que não é JSON', async () => {
    const { createHmac } = await import('node:crypto');
    const corpo = Buffer.from('isto nao e json').toString('base64url');
    const assinatura = createHmac('sha256', SEGREDO).update(corpo).digest('base64url');

    expect(verifyToken(`${corpo}.${assinatura}`)).toBeNull();
  });
});

describe('o segredo', () => {
  it('cai no de desenvolvimento, avisando, quando não há SESSION_SECRET', async () => {
    const aviso = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { signToken, verifyToken } = await carregar({ SESSION_SECRET: undefined });

      expect(verifyToken(signToken({ a: 1 }))).toMatchObject({ a: 1 });
      expect(aviso).toHaveBeenCalled();
    } finally {
      aviso.mockRestore();
    }
  });

  it('não tem padrão em produção: assinar sem segredo lança', async () => {
    const { signToken } = await carregar({ SESSION_SECRET: undefined, NODE_ENV: 'production' });

    expect(() => signToken({ a: 1 })).toThrow(/SESSION_SECRET/);
  });
});
