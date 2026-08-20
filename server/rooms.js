/**
 * Registro e relay de salas.
 *
 * Salas são criadas explicitamente por alguém e vivem em memória. Cada uma
 * pertence a uma instância da Activity (o canal de voz), então canais
 * diferentes não enxergam as salas uns dos outros.
 *
 * Vários transmissores simultâneos por sala; N espectadores. Cada transmissor
 * recebe um "slot" numérico e carimba esse número no primeiro byte de todo
 * quadro, então o servidor repassa o buffer sem tocar nele e o espectador sabe
 * para qual decoder mandar.
 *
 * O servidor não decodifica nada. Ele guarda o decoderConfig de cada
 * transmissor e distingue keyframe de delta, porque quem começa a assistir
 * precisa de um keyframe: delta em decoder frio só dá erro.
 */
import crypto from 'node:crypto';

const MAX_BROADCASTERS = 4;
// Duas por pessoa: a tela e a câmera. O teto da sala continua valendo por cima,
// então duas pessoas com as duas fontes já lotam.
const MAX_POR_PESSOA = 2;

/** As fontes que uma transmissão pode ter. */
export const FONTES = new Set(['tela', 'camera']);
// Sala é objeto em memória criado por qualquer pessoa autenticada: sem teto,
// um laço de "criar sala" consome a RAM do processo.
const MAX_ROOMS_PER_INSTANCE = 20;
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;
const MAX_NAME = 32;
const MAX_ROOM_NAME = 40;

// Sala vazia fecha, mas não no mesmo instante: recarregar a atividade
// desconecta e reconecta, e quem estivesse sozinho perderia a sala a cada F5.
// 12s cobre um reload com folga e some rápido o bastante para não deixar sala
// fantasma na lista.
const EMPTY_GRACE_MS = 12 * 1000;
// Quanto tempo a transmissão de alguém sobrevive à saída dessa pessoa da sala.
// Existe pelo mesmo motivo da carência acima: recarregar a atividade desconecta
// e reconecta, e sem ela um F5 derrubaria a transmissão de quem não saiu de
// lugar nenhum.
const SEM_PRESENCA_MS = 15 * 1000;
const SWEEP_EVERY_MS = 4 * 1000;

// Freio de força bruta: sem isso uma senha curta cai em segundos, porque o
// endpoint responde tão rápido quanto a rede permite.
const MAX_ATTEMPTS = 5;
const ATTEMPT_WINDOW_MS = 60 * 1000;
const LOCKOUT_MS = 30 * 1000;

const SLOT_BYTE = 0;
const TYPE_BYTE = 1;
const KEYFRAME = 1;
const AUDIO = 3;

const rooms = new Map();

// Contadores do payload de midia que realmente atravessa o relay. Eles nao
// incluem os poucos bytes de cabecalho TCP/TLS/WebSocket, mas refletem a parte
// que cresce com bitrate e quantidade de espectadores.
const appTraffic = trafficCounter();

function trafficCounter() {
  return {
    startedAt: Date.now(),
    receivedBytes: 0,
    transmittedBytes: 0,
    droppedBytes: 0,
    buckets: new Map(),
    lastPrunedSecond: 0,
  };
}

function recordTraffic(counter, direction, bytes) {
  if (!counter || !Number.isFinite(bytes) || bytes <= 0) return;
  const second = Math.floor(Date.now() / 1000);
  let bucket = counter.buckets.get(second);
  if (!bucket) {
    bucket = { receivedBytes: 0, transmittedBytes: 0, droppedBytes: 0 };
    counter.buckets.set(second, bucket);
  }

  counter[direction] += bytes;
  bucket[direction] += bytes;

  // Um stream pode entregar centenas de chunks por segundo. A limpeza roda no
  // maximo uma vez por segundo por contador, nunca uma vez por chunk.
  if (counter.lastPrunedSecond !== second) {
    counter.lastPrunedSecond = second;
    for (const key of counter.buckets.keys()) {
      if (key < second - 60) counter.buckets.delete(key);
    }
  }
}

