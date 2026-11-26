/**
 * O WebSocket, ponta a ponta, contra o servidor de verdade.
 *
 * Aqui não há socket de mentira: o que se testa é o aperto de mão — quem entra,
 * com qual token, em qual sala — e o caminho completo de um quadro, do
 * transmissor até o espectador. A espera é sempre por uma mensagem que chega,
 * nunca por um tempo fixo, senão a máquina lenta do CI vê um teste instável.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});
vi.spyOn(console, 'error').mockImplementation(() => {});

const { server, wss } = await import('./index.js');
const { signToken } = await import('./tokens.js');
const R = await import('./rooms.js');
if (!server.listening) await new Promise((pronto) => server.once('listening', pronto));
const porta = server.address().port;

let sequencia = 0;
const novaSala = () =>
  R.createRoom({
    instance: `ws-${++sequencia}`,
    name: 'Sala',
    ownerId: 'dono',
    ownerName: 'Dono',
  }).room;

const tokenDe = (roomId, role, uid = `u-${role}`) =>
  signToken({ room: roomId, uid, name: `Pessoa ${uid}`, av: null, role });

const abertos = [];

/** Abre um socket e devolve quando ele estiver de pé, guardando o que chegar. */
function conectar(token, caminho = '/ws', extra = {}) {
  const query = new URLSearchParams({ t: token ?? '', ...extra });
  const ws = new WebSocket(`ws://127.0.0.1:${porta}${caminho}?${query}`);
  ws.recebidas = [];
  ws.binarias = [];
  ws.on('message', (data, isBinary) => {
    if (isBinary) ws.binarias.push(Buffer.from(data));
    else ws.recebidas.push(JSON.parse(data.toString()));
  });
  abertos.push(ws);

  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

/** Espera até uma mensagem satisfazer o predicado, ou desiste. */
function ate(ws, predicado, oQue = 'a mensagem esperada') {
  const jaVeio = ws.recebidas.find(predicado);
  if (jaVeio) return Promise.resolve(jaVeio);

  return new Promise((resolve, reject) => {
    const prazo = setTimeout(() => {
      ws.off('message', ouvir);
      reject(new Error(`tempo esgotado esperando ${oQue}`));
    }, 3000);

    function ouvir(data, isBinary) {
      if (isBinary) return;
      const msg = JSON.parse(data.toString());
      if (!predicado(msg)) return;
      clearTimeout(prazo);
      ws.off('message', ouvir);
      resolve(msg);
    }
    ws.on('message', ouvir);
  });
}

const doTipo = (tipo) => (msg) => msg.type === tipo;

/** Espera um quadro binário chegar, ignorando o texto que vier no meio. */
function ateBinario(ws) {
  if (ws.binarias.length) return Promise.resolve(ws.binarias[0]);

  return new Promise((resolve, reject) => {
    const prazo = setTimeout(() => {
      ws.off('message', ouvir);
      reject(new Error('nenhum quadro chegou'));
    }, 3000);

    function ouvir(data, isBinary) {
      if (!isBinary) return;
      clearTimeout(prazo);
      ws.off('message', ouvir);
      resolve(Buffer.from(data));
    }
    ws.on('message', ouvir);
  });
}

const fechou = (ws) => new Promise((pronto) => ws.once('close', pronto));

/** Um transmissor no ar e um espectador assistindo o slot dele. */
async function noAr() {
  const room = novaSala();
  const transmissor = await conectar(tokenDe(room.id, 'broadcaster'));
  const { slot } = await ate(transmissor, doTipo('slot'), 'o slot');
  transmissor.send(JSON.stringify({ type: 'start' }));

  const espectador = await conectar(tokenDe(room.id, 'viewer'));
  await ate(espectador, doTipo('stream-start'), 'o anúncio da transmissão');
  espectador.send(JSON.stringify({ type: 'watch', slot }));
  await ate(transmissor, doTipo('need-keyframe'), 'o pedido de keyframe');

  return { room, transmissor, espectador, slot };
}

function quadro(slot, tipo) {
  const buffer = Buffer.alloc(64);
  buffer[0] = slot;
  buffer[1] = tipo;
  return buffer;
}

afterAll(async () => {
  for (const ws of abertos) ws.terminate();
  wss.close();
  await new Promise((pronto) => server.close(pronto));
});

describe('aperto de mão', () => {
  it('recusa um caminho que não é o do relay', async () => {
    await expect(conectar(tokenDe(novaSala().id, 'viewer'), '/outra-coisa')).rejects.toThrow();
  });

  it('recusa sem token', async () => {
    await expect(conectar(null)).rejects.toThrow(/401/);
  });

  it('recusa um token de identidade, que não dá acesso a sala nenhuma', async () => {
    const identidade = signToken({ scope: 'identity', uid: 'u1', instance: 'i' });

    await expect(conectar(identidade)).rejects.toThrow(/401/);
  });

  it('aceita o caminho com o prefixo do proxy do Discord', async () => {
    const room = novaSala();

    const ws = await conectar(tokenDe(room.id, 'viewer'), '/.proxy/ws');

    expect(await ate(ws, doTipo('state'), 'o estado da sala')).toHaveProperty('participants');
  });

  it('avisa e encerra quando a sala fechou entre o token e a conexão', async () => {
    const ws = await conectar(tokenDe('sala-que-nao-existe', 'viewer'));

    expect(await ate(ws, doTipo('room-gone'), 'o aviso de sala fechada')).toBeTruthy();
    await fechou(ws);
  });
});

describe('transmissor', () => {
  it('recebe um slot ao entrar', async () => {
    const ws = await conectar(tokenDe(novaSala().id, 'broadcaster'));

    expect(await ate(ws, doTipo('slot'), 'o slot')).toMatchObject({ slot: 0 });
  });

  it('é recusado quando já está transmitindo, e o socket cai', async () => {
    const room = novaSala();
    const primeiro = await conectar(tokenDe(room.id, 'broadcaster', 'mesma-pessoa'));
    await ate(primeiro, doTipo('slot'), 'o slot');

    const segundo = await conectar(tokenDe(room.id, 'broadcaster', 'mesma-pessoa'));

    expect(await ate(segundo, doTipo('error'), 'a recusa')).toMatchObject({
      message: expect.stringMatching(/já está transmitindo/),
    });
    await fechou(segundo);
  });

  it('anuncia a transmissão a quem já está na sala', async () => {
    const room = novaSala();
    const espectador = await conectar(tokenDe(room.id, 'viewer'));
    await ate(espectador, doTipo('state'), 'o estado da sala');

    const transmissor = await conectar(tokenDe(room.id, 'broadcaster'));
    await ate(transmissor, doTipo('slot'), 'o slot');
    transmissor.send(JSON.stringify({ type: 'start' }));

    expect(await ate(espectador, doTipo('stream-start'), 'o anúncio')).toHaveProperty('slot', 0);
  });

  it('repassa a config do vídeo e a do som a quem assiste', async () => {
    const { transmissor, espectador, slot } = await noAr();

    transmissor.send(JSON.stringify({ type: 'config', config: { codec: 'avc1' } }));
    transmissor.send(JSON.stringify({ type: 'audio-config', config: { codec: 'opus' } }));

    expect(await ate(espectador, doTipo('config'), 'a config')).toMatchObject({
      slot,
      config: { codec: 'avc1' },
    });
    expect(await ate(espectador, doTipo('audio-config'), 'a config de som')).toMatchObject({
      config: { codec: 'opus' },
    });
  });

  it('leva o quadro até quem pediu para assistir', async () => {
    const { transmissor, espectador, slot } = await noAr();

    transmissor.send(quadro(slot, 1));

    const recebido = await ateBinario(espectador);
    expect(recebido[0]).toBe(slot);
    expect(recebido).toHaveLength(64);
  });

  it('avisa a parada', async () => {
    const { transmissor, espectador } = await noAr();

    transmissor.send(JSON.stringify({ type: 'stop' }));

    expect(await ate(espectador, doTipo('stream-stop'), 'o aviso de parada')).toBeTruthy();
  });

  it('ignora mensagem que não é JSON, em vez de derrubar a conexão', async () => {
    const { transmissor, espectador } = await noAr();

    transmissor.send('isto não é json');
    transmissor.send(JSON.stringify({ type: 'config', config: { codec: 'vp8' } }));

    expect(await ate(espectador, doTipo('config'), 'a config seguinte')).toBeTruthy();
  });

  it('um quadro de protocolo inválido derruba só o socket dele, não o servidor', async () => {
    const room = novaSala();
    const transmissor = await conectar(tokenDe(room.id, 'broadcaster'));
    await ate(transmissor, doTipo('slot'), 'o slot');
    transmissor.on('error', () => {});
    const caiu = fechou(transmissor);

    // Quadro de texto com UTF-8 inválido: o ws emite 'error' no socket, e sem
    // ninguém ouvindo esse evento o processo inteiro caía.
    transmissor._socket.write(Buffer.from([0x81, 0x82, 0, 0, 0, 0, 0xff, 0xfe]));
    await caiu;

    await vi.waitFor(() => expect(room.broadcasters.size).toBe(0));
    const espectador = await conectar(tokenDe(room.id, 'viewer'));
    expect(await ate(espectador, doTipo('state'), 'o estado da sala')).toBeTruthy();
  });

  it('a saída libera o slot e atualiza a sala', async () => {
    const { room, transmissor, espectador } = await noAr();

    transmissor.close();
    await ate(espectador, (m) => m.type === 'state' && m.streams.length === 0, 'a sala sem stream');

    expect(room.broadcasters.size).toBe(0);
  });
});

describe('duas fontes', () => {
  it('a mesma pessoa transmite tela e câmera em slots diferentes', async () => {
    const room = novaSala();
    const tela = await conectar(tokenDe(room.id, 'broadcaster', 'mesma'), '/ws', { fonte: 'tela' });
    const camera = await conectar(tokenDe(room.id, 'broadcaster', 'mesma'), '/ws', {
      fonte: 'camera',
    });

    const slotTela = await ate(tela, doTipo('slot'), 'o slot da tela');
    const slotCamera = await ate(camera, doTipo('slot'), 'o slot da câmera');

    expect(slotCamera.slot).not.toBe(slotTela.slot);
  });

  it('uma fonte desconhecida na URL vira tela, que é o padrão', async () => {
    const room = novaSala();
    const ws = await conectar(tokenDe(room.id, 'broadcaster'), '/ws', { fonte: 'inventada' });
    await ate(ws, doTipo('slot'), 'o slot');

    const segunda = await conectar(tokenDe(room.id, 'broadcaster'), '/ws', { fonte: 'tela' });

    expect(await ate(segunda, doTipo('error'), 'a recusa')).toMatchObject({
      message: expect.stringMatching(/já está transmitindo a tela/),
    });
  });
});

describe('aba de captura', () => {
  const comoControle = (room, uid = 'mesma') =>
    conectar(tokenDe(room.id, 'broadcaster', uid), '/ws', { modo: 'controle' });

  it('conecta sem ocupar slot e sem receber um', async () => {
    const room = novaSala();
    const espectador = await conectar(tokenDe(room.id, 'viewer'));
    await ate(espectador, doTipo('state'), 'o estado');

    await comoControle(room);
    await ate(espectador, doTipo('state'), 'o estado depois da aba');

    expect(room.broadcasters.size).toBe(0);
    expect(room.controles.size).toBe(1);
  });

  it('recebe o pedido de ligar a câmera vindo da atividade', async () => {
    const room = novaSala();
    const aba = await comoControle(room);
    const naActivity = await conectar(tokenDe(room.id, 'viewer', 'mesma'));
    await ate(naActivity, doTipo('state'), 'o estado');

    naActivity.send(JSON.stringify({ type: 'start-broadcast', fonte: 'camera' }));

    expect(await ate(aba, doTipo('start-request'), 'o pedido')).toMatchObject({
      fonte: 'camera',
    });
  });

  it('ignora um pedido com fonte que não existe', async () => {
    const room = novaSala();
    const aba = await comoControle(room);
    const naActivity = await conectar(tokenDe(room.id, 'viewer', 'mesma'));
    await ate(naActivity, doTipo('state'), 'o estado');

    naActivity.send(JSON.stringify({ type: 'start-broadcast', fonte: 'inventada' }));
    naActivity.send(JSON.stringify({ type: 'config-broadcast', opcoes: { fps: 60 } }));

    // O que chega é o segundo recado: o primeiro foi descartado no caminho.
    expect(await ate(aba, doTipo('config-request'), 'a config')).toMatchObject({
      opcoes: { fps: 60 },
    });
  });

  it('a saída da aba não derruba a sala', async () => {
    const room = novaSala();
    const aba = await comoControle(room);
    const espectador = await conectar(tokenDe(room.id, 'viewer'));
    await ate(espectador, doTipo('state'), 'o estado');

    // A lista é zerada antes: `ate` devolve o que já chegou, e o estado que
    // interessa é o que vem depois de a aba cair.
    espectador.recebidas.length = 0;
    aba.close();
    await ate(espectador, doTipo('state'), 'o estado depois da saída');

    expect(room.controles.size).toBe(0);
  });
});

describe('espectador', () => {
  it('recebe o estado da sala ao entrar', async () => {
    const ws = await conectar(tokenDe(novaSala().id, 'viewer'));

    expect(await ate(ws, doTipo('state'), 'o estado')).toMatchObject({ viewers: 1 });
  });

  it('troca o próprio nome, e a sala fica sabendo', async () => {
    const room = novaSala();
    const um = await conectar(tokenDe(room.id, 'viewer', 'u1'));
    const outro = await conectar(tokenDe(room.id, 'viewer', 'u2'));
    await ate(outro, doTipo('state'), 'o estado');

    um.send(JSON.stringify({ type: 'rename', name: 'Batizada' }));

    const estado = await ate(
      outro,
      (m) => m.type === 'state' && m.participants.some((p) => p.name === 'Batizada'),
      'o nome novo',
    );
    expect(estado.participants.some((p) => p.name === 'Batizada')).toBe(true);
  });

  it('para de receber quando desiste de assistir', async () => {
    const { transmissor, espectador, slot } = await noAr();
    transmissor.send(quadro(slot, 1));
    await ateBinario(espectador);

    espectador.send(JSON.stringify({ type: 'unwatch', slot }));
    await ate(
      espectador,
      (m) => m.type === 'state' && m.streams.every((s) => s.watchers.length === 0),
      'a sala sem ninguém assistindo',
    );
    const antes = espectador.binarias.length;
    transmissor.send(quadro(slot, 1));
    await ate(transmissor, doTipo('state'), 'a próxima atualização de estado').catch(() => {});

    expect(espectador.binarias).toHaveLength(antes);
  });

  it('pede a parada da própria transmissão, e só dela', async () => {
    const room = novaSala();
    const transmissor = await conectar(tokenDe(room.id, 'broadcaster', 'mesma'));
    await ate(transmissor, doTipo('slot'), 'o slot');
    const naActivity = await conectar(tokenDe(room.id, 'viewer', 'mesma'));
    await ate(naActivity, doTipo('state'), 'o estado');

    naActivity.send(JSON.stringify({ type: 'stop-broadcast' }));

    expect(await ate(transmissor, doTipo('stop-request'), 'o pedido de parada')).toBeTruthy();
  });

  it('para só a fonte pedida quando há duas no ar', async () => {
    const room = novaSala();
    const tela = await conectar(tokenDe(room.id, 'broadcaster', 'mesma'), '/ws', { fonte: 'tela' });
    const camera = await conectar(tokenDe(room.id, 'broadcaster', 'mesma'), '/ws', {
      fonte: 'camera',
    });
    await ate(tela, doTipo('slot'), 'o slot da tela');
    await ate(camera, doTipo('slot'), 'o slot da câmera');
    const naActivity = await conectar(tokenDe(room.id, 'viewer', 'mesma'));
    await ate(naActivity, doTipo('state'), 'o estado');

    naActivity.send(JSON.stringify({ type: 'stop-broadcast', fonte: 'camera' }));
    await ate(camera, doTipo('stop-request'), 'o pedido de parada da câmera');

    expect(tela.recebidas.some(doTipo('stop-request'))).toBe(false);
  });

  it('sem fonte, para tudo o que a pessoa estiver transmitindo', async () => {
    const room = novaSala();
    const tela = await conectar(tokenDe(room.id, 'broadcaster', 'mesma'), '/ws', { fonte: 'tela' });
    const camera = await conectar(tokenDe(room.id, 'broadcaster', 'mesma'), '/ws', {
      fonte: 'camera',
    });
    await ate(tela, doTipo('slot'), 'o slot da tela');
    await ate(camera, doTipo('slot'), 'o slot da câmera');
    const naActivity = await conectar(tokenDe(room.id, 'viewer', 'mesma'));
    await ate(naActivity, doTipo('state'), 'o estado');

    naActivity.send(JSON.stringify({ type: 'stop-broadcast' }));

    expect(await ate(tela, doTipo('stop-request'), 'a parada da tela')).toBeTruthy();
    expect(await ate(camera, doTipo('stop-request'), 'a parada da câmera')).toBeTruthy();
  });

  it('o pedido de parada de outra pessoa não derruba a transmissão', async () => {
    const room = novaSala();
    const transmissor = await conectar(tokenDe(room.id, 'broadcaster', 'quem-transmite'));
    await ate(transmissor, doTipo('slot'), 'o slot');
    const estranho = await conectar(tokenDe(room.id, 'viewer', 'outra-pessoa'));
    await ate(estranho, doTipo('state'), 'o estado');

    estranho.send(JSON.stringify({ type: 'stop-broadcast' }));
    estranho.send(JSON.stringify({ type: 'rename', name: 'Marco' }));
    await ate(
      transmissor,
      (m) => m.type === 'state' && m.participants.some((p) => p.name === 'Marco'),
      'o rename, que vem depois',
    );

    expect(transmissor.recebidas.some(doTipo('stop-request'))).toBe(false);
  });

  it('ignora o que não entende: binário, JSON quebrado e slot que não é inteiro', async () => {
    const { espectador, transmissor } = await noAr();

    espectador.send(Buffer.from([1, 2, 3]));
    espectador.send('nem isto é json');
    espectador.send(JSON.stringify({ type: 'watch', slot: 'zero' }));
    espectador.send(JSON.stringify({ type: 'unwatch', slot: null }));
    espectador.send(JSON.stringify({ type: 'inventado' }));
    espectador.send(JSON.stringify({ type: 'rename', name: 'Segue de pé' }));

    const estado = await ate(
      transmissor,
      (m) => m.type === 'state' && m.participants.some((p) => p.name === 'Segue de pé'),
      'a sala ainda respondendo',
    );
    expect(estado).toBeTruthy();
  });

  it('a saída atualiza a contagem da sala', async () => {
    const room = novaSala();
    const um = await conectar(tokenDe(room.id, 'viewer', 'u1'));
    const outro = await conectar(tokenDe(room.id, 'viewer', 'u2'));
    await ate(outro, doTipo('state'), 'o estado');

    um.close();

    expect(
      await ate(outro, (m) => m.type === 'state' && m.viewers === 1, 'a sala com um só'),
    ).toBeTruthy();
  });
});

/**
 * Sinalização WebRTC pelo mesmo socket do relay.
 *
 * O canal já existe e já está autenticado; abrir um segundo só para offer e
 * candidato seria uma porta a mais para guardar, e uma a mais para errar.
 */
describe('sinalização WebRTC', () => {
  it('convida o transmissor a abrir a conexão direta com quem começa a assistir', async () => {
    const room = novaSala();
    const transmissor = await conectar(tokenDe(room.id, 'broadcaster'));
    const { slot } = await ate(transmissor, doTipo('slot'), 'o slot');
    transmissor.send(JSON.stringify({ type: 'start' }));

    const espectador = await conectar(tokenDe(room.id, 'viewer'));
    await ate(espectador, doTipo('stream-start'), 'o anúncio da transmissão');
    espectador.send(JSON.stringify({ type: 'watch', slot }));

    const convite = await ate(transmissor, doTipo('rtc-want'), 'o convite');
    expect(typeof convite.peer).toBe('string');
  });

  it('leva a oferta do transmissor até o espectador nomeado', async () => {
    const { transmissor, espectador, slot } = await noAr();
    const { peer } = await ate(transmissor, doTipo('rtc-want'), 'o convite');

    transmissor.send(
      JSON.stringify({
        type: 'rtc',
        peer,
        payload: { kind: 'offer', sdp: { type: 'offer', sdp: 'v=0' } },
      }),
    );

    expect(await ate(espectador, doTipo('rtc'), 'a oferta')).toMatchObject({
      slot,
      payload: { kind: 'offer', sdp: { type: 'offer', sdp: 'v=0' } },
    });
  });

  it('leva a resposta do espectador de volta ao transmissor', async () => {
    const { transmissor, espectador, slot } = await noAr();
    const { peer } = await ate(transmissor, doTipo('rtc-want'), 'o convite');

    espectador.send(
      JSON.stringify({ type: 'rtc', slot, payload: { kind: 'answer', sdp: { type: 'answer' } } }),
    );

    expect(await ate(transmissor, doTipo('rtc'), 'a resposta')).toMatchObject({
      peer,
      payload: { kind: 'answer', sdp: { type: 'answer' } },
    });
  });

  it('desliga o relay na origem quando quem assiste assume a conexão direta', async () => {
    const { transmissor, espectador, slot } = await noAr();
    // O predicado olha o valor, e não só o tipo: o primeiro espectador já tinha
    // ligado o relay ao pedir para assistir, e esse aviso continua no histórico.
    const desligou = (m) => m.type === 'chunks' && m.on === false;

    espectador.send(JSON.stringify({ type: 'rtc-ativo', slot, on: true }));

    expect(await ate(transmissor, desligou, 'o desligamento')).toBeTruthy();
  });

  it('religa o relay, com keyframe, quando a conexão direta cai', async () => {
    const { transmissor, espectador, slot } = await noAr();
    espectador.send(JSON.stringify({ type: 'rtc-ativo', slot, on: true }));
    await ate(transmissor, (m) => m.type === 'chunks' && m.on === false, 'o desligamento');
    transmissor.recebidas.length = 0;

    espectador.send(JSON.stringify({ type: 'rtc-ativo', slot, on: false }));

    expect(await ate(transmissor, doTipo('chunks'), 'a religada')).toMatchObject({ on: true });
    await ate(transmissor, doTipo('need-keyframe'), 'o ponto de partida');
  });
});
