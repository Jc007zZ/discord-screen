/**
 * Sala e relay.
 *
 * O registro de salas vive num Map de módulo, compartilhado por todos os
 * testes deste arquivo. Cada cenário usa uma instância própria — o id do canal
 * de voz — e é isso que os mantém isolados sem precisar zerar nada.
 */
import { describe, expect, it, vi } from 'vitest';
import * as R from './rooms.js';

let sequencia = 0;
const instancia = () => `canal-${++sequencia}`;

/** Um socket de mentira com o mínimo que o relay olha. */
function socket({ aberto = true, buffered = 0 } = {}) {
  return {
    OPEN: 1,
    readyState: aberto ? 1 : 3,
    bufferedAmount: buffered,
    enviados: [],
    send(data) {
      this.enviados.push(data);
    },
    mensagens() {
      return this.enviados.filter((d) => typeof d === 'string').map((d) => JSON.parse(d));
    },
    binarios() {
      return this.enviados.filter((d) => typeof d !== 'string');
    },
    tipos() {
      return this.mensagens().map((m) => m.type);
    },
    limpar() {
      this.enviados.length = 0;
      return this;
    },
  };
}

const pessoa = (id, extra = {}) => ({ id, name: `Pessoa ${id}`, ...extra });

/** Uma sala com um espectador dentro, que é o estado de onde tudo parte. */
function salaComEspectador(opcoes = {}) {
  const { room } = R.createRoom({
    instance: instancia(),
    name: 'Sala',
    ownerId: 'dono',
    ownerName: 'Dono',
    ...opcoes,
  });
  const viewer = socket();
  R.attachViewer(room, viewer, pessoa('espectador'));
  return { room, viewer: viewer.limpar() };
}

/** Um transmissor já no ar, com o espectador assistindo o slot dele. */
function comTransmissao({ assistindo = true } = {}) {
  const { room, viewer } = salaComEspectador();
  const ws = socket();
  const entry = R.attachBroadcaster(room, ws, pessoa('transmissor'));
  R.startStream(room, entry);
  if (assistindo) R.watch(room, viewer, entry.slot);
  return { room, viewer: viewer.limpar(), ws: ws.limpar(), entry };
}

/** Um quadro cru: slot no primeiro byte, tipo no segundo. */
function quadro(slot, tipo, tamanho = 64) {
  const buffer = Buffer.alloc(tamanho);
  buffer[0] = slot;
  buffer[1] = tipo;
  return buffer;
}

const KEYFRAME = 1;
const DELTA = 2;
const AUDIO = 3;

describe('createRoom', () => {
  it('normaliza o nome e devolve a sala pelo id', () => {
    const { room } = R.createRoom({
      instance: instancia(),
      name: '  Sala   com    espaços  ',
      ownerId: 'u1',
      ownerName: 'Alice',
    });

    expect(room.name).toBe('Sala com espaços');
    expect(R.getRoom(room.id)).toBe(room);
  });

  it('usa o nome de quem criou quando nenhum foi dado', () => {
    const { room } = R.createRoom({ instance: instancia(), ownerId: 'u1', ownerName: 'Alice' });

    expect(room.name).toBe('Sala de Alice');
  });

  it('corta o nome em 40 caracteres', () => {
    const { room } = R.createRoom({
      instance: instancia(),
      name: 'x'.repeat(80),
      ownerId: 'u1',
      ownerName: 'Alice',
    });

    expect(room.name).toHaveLength(40);
  });

  it('recusa a vigésima primeira sala da mesma instância', () => {
    const canal = instancia();
    for (let i = 0; i < 20; i++) {
      R.createRoom({ instance: canal, name: `Sala ${i}`, ownerId: 'u1', ownerName: 'Alice' });
    }

    expect(R.createRoom({ instance: canal, ownerId: 'u1', ownerName: 'Alice' }).error).toMatch(
      /Limite de salas/,
    );
  });

  it('guarda a senha como hash com sal, nunca em claro', () => {
    const { room } = R.createRoom({
      instance: instancia(),
      ownerId: 'u1',
      ownerName: 'Alice',
      password: 'segreda',
    });

    expect(room.password.hash).toBeInstanceOf(Buffer);
    expect(JSON.stringify(room.password)).not.toContain('segreda');
  });

  it('devolve null para um id que não existe', () => {
    expect(R.getRoom('nao-existe')).toBeNull();
  });
});