function trafficSnapshot(counter, windowSeconds = 5) {
  if (!counter) {
    return {
      receivedBytes: 0,
      transmittedBytes: 0,
      droppedBytes: 0,
      receivedBytesPerSecond: 0,
      transmittedBytesPerSecond: 0,
    };
  }

  const now = Date.now();
  const currentSecond = Math.floor(now / 1000);
  const firstSecond = currentSecond - windowSeconds + 1;
  let receivedBytes = 0;
  let transmittedBytes = 0;
  let droppedBytes = 0;

  for (const [second, bucket] of counter.buckets) {
    if (second < firstSecond) continue;
    receivedBytes += bucket.receivedBytes;
    transmittedBytes += bucket.transmittedBytes;
    droppedBytes += bucket.droppedBytes;
  }

  const actualWindow = Math.max(1, Math.min(windowSeconds, (now - counter.startedAt) / 1000));
  return {
    receivedBytes: counter.receivedBytes,
    transmittedBytes: counter.transmittedBytes,
    droppedBytes: counter.droppedBytes,
    receivedBytesPerSecond: receivedBytes / actualWindow,
    transmittedBytesPerSecond: transmittedBytes / actualWindow,
    droppedBytesPerSecond: droppedBytes / actualWindow,
  };
}

// Uma pessoa pode ter duas transmissões ao mesmo tempo, então o uid sozinho não
// identifica mais uma delas. A chave composta mantém o acesso direto que o
// registro sempre teve, sem virar um Map de Maps.
const chaveDe = (uid, fonte) => `${uid}|${fonte}`;

/** As transmissões de uma pessoa, de uma fonte só quando `fonte` vem. */
export function broadcastersOf(room, userId, fonte = null) {
  return [...room.broadcasters.values()].filter(
    (e) => e.info.id === userId && (!fonte || e.fonte === fonte),
  );
}

const transmitindo = (room, userId) => broadcastersOf(room, userId).length > 0;

/**
 * A pessoa está na sala, e não só transmitindo para ela.
 *
 * A aba de captura não conta: ela tem conexão própria e continua de pé depois
 * que a atividade fecha, que é justamente o caso a detectar.
 */
function temViewer(room, userId) {
  for (const v of room.viewers) if (v.__info?.id === userId) return true;
  return false;
}

/**
 * A aba de captura, ligada desde que carrega e antes de qualquer transmissão.
 *
 * Existe porque a atividade precisa falar com ela justamente quando não há nada
 * no ar: mudar a qualidade, ou pedir a tela — que só nasce de um clique lá. A
 * conexão de transmissão não serve para isso, porque só é aberta depois que a
 * captura foi concedida.
 *
 * Não ocupa slot, não entra na contagem de pessoas e não segura a sala de pé:
 * uma aba esquecida aberta não pode manter viva uma sala que todo mundo já
 * deixou.
 */
export function attachControl(room, ws, userId) {
  ws.__controlOf = userId;
  room.controles.add(ws);
}

export function detachControl(room, ws) {
  room.controles.delete(ws);
}

/** Manda um recado para as abas de captura de uma pessoa. */
export function toControls(room, userId, obj) {
  let entregues = 0;
  for (const ws of room.controles) {
    if (ws.__controlOf !== userId) continue;
    if (sendJson(ws, obj)) entregues++;
  }
  return entregues;
}

// ------------------------------------------------------------------- senha

function hashPassword(password, salt = crypto.randomBytes(16)) {
  return { salt, hash: crypto.scryptSync(password, salt, 32) };
}

function passwordMatches(room, password) {
  if (!room.password) return true;
  const { hash } = hashPassword(password, room.password.salt);
  return crypto.timingSafeEqual(hash, room.password.hash);
}

/** Retorna null se pode tentar, ou os segundos que faltam para liberar. */
function lockoutRemaining(room) {
  if (!room.lockedUntil) return null;
  const left = room.lockedUntil - Date.now();
  if (left <= 0) {
    room.lockedUntil = 0;
    room.attempts = [];
    return null;
  }
  return Math.ceil(left / 1000);
}

/**
 * @returns {{ok:true}|{ok:false, reason:'senha'|'bloqueado', seconds?:number}}
 */
