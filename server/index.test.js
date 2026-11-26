/**
 * As rotas HTTP, com o servidor de verdade escutando numa porta livre.
 *
 * Nada aqui fala com o Discord: o `fetch` global é trocado por um que responde
 * do roteiro do teste e devolve o de verdade para o próprio servidor. Uma
 * chamada externa não prevista vira erro em vez de ir para a rede — é assim
 * que o teste continua igual sem internet.
 *
 * Este arquivo é o servidor *sem* credencial nenhuma: sem aplicação do
 * Discord, sem bot e sem painel. É a configuração de quem só rodou
 * `npm start`, e a que mais precisa não quebrar.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});
vi.spyOn(console, 'error').mockImplementation(() => {});

const fetchReal = globalThis.fetch;
const { server, wss } = await import('./index.js');
if (!server.listening) await new Promise((pronto) => server.once('listening', pronto));
const base = `http://127.0.0.1:${server.address().port}`;

/** Rotas externas que este teste finge, por prefixo de URL. */
let externas = new Map();

vi.stubGlobal('fetch', async (url, init) => {
  const alvo = String(url);
  for (const [prefixo, responder] of externas) {
    if (alvo.startsWith(prefixo)) return responder(alvo, init);
  }
  if (alvo.startsWith(base)) return fetchReal(url, init);
  throw new Error(`chamada externa não prevista: ${alvo}`);
});

const json = (corpo, status = 200) =>
  new Response(JSON.stringify(corpo), { status, headers: { 'Content-Type': 'application/json' } });

