import { iceServers, criarPeer, suportaWebRTC, MORTO } from './rtc.js';

/**
 * Pipeline de transmissão: captura → codifica → envia.
 *
 * Módulo compartilhado entre a Activity (captura dentro do modal, quando o
 * Discord permite) e a página de captura externa (quando não permite). Uma
 * implementação só — duas cópias divergiriam na primeira correção.
 *
 * Sem MediaRecorder porque o container impõe piso de latência: WebCodecs
 * codifica quadro a quadro e envia direto pelo relay.
 *
 * Por cima disso, cada espectador ganha uma tentativa de conexão direta por
 * WebRTC (veja rtc.js): um RTCDataChannel não-confiável que carrega os mesmos
 * pacotes binários do relay — nada de faixa de mídia, fila de jitter ou segunda
 * codificação. Quando ela fecha, o vídeo daquele espectador para de passar pelo
 * relay e passa a sair daqui num transporte que sabe descartar quadro atrasado
 * em vez de enfileirar. Quando não fecha, nada muda — o caminho abaixo continua
 * sendo o mesmo de sempre, e é ele que garante que ninguém fica sem imagem por
 * causa de um NAT.
 */

/**
 * Níveis do H.264, do mais baixo ao mais alto, com os dois tetos que decidem.
 *
 * Nome de codec do H.264 carrega o nível nos dois últimos dígitos, e nível não
 * é enfeite: é um contrato sobre o tamanho do quadro e sobre quantos
 * macroblocos por segundo o decodificador precisa aguentar. Pedir um nível que
 * não cabe faz o navegador recusar a configuração inteira — e, no nosso caso,
 * cair em VP8, que a 1080p não tem encoder por hardware em máquina nenhuma
 * comum e derruba a taxa de quadros pela metade.
 *
 * Este arquivo pediu `avc1.42E01E` — nível 3.0 — desde sempre. Nível 3.0 aguenta
 * 1620 macroblocos por quadro, uns 720×576. Uma tela 1080p tem 8160. O H.264
 * nunca esteve disponível para compartilhamento de tela; só para câmera, que
 * captura pequeno o bastante para caber. Ninguém tinha por que desconfiar,
 * porque a transmissão funcionava — só que em software.
 */
const NIVEIS_H264 = [
  { nivel: 0x1e, maxFS: 1620, maxMBPS: 40500 }, // 3.0
  { nivel: 0x1f, maxFS: 3600, maxMBPS: 108000 }, // 3.1
  { nivel: 0x20, maxFS: 5120, maxMBPS: 216000 }, // 3.2
  { nivel: 0x28, maxFS: 8192, maxMBPS: 245760 }, // 4.0 — 1080p30 cabe raspando
  { nivel: 0x2a, maxFS: 8704, maxMBPS: 522240 }, // 4.2 — 1080p60 pede este
  { nivel: 0x32, maxFS: 22080, maxMBPS: 589824 }, // 5.0
  { nivel: 0x33, maxFS: 36864, maxMBPS: 983040 }, // 5.1
  { nivel: 0x34, maxFS: 36864, maxMBPS: 2073600 }, // 5.2
];

/**
 * Perfis, do que comprime melhor ao que tem encoder em mais lugares.
 *
 * High entrega mais imagem no mesmo bitrate e é acelerado por hardware em
 * qualquer GPU desta década. Baseline fica por último como rede de segurança:
 * é o que roda onde nada mais roda.
 */
const PERFIS_H264 = ['6400', '4d40', '42e0'];

/** O menor nível que aguenta este quadro nesta taxa. */
export function nivelH264(width, height, fps) {
  const macroblocos = Math.ceil(width / 16) * Math.ceil(height / 16);
  const porSegundo = macroblocos * fps;
  const cabe = NIVEIS_H264.find((n) => macroblocos <= n.maxFS && porSegundo <= n.maxMBPS);
  // Acima de 5.2 não existe nível para pedir; deixa o navegador recusar e o
  // VP8 assumir, que é melhor que montar um nome de codec inválido.
  return (cabe ?? NIVEIS_H264.at(-1)).nivel;
}

/** Troca o nível de um nome de codec H.264. Devolve os outros intactos. */
function comNivel(codec, nivel) {
  if (!codec?.startsWith('avc1.') || codec.length !== 11) return codec;
  return codec.slice(0, 9) + nivel.toString(16).padStart(2, '0');
}

/**
 * Os codecs a tentar, nesta ordem, para este quadro e esta taxa.
 *
 * H.264 primeiro porque quase sempre tem encoder por hardware; VP8 e VP9 são a
 * saída para quem não tem H.264 nenhum. `annexb` vem antes de cada perfil
 * porque dispensa o blob `description`, e o avcC é aceito onde annexb não é.
 */
function candidatos(width, height, fps) {
  const nivel = nivelH264(width, height, fps).toString(16).padStart(2, '0');
  const h264 = PERFIS_H264.flatMap((perfil) => {
    const codec = `avc1.${perfil}${nivel}`;
    return [{ codec, avc: { format: 'annexb' } }, { codec }];
  });
  return [...h264, { codec: 'vp8' }, { codec: 'vp09.00.10.08' }];
}

/**
 * Quão longe da marca da grade um quadro ainda serve para aquela marca.
 *
 * Meio intervalo para cada lado, e meio não é chute: é a maior tolerância que
 * ainda escolhe um quadro só por marca. Mais que isso e dois quadros disputam
 * a mesma vaga; menos e o tremor normal da captura passa a derrubar quadro bom.
 *
 * Este número já foi 15% do intervalo, e foi um erro caro. A 30 fps sobravam
 * 5 ms de folga e ninguém via nada; a 60 fps sobravam 2,5 — menos que o tremor
 * da própria captura de tela. O freio passou a derrubar quadros ao acaso, e a
 * taxa virou cara ou coroa entre 60 e 30. Era isso que fazia 60 fps tremer.
 */
const TOLERANCIA_GRADE = 0.5;