export function checkPassword(room, password) {
  const locked = lockoutRemaining(room);
  if (locked !== null) return { ok: false, reason: 'bloqueado', seconds: locked };

  if (passwordMatches(room, password ?? '')) {
    room.attempts = [];
    return { ok: true };
  }

  const now = Date.now();
  room.attempts = room.attempts.filter((t) => now - t < ATTEMPT_WINDOW_MS);
  room.attempts.push(now);

  if (room.attempts.length >= MAX_ATTEMPTS) {
    room.lockedUntil = now + LOCKOUT_MS;
    return { ok: false, reason: 'bloqueado', seconds: Math.ceil(LOCKOUT_MS / 1000) };
  }
  return { ok: false, reason: 'senha' };
}

/** Só o dono mexe na senha. Passar vazio remove. */
export function setPassword(room, userId, password) {
  if (room.ownerId !== userId) return 'Só quem criou a sala pode mudar a senha.';

  if (!password) {
    room.password = null;
  } else {
    room.password = hashPassword(String(password));
  }
  room.attempts = [];
  room.lockedUntil = 0;
  broadcastState(room);
  return null;
}

// ------------------------------------------------------------------ registro

export function createRoom({
  instance,
  name,
  ownerId,
  ownerName,
  password,
  guildId = null,
  guildName = null,
  channelId = null,
}) {
  const abertas = [...rooms.values()].filter((r) => r.instance === instance).length;
  if (abertas >= MAX_ROOMS_PER_INSTANCE) {
    return { error: 'Limite de salas abertas atingido. Feche uma antes de criar outra.' };
  }

  const escolhido = String(name ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  // Nome é opcional: sem ele, um baseado em quem criou.
  const clean = (escolhido || `Sala de ${ownerName}`).slice(0, MAX_ROOM_NAME);

  const id = crypto.randomBytes(6).toString('base64url');

  const room = {
    id,
    instance,
    guildId,
    guildName,
    channelId,
    name: clean,
    ownerId,
    ownerName,
    password: password ? hashPassword(String(password)) : null,
    attempts: [],
    lockedUntil: 0,
    createdAt: Date.now(),
    emptySince: Date.now(),
    broadcasters: new Map(),
    slots: new Map(),
    viewers: new Set(),
    controles: new Set(),
    droppedChunks: 0,
    traffic: trafficCounter(),
  };

  rooms.set(id, room);
  return { room };
}

export const getRoom = (id) => rooms.get(id) ?? null;

/**
 * A sala fixa de uma call: id derivado do canal, criada na primeira entrada.
 *
 * Não tem dono nem senha — quem controla o acesso é a própria call, já que só
 * entra quem o Discord confirmou estar conectado ao canal.
 */
export function ensureCallRoom(instance, id, metadata = {}) {
  let room = rooms.get(id);
  if (room) {
    // A instância da Activity muda a cada relançamento no mesmo canal; o canal
    // é que é estável. Sem atualizar, a sala sumiria da lista após um relaunch.
    room.instance = instance;
    room.guildId = metadata.guildId ?? room.guildId ?? null;
    room.guildName = metadata.guildName ?? room.guildName ?? null;
    room.channelId = metadata.channelId ?? room.channelId ?? null;
    return room;
  }

  room = {
    id,
    instance,
    guildId: metadata.guildId ?? null,
    guildName: metadata.guildName ?? null,
    channelId: metadata.channelId ?? null,
    name: 'Sala da call',
    isCall: true,
    ownerId: null,
    ownerName: 'a call',
    password: null,
    attempts: [],
    lockedUntil: 0,
    createdAt: Date.now(),
    emptySince: Date.now(),
    broadcasters: new Map(),
    slots: new Map(),
    viewers: new Set(),
    controles: new Set(),
    droppedChunks: 0,
    traffic: trafficCounter(),
  };

  rooms.set(id, room);
  return room;
}

/**
 * Lista pública: nunca vaza hash de senha, só se ela existe.
 *
 * A sala automática da call fica de fora: dentro do Discord a atividade entra
 * nela direto, e no site ela nunca poderia ser aberta. Listá-la seria mostrar
 * uma porta que não abre.
 */
export function listRooms(instance) {
  return [...rooms.values()]
    .filter((r) => r.instance === instance && !r.isCall)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((r) => ({
      id: r.id,
      name: r.name,
      owner: r.ownerName,
      isCall: Boolean(r.isCall),
      locked: Boolean(r.password),
      people: countPeople(r),
      streams: [...r.broadcasters.values()].filter((e) => e.streaming).length,
    }));
}

function countPeople(room) {
  const ids = new Set();
  for (const v of room.viewers) if (v.__info) ids.add(v.__info.id);
  for (const e of room.broadcasters.values()) ids.add(e.info.id);
  return ids.size;
}

/**
 * Fecha salas vazias há tempo demais.
 *
 * A carência existe porque recarregar a atividade desconecta e reconecta: sem
 * ela, quem estivesse sozinho perderia a sala a cada F5.
 */
/**
 * Encerra a transmissão de quem já não está mais na sala.
 *
 * A aba de captura tem conexão própria: fechar a atividade não a alcança, e a
 * tela continua indo para quem ficou — sem a pessoa estar vendo, e sem nada na
 * frente dela dizendo que ainda está no ar. Isso é vazamento de tela, não
 * detalhe de interface, então quem decide é o servidor, que é o único lado que
 * enxerga as duas conexões.
 *
 * O `stop-request` faz a aba encerrar por conta própria e dizer o motivo. O
 * `detachBroadcaster` vem junto e não depende dela: uma aba travada, ou que
 * perdeu o socket, não pode continuar segurando a tela no ar.
 */
function derrubarAbandonadas(room, now) {
  for (const entry of room.broadcasters.values()) {
    if (temViewer(room, entry.info.id)) {
      entry.semDonoDesde = null;
      continue;
    }
    if (entry.semDonoDesde === null) {
      entry.semDonoDesde = now;
      continue;
    }
    if (now - entry.semDonoDesde <= SEM_PRESENCA_MS) continue;

    sendJson(entry.ws, {
      type: 'stop-request',
      motivo: 'Você saiu da atividade, então a transmissão parou.',
    });
    console.log(`[room ${room.id}] ${entry.info.name} saiu da sala — ${entry.fonte} encerrada`);
    detachBroadcaster(room, entry.ws);
  }
}

const sweeper = setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    derrubarAbandonadas(room, now);

    const empty = room.viewers.size === 0 && room.broadcasters.size === 0;

    if (!empty) {
      room.emptySince = null;
      continue;
    }
    if (room.emptySince === null) {
      room.emptySince = now;
      continue;
    }
    if (now - room.emptySince > EMPTY_GRACE_MS) {
      // As abas de captura não seguram a sala de pé, mas continuam ligadas a
      // ela — e essa é a única conexão que sobrevive a este ponto, justamente
      // porque ficou de fora da conta de vazio. Sem fechar aqui, ela segue
      // aberta contra um objeto que ninguém mais alcança: não recebe mais nada,
      // e como não há `close`, a aba nem tenta reconectar.
      for (const ws of room.controles) {
        sendJson(ws, { type: 'room-gone' });
        ws.close();
      }
      room.controles.clear();

      rooms.delete(room.id);
      console.log(`[room ${room.id}] fechada por inatividade`);
    }
  }
}, SWEEP_EVERY_MS);
sweeper.unref?.();

