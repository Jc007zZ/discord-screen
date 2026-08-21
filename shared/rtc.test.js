/**
 * A camada WebRTC, com dublês no lugar do navegador.
 *
 * Nada disto existe fora de um navegador de verdade, e o que este módulo faz
 * não é negociar — é ligar os fios certos e traduzir o que o RTCPeerConnection
 * conta. Os dublês daqui imitam o contrato dessa API, que é o que o módulo
 * realmente depende: quais eventos ele escuta, o que ele repassa, e o que ele
 * decide quando a resposta não vem.
 *
 * O que se prova aqui é sobretudo a rede de segurança: candidato nulo que não
 * pode ser repassado, ICE que falha sem emitir mudança de estado, `getStats`
 * que lança. Nenhuma dessas situações quebra a transmissão hoje — e é justamente
 * por isso que uma regressão nelas passaria despercebida.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { criarPeer, MORTO, PRAZO_CONEXAO_MS, resumoPeer } from './rtc.js';

const STUN = 'stun:stun.l.google.com:19302';

/** Um RTCPeerConnection de mentira: guarda os ouvintes para o teste disparar. */
class PeerFalso {
  constructor(config) {
    this.config = config;
    this.ouvintes = new Map();
    this.estatisticas = new Map();
    PeerFalso.criados.push(this);
  }
  addEventListener(nome, fn) {
    this.ouvintes.set(nome, fn);
  }
  disparar(nome, evento) {
    this.ouvintes.get(nome)?.(evento);
  }
  async getStats() {
    return this.estatisticas;
  }
}
PeerFalso.criados = [];

