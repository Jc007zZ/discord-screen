/**
 * Pipeline de transmissão: captura → codifica → envia.
 *
 * Módulo compartilhado entre a Activity (captura dentro do modal, quando o
 * Discord permite) e a página de captura externa (quando não permite). Uma
 * implementação só — duas cópias divergiriam na primeira correção.
 *
 * Sem WebRTC porque a Activity não tem, e sem MediaRecorder porque o container
 * impõe piso de latência. WebCodecs codifica quadro a quadro e envia direto.
 */

// H264 costuma ter encoder por hardware; VP8 quase sempre cai em software, que
// a 1080p derruba o framerate. Por isso as duas variantes de H264 vêm antes:
// annexb dispensa o blob `description`, e avcC é aceito onde annexb não é.
const CANDIDATES = [
  { codec: 'avc1.42E01E', avc: { format: 'annexb' } },
  { codec: 'avc1.42E01E' },
  { codec: 'vp8' },
  { codec: 'vp09.00.10.08' },
];

// Keyframe periódico: seguro barato para quem reconecta fora do fluxo normal.
const KEYFRAME_EVERY_MS = 3000;

// Tipos do primeiro byte útil de cada pacote. O áudio anda pelo mesmo socket e
// pelo mesmo cabeçalho do vídeo: um canal só, um formato só, e o servidor
// continua repassando o buffer sem precisar abrir nada.
const TIPO_KEYFRAME = 1;
const TIPO_DELTA = 2;
const TIPO_AUDIO = 3;

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
  // Configuração emitida pelo encoder para inicializar o decoder remoto. Ela
  // precisa sobreviver ao primeiro envio para atender espectadores atrasados.
  let decoderConfig = null;
  let stage = null;
  let stageCtx = null;

  let running = false;
  let mySlot = 0;
  let wantKeyframe = true;
  let lastKeyframeAt = 0;
  let srcW = 0;
  let srcH = 0;
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
        mbps: (bytes * 8) / 1e6,
        seconds: Math.floor((Date.now() - startedAt) / 1000),
      });
      bytes = 0;
      frames = 0;
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
    if (ws?.readyState !== WebSocket.OPEN) return;

    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    ws.send(empacotar(TIPO_AUDIO, chunk.timestamp ?? 0, data));
    bytes += 18 + data.byteLength;
  }

  async function pickConfig(width, height) {
    // Duas passadas: navegadores que não conhecem `latencyMode` podem recusar a
    // configuração inteira por causa dela. Mais latência é melhor que nada.
    for (const realtime of [true, false]) {
      for (const candidate of CANDIDATES) {
        const cfg = { ...candidate, width, height, bitrate, framerate: fps };
        if (realtime) cfg.latencyMode = 'realtime';
        try {
          const { supported } = await VideoEncoder.isConfigSupported(cfg);
          if (supported) return cfg;
        } catch {
          // candidato inválido neste navegador; tenta o próximo
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
    // Backpressure: fila no encoder vira latência que nunca mais sai.
    if (encoder.encodeQueueSize > 2) {
      frame.close();
      return true;
    }

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
      config = { ...config, ...target };
      encoder.configure(config);
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
    if (ws?.readyState !== WebSocket.OPEN) return;

    // O decoderConfig chega no primeiro chunk e sempre que a config muda.
    if (metadata?.decoderConfig) {
      decoderConfig = serializeConfig(metadata.decoderConfig);
      ws.send(JSON.stringify({ type: 'config', config: decoderConfig }));
    }

    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);

    const buf = empacotar(
      chunk.type === 'key' ? TIPO_KEYFRAME : TIPO_DELTA,
      chunk.timestamp ?? 0,
      data,
    );
    ws.send(buf);
    bytes += buf.byteLength;
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
        // O servidor ainda não tinha a configuração quando o espectador pediu
        // a live. Reenviar a última evita uma transmissão sem decoder.
        else if (msg.type === 'need-config' && decoderConfig) {
          ws.send(JSON.stringify({ type: 'config', config: decoderConfig }));
        }
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

  /**
   * Troca a tela compartilhada sem derrubar a transmissão.
   *
   * A conexão, o encoder e o slot continuam os mesmos — quem assiste só vê a
   * imagem mudar, sem piscar nem reconectar.
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
    if (nextFps) fps = nextFps;
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