// -------------------------------------------------------------------- envio

function send(ws, data) {
  if (!ws || ws.readyState !== ws.OPEN) return false;
  ws.send(data);
  return true;
}

export function sendJson(ws, obj) {
  return send(ws, JSON.stringify(obj));
}

function toViewers(room, obj) {
  const msg = JSON.stringify(obj);
  for (const v of room.viewers) send(v, msg);
}

// -------------------------------------------------------------------- estado

// O avatar vai junto do nome: a lista de quem assiste mostra as fotos, e sem
// isto sobrava só a inicial colorida para quem tem foto no Discord.
function watchersOf(room, slot) {
  const byId = new Map();
  for (const v of room.viewers) {
    if (v.__watching?.has(slot) && v.__info) byId.set(v.__info.id, v.__info);
  }
  return [...byId.values()].map((info) => ({
    id: info.id,
    name: info.name,
    avatar: info.avatar ?? null,
  }));
}

function roomState(room) {
  // Uma pessoa pode ter a sala aberta em mais de uma aba; agrupamos por id
  // para não aparecer duplicada na lista.
  const byId = new Map();
  for (const v of room.viewers) {
    if (v.__info) byId.set(v.__info.id, v.__info);
  }

  const participants = [...byId.values()].map((info) => ({
    id: info.id,
    name: info.name,
    avatar: info.avatar ?? null,
    broadcasting: transmitindo(room, info.id),
  }));

  // Quem transmite pode ter fechado a aba da Activity: continua na lista,
  // senão o vídeo fica sem dono visível. O `vistos` importa agora que a mesma
  // pessoa pode ter duas transmissões — sem ele, apareceria duplicada.
  const vistos = new Set(byId.keys());
  for (const entry of room.broadcasters.values()) {
    if (vistos.has(entry.info.id)) continue;
    vistos.add(entry.info.id);
    participants.push({
      id: entry.info.id,
      name: entry.info.name,
      avatar: entry.info.avatar ?? null,
      broadcasting: true,
    });
  }

  participants.sort((a, b) => Number(b.broadcasting) - Number(a.broadcasting));

  // Quem tem aba de captura aberta. É o que permite à atividade saber se pode
  // falar com ela em vez de abrir outra — antes isso era deduzido do que estava
  // no ar, e uma aba ainda parada não aparecia em lugar nenhum.
  const abas = [...new Set([...room.controles].map((ws) => ws.__controlOf))];

  return {
    type: 'state',
    abas,
    room: { id: room.id, name: room.name, ownerId: room.ownerId, locked: Boolean(room.password) },
    broadcasting: room.broadcasters.size > 0,
    viewers: room.viewers.size,
    participants,
    streams: [...room.broadcasters.values()]
      .filter((e) => e.streaming)
      .map((e) => ({
        slot: e.slot,
        userId: e.info.id,
        fonte: e.fonte,
        watchers: watchersOf(room, e.slot),
      })),
  };
}