beforeEach(() => {
  PeerFalso.criados = [];
  vi.stubGlobal('RTCPeerConnection', PeerFalso);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('iceServers', () => {
  /**
   * O módulo guarda a lista numa promessa de módulo, para buscá-la uma vez por
   * sessão. Isso obriga a reimportar a cada caso — sem isso o primeiro teste
   * decidiria o resultado dos outros.
   */
  async function comFetch(implementacao) {
    vi.resetModules();
    vi.stubGlobal('fetch', vi.fn(implementacao));
    const { iceServers } = await import('./rtc.js');
    return iceServers;
  }

  it('usa a lista que o servidor mandou', async () => {
    const iceServers = await comFetch(async () => ({
      ok: true,
      json: async () => ({ iceServers: [{ urls: 'turn:exemplo.test', username: 'u' }] }),
    }));

    expect(await iceServers()).toEqual([{ urls: 'turn:exemplo.test', username: 'u' }]);
  });

  it('busca uma vez só, por mais que perguntem', async () => {
    const iceServers = await comFetch(async () => ({
      ok: true,
      json: async () => ({ iceServers: [{ urls: STUN }] }),
    }));

    await Promise.all([iceServers(), iceServers(), iceServers()]);

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('respeita o prefixo do proxy da Activity', async () => {
    const iceServers = await comFetch(async () => ({ ok: true, json: async () => ({}) }));

    await iceServers('/.proxy');

    expect(globalThis.fetch).toHaveBeenCalledWith('/.proxy/api/ice');
  });

  it('cai no STUN público quando a rede falha', async () => {
    // Ficar sem lista não pode significar ficar sem conexão direta: o STUN
    // público sozinho já resolve a maioria das casas.
    const iceServers = await comFetch(async () => {
      throw new Error('sem rede');
    });

    expect(await iceServers()).toEqual([{ urls: STUN }]);
  });

  it('cai no STUN público quando o servidor recusa', async () => {
    const iceServers = await comFetch(async () => ({ ok: false }));

    expect(await iceServers()).toEqual([{ urls: STUN }]);
  });

  it('cai no STUN público quando a lista vem vazia', async () => {
    const iceServers = await comFetch(async () => ({
      ok: true,
      json: async () => ({ iceServers: [] }),
    }));

    expect(await iceServers()).toEqual([{ urls: STUN }]);
  });
});

describe('criarPeer', () => {
  it('junta áudio e vídeo num transporte só', async () => {
    // Sem isto são duas negociações de ICE para a mesma conexão, e o dobro de
    // tempo até o primeiro quadro.
    criarPeer({ ice: [{ urls: STUN }] });

    expect(PeerFalso.criados[0].config).toMatchObject({ bundlePolicy: 'max-bundle' });
  });

  it('repassa o candidato já convertido', async () => {
    const onIce = vi.fn();
    const pc = criarPeer({ ice: [], onIce });

    pc.disparar('icecandidate', { candidate: { toJSON: () => ({ candidate: 'a=1' }) } });

    expect(onIce).toHaveBeenCalledWith({ candidate: 'a=1' });
  });

  it('não repassa o candidato nulo, que é o fim da lista', async () => {
    // Repassá-lo faria o outro lado chamar addIceCandidate(null) e lançar.
    const onIce = vi.fn();
    const pc = criarPeer({ ice: [], onIce });

    pc.disparar('icecandidate', { candidate: null });

    expect(onIce).not.toHaveBeenCalled();
  });

  it('avisa a mudança de estado da conexão', async () => {
    const onEstado = vi.fn();
    const pc = criarPeer({ ice: [], onEstado });
    pc.connectionState = 'connected';

    pc.disparar('connectionstatechange');

    expect(onEstado).toHaveBeenCalledWith('connected');
  });

  it('trata a falha de ICE como falha, mesmo sem mudança de conexão', async () => {
    // Nem todo navegador emite connectionstatechange quando o ICE desiste; sem
    // isto a tentativa ficaria pendurada até o prazo estourar.
    const onEstado = vi.fn();
    const pc = criarPeer({ ice: [], onEstado });
    pc.iceConnectionState = 'failed';

    pc.disparar('iceconnectionstatechange');

    expect(onEstado).toHaveBeenCalledWith('failed');
  });

  it('ignora estado de ICE que não é falha', async () => {
    const onEstado = vi.fn();
    const pc = criarPeer({ ice: [], onEstado });
    pc.iceConnectionState = 'checking';

    pc.disparar('iceconnectionstatechange');

    expect(onEstado).not.toHaveBeenCalled();
  });

  it('reconhece os estados dos quais não se volta', async () => {
    expect([...MORTO]).toEqual(expect.arrayContaining(['failed', 'closed', 'disconnected']));
    expect(MORTO.has('connected')).toBe(false);
    expect(PRAZO_CONEXAO_MS).toBeGreaterThan(0);
  });
});

describe('resumoPeer', () => {
  const par = (extra = {}) => ({
    id: 'par',
    type: 'candidate-pair',
    state: 'succeeded',
    localCandidateId: 'local',
    currentRoundTripTime: 0.042,
    ...extra,
  });

  function comEstatisticas(entradas) {
    const pc = criarPeer({ ice: [] });
    pc.estatisticas = new Map(entradas.map((e) => [e.id, e]));
    return pc;
  }

  it('traduz o ida-e-volta para milissegundos', async () => {
    const pc = comEstatisticas([
      par(),
      { id: 'local', type: 'local-candidate', candidateType: 'srflx' },
    ]);

    expect(await resumoPeer(pc)).toMatchObject({ rtt: 42, relay: false });
  });

  it('acusa quando a conexão está passando por TURN', async () => {
    // TURN encaminha o vídeo de verdade: é banda paga por alguém, e quem olha
    // o diagnóstico precisa saber que está nesse caminho.
    const pc = comEstatisticas([
      par(),
      { id: 'local', type: 'local-candidate', candidateType: 'relay' },
    ]);

    expect(await resumoPeer(pc)).toMatchObject({ relay: true });
  });

  it('ignora o par que não foi escolhido', async () => {
    const pc = comEstatisticas([par({ id: 'a', state: 'failed' })]);

    expect(await resumoPeer(pc)).toMatchObject({ rtt: null, relay: false });
  });

  it('devolve só o que dá para agir: ida-e-volta e se passa por TURN', async () => {
    // Sem taxa de chegada de proposito. Ela existiu aqui por um tempo, lendo
    // `bytesReceived` — que e um acumulado desde o inicio, nao uma taxa. Um
    // numero com nome de velocidade e valor de total engana quem le o painel
    // mais do que a ausencia dele.
    const pc = comEstatisticas([
      par(),
      { id: 'local', type: 'local-candidate', candidateType: 'srflx' },
      { id: 'in', type: 'inbound-rtp', kind: 'video', bytesReceived: 4242 },
    ]);

    expect(Object.keys(await resumoPeer(pc)).sort()).toEqual(['relay', 'rtt']);
  });

  it('some o diagnóstico, e não a conexão, quando getStats lança', async () => {
    const pc = criarPeer({ ice: [] });
    pc.getStats = async () => {
      throw new Error('sem suporte');
    };

    expect(await resumoPeer(pc)).toEqual({ rtt: null, relay: false });
  });
});