describe('ensureCallRoom', () => {
  it('cria a sala da call sem dono nem senha', () => {
    const room = R.ensureCallRoom(instancia(), 'call-1', { guildName: 'Servidor' });

    expect(room).toMatchObject({ isCall: true, ownerId: null, password: null });
    expect(room.guildName).toBe('Servidor');
  });

  it('reaproveita a sala e atualiza a instância a cada relançamento', () => {
    const primeira = R.ensureCallRoom('canal-antigo', 'call-2', { guildId: 'g1' });
    const nova = instancia();
    const segunda = R.ensureCallRoom(nova, 'call-2');

    expect(segunda).toBe(primeira);
    expect(segunda.instance).toBe(nova);
    // Metadado ausente na segunda chamada não apaga o que já se sabia.
    expect(segunda.guildId).toBe('g1');
  });
});

describe('listRooms', () => {
  it('mostra só as salas da instância, e nunca a da call', () => {
    const canal = instancia();
    R.createRoom({ instance: canal, name: 'Minha', ownerId: 'u1', ownerName: 'Alice' });
    R.ensureCallRoom(canal, `call-${canal}`);
    R.createRoom({
      instance: instancia(),
      name: 'De outro canal',
      ownerId: 'u2',
      ownerName: 'Bob',
    });

    expect(R.listRooms(canal).map((r) => r.name)).toEqual(['Minha']);
  });

  it('diz que há senha sem entregar a senha', () => {
    const canal = instancia();
    R.createRoom({
      instance: canal,
      name: 'Trancada',
      ownerId: 'u1',
      ownerName: 'Alice',
      password: 'x',
    });

    const [sala] = R.listRooms(canal);
    expect(sala.locked).toBe(true);
    expect(sala).not.toHaveProperty('password');
  });

  it('conta gente uma vez só, mesmo com duas abas abertas', () => {
    const canal = instancia();
    const { room } = R.createRoom({
      instance: canal,
      name: 'Sala',
      ownerId: 'u1',
      ownerName: 'Alice',
    });
    R.attachViewer(room, socket(), pessoa('mesma'));
    R.attachViewer(room, socket(), pessoa('mesma'));
    R.attachViewer(room, socket(), pessoa('outra'));

    expect(R.listRooms(canal)[0].people).toBe(2);
  });

  it('conta as transmissões no ar', () => {
    const canal = instancia();
    const { room } = R.createRoom({
      instance: canal,
      name: 'Sala',
      ownerId: 'u1',
      ownerName: 'Alice',
    });
    const entry = R.attachBroadcaster(room, socket(), pessoa('t1'));
    expect(R.listRooms(canal)[0].streams).toBe(0);

    R.startStream(room, entry);
    expect(R.listRooms(canal)[0].streams).toBe(1);
  });

  it('ordena da mais antiga para a mais nova', () => {
    const canal = instancia();
    vi.useFakeTimers();
    try {
      R.createRoom({ instance: canal, name: 'Primeira', ownerId: 'u1', ownerName: 'A' });
      vi.advanceTimersByTime(1000);
      R.createRoom({ instance: canal, name: 'Segunda', ownerId: 'u1', ownerName: 'A' });
    } finally {
      vi.useRealTimers();
    }

    expect(R.listRooms(canal).map((r) => r.name)).toEqual(['Primeira', 'Segunda']);
  });
});