export function broadcastState(room) {
  const msg = JSON.stringify(roomState(room));
  for (const v of room.viewers) send(v, msg);
  for (const e of room.broadcasters.values()) send(e.ws, msg);
}

function requestKeyframe(entry) {
  sendJson(entry.ws, { type: 'need-keyframe' });
}

export function rename(room, ws, raw) {
  if (!ws.__info || typeof raw !== 'string') return;

  const name = raw.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
  if (!name) return;

  ws.__info.name = name;
  // Todas as transmissões da pessoa, não "a" transmissão: quem divide tela e
  // câmera tem duas, e renomear só uma deixaria o grid com dois nomes.
  for (const entry of broadcastersOf(room, ws.__info.id)) entry.info.name = name;
  broadcastState(room);
}

// ---------------------------------------------------------------- transmissor

function freeSlot(room) {
  for (let i = 0; i < MAX_BROADCASTERS; i++) {
    if (!room.slots.has(i)) return i;
  }
  return null;
}

/** Retorna a entry criada, ou uma string com o motivo da recusa. */
export function attachBroadcaster(room, ws, info, fonte = 'tela') {
  const chave = chaveDe(info.id, fonte);

  // A recusa nomeia a fonte: "você já está transmitindo" era claro quando só
  // havia uma, mas com duas deixaria a pessoa sem saber qual delas repetiu.
  if (room.broadcasters.has(chave)) {
    return fonte === 'camera'
      ? 'Você já está transmitindo a câmera nesta sala.'
      : 'Você já está transmitindo a tela nesta sala.';
  }
  if (broadcastersOf(room, info.id).length >= MAX_POR_PESSOA) {
    return `Limite de ${MAX_POR_PESSOA} transmissões por pessoa atingido.`;
  }
  if (room.broadcasters.size >= MAX_BROADCASTERS) {
    return `Limite de ${MAX_BROADCASTERS} transmissões simultâneas atingido.`;
  }

  const slot = freeSlot(room);
  if (slot === null) return 'Sem espaço para mais transmissões.';

  const entry = {
    ws,
    info,
    fonte,
    chave,
    slot,
    streaming: false,
    // Desde quando quem transmite não está mais na sala. Null enquanto está.
    semDonoDesde: null,
    config: null,
    audioConfig: null,
    connectedAt: Date.now(),
    startedAt: null,
    traffic: trafficCounter(),
    droppedChunks: 0,
    viewerHealth: new Map(),
    viewerHealthSentAt: 0,
  };
  room.broadcasters.set(chave, entry);
  room.slots.set(slot, entry);
  ws.__entry = entry;
  room.emptySince = null;

  sendJson(ws, { type: 'slot', slot });
  broadcastState(room);
  return entry;
}

