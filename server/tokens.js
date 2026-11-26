import crypto from 'node:crypto';

/**
 * Segredo lido na hora do uso, nunca na importação.
 *
 * Este módulo é importado por index.js, e imports são avaliados antes do corpo
 * de quem importa — ou seja, antes de `dotenv.config()`. Lendo o segredo aqui
 * em cima, o valor do .env nunca chegava: tudo era assinado com o padrão de
 * desenvolvimento, que está publicado neste repositório. Qualquer pessoa
 * poderia forjar um token de sala.
 */
let cached = null;

function secret() {
  if (cached) return cached;

  cached = process.env.SESSION_SECRET;
  if (!cached) {
    // Em produção não existe padrão aceitável: sem segredo, não há assinatura.
    if (process.env.NODE_ENV === 'production') {
      throw new Error('SESSION_SECRET obrigatorio em producao.');
    }
    console.warn('aviso: SESSION_SECRET ausente — assinando com segredo de desenvolvimento.');
    cached = 'dev-inseguro-troque-isto';
  }
  return cached;
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function hmac(data) {
  return crypto.createHmac('sha256', secret()).update(data).digest('base64url');
}

/**
 * Token assinado e curto, sem dependência externa.
 * Formato: <payload base64url>.<hmac base64url>
 *
 * `ttlSeconds` é opcional. Tokens de sala não expiram de propósito: a sala
 * fecha quando esvazia e o id dela é aleatório, então a própria vida da sala
 * já limita o token. Um prazo separado só criaria a chance de expirar no meio
 * de uma sessão. Já a identidade, que não está presa a nenhuma sala, expira.
 */
export function signToken(payload, ttlSeconds = null) {
  const claims = { ...payload };
  if (ttlSeconds) claims.exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  return (() => {
    const body = b64url(JSON.stringify(claims));
    return `${body}.${hmac(body)}`;
  })();
}

export function verifyToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;

  const recebida = Buffer.from(sig);
  const esperada = Buffer.from(hmac(body));
  // Comparação em tempo constante — evita vazar o segredo por timing. O tamanho
  // conferido é o dos bytes: um caractere não-ASCII deixa o texto do mesmo
  // tamanho e o buffer maior, e aí o timingSafeEqual lançaria.
  if (recebida.length !== esperada.length || !crypto.timingSafeEqual(recebida, esperada)) {
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString());
  } catch {
    return null;
  }

  // Sem `exp` o token não expira — ver a nota em signToken.
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}