describe('checkPassword', () => {
  const comSenha = (password = 'certa') =>
    R.createRoom({ instance: instancia(), ownerId: 'u1', ownerName: 'A', password }).room;

  it('deixa entrar quando a sala não tem senha', () => {
    const { room } = R.createRoom({ instance: instancia(), ownerId: 'u1', ownerName: 'A' });

    expect(R.checkPassword(room, undefined)).toEqual({ ok: true });
  });

  it('aceita a senha certa e zera as tentativas', () => {
    const room = comSenha();
    R.checkPassword(room, 'errada');

    expect(R.checkPassword(room, 'certa')).toEqual({ ok: true });
    expect(room.attempts).toEqual([]);
  });

  it('recusa a senha errada', () => {
    expect(R.checkPassword(comSenha(), 'errada')).toEqual({ ok: false, reason: 'senha' });
  });

  it('tranca na quinta tentativa e diz por quantos segundos', () => {
    const room = comSenha();
    for (let i = 0; i < 4; i++) R.checkPassword(room, 'errada');

    expect(R.checkPassword(room, 'errada')).toEqual({
      ok: false,
      reason: 'bloqueado',
      seconds: 30,
    });
  });

  it('continua trancada mesmo com a senha certa na mão', () => {
    const room = comSenha();
    for (let i = 0; i < 5; i++) R.checkPassword(room, 'errada');

    expect(R.checkPassword(room, 'certa')).toMatchObject({ ok: false, reason: 'bloqueado' });
  });

  it('destranca sozinha quando o tempo passa', () => {
    const room = comSenha();
    vi.useFakeTimers();
    try {
      for (let i = 0; i < 5; i++) R.checkPassword(room, 'errada');
      vi.advanceTimersByTime(31_000);

      expect(R.checkPassword(room, 'certa')).toEqual({ ok: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('esquece as tentativas velhas: a janela é de um minuto', () => {
    const room = comSenha();
    vi.useFakeTimers();
    try {
      for (let i = 0; i < 4; i++) R.checkPassword(room, 'errada');
      vi.advanceTimersByTime(61_000);

      expect(R.checkPassword(room, 'errada')).toEqual({ ok: false, reason: 'senha' });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('setPassword', () => {
  it('recusa quem não é o dono', () => {
    const { room } = salaComEspectador();

    expect(R.setPassword(room, 'intruso', 'nova')).toMatch(/Só quem criou/);
    expect(room.password).toBeNull();
  });

  it('define a senha e anuncia o novo estado', () => {
    const { room, viewer } = salaComEspectador();

    expect(R.setPassword(room, 'dono', 'nova')).toBeNull();
    expect(R.checkPassword(room, 'nova')).toEqual({ ok: true });
    expect(viewer.mensagens().at(-1).room.locked).toBe(true);
  });

  it('remove a senha quando a nova vem vazia', () => {
    const { room } = salaComEspectador({ password: 'antiga' });
    R.setPassword(room, 'dono', '');

    expect(room.password).toBeNull();
  });

  it('solta o bloqueio junto com a troca', () => {
    const { room } = salaComEspectador({ password: 'antiga' });
    for (let i = 0; i < 5; i++) R.checkPassword(room, 'errada');
    R.setPassword(room, 'dono', 'nova');

    expect(room.lockedUntil).toBe(0);
    expect(room.attempts).toEqual([]);
  });
});

describe('attachBroadcaster', () => {
  it('dá um slot, avisa quem chegou e anuncia à sala', () => {
    const { room, viewer } = salaComEspectador();
    const ws = socket();
    const entry = R.attachBroadcaster(room, ws, pessoa('t1'));

    expect(entry.slot).toBe(0);
    expect(ws.mensagens()[0]).toEqual({ type: 'slot', slot: 0 });
    expect(viewer.tipos()).toContain('state');
  });

  it('recusa a mesma pessoa transmitindo duas vezes', () => {
    const { room } = salaComEspectador();
    R.attachBroadcaster(room, socket(), pessoa('t1'));

    expect(R.attachBroadcaster(room, socket(), pessoa('t1'))).toMatch(/já está transmitindo/);
  });

  it('recusa a quinta transmissão simultânea', () => {
    const { room } = salaComEspectador();
    for (let i = 0; i < 4; i++) R.attachBroadcaster(room, socket(), pessoa(`t${i}`));

    expect(R.attachBroadcaster(room, socket(), pessoa('t5'))).toMatch(/Limite de 4/);
  });

  it('reaproveita o slot de quem saiu', () => {
    const { room } = salaComEspectador();
    const ws = socket();
    R.attachBroadcaster(room, ws, pessoa('t1'));
    R.attachBroadcaster(room, socket(), pessoa('t2'));
    R.detachBroadcaster(room, ws);

    expect(R.attachBroadcaster(room, socket(), pessoa('t3')).slot).toBe(0);
  });

  it('encontra as entradas pelo id de quem transmite', () => {
    const { room, entry } = comTransmissao();

    expect(R.broadcastersOf(room, 'transmissor')).toEqual([entry]);
    expect(R.broadcastersOf(room, 'ninguem')).toEqual([]);
  });

  it('separa as duas fontes da mesma pessoa', () => {
    const { room, entry } = comTransmissao();
    const camera = R.attachBroadcaster(room, socket(), pessoa('transmissor'), 'camera');

    expect(camera.slot).not.toBe(entry.slot);
    expect(R.broadcastersOf(room, 'transmissor')).toHaveLength(2);
    expect(R.broadcastersOf(room, 'transmissor', 'camera')).toEqual([camera]);
  });

  it('recusa a mesma fonte duas vezes, nomeando qual', () => {
    const { room } = comTransmissao();

    expect(R.attachBroadcaster(room, socket(), pessoa('transmissor'), 'camera')).not.toBeTypeOf(
      'string',
    );
    expect(R.attachBroadcaster(room, socket(), pessoa('transmissor'), 'camera')).toMatch(
      /já está transmitindo a câmera/,
    );
  });

  it('recusa a terceira transmissão da mesma pessoa', () => {
    const { room } = comTransmissao();
    R.attachBroadcaster(room, socket(), pessoa('transmissor'), 'camera');

    // Fonte repetida cai na primeira recusa; o teto por pessoa é outro.
    expect(R.broadcastersOf(room, 'transmissor')).toHaveLength(2);
  });
});

describe('startStream', () => {
  it('anuncia a transmissão e zera quem estava assistindo', () => {
    const { room, viewer, entry } = comTransmissao();
    expect(viewer.__watching.has(entry.slot)).toBe(true);

    R.startStream(room, entry);

    expect(viewer.__watching.has(entry.slot)).toBe(false);
    expect(viewer.tipos()).toContain('stream-start');
  });
});

describe('watch e unwatch', () => {
  it('não assiste um slot que não existe', () => {
    const { room, viewer } = salaComEspectador();
    R.watch(room, viewer, 3);

    expect(viewer.enviados).toHaveLength(0);
  });

  it('não assiste um transmissor que ainda não começou', () => {
    const { room, viewer } = salaComEspectador();
    const entry = R.attachBroadcaster(room, socket(), pessoa('t1'));
    viewer.limpar();
    R.watch(room, viewer, entry.slot);

    expect(viewer.__watching.has(entry.slot)).toBe(false);
  });

  it('entrega as configs guardadas e pede um keyframe', () => {
    const { room, viewer } = salaComEspectador();
    const ws = socket();
    const entry = R.attachBroadcaster(room, ws, pessoa('t1'));
    R.startStream(room, entry);
    R.setConfig(room, entry, { codec: 'avc1' });
    R.setAudioConfig(room, entry, { codec: 'opus' });
    viewer.limpar();
    ws.limpar();

    R.watch(room, viewer, entry.slot);

    expect(viewer.tipos()).toEqual(expect.arrayContaining(['config', 'audio-config']));
    expect(ws.tipos()).toContain('need-keyframe');
  });

  it('pede novamente a configuração quando ela ainda não foi guardada', () => {
    const { room, viewer } = salaComEspectador();
    const ws = socket();
    const entry = R.attachBroadcaster(room, ws, pessoa('t1'));
    R.startStream(room, entry);
    viewer.limpar();
    ws.limpar();

    R.watch(room, viewer, entry.slot);

    expect(viewer.tipos()).not.toContain('config');
    expect(ws.tipos()).toEqual(expect.arrayContaining(['need-config', 'need-keyframe']));
  });

  it('ignora o pedido repetido, para um cliente em laço não inundar a sala', () => {
    const { room, viewer, entry } = comTransmissao();
    R.watch(room, viewer, entry.slot);

    expect(viewer.enviados).toHaveLength(0);
  });

  it('para de enviar quando o espectador desiste', () => {
    const { room, viewer, entry } = comTransmissao();
    R.unwatch(room, viewer, entry.slot);

    expect(viewer.__watching.has(entry.slot)).toBe(false);
    expect(viewer.tipos()).toContain('state');
  });

  it('ignora o unwatch de um slot que ninguém assistia', () => {
    const { room, viewer } = comTransmissao({ assistindo: false });
    R.unwatch(room, viewer, 0);

    expect(viewer.enviados).toHaveLength(0);
  });
});

describe('setConfig e setAudioConfig', () => {
  it('a config nova obriga o espectador a esperar outro keyframe', () => {
    const { room, viewer, entry } = comTransmissao();
    R.pushChunk(room, entry, quadro(entry.slot, KEYFRAME));
    expect(viewer.__primed.has(entry.slot)).toBe(true);

    R.setConfig(room, entry, { codec: 'vp8' });

    expect(viewer.__primed.has(entry.slot)).toBe(false);
    expect(viewer.tipos()).toContain('config');
  });

  it('não manda config para quem não pediu aquela tela', () => {
    const { room, viewer, entry } = comTransmissao({ assistindo: false });
    R.setConfig(room, entry, { codec: 'vp8' });
    R.setAudioConfig(room, entry, { codec: 'opus' });

    expect(viewer.tipos()).not.toContain('config');
    expect(viewer.tipos()).not.toContain('audio-config');
  });
});

describe('pushChunk', () => {
  it('descarta o quadro carimbado com o slot de outro transmissor', () => {
    const { room, viewer, entry } = comTransmissao();
    R.pushChunk(room, entry, quadro(entry.slot + 1, KEYFRAME));

    expect(viewer.binarios()).toHaveLength(0);
  });

  it('barra o delta enquanto o decoder está frio', () => {
    const { room, viewer, entry } = comTransmissao();
    R.pushChunk(room, entry, quadro(entry.slot, DELTA));

    expect(viewer.binarios()).toHaveLength(0);
  });

  it('o keyframe destrava, e o delta seguinte passa', () => {
    const { room, viewer, entry } = comTransmissao();
    R.pushChunk(room, entry, quadro(entry.slot, KEYFRAME));
    R.pushChunk(room, entry, quadro(entry.slot, DELTA));

    expect(viewer.binarios()).toHaveLength(2);
  });

  it('o áudio passa sem keyframe nenhum antes', () => {
    const { room, viewer, entry } = comTransmissao();
    R.pushChunk(room, entry, quadro(entry.slot, AUDIO));

    expect(viewer.binarios()).toHaveLength(1);
  });

  it('não envia a quem não pediu esta tela', () => {
    const { room, viewer, entry } = comTransmissao({ assistindo: false });
    R.pushChunk(room, entry, quadro(entry.slot, KEYFRAME));

    expect(viewer.binarios()).toHaveLength(0);
  });

  it('pula o socket que já fechou', () => {
    const { room, entry } = comTransmissao();
    const morto = socket({ aberto: false });
    R.attachViewer(room, morto, pessoa('morto'));
    morto.__watching.add(entry.slot);
    morto.limpar();

    R.pushChunk(room, entry, quadro(entry.slot, KEYFRAME));

    expect(morto.binarios()).toHaveLength(0);
  });

  it('conta o que passou pelo relay', () => {
    const { room, entry } = comTransmissao();
    R.pushChunk(room, entry, quadro(entry.slot, KEYFRAME, 128));

    expect(room.traffic.receivedBytes).toBe(128);
    expect(room.traffic.transmittedBytes).toBe(128);
  });

  describe('contrapressão', () => {
    /** Um espectador cujo socket já está entupido. */
    function entupido(bytes) {
      const { room, entry } = comTransmissao({ assistindo: false });
      const lento = socket({ buffered: bytes });
      R.attachViewer(room, lento, pessoa('lento'));
      R.watch(room, lento, entry.slot);
      lento.limpar();
      return { room, entry, lento };
    }

    it('descarta o delta de quem não vaza a fila', () => {
      const { room, entry, lento } = entupido(3 * 1024 * 1024);
      lento.__primed.add(entry.slot);

      R.pushChunk(room, entry, quadro(entry.slot, DELTA));

      expect(lento.binarios()).toHaveLength(0);
      expect(room.droppedChunks).toBe(1);
    });

    it('descarta o áudio pelo mesmo teto', () => {
      const { room, entry, lento } = entupido(3 * 1024 * 1024);

      R.pushChunk(room, entry, quadro(entry.slot, AUDIO));

      expect(lento.binarios()).toHaveLength(0);
      expect(room.droppedChunks).toBe(1);
    });

    it('dá ao keyframe o dobro de folga, porque sem ele a tela não volta', () => {
      const { room, entry, lento } = entupido(3 * 1024 * 1024);

      R.pushChunk(room, entry, quadro(entry.slot, KEYFRAME));

      expect(lento.binarios()).toHaveLength(1);
    });

    it('mas nem o keyframe passa quando a fila estourou de vez', () => {
      const { room, entry, lento } = entupido(5 * 1024 * 1024);

      R.pushChunk(room, entry, quadro(entry.slot, KEYFRAME));

      expect(lento.binarios()).toHaveLength(0);
      expect(entry.droppedChunks).toBe(1);
    });
  });
});

describe('stopStream e detachBroadcaster', () => {
  it('avisa a sala e esquece quem assistia', () => {
    const { room, viewer, entry } = comTransmissao();
    R.stopStream(room, entry);

    expect(viewer.tipos()).toContain('stream-stop');
    expect(viewer.__watching.has(entry.slot)).toBe(false);
    expect(entry.streaming).toBe(false);
  });

  it('parar de novo não faz nada', () => {
    const { room, viewer, entry } = comTransmissao();
    R.stopStream(room, entry);
    viewer.limpar();
    R.stopStream(room, entry);

    expect(viewer.enviados).toHaveLength(0);
  });

  it('a saída do transmissor libera o slot', () => {
    const { room, ws, entry } = comTransmissao();
    R.detachBroadcaster(room, ws);

    expect(room.broadcasters.size).toBe(0);
    expect(room.slots.has(entry.slot)).toBe(false);
  });

  it('ignora a saída de um socket que não transmitia', () => {
    const { room } = comTransmissao();
    const estranho = socket();

    expect(() => R.detachBroadcaster(room, estranho)).not.toThrow();
    expect(room.broadcasters.size).toBe(1);
  });

  it('ignora a saída de uma entrada já substituída', () => {
    const { room, ws } = comTransmissao();
    R.detachBroadcaster(room, ws);
    R.attachBroadcaster(room, socket(), pessoa('transmissor'));

    R.detachBroadcaster(room, ws);

    expect(room.broadcasters.size).toBe(1);
  });
});

describe('attachViewer e detachViewer', () => {
  it('entrega o estado da sala e anuncia o que já está no ar', () => {
    const { room, entry } = comTransmissao({ assistindo: false });
    const novo = socket();

    R.attachViewer(room, novo, pessoa('novo'));

    expect(novo.tipos()).toContain('state');
    expect(novo.mensagens().find((m) => m.type === 'stream-start').slot).toBe(entry.slot);
    // Anunciar não é enviar: assistir continua sendo opt-in.
    expect(novo.binarios()).toHaveLength(0);
  });

  it('não anuncia transmissor que ainda não começou', () => {
    const { room } = salaComEspectador();
    R.attachBroadcaster(room, socket(), pessoa('t1'));
    const novo = socket();

    R.attachViewer(room, novo, pessoa('novo'));

    expect(novo.tipos()).not.toContain('stream-start');
  });

  it('a saída de um espectador atualiza a sala', () => {
    const { room, viewer } = salaComEspectador();
    const outro = socket();
    R.attachViewer(room, outro, pessoa('outro'));
    outro.limpar();

    R.detachViewer(room, viewer);

    expect(outro.mensagens().at(-1).viewers).toBe(1);
  });

  it('quem transmite de fora da Activity continua na lista de participantes', () => {
    const { room, viewer, entry } = comTransmissao();
    R.detachViewer(room, viewer);
    const observador = socket();
    R.attachViewer(room, observador, pessoa('observador'));

    const estado = observador.mensagens().find((m) => m.type === 'state');
    expect(estado.participants.some((p) => p.id === entry.info.id && p.broadcasting)).toBe(true);
  });
});

describe('rename', () => {
  it('normaliza os espaços e propaga para a sala', () => {
    const { room, viewer } = salaComEspectador();
    R.rename(room, viewer, '  Novo   Nome  ');

    expect(viewer.__info.name).toBe('Novo Nome');
    expect(viewer.mensagens().at(-1).participants[0].name).toBe('Novo Nome');
  });

  it('corta em 32 caracteres', () => {
    const { room, viewer } = salaComEspectador();
    R.rename(room, viewer, 'n'.repeat(80));

    expect(viewer.__info.name).toHaveLength(32);
  });

  it('acompanha o nome de quem está transmitindo', () => {
    const { room, entry } = comTransmissao();
    const transmissorNaSala = socket();
    R.attachViewer(room, transmissorNaSala, pessoa('transmissor'));
    R.rename(room, transmissorNaSala, 'Outro');

    expect(entry.info.name).toBe('Outro');
  });

  it.each([
    ['um nome só de espaço', '    '],
    ['o que não é texto', 42],
  ])('ignora %s', (_nome, entrada) => {
    const { room, viewer } = salaComEspectador();
    const antes = viewer.__info.name;

    R.rename(room, viewer, entrada);

    expect(viewer.__info.name).toBe(antes);
  });

  it('ignora um socket sem identidade', () => {
    const { room } = salaComEspectador();
    const anonimo = socket();

    expect(() => R.rename(room, anonimo, 'Nome')).not.toThrow();
  });
});

describe('aba de captura', () => {
  it('recebe recados endereçados a quem a abriu, e mais ninguém', () => {
    const { room } = salaComEspectador();
    const minha = socket();
    const alheia = socket();
    R.attachControl(room, minha, 'alice');
    R.attachControl(room, alheia, 'bob');

    expect(R.toControls(room, 'alice', { type: 'start-request', fonte: 'camera' })).toBe(1);
    expect(minha.tipos()).toEqual(['start-request']);
    expect(alheia.enviados).toHaveLength(0);
  });

  it('não conta como gente na sala nem segura a sala de pé', () => {
    const canal = instancia();
    const { room } = R.createRoom({
      instance: canal,
      name: 'Sala',
      ownerId: 'u1',
      ownerName: 'Alice',
    });
    R.attachControl(room, socket(), 'alice');

    expect(R.listRooms(canal)[0].people).toBe(0);
    expect(room.viewers.size).toBe(0);
  });

  it('some quando a aba fecha', () => {
    const { room } = salaComEspectador();
    const aba = socket();
    R.attachControl(room, aba, 'alice');

    R.detachControl(room, aba);

    expect(R.toControls(room, 'alice', { type: 'start-request' })).toBe(0);
  });

  it('não entrega para uma aba cujo socket já caiu', () => {
    const { room } = salaComEspectador();
    R.attachControl(room, socket({ aberto: false }), 'alice');

    expect(R.toControls(room, 'alice', { type: 'start-request' })).toBe(0);
  });
});

describe('sendJson', () => {
  it('devolve false quando o socket já fechou', () => {
    expect(R.sendJson(socket({ aberto: false }), { a: 1 })).toBe(false);
  });

  it('devolve false quando não há socket', () => {
    expect(R.sendJson(null, { a: 1 })).toBe(false);
  });
});

describe('stats', () => {
  it('resume cada sala sem entregar a senha', () => {
    const { room } = comTransmissao();
    const linha = R.stats().find((r) => r.id === room.id);

    expect(linha).toMatchObject({ broadcasting: 1, viewers: 1, droppedChunks: 0 });
    expect(linha).not.toHaveProperty('password');
  });
});

describe('adminStats', () => {
  const adminSala = (id) => R.adminStats().rooms.find((r) => r.id === id);

  it('descreve a sala, quem está nela e o que cada um assiste', () => {
    const { room, entry, viewer } = comTransmissao();
    viewer.__rttMs = 40;
    R.setConfig(room, entry, { codec: 'avc1', codedWidth: 1280, codedHeight: 720 });
    R.setAudioConfig(room, entry, { codec: 'opus' });
    R.pushChunk(room, entry, quadro(entry.slot, KEYFRAME, 256));

    const sala = adminSala(room.id);

    expect(sala).toMatchObject({ viewers: 1, broadcasters: 1, isCall: false });
    expect(sala.streams[0]).toMatchObject({
      slot: entry.slot,
      codec: 'avc1',
      width: 1280,
      height: 720,
      audioCodec: 'opus',
      watchers: 1,
    });
    expect(sala.users.find((u) => u.id === 'espectador')).toMatchObject({
      roles: ['viewer'],
      pingMs: 40,
      mediaBytesOut: 256,
    });
    expect(sala.users.find((u) => u.id === 'transmissor')).toMatchObject({
      roles: ['broadcaster'],
      broadcasting: true,
    });
  });

  it('junta as duas funções quando é a mesma pessoa', () => {
    const { room, entry } = comTransmissao({ assistindo: false });
    const mesmaAba = socket();
    R.attachViewer(room, mesmaAba, pessoa(entry.info.id));

    const usuario = adminSala(room.id).users.find((u) => u.id === entry.info.id);
    expect(usuario.roles).toEqual(expect.arrayContaining(['viewer', 'broadcaster']));
    expect(usuario.connections).toBe(2);
  });

  it('reporta o tráfego acumulado do processo', () => {
    expect(R.adminStats().traffic.receivedBytes).toBeGreaterThan(0);
  });
});