export function startStream(room, entry) {
  entry.streaming = true;
  entry.startedAt = Date.now();
  entry.config = null;
  entry.audioConfig = null;
  entry.viewerHealth.clear();
  entry.viewerHealthSentAt = 0;
  // Transmissão nova recomeça do zero: ninguém assiste até pedir.
  for (const v of room.viewers) {
    v.__primed?.delete(entry.slot);
    v.__watching?.delete(entry.slot);
  }
  toViewers(room, {
    type: 'stream-start',
    slot: entry.slot,
    userId: entry.info.id,
    fonte: entry.fonte,
  });
  broadcastState(room);
}

/**
 * Config do áudio, guardada e repassada igual à do vídeo.
 *
 * Quem começa a assistir no meio precisa dela para montar o decodificador — e,
 * ao contrário do vídeo, aqui não existe keyframe para servir de ponto de
 * partida: sem a config, nenhum pacote de som é aproveitável.
 */
export function setAudioConfig(room, entry, config) {
  entry.audioConfig = config;
  for (const v of room.viewers) {
    if (v.__watching?.has(entry.slot)) {
      sendJson(v, { type: 'audio-config', slot: entry.slot, config });
    }
  }
}

export function setConfig(room, entry, config) {
  entry.config = config;
  // Config nova significa decoder recriado; ele volta a precisar de keyframe.
  for (const v of room.viewers) v.__primed?.delete(entry.slot);
  for (const v of room.viewers) {
    if (v.__watching?.has(entry.slot)) sendJson(v, { type: 'config', slot: entry.slot, config });
  }
}

export function pushChunk(room, entry, chunk) {
  const bytes = Number(chunk?.byteLength ?? chunk?.length ?? 0);
  recordTraffic(appTraffic, 'receivedBytes', bytes);
  recordTraffic(room.traffic, 'receivedBytes', bytes);
  recordTraffic(entry.traffic, 'receivedBytes', bytes);

  if (chunk[SLOT_BYTE] !== entry.slot) return;

  const tipo = chunk[TYPE_BYTE];
  const isKeyframe = tipo === KEYFRAME;
  const isAudio = tipo === AUDIO;
  let sentCopies = 0;
  let droppedCopies = 0;

  for (const v of room.viewers) {
    if (v.readyState !== v.OPEN) continue;

    // Assistir é opt-in: quem não pediu esta tela não recebe os bytes dela.
    if (!v.__watching.has(entry.slot)) continue;

    // Áudio não depende de keyframe — cada pacote Opus se decodifica sozinho —,
    // então não passa pelo controle de "já recebeu ponto de partida".
    if (isAudio) {
      if (v.bufferedAmount > MAX_BUFFERED_BYTES) {
        room.droppedChunks++;
        entry.droppedChunks++;
        droppedCopies++;
        continue;
      }
      v.send(chunk);
      sentCopies++;
      v.__mediaBytesOut = (v.__mediaBytesOut ?? 0) + bytes;
      continue;
    }

    if (isKeyframe) {
      if (v.bufferedAmount > MAX_BUFFERED_BYTES * 2) {
        room.droppedChunks++;
        entry.droppedChunks++;
        droppedCopies++;
        continue;
      }
      v.send(chunk);
      sentCopies++;
      v.__mediaBytesOut = (v.__mediaBytesOut ?? 0) + bytes;
      v.__primed.add(entry.slot);
      continue;
    }

    if (!v.__primed.has(entry.slot)) continue;

    if (v.bufferedAmount > MAX_BUFFERED_BYTES) {
      room.droppedChunks++;
      entry.droppedChunks++;
      droppedCopies++;
      continue;
    }
    v.send(chunk);
    sentCopies++;
    v.__mediaBytesOut = (v.__mediaBytesOut ?? 0) + bytes;
  }

  const sentBytes = bytes * sentCopies;
  const droppedBytes = bytes * droppedCopies;
  for (const counter of [appTraffic, room.traffic, entry.traffic]) {
    recordTraffic(counter, 'transmittedBytes', sentBytes);
    recordTraffic(counter, 'droppedBytes', droppedBytes);
  }
}