/**
 * Salto que denuncia relógio de origem novo, em intervalos.
 *
 * Trocar de tela, ou uma aba que dormiu e voltou, traz timestamps de outra
 * régua. Quatro intervalos é mais que qualquer engasgo de rede e menos que
 * qualquer troca de fonte de verdade.
 */
const GRADE_PERDIDA = 4;

// Keyframe periódico: seguro barato para quem reconecta fora do fluxo normal.
const KEYFRAME_EVERY_MS = 3000;

// Tipos do primeiro byte útil de cada pacote. O áudio anda pelo mesmo socket e
// pelo mesmo cabeçalho do vídeo: um canal só, um formato só, e o servidor
// continua repassando o buffer sem precisar abrir nada.
const TIPO_KEYFRAME = 1;
const TIPO_DELTA = 2;
const TIPO_AUDIO = 3;

/**
 * O canal de dados carrega os mesmos pacotes binários do relay — é a única
 * coisa que ele faz. Fora de ordem e sem retransmissão de propósito: quadro
 * atrasado não vale a espera que um transporte confiável impõe para entregá-lo,
 * e quem perde o fio recupera a imagem no keyframe periódico.
 */
const CANAL_OPTS = { ordered: false, maxRetransmits: 0 };

/**
 * Backpressure do canal: entupido não enfileira mais. Descartar quadro é o
 * contrato deste transporte; enfileirar seria reconstruir, dentro do SCTP, o
 * comportamento de TCP que se quer evitar.
 */
const MAX_CANAL_BYTES = 1024 * 1024;

// 96 kbps em Opus estéreo é transparente para som de aplicativo e de vídeo, e é
// ruído perto dos megabits do vídeo — não vale economizar aqui.
const AUDIO_BITRATE = 96_000;

// Teto de resolução: acima disso banda e CPU disparam sem ganho de legibilidade.
// A imagem é reduzida proporcionalmente, nunca cortada.
const MAX_W = 1920;
const MAX_H = 1080;

const even = (n) => Math.max(2, n - (n % 2));

function fitWithin(w, h) {
  const scale = Math.min(1, MAX_W / w, MAX_H / h);
  return { width: even(Math.round(w * scale)), height: even(Math.round(h * scale)) };
}

/**
 * Restrições do som capturado junto com a tela.
 *
 * Os tratamentos de voz ficam desligados: eles existem para microfone e, em som
 * de aplicativo, cortam justamente o que se queria ouvir.
 */
export function restricoesDeSom() {
  const c = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  };
  if (navigator.mediaDevices.getSupportedConstraints?.().restrictOwnAudio) {
    c.restrictOwnAudio = true;
  }
  return c;
}

/**
 * Opções da captura de tela.
 *
 * Exportada porque a prévia da página de captura precisa pedir exatamente o
 * mesmo. Um stream aberto com opções diferentes não serve para transmitir
 * depois: sem faixa de som, ligar o som exigiria escolher a tela de novo — e
 * abrir o seletor duas vezes para o mesmo compartilhamento é o que a prévia
 * existe para evitar.
 *
 * windowAudio: 'window' pede o som da janela escolhida em vez de só o da aba,
 * que é o que destrava transmitir um jogo com o som dele.
 */
export function opcoesTela({ fps = 30, comSom = false, video } = {}) {
  const opts = {
    video: video ?? { frameRate: { ideal: fps, max: fps } },
    audio: comSom ? restricoesDeSom() : false,
  };
  if (comSom) {
    opts.windowAudio = 'window';
    opts.systemAudio = 'exclude';
  }
  return opts;
}

/**
 * Motivo pelo qual este navegador não consegue transmitir nada, ou null.
 *
 * Só o que vale para as duas fontes. O que cada uma precisa é pergunta de cada
 * uma — ver `fonteIndisponivel` —, senão faltar `getDisplayMedia` derrubaria
 * também a câmera, que não depende dele.
 */
export function supportError({ requireChromium = false } = {}) {
  if (!window.VideoEncoder || !window.VideoFrame || !window.EncodedVideoChunk) {
    return 'Este navegador não tem WebCodecs, necessário para transmitir. Use Chrome, Edge ou outro navegador Chromium no desktop.';
  }
  // Exigência de produto, não de capacidade: o caminho via <video> funciona em
  // Firefox e Safari, mas a captura sai visivelmente pior.
  if (requireChromium && !window.MediaStreamTrackProcessor) {
    return 'Transmitir exige um navegador Chromium — Chrome, Edge, Brave ou Opera. Nos outros a captura fica com qualidade ruim, então está desabilitada. Você continua podendo assistir.';
  }
  return null;
}

/**
 * Motivo pelo qual esta fonte não pode ser capturada aqui, ou null.
 *
 * Separado do `supportError` porque as duas dependem de APIs diferentes: um
 * celular não tem `getDisplayMedia` e tem `getUserMedia`, e derrubar a página
 * inteira por causa da tela tirava dele a câmera, que funcionaria.
 */
export function fonteIndisponivel(fonte) {
  if (fonte === 'camera') {
    return navigator.mediaDevices?.getUserMedia
      ? null
      : 'Este navegador não permite acesso à câmera.';
  }
  return navigator.mediaDevices?.getDisplayMedia
    ? null
    : 'Este navegador não permite captura de tela. Navegador de celular não suporta captura — use um desktop.';
}

/**
 * @param {object} opts
 * @param {string} opts.wsUrl        endpoint do relay, com o token de transmissor
 * @param {number} opts.bitrate      bits por segundo
 * @param {number} opts.fps
 * @param {boolean} [opts.audio]     capturar também o som do computador
 * @param {'tela'|'camera'} [opts.fonte]  de onde vem o vídeo
 * @param {(info:object)=>void} [opts.onStatus]  codec/resolução/caminho de captura
 * @param {(stats:object)=>void} [opts.onStats]  viewers, fps, mbps, segundos no ar
 * @param {(reason:string)=>void} [opts.onEnd]   encerrou (por qualquer motivo)
 * @param {(msg:string)=>void} [opts.onAviso]    algo mudou sem ser erro
 */