const post = (caminho, corpo) =>
  fetch(`${base}${caminho}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(corpo ?? {}),
  });

const get = (caminho, init) => fetch(`${base}${caminho}`, { redirect: 'manual', ...init });

/** Uma identidade assinada pelo próprio servidor, como o cliente obtém. */
async function identidade(corpo = {}) {
  const resposta = await post('/api/session-dev', { instance_id: 'teste', ...corpo });
  return resposta.json();
}

beforeEach(() => {
  externas = new Map();
});

afterEach(() => {
  vi.clearAllMocks();
});

afterAll(async () => {
  wss.close();
  await new Promise((pronto) => server.close(pronto));
});

describe('/api/health', () => {
  it('responde sem contar nada sobre as salas', async () => {
    const resposta = await get('/api/health');

    expect(resposta.status).toBe(200);
    expect(await resposta.json()).toEqual({ ok: true });
  });
});

describe('/api/config', () => {
  it('diz que não há aplicação configurada, sem inventar string vazia', async () => {
    const resposta = await get('/api/config');
    const corpo = await resposta.json();

    expect(corpo.clientId).toBeNull();
    expect(corpo).toHaveProperty('asset');
    expect(resposta.headers.get('cache-control')).toBe('no-store');
  });
});

describe('cabeçalhos', () => {
  it('autoriza o Discord a desenhar isto num iframe', async () => {
    const csp = (await get('/api/health')).headers.get('content-security-policy');

    expect(csp).toContain('frame-ancestors');
    expect(csp).toContain('https://discord.com');
  });

  it('desarma o X-Frame-Options que a borda da hospedagem injeta', async () => {
    // ALLOWALL não existe no padrão de propósito: o navegador descarta o header
    // inteiro ao ver um valor que não reconhece, e com ele vai embora o
    // SAMEORIGIN que a hospedagem carimbaria. Quem restringe o iframe continua
    // sendo o frame-ancestors do CSP.
    const resposta = await get('/api/health');

    expect(resposta.headers.get('x-frame-options')).toBe('ALLOWALL');
    expect(resposta.headers.get('cloudflare-frame-options')).toBe('allow');
  });

  it('não restringe script, estilo ou conexão pelo CSP', async () => {
    // O CSP daqui existe só para autorizar o iframe. Ganhar um default-src
    // silenciosamente quebraria hospedagens que servem estático de outro
    // domínio, e o sintoma seria uma página branca sem erro de servidor.
    const csp = (await get('/api/health')).headers.get('content-security-policy');

    expect(csp).not.toContain('default-src');
    expect(csp).not.toContain('script-src');
    expect(csp).not.toContain('connect-src');
  });

  it('serve a página de captura sem cache', async () => {
    const resposta = await get('/share.html');

    expect(resposta.status).toBe(200);
    expect(resposta.headers.get('cache-control')).toBe('no-store');
  });

  it('serve os termos sem a extensão no endereço', async () => {
    expect((await get('/termos')).status).toBe(200);
  });

  it('serve o pipeline compartilhado com a página de captura', async () => {
    const resposta = await get('/shared/broadcaster.js');

    expect(resposta.status).toBe(200);
    expect(await resposta.text()).toContain('createBroadcaster');
  });
});

describe('prefixo /.proxy da Activity', () => {
  // Dentro da Activity o caminho pode chegar prefixado. Sem limpar, toda rota
  // vira 404 e o cliente fica esperando uma resposta que não vem.
  it('resolve rota de API pedida com o prefixo', async () => {
    const resposta = await get('/.proxy/api/health');

    expect(resposta.status).toBe(200);
    expect((await resposta.json()).ok).toBe(true);
  });

  it('resolve arquivo estático pedido com o prefixo', async () => {
    expect((await get('/.proxy/share.html')).status).toBe(200);
  });

  it('a raiz prefixada não vira caminho vazio', async () => {
    // '/.proxy' sozinho viraria '' sem o fallback, e '' não é um caminho válido.
    expect((await get('/.proxy')).status).toBe(200);
  });

  it('não mexe em caminho que só parece prefixado', async () => {
    // O prefixo é um caminho, não um pedaço de palavra. Cortado por engano,
    // /.proxyapi/health viraria a rota de API e devolveria JSON; intacto, cai
    // no catch-all e recebe a página, que é o certo para um caminho que não
    // existe. O status não distingue os dois — o tipo do corpo, sim.
    const resposta = await get('/.proxyapi/health');

    expect(resposta.headers.get('content-type')).not.toContain('application/json');
  });
});

describe('/api/session-dev', () => {
  it('emite identidade com a instância pedida', async () => {
    const corpo = await identidade({ name: 'Alice' });

    expect(corpo.instance).toBe('teste');
    expect(corpo.user).toMatchObject({ id: 'dev-Alice', name: 'Alice' });
    expect(corpo.identity).toBeTypeOf('string');
  });

  it('aceita corpo vazio', async () => {
    expect((await post('/api/session-dev')).status).toBe(200);
  });
});

describe('/api/session-guest', () => {
  it('inventa um nome quando nenhum foi dado', async () => {
    const corpo = await (await post('/api/session-guest', { name: '   ' })).json();

    expect(corpo.user.name).toMatch(/^Convidado \d{4}$/);
    expect(corpo.instance).toBe('web');
  });

  it('normaliza e corta o nome escolhido', async () => {
    const corpo = await (await post('/api/session-guest', { name: ` ${'n'.repeat(80)} ` })).json();

    expect(corpo.user.name).toHaveLength(32);
  });

  it('dá a cada convidado um id próprio', async () => {
    const um = await (await post('/api/session-guest', { name: 'A' })).json();
    const outro = await (await post('/api/session-guest', { name: 'A' })).json();

    expect(um.user.id).not.toBe(outro.user.id);
  });
});

describe('/api/token', () => {
  it('exige o código', async () => {
    expect((await post('/api/token', {})).status).toBe(400);
  });

  it('avisa que o servidor está sem credencial em vez de deixar o Discord recusar', async () => {
    const resposta = await post('/api/token', { code: 'abc' });

    expect(resposta.status).toBe(500);
    expect((await resposta.json()).error).toMatch(/credenciais do Discord/);
  });
});

describe('/api/session', () => {
  it('exige access_token e instance_id', async () => {
    expect((await post('/api/session', { access_token: 'x' })).status).toBe(400);
    expect((await post('/api/session', { instance_id: 'i' })).status).toBe(400);
  });

  it('recusa quando o Discord não reconhece o token', async () => {
    externas.set('https://discord.com/api/users/@me', () => json({ message: '401: Unauthorized' }));

    expect((await post('/api/session', { access_token: 'x', instance_id: 'i' })).status).toBe(401);
  });

  it('emite identidade a partir do perfil do Discord', async () => {
    externas.set('https://discord.com/api/users/@me', () =>
      json({ id: '123456789012345678', global_name: 'Alice', avatar: 'abc' }),
    );

    const corpo = await (
      await post('/api/session', { access_token: 'x', instance_id: 'i' })
    ).json();

    expect(corpo.user).toMatchObject({ id: '123456789012345678', name: 'Alice', avatar: 'abc' });
    // Sem token de bot não há como confirmar presença em call nem nome de servidor.
    expect(corpo.call).toBeNull();
    expect(corpo.guildName).toBeNull();
  });

  it('devolve a sala da call junto, poupando uma ida ao servidor', async () => {
    // Cada requisicao custa caro numa hospedagem distante, e o /api/rooms/call
    // nao faria nada que nao possa ser feito aqui. Se esta chave sumir, entrar
    // na sala volta a custar duas idas em vez de uma.
    externas.set('https://discord.com/api/users/@me', () =>
      json({ id: '123456789012345678', global_name: 'Alice' }),
    );

    const corpo = await (
      await post('/api/session', { access_token: 'x', instance_id: 'sessao-sala' })
    ).json();

    expect(corpo.sala?.roomId).toBe('atividade-sessao-sala');
    expect(corpo.sala?.viewerToken).toBeTypeOf('string');
    expect(corpo.sala?.shareUrl).toContain('/share.html?t=');
  });

  it('a sala da sessão é a mesma que o /api/rooms/call daria', async () => {
    externas.set('https://discord.com/api/users/@me', () =>
      json({ id: '123456789012345678', global_name: 'Alice' }),
    );

    const sessao = await (
      await post('/api/session', { access_token: 'x', instance_id: 'sessao-igual' })
    ).json();
    const pelaRota = await (await post('/api/rooms/call', { identity: sessao.identity })).json();

    expect(pelaRota.roomId).toBe(sessao.sala.roomId);
  });

  it('cai para o username quando não há global_name', async () => {
    externas.set('https://discord.com/api/users/@me', () =>
      json({ id: '123456789012345678', username: 'alice_2' }),
    );

    const corpo = await (
      await post('/api/session', { access_token: 'x', instance_id: 'i' })
    ).json();

    expect(corpo.user.name).toBe('alice_2');
  });

  it('descarta guild e channel fora do formato de id do Discord', async () => {
    externas.set('https://discord.com/api/users/@me', () => json({ id: '123456789012345678' }));

    const corpo = await (
      await post('/api/session', {
        access_token: 'x',
        instance_id: 'i',
        guild_id: 'nao-e-id',
        channel_id: '1',
      })
    ).json();

    expect(corpo.guild).toBeNull();
    expect(corpo.channel).toBeNull();
  });

  it('devolve erro interno quando a chamada ao Discord explode', async () => {
    externas.set('https://discord.com/api/users/@me', () => {
      throw new Error('rede fora');
    });

    expect((await post('/api/session', { access_token: 'x', instance_id: 'i' })).status).toBe(500);
  });
});

describe('/api/avatar', () => {
  const ID = '123456789012345678';
  const HASH = 'a'.repeat(32);

  it.each([
    ['id fora do formato', `nao-e-id/${'a'.repeat(32)}`],
    ['hash fora do formato', `${'1'.repeat(18)}/nao-e-hash`],
    ['hash com letra que não é hexadecimal', `${'1'.repeat(18)}/${'z'.repeat(32)}`],
  ])('recusa %s, para não virar proxy aberto', async (_nome, caminho) => {
    expect((await get(`/api/avatar/${caminho}`)).status).toBe(400);
  });

  it('espelha a imagem do CDN e a guarda para a próxima', async () => {
    let idas = 0;
    externas.set('https://cdn.discordapp.com/', () => {
      idas++;
      return new Response(Buffer.from([1, 2, 3]), { status: 200 });
    });

    const primeira = await get(`/api/avatar/${ID}/${HASH}`);
    expect(primeira.status).toBe(200);
    expect(primeira.headers.get('content-type')).toBe('image/png');
    expect(primeira.headers.get('cache-control')).toContain('immutable');

    await get(`/api/avatar/${ID}/${HASH}`);
    expect(idas).toBe(1);
  });

  it('devolve 404 quando o CDN não tem essa foto', async () => {
    externas.set('https://cdn.discordapp.com/', () => new Response('', { status: 404 }));

    expect((await get(`/api/avatar/${ID}/${'b'.repeat(32)}`)).status).toBe(404);
  });

  it('devolve 502 quando o CDN está fora do ar', async () => {
    externas.set('https://cdn.discordapp.com/', () => {
      throw new Error('sem resposta');
    });

    expect((await get(`/api/avatar/${ID}/${'c'.repeat(32)}`)).status).toBe(502);
  });
});

describe('/api/rooms/list', () => {
  it('não exige login: dá para ver o lobby antes de entrar', async () => {
    const resposta = await post('/api/rooms/list', {});

    expect(resposta.status).toBe(200);
    expect(Array.isArray((await resposta.json()).rooms)).toBe(true);
  });

  it('mostra as salas da instância de quem pergunta', async () => {
    const me = await identidade({ instance_id: 'lista-1', name: 'Alice' });
    await post('/api/rooms/create', { identity: me.identity, name: 'Minha sala' });

    const minhas = await (await post('/api/rooms/list', { identity: me.identity })).json();
    const anonimo = await (await post('/api/rooms/list', {})).json();

    expect(minhas.rooms.map((r) => r.name)).toContain('Minha sala');
    expect(anonimo.rooms.map((r) => r.name)).not.toContain('Minha sala');
  });
});

describe('/api/rooms/create', () => {
  it('recusa quem não traz identidade assinada', async () => {
    const resposta = await post('/api/rooms/create', { identity: 'forjada', name: 'X' });

    expect(resposta.status).toBe(401);
    expect((await resposta.json()).error).toMatch(/identidade/);
  });

  it('devolve os dois tokens da sala e o endereço de captura', async () => {
    const me = await identidade({ instance_id: 'criar-1' });
    const corpo = await (
      await post('/api/rooms/create', { identity: me.identity, name: 'Sala' })
    ).json();

    expect(corpo.roomId).toBeTypeOf('string');
    expect(corpo.viewerToken).toBeTypeOf('string');
    expect(corpo.shareUrl).toContain('/share.html?t=');
  });

  it('repassa o limite de salas como 400', async () => {
    const me = await identidade({ instance_id: 'cheia' });
    for (let i = 0; i < 20; i++) {
      await post('/api/rooms/create', { identity: me.identity, name: `Sala ${i}` });
    }

    const resposta = await post('/api/rooms/create', { identity: me.identity, name: 'A mais' });
    expect(resposta.status).toBe(400);
    expect((await resposta.json()).error).toMatch(/Limite de salas/);
  });
});

describe('/api/rooms/join', () => {
  async function salaCom(password = null, instancia = 'entrar-1') {
    const dono = await identidade({ instance_id: instancia, name: 'Dono' });
    const sala = await (
      await post('/api/rooms/create', { identity: dono.identity, name: 'Sala', password })
    ).json();
    return { dono, sala };
  }

  it('recusa uma sala que não existe', async () => {
    const me = await identidade({ instance_id: 'entrar-2' });

    expect((await post('/api/rooms/join', { identity: me.identity, roomId: 'nada' })).status).toBe(
      404,
    );
  });

  it('some para quem está em outro canal de voz', async () => {
    const { sala } = await salaCom(null, 'entrar-3');
    const forasteiro = await identidade({ instance_id: 'outro-canal' });

    const resposta = await post('/api/rooms/join', {
      identity: forasteiro.identity,
      roomId: sala.roomId,
    });

    // 404 e não 403: revelar que a sala existe já seria vazar o lobby alheio.
    expect(resposta.status).toBe(404);
  });

  it('entra numa sala aberta', async () => {
    const { sala } = await salaCom(null, 'entrar-4');
    const visita = await identidade({ instance_id: 'entrar-4', name: 'Visita' });

    const corpo = await (
      await post('/api/rooms/join', { identity: visita.identity, roomId: sala.roomId })
    ).json();

    expect(corpo.roomId).toBe(sala.roomId);
  });

  it('recusa a senha errada com 403', async () => {
    const { sala } = await salaCom('certa', 'entrar-5');
    const visita = await identidade({ instance_id: 'entrar-5', name: 'Visita' });

    const resposta = await post('/api/rooms/join', {
      identity: visita.identity,
      roomId: sala.roomId,
      password: 'errada',
    });

    expect(resposta.status).toBe(403);
    expect(await resposta.json()).toMatchObject({ reason: 'senha' });
  });

  it('recusa com 403 uma senha que não é texto, sem erro interno', async () => {
    const { sala } = await salaCom('certa', 'entrar-5b');
    const visita = await identidade({ instance_id: 'entrar-5b', name: 'Visita' });

    for (const password of [123, { a: 1 }, ['certa'], true]) {
      const resposta = await post('/api/rooms/join', {
        identity: visita.identity,
        roomId: sala.roomId,
        password,
      });

      expect(resposta.status).toBe(403);
      expect(await resposta.json()).toMatchObject({ reason: 'senha' });
    }
  });

  it('responde 429 depois de tentativas demais', async () => {
    const { sala } = await salaCom('certa', 'entrar-6');
    const visita = await identidade({ instance_id: 'entrar-6', name: 'Visita' });
    const tentar = (password) =>
      post('/api/rooms/join', { identity: visita.identity, roomId: sala.roomId, password });

    for (let i = 0; i < 4; i++) await tentar('errada');
    const resposta = await tentar('errada');

    expect(resposta.status).toBe(429);
    expect((await resposta.json()).error).toMatch(/Muitas tentativas/);
  });

  it('aceita a senha certa', async () => {
    const { sala } = await salaCom('certa', 'entrar-7');
    const visita = await identidade({ instance_id: 'entrar-7', name: 'Visita' });

    const resposta = await post('/api/rooms/join', {
      identity: visita.identity,
      roomId: sala.roomId,
      password: 'certa',
    });

    expect(resposta.status).toBe(200);
  });
});

describe('/api/rooms/call', () => {
  it('sem call confirmada, a sala é a da instância da atividade', async () => {
    const me = await identidade({ instance_id: 'call-a' });
    const corpo = await (await post('/api/rooms/call', { identity: me.identity })).json();

    expect(corpo.roomId).toBe('atividade-call-a');
  });

  it('a mesma pessoa volta sempre para a mesma sala', async () => {
    const me = await identidade({ instance_id: 'call-b' });
    const primeira = await (await post('/api/rooms/call', { identity: me.identity })).json();
    const segunda = await (await post('/api/rooms/call', { identity: me.identity })).json();

    expect(segunda.roomId).toBe(primeira.roomId);
  });

  it('com call confirmada, a sala é a do canal de voz', async () => {
    const me = await identidade({ instance_id: 'call-c', call: 'canal-9' });
    const corpo = await (await post('/api/rooms/call', { identity: me.identity })).json();

    expect(corpo.roomId).toBe('call-canal-9');
  });

  it('quem não está na call não entra na sala dela', async () => {
    const naCall = await identidade({ instance_id: 'call-d', call: 'canal-8' });
    const sala = await (await post('/api/rooms/call', { identity: naCall.identity })).json();
    const fora = await identidade({ instance_id: 'call-d', name: 'Fora' });

    const resposta = await post('/api/rooms/join', {
      identity: fora.identity,
      roomId: sala.roomId,
    });

    expect(resposta.status).toBe(403);
    expect((await resposta.json()).error).toMatch(/Entre na call/);
  });

  it('quem está na call entra por /join também', async () => {
    const me = await identidade({ instance_id: 'call-e', call: 'canal-7' });
    const sala = await (await post('/api/rooms/call', { identity: me.identity })).json();

    const resposta = await post('/api/rooms/join', {
      identity: me.identity,
      roomId: sala.roomId,
    });

    expect(resposta.status).toBe(200);
  });

  it('a sala da call não aparece no lobby', async () => {
    const me = await identidade({ instance_id: 'call-f' });
    await post('/api/rooms/call', { identity: me.identity });

    const { rooms } = await (await post('/api/rooms/list', { identity: me.identity })).json();
    expect(rooms).toHaveLength(0);
  });
});

describe('/api/rooms/open', () => {
  /** O que a atividade entrega ao botão "Assistir no site". */
  const salaDaCall = async (call) => {
    const me = await identidade({ instance_id: `abrir-${call}`, call, name: 'Quem assiste' });
    return (await post('/api/rooms/call', { identity: me.identity })).json();
  };

  it('o ingresso abre a sala da call para quem está fora da call', async () => {
    const sala = await salaDaCall('canal-10');

    // Sem identidade nenhuma: é exatamente a situação do site, que não tem
    // como provar presença no canal de voz.
    const resposta = await post('/api/rooms/open', { token: sala.viewerToken });

    expect(resposta.status).toBe(200);
    expect((await resposta.json()).roomId).toBe(sala.roomId);
  });

  it('devolve o nome da sala, que o site não teria de onde tirar', async () => {
    const sala = await salaDaCall('canal-11');
    const corpo = await (await post('/api/rooms/open', { token: sala.viewerToken })).json();

    expect(corpo.name).toBe('Sala da call');
  });

  it('devolve um shareUrl utilizável, e não só o token de assistir', async () => {
    const sala = await salaDaCall('canal-12');
    const corpo = await (await post('/api/rooms/open', { token: sala.viewerToken })).json();

    expect(corpo.shareUrl).toContain('/share.html?t=');
    expect(corpo.viewerToken).toBeTruthy();
  });

  it('o token de transmissor não serve de ingresso', async () => {
    const sala = await salaDaCall('canal-13');
    // Base fixa porque sem PUBLIC_ORIGIN o shareUrl sai relativo, que é o
    // caso desta suíte — ela roda sem herdar o .env da máquina.
    const doTransmissor = new URL(sala.shareUrl, 'http://x').searchParams.get('t');

    const resposta = await post('/api/rooms/open', { token: doTransmissor });

    expect(resposta.status).toBe(401);
  });

  it('token forjado é recusado', async () => {
    expect((await post('/api/rooms/open', { token: 'nada.nada' })).status).toBe(401);
    expect((await post('/api/rooms/open', {})).status).toBe(401);
  });

  it('sala que já fechou devolve 404, não uma sala vazia', async () => {
    // Assinado de verdade, mas para uma sala que nunca existiu: é o mesmo
    // estado de um link guardado depois de a sala fechar por inatividade.
    const { signToken } = await import('./tokens.js');
    const orfao = signToken({ room: 'sala-que-fechou', uid: 'u1', name: 'Alguém', role: 'viewer' });

    const resposta = await post('/api/rooms/open', { token: orfao });
    expect(resposta.status).toBe(404);
  });
});

describe('/api/rooms/password', () => {
  it('só o dono troca a senha', async () => {
    const dono = await identidade({ instance_id: 'senha-1', name: 'Dono' });
    const sala = await (
      await post('/api/rooms/create', { identity: dono.identity, name: 'Sala' })
    ).json();
    const outro = await identidade({ instance_id: 'senha-1', name: 'Outro' });

    const recusa = await post('/api/rooms/password', {
      identity: outro.identity,
      roomId: sala.roomId,
      password: 'x',
    });
    expect(recusa.status).toBe(403);

    const aceita = await post('/api/rooms/password', {
      identity: dono.identity,
      roomId: sala.roomId,
      password: 'x',
    });
    expect(await aceita.json()).toEqual({ ok: true, locked: true });
  });

  it('senha vazia destranca a sala', async () => {
    const dono = await identidade({ instance_id: 'senha-2', name: 'Dono' });
    const sala = await (
      await post('/api/rooms/create', { identity: dono.identity, name: 'Sala', password: 'x' })
    ).json();

    const corpo = await (
      await post('/api/rooms/password', {
        identity: dono.identity,
        roomId: sala.roomId,
        password: '',
      })
    ).json();

    expect(corpo).toEqual({ ok: true, locked: false });
  });

  it('recusa uma sala de outra instância', async () => {
    const dono = await identidade({ instance_id: 'senha-3', name: 'Dono' });
    const sala = await (
      await post('/api/rooms/create', { identity: dono.identity, name: 'Sala' })
    ).json();
    const forasteiro = await identidade({ instance_id: 'senha-4' });

    const resposta = await post('/api/rooms/password', {
      identity: forasteiro.identity,
      roomId: sala.roomId,
      password: 'x',
    });

    expect(resposta.status).toBe(404);
  });
});

describe('login pelo site', () => {
  it('manda para o Discord', async () => {
    const resposta = await get('/auth/login');

    expect(resposta.status).toBe(302);
    expect(resposta.headers.get('location')).toContain('discord.com/oauth2/authorize');
  });

  it('sem painel configurado, o login administrativo volta dizendo isso', async () => {
    const resposta = await get('/admin/auth/login');

    expect(resposta.headers.get('location')).toBe('/admin?error=not_configured');
  });

  it('sem código na volta, avisa em vez de tentar a troca', async () => {
    const resposta = await get('/auth/callback');

    expect(resposta.headers.get('location')).toBe('/?erro=sem_codigo');
  });

  it('quando o Discord recusa a troca, volta com o motivo na URL', async () => {
    externas.set('https://discord.com/api/oauth2/token', () => json({ error: 'invalid_grant' }));

    const resposta = await get('/auth/callback?code=abc');

    expect(resposta.headers.get('location')).toBe('/?erro=troca_falhou');
  });

  it('quando o perfil não vem, volta dizendo isso', async () => {
    externas.set('https://discord.com/api/oauth2/token', () => json({ access_token: 'tok' }));
    externas.set('https://discord.com/api/users/@me', () => json({}));

    const resposta = await get('/auth/callback?code=abc');

    expect(resposta.headers.get('location')).toBe('/?erro=perfil_falhou');
  });

  it('entrega a identidade no fragmento, que não chega ao servidor', async () => {
    externas.set('https://discord.com/api/oauth2/token', () => json({ access_token: 'tok' }));
    externas.set('https://discord.com/api/users/@me', () =>
      json({ id: '123456789012345678', global_name: 'Alice' }),
    );

    const destino = (await get('/auth/callback?code=abc')).headers.get('location');

    expect(destino).toMatch(/^\/#identity=/);
  });

  it('erro no meio da volta não deixa a pessoa numa tela morta', async () => {
    externas.set('https://discord.com/api/oauth2/token', () => {
      throw new Error('rede fora');
    });

    expect((await get('/auth/callback?code=abc')).headers.get('location')).toBe('/?erro=interno');
  });
});

describe('painel desligado', () => {
  it('/api/admin/me responde 503 dizendo que não está configurado', async () => {
    const resposta = await get('/api/admin/me');

    expect(resposta.status).toBe(503);
    expect(await resposta.json()).toMatchObject({ configured: false });
  });

  it('as métricas continuam exigindo sessão', async () => {
    const resposta = await get('/api/admin/metrics');

    expect(resposta.status).toBe(401);
    expect(await resposta.json()).toMatchObject({ configured: false });
  });

  it('sair apaga o cookie de qualquer jeito', async () => {
    const resposta = await post('/api/admin/logout');

    expect(resposta.headers.get('set-cookie')).toContain('Max-Age=0');
  });
});

describe('/api/ice', () => {
  it('devolve ao menos um STUN, para a conexão direta se achar sozinha', async () => {
    const { iceServers } = await (await get('/api/ice')).json();

    expect(Array.isArray(iceServers)).toBe(true);
    expect(iceServers.some((s) => String(s.urls).startsWith('stun:'))).toBe(true);
  });

  it('não guarda em cache: credencial de TURN vence', async () => {
    const resposta = await get('/api/ice');

    expect(resposta.headers.get('cache-control')).toBe('no-store');
  });
});