export function stopStream(room, entry) {
  if (!entry.streaming) return;
  entry.streaming = false;
  entry.startedAt = null;
  entry.config = null;
  entry.audioConfig = null;
  for (const v of room.viewers) {
    v.__primed?.delete(entry.slot);
    v.__watching?.delete(entry.slot);
  }
  toViewers(room, { type: 'stream-stop', slot: entry.slot });
}

export function detachBroadcaster(room, ws) {
  const entry = ws.__entry;
  if (!entry || room.broadcasters.get(entry.chave) !== entry) return;

  stopStream(room, entry);
  room.broadcasters.delete(entry.chave);
  room.slots.delete(entry.slot);
  broadcastState(room);
}

// --------------------------------------------------------------- espectador

export function watch(room, ws, slot) {
  const entry = room.slots.get(slot);
  if (!entry || !entry.streaming) return;
  // Repetir o pedido não muda nada, mas custaria um broadcast de estado para a
  // sala inteira — um cliente em laço faria o servidor inundar todo mundo.
  if (ws.__watching.has(slot)) return;

  ws.__watching.add(slot);
  ws.__primed.delete(slot);

  if (entry.config) sendJson(ws, { type: 'config', slot, config: entry.config });
  if (entry.audioConfig) {
    sendJson(ws, { type: 'audio-config', slot, config: entry.audioConfig });
  }
  requestKeyframe(entry);
  broadcastState(room);
}

export function unwatch(room, ws, slot) {
  // Só avisa a sala se algo mudou de fato; ver a nota em watch().
  if (!ws.__watching.delete(slot)) return;
  ws.__primed.delete(slot);
  broadcastState(room);
}

/** Agrega a condição dos espectadores e envia o pior caso ao transmissor. */
export function viewerFeedback(room, ws, slot, telemetry) {
  const entry = room.slots.get(slot);
  if (!entry?.streaming || !ws.__watching?.has(slot) || !ws.__info?.id) return;

  const now = Date.now();
  entry.viewerHealth.set(ws.__info.id, { at: now, telemetry });
  for (const [id, sample] of entry.viewerHealth) {
    if (now - sample.at > 5_000) entry.viewerHealth.delete(id);
  }

  if (now - (entry.viewerHealthSentAt ?? 0) < 1_000) return;
  entry.viewerHealthSentAt = now;
  const samples = [...entry.viewerHealth.values()].map((sample) => sample.telemetry ?? {});
  const rendered = samples.map((sample) => sample.renderedFps).filter(Number.isFinite);
  const latency = samples.map((sample) => sample.estimatedLatencyMs).filter(Number.isFinite);
  sendJson(entry.ws, {
    type: 'viewer-health',
    health: {
      viewerCount: samples.length,
      worstRenderedFps: rendered.length ? Math.min(...rendered) : 0,
      worstLatency: latency.length ? Math.max(...latency) : 0,
      congestedViewers: samples.filter((sample) => (sample.decodeQueueSize ?? 0) >= 3).length,
    },
  });
}

export function attachViewer(room, ws, info) {
  ws.__primed = new Set();
  ws.__watching = new Set();
  ws.__info = info;
  ws.__connectedAt = ws.__connectedAt ?? Date.now();
  ws.__mediaBytesOut = ws.__mediaBytesOut ?? 0;
  room.viewers.add(ws);
  room.emptySince = null;

  sendJson(ws, roomState(room));

  // Anuncia o que está no ar, sem começar a mandar quadros: assistir é opt-in.
  for (const entry of room.broadcasters.values()) {
    if (!entry.streaming) continue;
    sendJson(ws, {
      type: 'stream-start',
      slot: entry.slot,
      userId: entry.info.id,
      fonte: entry.fonte,
    });
  }

  broadcastState(room);
}