export function createBroadcaster({
  wsUrl,
  // Prefixo das rotas HTTP. Dentro da Activity tudo passa por /.proxy, e é daí
  // que vem a lista de servidores ICE.
  apiBase = '',
  bitrate,
  fps,
  audio = false,
  fonte = 'tela',
  // Stream já aberto pela prévia. Reaproveitá-lo é o que evita abrir o seletor
  // de tela duas vezes — e, na câmera, segurar o dispositivo em duas capturas.
  streamPronto = null,
  // Qual câmera, quando há mais de uma. Ignorado pela tela, que não tem lista.
  deviceId = null,
  onStatus,
  onStats,
  onEnd,
  onAviso,
}) {
  let ws = null;
  let stream = null;
  let encoder = null;
  let reader = null;
  let audioEncoder = null;
  let audioReader = null;
  // Pediram som, mas a superfície escolhida traria o Discord junto. Guardado
  // para a interface poder oferecer a saída em vez de só avisar e esquecer.
  let somBloqueado = false;
  let video = null;
  let config = null;
  let stage = null;
  let stageCtx = null;

  // Uma conexão direta por espectador. O servidor nomeia cada um; aqui o nome
  // é só a chave — quem é a pessoa não interessa para negociar transporte.
  const peers = new Map(); // peerId -> { pc, canal }
  // Quadros ainda precisam subir pelo relay? Falso quando todo mundo que
  // assiste está na conexão direta, e o servidor é quem sabe disso. Codificar
  // continua: os canais diretos bebem da mesma saída do encoder — o que este
  // sinal desliga é só a subida, não a produção.
  let enviarChunks = true;
  // Antes do primeiro config, pausar deixaria quem chegasse depois sem como
  // montar o decodificador: o servidor guarda o config, mas só depois de vê-lo.
  let configEnviada = false;

  let running = false;
  let mySlot = 0;
  let wantKeyframe = true;
  let lastKeyframeAt = 0;
  let srcW = 0;
  let srcH = 0;
  // Próxima marca da grade de ritmo, em ms do relógio da captura. Null recomeça
  // a grade no quadro seguinte — é o que reinicia o ritmo depois de trocar de
  // tela ou de taxa, quando a régua anterior não vale mais.
  let proximaMarca = null;
  // Encoder em apuros. Ver a histerese no encodeFrame.
  let afogado = false;
  // Quantos quadros a captura entregou, contra quantos foram codificados. A
  // diferença entre os dois é o diagnóstico deste bloco.
  let framesEntrada = 0;
  let startedAt = 0;
  let bytes = 0;
  let frames = 0;
  let viewers = 0;
  let statsTimer = null;

  async function start() {
    // Precisa vir do gesto do usuário; qualquer await antes disso o invalida.
    // A prévia já pagou esse preço, então quando ela existe não há o que pedir.
    stream = streamPronto ?? (fonte === 'camera' ? await capturarCamera() : await capturarTela());

    const track = stream.getVideoTracks()[0];
    // Tela é texto e interface, onde suavizar borra o que importa. Câmera é
    // vídeo natural, e aí suavizar é justamente o certo.
    track.contentHint = fonte === 'camera' ? 'motion' : 'text';
    track.addEventListener('ended', () =>
      stop(
        fonte === 'camera'
          ? 'A câmera foi desligada.'
          : 'Você parou o compartilhamento pelo navegador.',
      ),
    );

    const s = track.getSettings();
    const target = fitWithin(s.width ?? 1280, s.height ?? 720);

    config = await pickConfig(target.width, target.height);
    if (!config) {
      cleanup();
      throw new Error('Nenhum codec de vídeo suportado por este navegador.');
    }

    await connect();

    encoder = new VideoEncoder({
      output: onEncoded,
      error: (err) => stop(`Erro no encoder: ${err.message}`),
    });
    encoder.configure(config);

    ws.send(JSON.stringify({ type: 'start' }));

    running = true;
    wantKeyframe = true;
    lastKeyframeAt = 0;
    srcW = 0;
    srcH = 0;
    startedAt = Date.now();

    onStatus?.({
      codec: config.codec,
      width: config.width,
      height: config.height,
      direct: Boolean(window.MediaStreamTrackProcessor),
    });

    statsTimer = setInterval(() => {
      onStats?.({
        viewers,
        fps: frames,
        // A taxa que a captura está entregando de verdade. Quando ela está bem
        // acima da escolhida, é a tela que ignorou a restrição — e sem o freio
        // do encodeFrame seria esse o fator pelo qual a saída passaria do alvo.
        fpsEntrada: framesEntrada,
        mbps: (bytes * 8) / 1e6,
        seconds: Math.floor((Date.now() - startedAt) / 1000),
      });
      bytes = 0;
      frames = 0;
      framesEntrada = 0;
    }, 1000);

    pump(track);
    // Pedir áudio não garante receber: em vários sistemas a caixa "compartilhar
    // o som" fica desmarcada, e o navegador devolve a tela sem faixa de som.
    const audioTrack = prepararSom(track, stream);
    if (audioTrack) pumpAudio(audioTrack);

    return stream;
  }

  function capturarTela() {
    return navigator.mediaDevices.getDisplayMedia(opcoesCaptura());
  }

  /**
   * Câmera, sempre sem som.
   *
   * O microfone fica de fora de propósito: a voz já anda pela call do Discord,
   * com cancelamento de eco que aqui não existe. Somá-la devolveria a mesma
   * pessoa duas vezes, fora de sincronia — e o `prepararSom` nem chega a rodar,
   * porque sem faixa de áudio no stream ele retorna null.
   *
   * 720p de teto porque câmera não tem texto a preservar: acima disso é banda
   * gasta em ruído de sensor, e o teto de 1080p do `fitWithin` nem entra em
   * jogo.
   */
  function capturarCamera() {
    return navigator.mediaDevices.getUserMedia({
      video: {
        // `exact` de propósito: escolher uma câmera e receber outra porque a
        // pedida sumiu é pior que a falha, que ao menos diz o que houve.
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: fps, max: fps },
      },
      audio: false,
    });
  }

  /**
   * Restrições da captura de som.
   *
   * Os tratamentos de voz ficam desligados: existem para microfone e, em som de
   * aplicativo, cortam justamente o que se queria ouvir.
   *
   * restrictOwnAudio tira da captura o que esta própria página está tocando —
   * sem ele, quem transmite enquanto assiste a outra tela devolveria o som dela
   * de volta para a sala, em laço. É experimental, então vai sob detecção.
   */

  /**
   * Opções da captura de tela.
   *
   * `windowAudio` e `systemAudio` são membros de DisplayMediaStreamOptions —
   * irmãos de `audio` e `video`, não constraints. Dentro do objeto de `audio`,
   * que era onde `systemAudio` estava, os dois são ignorados em silêncio.
   *
   * O par pedido é sempre o mesmo, porque a superfície só se conhece depois da
   * escolha: escopar o som à janela e recusar a mistura do sistema. É o mesmo
   * veto do prepararSom, aplicado antes de o som existir — quem escolhe a tela
   * inteira volta sem faixa nenhuma, em vez de com uma que precisa ser morta.
   */
  const opcoesCaptura = (over) => opcoesTela({ fps, comSom: audio, ...over });

  /**
   * Dá para confiar no som que veio junto de uma janela?
   *
   * Não existe pergunta direta: opção de captura desconhecida é ignorada sem
   * erro, e `getSupportedConstraints` não lista `windowAudio` nem `systemAudio`
   * porque nenhum dos dois é constraint. `restrictOwnAudio` é, e é bem mais
   * nova que os dois — onde ela existe, a pilha de captura é atual o bastante
   * para obedecer ao `systemAudio: 'exclude'` que sempre pedimos. E se a
   * exclusão foi obedecida, uma faixa que chegou numa janela não pode ser a
   * mistura do sistema: só sobra o som daquela janela.
   *
   * Errar para menos custa o comportamento antigo, só aba. Errar para mais
   * devolveria a call em eco — por isso a prova é a feature mais nova das três,
   * e não a mais antiga.
   */
  function somDeJanelaConfiavel() {
    return Boolean(navigator.mediaDevices.getSupportedConstraints?.().restrictOwnAudio);
  }

  /**
   * Devolve a faixa de som, ou null quando ela traria a call de volta em eco.
   *
   * O nó: o som do sistema é capturado como uma mistura única. "Som da tela
   * inteira" é sempre "som do sistema INTEIRO", com a saída do Discord dentro —
   * e a call inteira se escuta, com atraso.
   *
   * Duas superfícies escapam disso. Aba, que sempre foi isolada por construção:
   * o som sai só dali e o Discord nunca entra. E janela, desde que o navegador
   * aceite escopar o som ao processo dela — é o que `windowAudio: 'window'`
   * pede em opcoesCaptura, e é o que destrava transmitir um jogo com o som do
   * jogo, que antes era impossível por aqui.
   *
   * Fora dessas duas a faixa morre aqui, antes de sair da máquina — e aí sim
   * acende o `somBloqueado`, porque veio som e ele foi barrado.
   *
   * Vir sem faixa nenhuma é silêncio, não erro: o som é sempre pedido, e é a
   * caixa "Compartilhar o áudio" do seletor que decide. Quem a deixou desmarcada
   * escolheu transmitir sem som, e avisar disso seria acusar a escolha.
   */
  function prepararSom(videoTrack, capturado) {
    if (!audio) return null;

    const faixa = capturado.getAudioTracks()[0];
    if (!faixa) return null;

    const superficie = videoTrack.getSettings?.().displaySurface;
    if (somIsolado(superficie)) {
      somBloqueado = false;
      return faixa;
    }

    faixa.stop();
    capturado.removeTrack(faixa);

    somBloqueado = true;
    onAviso?.(avisoSemSom(superficie));
    return null;
  }

  /** A superfície escolhida entrega som sem levar o Discord junto? */
  function somIsolado(superficie) {
    if (superficie === 'browser') return true;
    return superficie === 'window' && somDeJanelaConfiavel();
  }

  /** Por que o som que veio foi barrado, e por onde sair disso. */
  function avisoSemSom(superficie) {
    const saida = ' Ou use "Som de uma aba ou janela" para escolher a fonte.';

    // Janela só chega aqui quando o navegador não sabe escopar o som a ela.
    if (superficie === 'window') {
      return (
        'Este navegador não isola o som por janela, e o som do computador traria o Discord ' +
        'junto. Transmitindo sem som.' +
        saida
      );
    }
    if (superficie === 'monitor') {
      const comoLevar = somDeJanelaConfiavel()
        ? ' Compartilhe o jogo como janela para levar o som dele.'
        : '';
      return (
        'A tela inteira carrega o som do Discord junto, e a call se ouviria em eco. ' +
        'Transmitindo sem som.' +
        comoLevar +
        saida
      );
    }
    return 'Não deu para confirmar de onde vinha esse som, então ele foi removido.' + saida;
  }

  /**
   * Troca só a fonte do som, sem tocar no vídeo.
   *
   * É o que torna som e tela inteira compatíveis: o vídeo continua sendo a tela
   * escolhida e o som passa a vir de uma aba ou de uma janela, que são as
   * fontes isoladas. A segunda janela de escolha é o preço, e é um preço
   * honesto — o navegador não tem como adivinhar de qual aplicativo o som
   * deveria vir.
   */
  async function trocarSom() {
    // Precisa vir do gesto do usuário, como qualquer getDisplayMedia.
    const escolha = await navigator.mediaDevices.getDisplayMedia(
      opcoesCaptura({ video: true, comSom: true }),
    );

    const faixa = escolha.getAudioTracks()[0];
    const superficie = escolha.getVideoTracks()[0]?.getSettings?.().displaySurface;

    // O vídeo desta escolha não interessa: viemos só pelo som.
    escolha.getVideoTracks().forEach((t) => t.stop());

    if (!faixa) {
      escolha.getTracks().forEach((t) => t.stop());
      throw new Error(
        somDeJanelaConfiavel()
          ? 'Essa escolha veio sem som. Escolha uma aba ou a janela do aplicativo e marque "Compartilhar o áudio".'
          : 'Essa escolha veio sem som. Escolha uma aba e marque "Compartilhar o áudio da guia".',
      );
    }

    if (!somIsolado(superficie)) {
      faixa.stop();
      throw new Error(
        superficie === 'window'
          ? 'Este navegador não isola o som por janela. Escolha uma aba.'
          : 'Tela inteira traria o Discord junto e a call se ouviria. Escolha uma aba ou a janela do aplicativo.',
      );
    }

    // Encerra o laço anterior antes de abrir outro, senão os dois alimentam o
    // mesmo encoder e a fila estoura.
    await audioReader?.cancel().catch(() => {});
    audioReader = null;
    if (audioEncoder?.state === 'configured') {
      try {
        audioEncoder.close();
      } catch {
        // Fechar o que já se fechou sozinho lança; não há nada a desfazer.
      }
    }
    audioEncoder = null;

    somBloqueado = false;
    faixa.addEventListener('ended', () => onAviso?.('A fonte do som foi fechada.'));
    pumpAudio(faixa);
    return faixa;
  }

  // -------------------------------------------------------------------- áudio

  /**
   * Captura, codifica e envia o som.
   *
   * O AudioEncoder recebe os blocos no tamanho que o sistema entregar e devolve
   * pacotes Opus de 20 ms — não é preciso reagrupar nada por fora. Cada pacote
   * se decodifica sozinho, então não existe aqui o equivalente ao keyframe.
   */
  async function pumpAudio(track) {
    if (!window.AudioEncoder || !window.MediaStreamTrackProcessor) return;

    const s = track.getSettings();
    const sampleRate = s.sampleRate || 48_000;
    const numberOfChannels = Math.min(2, s.channelCount || 2);

    try {
      audioEncoder = new AudioEncoder({
        output: onAudioEncoded,
        // Som é acessório: se o encoder cair, a tela continua no ar.
        error: (err) => console.warn('[audio encoder]', err.message),
      });
      audioEncoder.configure({
        codec: 'opus',
        sampleRate,
        numberOfChannels,
        bitrate: AUDIO_BITRATE,
      });
    } catch (err) {
      console.warn('[audio encoder]', err.message);
      audioEncoder = null;
      return;
    }

    // O mesmo caminho do vídeo: quem chega depois recebe isto ao pedir a tela.
    ws?.send(
      JSON.stringify({
        type: 'audio-config',
        config: { codec: 'opus', sampleRate, numberOfChannels },
      }),
    );

    audioReader = new MediaStreamTrackProcessor({ track }).readable.getReader();
    while (running) {
      let dados;
      try {
        const { done, value } = await audioReader.read();
        if (done) break;
        dados = value;
      } catch {
        break;
      }

      if (audioEncoder?.state === 'configured') {
        try {
          audioEncoder.encode(dados);
        } catch (err) {
          console.warn('[audio encode]', err.message);
        }
      }
      dados.close();
    }
  }

  function onAudioEncoded(chunk) {
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    const buf = empacotar(TIPO_AUDIO, chunk.timestamp ?? 0, data);
    bytes += buf.byteLength;
    if (enviarChunks && ws?.readyState === WebSocket.OPEN) ws.send(buf);
    enviarPorCanais(buf);
  }

  async function pickConfig(width, height) {
    // O codec por fora, as opções por dentro. A ordem é a decisão inteira desta
    // função, e inverter os laços custou caro uma vez: com as opções por fora,
    // um H.264 que recusasse `bitrateMode` perdia para um VP8 que o aceitasse —
    // e VP8 em 1080p não tem encoder por hardware em máquina nenhuma comum.
    // Trocar o chip de vídeo pela CPU para não abrir mão de uma opção de
    // bitrate derruba a taxa de quadros pela metade. Degrada-se a opção antes
    // de degradar o codec.
    //
    // Dentro de um codec, `latencyMode` vem antes de `bitrateMode` porque
    // atraso é o que este programa existe para não ter; o teto de bitrate é o
    // segundo prêmio.
    //
    // `bitrateMode: 'constant'` ainda importa. O padrão é `variable`, e em VBR
    // o controlador de taxa trata o `bitrate` como média de longo prazo — numa
    // troca de cena ele estoura o alvo com folga, e a rajada é justamente o que
    // entope o relay. Constante troca qualidade em cena difícil por um teto que
    // se cumpre.
    for (const candidate of candidatos(width, height, fps)) {
      for (const realtime of [true, false]) {
        for (const constante of [true, false]) {
          const cfg = { ...candidate, width, height, bitrate, framerate: fps };
          if (realtime) cfg.latencyMode = 'realtime';
          if (constante) cfg.bitrateMode = 'constant';
          try {
            const { supported } = await VideoEncoder.isConfigSupported(cfg);
            if (supported) return cfg;
          } catch {
            // candidato inválido neste navegador; tenta o próximo
          }
        }
      }
    }
    return null;
  }

  // ------------------------------------------------------------------ captura

  function pump(track) {
    if (window.MediaStreamTrackProcessor) pumpDirect(track);
    else pumpViaVideo();
  }

  /** Chromium: acesso direto aos quadros, sem cópia intermediária. */
  async function pumpDirect(track) {
    reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
    while (running) {
      let frame;
      try {
        const { done, value } = await reader.read();
        if (done) break;
        frame = value;
      } catch {
        break;
      }
      if (!encodeFrame(frame)) break;
    }
  }

  /** Demais navegadores: extrai os quadros de um <video> alimentado pela stream. */
  function pumpViaVideo() {
    video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    // Fora do fluxo mas no DOM: alguns navegadores não decodificam um elemento
    // solto, e display:none chega a pausar a reprodução.
    Object.assign(video.style, {
      position: 'fixed',
      left: '-9999px',
      width: '2px',
      height: '2px',
      opacity: '0',
    });
    document.body.append(video);
    video.play().catch(() => {});

    const t0 = performance.now();
    const hasRvfc = typeof video.requestVideoFrameCallback === 'function';
    const minGap = 1000 / (fps + 2);
    let lastAt = 0;

    const schedule = () => {
      if (!running) return;
      if (hasRvfc) video.requestVideoFrameCallback(tick);
      else requestAnimationFrame(tick);
    };

    const tick = () => {
      if (!running) return;
      // Alguns navegadores pausam ao trocar de aba; sem isso o loop morre em
      // silêncio e a transmissão congela sem erro nenhum.
      if (video.paused) video.play().catch(() => {});
      if (video.readyState < 2 || !video.videoWidth) return schedule();

      const now = performance.now();
      // rAF segue o refresh da tela, que pode ser bem acima do fps alvo.
      if (!hasRvfc && now - lastAt < minGap) return schedule();
      lastAt = now;

      let frame;
      try {
        frame = new VideoFrame(video, { timestamp: (now - t0) * 1000 });
      } catch {
        return schedule();
      }
      encodeFrame(frame);
      schedule();
    };

    schedule();
  }

  function encodeFrame(frame) {
    if (!running || encoder?.state !== 'configured') {
      frame.close();
      return false;
    }

    // Ninguém consumindo em lugar nenhum — nem relay, nem canal direto aberto:
    // este quadro não tem para onde ir. Codificá-lo assim mesmo gastaria CPU
    // e, pior, subida — que é o recurso que as conexões diretas disputam. Volta
    // sozinho no instante que alguém precisar de qualquer um dos caminhos.
    if (!enviarChunks && configEnviada && !temCanalAberto()) {
      frame.close();
      return true;
    }
    framesEntrada++;

    // Backpressure com histerese: entra em apuros com a fila acima de 2 e só
    // sai quando ela desce a 1.
    //
    // A histerese é o que separa uma taxa menor de uma taxa que balança. Com a
    // carga exatamente em cima do limite — que é onde 60 fps quase sempre fica
    // — um limiar seco faz o encoder aceitar, atrasar, descartar, alcançar e
    // aceitar de novo, a cada quadro. Não se vê "menos quadros", vê-se tranco.
    // Trinta firmes são melhores que quarenta e cinco tremendo.
    //
    // Vem antes do ritmo de propósito: quadro que o encoder não tem como
    // receber não pode consumir uma marca da grade. Era esse detalhe que fazia
    // o descarte por fila mexer na régua do ritmo e derrubar a taxa junto.
    if (encoder.encodeQueueSize > (afogado ? 1 : 2)) {
      afogado = true;
      frame.close();
      return true;
    }
    afogado = false;

    // Ritmo, medido contra uma grade ideal — e não contra o último aceito.
    //
    // O encoder foi configurado para uma taxa e é por ela que reparte os bits:
    // cada quadro recebe mais ou menos `bitrate / framerate`. Entregar mais
    // depressa que o combinado não faz ele comprimir mais, faz ele emitir mais
    // quadros do mesmo tamanho, e a saída passa do alvo pelo fator exato do
    // excesso. Uma tela de 144 Hz codificada a 30 fps manda quase cinco vezes o
    // que foi pedido. A restrição `frameRate` da captura deveria segurar isso,
    // mas ela é um pedido: `getDisplayMedia` a atende quando quer, e
    // `applyConstraints` numa faixa de tela viva quase nunca.
    //
    // Medir contra o último aceito parece a mesma coisa e não é. Um quadro que
    // chega atrasado leva a régua junto: o seguinte passa a ser cobrado a
    // partir do atraso dele, o próximo a partir daquele, e a taxa escorrega
    // para baixo sozinha, sem que nada tenha piorado. Contra a grade, atraso de
    // um quadro é atraso de um quadro só.
    const passo = 1000 / fps;
    const tsMs = (frame.timestamp ?? 0) / 1000;

    if (proximaMarca === null || tsMs < proximaMarca - passo * GRADE_PERDIDA) {
      proximaMarca = tsMs;
    }
    if (tsMs < proximaMarca - passo * TOLERANCIA_GRADE) {
      frame.close();
      return true;
    }

    proximaMarca += passo;
    // A origem entrega mais devagar que o alvo: a grade não tem por que correr
    // atrás de marcas que já passaram e que nenhum quadro vai preencher.
    if (proximaMarca < tsMs) proximaMarca = tsMs + passo;

    const timestamp = frame.timestamp ?? performance.now() * 1000;
    syncSize(frame);

    const now = Date.now();
    if (now - lastKeyframeAt > KEYFRAME_EVERY_MS) wantKeyframe = true;

    let out = frame;
    if (stage) {
      stageCtx.drawImage(frame, 0, 0, stage.width, stage.height);
      frame.close();
      out = new VideoFrame(stage, { timestamp });
    }

    try {
      encoder.encode(out, { keyFrame: wantKeyframe });
      if (wantKeyframe) {
        lastKeyframeAt = now;
        wantKeyframe = false;
      }
    } catch (err) {
      console.error('[encode]', err);
    }

    out.close();
    frames++;
    return true;
  }

  /**
   * Mantém o encoder casado com o tamanho real da fonte.
   *
   * displayWidth/Height e não codedWidth/Height: o codificado inclui padding de
   * alinhamento do codec, e configurar o encoder por ele faz recortar as bordas.
   */
  function syncSize(frame) {
    const sw = frame.displayWidth;
    const sh = frame.displayHeight;
    if (!sw || !sh || (sw === srcW && sh === srcH)) return;

    srcW = sw;
    srcH = sh;
    const target = fitWithin(sw, sh);

    if (target.width !== config.width || target.height !== config.height) {
      // O nível acompanha o tamanho. Uma janela de 720p que vira 1080p no meio
      // da transmissão passa a precisar de um nível acima, e reconfigurar com o
      // antigo é pedir um quadro que não cabe no contrato — exatamente o erro
      // que fazia a tela cair para VP8, agora com a transmissão no ar.
      const anterior = config;
      config = {
        ...config,
        ...target,
        codec: comNivel(config.codec, nivelH264(target.width, target.height, fps)),
      };

      try {
        encoder.configure(config);
      } catch (err) {
        // Nível novo recusado: seguir com o tamanho velho entrega imagem
        // esticada, mas entrega. Parar aqui não entregaria nada.
        console.warn('[encoder] nivel recusado, mantendo a configuracao anterior:', err.message);
        config = anterior;
        return;
      }
      wantKeyframe = true;
      onStatus?.({
        codec: config.codec,
        width: config.width,
        height: config.height,
        direct: Boolean(window.MediaStreamTrackProcessor),
      });
    }

    // fitWithin preserva a proporção, então reduzir não corta nada.
    if (target.width === sw && target.height === sh) {
      stage = null;
      stageCtx = null;
    } else {
      stage = document.createElement('canvas');
      stage.width = target.width;
      stage.height = target.height;
      stageCtx = stage.getContext('2d', { alpha: false, desynchronized: true });
    }
  }

  function onEncoded(chunk, metadata) {
    // O decoderConfig chega no primeiro chunk e sempre que a config muda — e
    // só pelo relay: quem assiste monta o decoder com a config que veio pelo
    // WebSocket ao pedir a tela, antes de o canal direto existir.
    if (metadata?.decoderConfig) {
      configEnviada = true;
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'config', config: serializeConfig(metadata.decoderConfig) }));
      }
    }

    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);

    const buf = empacotar(
      chunk.type === 'key' ? TIPO_KEYFRAME : TIPO_DELTA,
      chunk.timestamp ?? 0,
      data,
    );
    bytes += buf.byteLength;
    // O relay é um dos destinos, não o único. Subir para ele é opcional — o
    // servidor avisa quando ninguém mais precisa; o espelho para os canais é o
    // que alimenta quem está neles.
    if (enviarChunks && ws?.readyState === WebSocket.OPEN) ws.send(buf);
    enviarPorCanais(buf);
  }

  /**
   * Espelha um pacote já empacotado para todos os canais diretos abertos.
   *
   * O mesmo buffer do relay, sem transformação nenhuma: quem recebe monta o
   * decoder exatamente como receberia pelo WebSocket.
   */
  function enviarPorCanais(buf) {
    for (const { canal } of peers.values()) {
      if (canal.readyState !== 'open') continue;
      if (canal.bufferedAmount > MAX_CANAL_BYTES) continue;
      canal.send(buf);
    }
  }

  /** Existe algum espectador consumindo os quadros por canal direto agora? */
  function temCanalAberto() {
    for (const { canal } of peers.values()) {
      if (canal.readyState === 'open') return true;
    }
    return false;
  }

  /**
   * [1B slot][1B tipo][8B timestamp][8B relógio de envio][payload]
   *
   * O slot vem carimbado na origem para o servidor repassar o buffer intacto, e
   * o relógio de envio é o que permite medir o atraso do outro lado. Áudio e
   * vídeo compartilham o formato: o tipo é a única coisa que os distingue.
   */
  function empacotar(tipo, timestamp, data) {
    const buf = new ArrayBuffer(18 + data.byteLength);
    const view = new DataView(buf);
    view.setUint8(0, mySlot);
    view.setUint8(1, tipo);
    view.setFloat64(2, timestamp);
    view.setFloat64(10, Date.now());
    new Uint8Array(buf, 18).set(data);
    return buf;
  }

  function serializeConfig(dc) {
    const out = { codec: dc.codec, codedWidth: dc.codedWidth, codedHeight: dc.codedHeight };
    if (dc.description) {
      const b = new Uint8Array(
        dc.description instanceof ArrayBuffer ? dc.description : dc.description.buffer,
      );
      let bin = '';
      for (const x of b) bin += String.fromCharCode(x);
      out.description = btoa(bin);
    }
    return out;
  }

  // ---------------------------------------------------------------- websocket

  function connect() {
    return new Promise((resolve, reject) => {
      ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';

      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('Não foi possível falar com o servidor (timeout).'));
      }, 10_000);

      ws.addEventListener('open', () => {
        clearTimeout(timeout);
        resolve();
      });

      ws.addEventListener('message', (e) => {
        if (typeof e.data !== 'string') return;
        const msg = JSON.parse(e.data);

        if (msg.type === 'slot') mySlot = msg.slot;
        else if (msg.type === 'state') viewers = msg.viewers;
        // Alguém entrou na sala e precisa de um ponto de partida.
        else if (msg.type === 'need-keyframe') wantKeyframe = true;
        else if (msg.type === 'rtc-want') abrirPeer(msg.peer);
        else if (msg.type === 'rtc') receberRtc(msg.peer, msg.payload);
        else if (msg.type === 'rtc-bye') fecharPeer(msg.peer);
        // Ninguém mais depende do relay para esta transmissão (ou voltou a
        // depender). Ver a nota em encodeFrame.
        else if (msg.type === 'chunks') enviarChunks = msg.on !== false;
        else if (msg.type === 'stop-request')
          stop(msg.motivo ?? 'Transmissão encerrada pela atividade.');
        else if (msg.type === 'error') {
          if (running) stop(msg.message);
          else {
            clearTimeout(timeout);
            reject(new Error(msg.message));
          }
        }
      });

      ws.addEventListener('error', () => {
        clearTimeout(timeout);
        reject(new Error('Falha ao conectar no servidor.'));
      });

      ws.addEventListener('close', () => {
        clearTimeout(timeout);
        if (running) stop('Conexão com o servidor caiu.');
      });
    });
  }

  // -------------------------------------------------------------------- parar

  // ------------------------------------------------------------ ao vivo

  // ------------------------------------------------------------------ WebRTC

  function enviarRtc(peerId, payload) {
    if (ws?.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'rtc', peer: peerId, payload }));
  }

  /**
   * Abre a conexão direta com um espectador e manda a oferta.
   *
   * O canal de dados nasce antes da oferta: é ele que cria a seção de
   * aplicação no SDP, e uma negociação única basta. Este lado oferece porque é
   * ele quem cria o canal — a direção dos dados não decide quem oferece.
   */
  async function abrirPeer(peerId) {
    if (!peerId || !suportaWebRTC() || peers.has(peerId)) return;

    try {
      const ice = await iceServers(apiBase);
      // O await acima é longo o bastante para a transmissão ter acabado.
      if (!running || peers.has(peerId)) return;

      const pc = criarPeer({
        ice,
        onIce: (candidate) => enviarRtc(peerId, { kind: 'ice', candidate }),
        onEstado: (estado) => {
          if (MORTO.has(estado)) fecharPeer(peerId);
        },
      });

      const canal = pc.createDataChannel('quadros', CANAL_OPTS);
      canal.binaryType = 'arraybuffer';
      peers.set(peerId, { pc, canal });

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      enviarRtc(peerId, { kind: 'offer', sdp: pc.localDescription });
    } catch (err) {
      console.warn('[rtc] oferta falhou:', err.message);
      fecharPeer(peerId);
    }
  }

  async function receberRtc(peerId, payload) {
    const peer = peers.get(peerId);
    if (!peer || !payload) return;

    try {
      if (payload.kind === 'answer' && payload.sdp) {
        await peer.pc.setRemoteDescription(payload.sdp);
      } else if (payload.kind === 'ice' && payload.candidate) {
        await peer.pc.addIceCandidate(payload.candidate);
      } else if (payload.kind === 'need-keyframe') {
        // O decoder do espectador está frio ou quebrou: o próximo quadro sai
        // completo, e chega por qualquer um dos caminhos que ele estiver usando.
        wantKeyframe = true;
      }
    } catch (err) {
      // Candidato que chega antes da descrição remota é normal e recuperável;
      // derrubar a conexão por causa dele custaria uma renegociação inteira.
      console.warn('[rtc]', err.message);
    }
  }

  function fecharPeer(peerId) {
    const peer = peers.get(peerId);
    if (!peer) return;
    peers.delete(peerId);
    try {
      peer.pc.close();
    } catch {
      // Fechar o que já se fechou lança e não há nada a desfazer. Fechar o pc
      // fecha os canais dele junto — não há mais nada a encerrar aqui.
    }
  }

  function fecharPeers() {
    for (const peerId of [...peers.keys()]) fecharPeer(peerId);
    enviarChunks = true;
  }

  /**
   * Troca a tela compartilhada sem derrubar a transmissão.
   *
   * A conexão, o encoder e o slot continuam os mesmos — quem assiste só vê a
   * imagem mudar, sem piscar nem reconectar. As conexões diretas não precisam
   * saber de nada: os quadros novos saem do mesmo encoder para os mesmos
   * canais, venham da fonte que vierem.
   */
  async function changeScreen() {
    // Precisa vir do gesto do usuário, como qualquer getDisplayMedia.
    const fresh = await navigator.mediaDevices.getDisplayMedia(opcoesCaptura());

    const previous = stream;
    const previousReader = reader;

    stream = fresh;
    const track = fresh.getVideoTracks()[0];
    track.contentHint = 'text';
    track.addEventListener('ended', () => stop('Você parou o compartilhamento pelo navegador.'));

    // Encerra o loop anterior antes de abrir outro, senão os dois disputam o
    // encoder e a fila estoura.
    reader = null;
    await previousReader?.cancel().catch(() => {});
    previous?.getTracks().forEach((t) => t.stop());

    // Zera o tamanho conhecido: a tela nova quase certamente tem outro, e é o
    // syncSize que reconfigura o encoder.
    srcW = 0;
    srcH = 0;
    wantKeyframe = true;
    // A tela nova traz o próprio relógio de captura: cobrar da grade antiga
    // derrubaria quadros por uma diferença que não significa nada.
    proximaMarca = null;
    afogado = false;

    if (video) {
      video.srcObject = fresh;
      video.play().catch(() => {});
    } else {
      pumpDirect(track);
    }

    // A tela nova traz a própria faixa de som; a antiga morreu com o stream.
    await audioReader?.cancel().catch(() => {});
    audioReader = null;
    const novoAudio = prepararSom(track, fresh);
    if (novoAudio && audioEncoder) pumpAudio(novoAudio);

    return fresh;
  }

  /** Ajusta qualidade e taxa de quadros com a transmissão no ar. */
  function setQuality({ bitrate: nextBitrate, fps: nextFps } = {}) {
    if (nextBitrate) bitrate = nextBitrate;
    // Taxa nova, grade nova: o freio do encodeFrame mede contra a taxa atual, e
    // subir de 15 para 60 fps precisa valer já no próximo quadro.
    if (nextFps && nextFps !== fps) {
      fps = nextFps;
      proximaMarca = null;
      afogado = false;
    }
    if (encoder?.state !== 'configured') return;

    config = { ...config, bitrate, framerate: fps };
    encoder.configure(config);
    wantKeyframe = true;

    // Pedir a taxa nova à própria captura evita gastar CPU codificando quadros
    // que seriam descartados adiante.
    stream
      ?.getVideoTracks()[0]
      ?.applyConstraints({ frameRate: { ideal: fps, max: fps } })
      .catch(() => {});
  }

  const getSettings = () => ({ bitrate, fps });

  function cleanup() {
    fecharPeers();
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    video?.remove();
    video = null;
    stage = null;
    stageCtx = null;
  }

  function stop(reason) {
    const wasRunning = running;
    running = false;

    clearInterval(statsTimer);
    statsTimer = null;

    reader?.cancel().catch(() => {});
    reader = null;
    audioReader?.cancel().catch(() => {});
    audioReader = null;

    for (const e of [encoder, audioEncoder]) {
      if (e?.state === 'configured') {
        try {
          e.close();
        } catch {
          // Fechar o que já se fechou sozinho lança; não há nada a desfazer.
        }
      }
    }
    encoder = null;
    audioEncoder = null;

    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'stop' }));
      ws.close();
    }
    ws = null;

    cleanup();
    if (wasRunning) onEnd?.(reason ?? '');
  }

  return {
    start,
    stop,
    changeScreen,
    trocarSom,
    setQuality,
    getSettings,
    temSom: () => Boolean(audioEncoder),
    somBloqueado: () => somBloqueado,
    isRunning: () => running,
  };
}
