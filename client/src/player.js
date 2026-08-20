/**
 * Player WebCodecs.
 *
 * Dentro da Activity não existe WebRTC, mas WebCodecs não é bloqueado por
 * Permissions Policy — então dá para decodificar quadro a quadro e desenhar
 * num canvas, sem passar por container nem por MediaSource.
 *
 * O canvas mantém SEMPRE o tamanho nativo do vídeo no buffer interno
 * (canvas.width/height). Isso dá a ele uma proporção intrínseca, e o CSS
 * apenas o limita com max-width/max-height — o navegador então reduz
 * preservando a proporção, por construção.
 *
 * Dimensionar o buffer pelo tamanho de exibição, como cheguei a tentar, faz a
 * proporção do vídeo passar a depender do formato do container e distorce a
 * imagem durante o redimensionamento.
 */

export function createPlayer(canvas, { onError, onTamanho } = {}) {
  const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });

  let decoder = null;
  let needKeyframe = true;
  let lastLagMs = 0;
  let framesDrawn = 0;
  let telemetry = null;
  let counters = { received: 0, decoded: 0, dropped: 0 };
  // Quem espera precisa saber quando a espera acabou: entre pedir para assistir
  // e o primeiro quadro cabe um keyframe inteiro de atraso, e o canvas preto
  // desse intervalo é idêntico a um travamento.
  let virgem = true;

  function start(rawConfig) {
    stop();

    if (!window.VideoDecoder) {
      onError?.('Este navegador não tem WebCodecs — não é possível assistir.');
      return false;
    }

    const config = deserialize(rawConfig);

    decoder = new VideoDecoder({
      output: draw,
      error: (err) => {
        // Erro de decodificação normalmente é fluxo fora de sincronia:
        // pedir um keyframe recupera sem derrubar a sessão.
        console.warn('[decoder]', err.message);
        needKeyframe = true;
        counters.dropped++;
      },
    });

    try {
      decoder.configure(config);
    } catch {
      onError?.(`Codec não suportado por este navegador: ${config.codec}`);
      decoder = null;
      return false;
    }

    needKeyframe = true;
    counters = { received: 0, decoded: 0, dropped: 0 };
    return true;
  }

  /** Quadro empacotado: [1B slot][1B tipo][8B timestamp][8B envio][payload] */
  function push(buffer) {
    if (!decoder || decoder.state !== 'configured') return;

    const view = new DataView(buffer);
    const isKeyframe = view.getUint8(1) === 1;

    // Decoder frio só aceita keyframe; deltas antes disso viram erro.
    if (needKeyframe && !isKeyframe) {
      counters.dropped++;
      return;
    }

    const timestamp = view.getFloat64(2);
    const sentAt = view.getFloat64(10);
    lastLagMs = Date.now() - sentAt;
    counters.received++;

    try {
      decoder.decode(
        new EncodedVideoChunk({
          type: isKeyframe ? 'key' : 'delta',
          timestamp,
          data: new Uint8Array(buffer, 18),
        }),
      );
      needKeyframe = false;
    } catch (err) {
      console.warn('[decode]', err.message);
      needKeyframe = true;
      counters.dropped++;
    }
  }

  function draw(frame) {
    // Buffer no tamanho nativo do vídeo: é isso que define a proporção
    // intrínseca do elemento, e é o que impede o CSS de distorcer.
    let mudou = false;
    if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
      canvas.width = frame.displayWidth;
      canvas.height = frame.displayHeight;
      mudou = true;
    }

    ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);

    // VideoFrame segura memória de GPU; sem close() a aba trava em segundos.
    frame.close();
    framesDrawn++;
    counters.decoded++;

    // Avisa no primeiro quadro e sempre que a resolução muda: quem desenha o
    // palco precisa das duas coisas — tirar o "conectando" e refazer a forma.
    if (virgem || mudou) {
      virgem = false;
      onTamanho?.();
    }
  }

  function stop() {
    if (decoder && decoder.state !== 'closed') {
      try {
        decoder.close();
      } catch {
        // Fechar o que já se fechou sozinho lança; não há nada a desfazer.
      }
    }
    decoder = null;
    needKeyframe = true;
    lastLagMs = 0;
    if (canvas.width && canvas.height) {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
  }

  /** Atraso aproximado em ms. Exato na mesma máquina; entre máquinas, sujeito a desvio de relógio. */
  const getLag = () => lastLagMs;

  /** Resolução nativa do vídeo e tamanho de exibição — para diagnóstico. */
  function getSizes() {
    const rect = canvas.getBoundingClientRect();
    return {
      video: `${canvas.width}×${canvas.height}`,
      box: `${Math.round(rect.width)}×${Math.round(rect.height)}`,
    };
  }

  function takeFrameCount() {
    const n = framesDrawn;
    framesDrawn = 0;
    return n;
  }

  /** Retorna e reinicia a janela de telemetria real do espectador. */
  function takeTelemetry(dt = 1) {
    const sample = {
      receivedFps: dt > 0 ? Math.round(counters.received / dt) : 0,
      decodedFps: dt > 0 ? Math.round(counters.decoded / dt) : 0,
      renderedFps: takeFrameCount(),
      decodeQueueSize: decoder?.decodeQueueSize ?? 0,
      droppedFrames: counters.dropped,
      estimatedLatencyMs: Math.max(0, Math.round(lastLagMs)),
    };
    counters = { received: 0, decoded: 0, dropped: 0 };
    telemetry = sample;
    return sample;
  }

  const getTelemetry = () => telemetry;

  return { start, push, stop, getLag, takeFrameCount, takeTelemetry, getTelemetry, getSizes };
}

function deserialize(c) {
  const out = {
    codec: c.codec,
    codedWidth: c.codedWidth,
    codedHeight: c.codedHeight,
    // Reduz o buffering interno do decoder — sem isso ele acumula alguns
    // quadros antes de emitir o primeiro.
    optimizeForLatency: true,
  };

  if (c.description) {
    const bin = atob(c.description);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    out.description = bytes;
  }

  return out;
}