export function detachViewer(room, ws) {
  room.viewers.delete(ws);
  broadcastState(room);
}

export function stats() {
  return [...rooms.values()].map((r) => ({
    id: r.id,
    name: r.name,
    locked: Boolean(r.password),
    broadcasting: r.broadcasters.size,
    viewers: r.viewers.size,
    droppedChunks: r.droppedChunks,
  }));
}

function average(values) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}

function usersOf(room) {
  const users = new Map();

  function add(info, role, ws, extra = {}) {
    if (!info?.id) return;
    let user = users.get(info.id);
    if (!user) {
      user = {
        id: info.id,
        name: info.name,
        avatar: info.avatar ?? null,
        roles: new Set(),
        connections: 0,
        connectedAt: Date.now(),
        pingSamples: [],
        watching: new Set(),
        mediaBytesOut: 0,
        bufferedBytes: 0,
      };
      users.set(info.id, user);
    }

    user.name = info.name || user.name;
    user.avatar = info.avatar ?? user.avatar;
    user.roles.add(role);
    user.connections++;
    user.connectedAt = Math.min(user.connectedAt, ws?.__connectedAt ?? Date.now());
    if (Number.isFinite(ws?.__rttMs)) user.pingSamples.push(ws.__rttMs);
    for (const slot of ws?.__watching ?? []) user.watching.add(slot);
    user.mediaBytesOut += ws?.__mediaBytesOut ?? 0;
    user.bufferedBytes += ws?.bufferedAmount ?? 0;
    if (extra.broadcasting) user.broadcasting = true;
  }

  for (const viewer of room.viewers) add(viewer.__info, 'viewer', viewer);
  for (const entry of room.broadcasters.values()) {
    add(entry.info, 'broadcaster', entry.ws, { broadcasting: entry.streaming });
  }

  return [...users.values()].map((user) => ({
    id: user.id,
    name: user.name,
    avatar: user.avatar,
    roles: [...user.roles],
    connections: user.connections,
    connectedAt: user.connectedAt,
    pingMs: average(user.pingSamples),
    watching: [...user.watching],
    broadcasting: Boolean(user.broadcasting),
    mediaBytesOut: user.mediaBytesOut,
    bufferedBytes: user.bufferedBytes,
  }));
}

/** Estado detalhado usado exclusivamente pela API administrativa protegida. */
export function adminStats() {
  const roomList = [...rooms.values()].map((room) => {
    const users = usersOf(room);
    const streams = [...room.broadcasters.values()]
      .filter((entry) => entry.streaming)
      .map((entry) => ({
        slot: entry.slot,
        userId: entry.info.id,
        userName: entry.info.name,
        startedAt: entry.startedAt,
        codec: entry.config?.codec ?? null,
        width: entry.config?.codedWidth ?? null,
        height: entry.config?.codedHeight ?? null,
        audioCodec: entry.audioConfig?.codec ?? null,
        watchers: watchersOf(room, entry.slot).length,
        droppedChunks: entry.droppedChunks,
        bufferedBytes: entry.ws?.bufferedAmount ?? 0,
        pingMs: Number.isFinite(entry.ws?.__rttMs) ? entry.ws.__rttMs : null,
        traffic: trafficSnapshot(entry.traffic),
      }));

    return {
      id: room.id,
      name: room.name,
      instance: room.instance,
      guildId: room.guildId ?? null,
      guildName: room.guildName ?? null,
      channelId: room.channelId ?? null,
      isCall: Boolean(room.isCall),
      locked: Boolean(room.password),
      createdAt: room.createdAt,
      connections: room.viewers.size + room.broadcasters.size,
      viewers: room.viewers.size,
      broadcasters: room.broadcasters.size,
      droppedChunks: room.droppedChunks,
      traffic: trafficSnapshot(room.traffic),
      users,
      streams,
    };
  });

  return { rooms: roomList, traffic: trafficSnapshot(appTraffic), startedAt: appTraffic.startedAt };
}
