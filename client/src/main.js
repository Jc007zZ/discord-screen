import { DiscordSDK } from '@discord/embedded-app-sdk';
import { createPlayer } from './player.js';
import { createAudio } from './audio.js';
import { createBroadcaster } from '../../shared/broadcaster.js';

const $ = (id) => document.getElementById(id);

const params = new URLSearchParams(location.search);
// O Discord injeta frame_id/instance_id na URL do iframe. Sem eles, estamos
// rodando direto no navegador — modo de desenvolvimento.
const inDiscord = params.has('frame_id');

// Dentro da Activity todo tráfego precisa passar pelo proxy do Discord.
const P = inDiscord ? '/.proxy' : '';

// Um decoder e um canvas por transmissor, indexados pelo slot que o servidor
// atribuiu. Os canvas vivem fora do DOM entre renderizações e são movidos para
// dentro do tile de cada pessoa — detachar não apaga o conteúdo nem invalida o
// contexto 2D, então os decoders seguem desenhando sem saber de nada.
const streams = new Map(); // slot -> { userId, canvas, player }

// Transmissões anunciadas pelo servidor, assistidas ou não. Assistir é opt-in:
// sem pedir, o servidor nem envia os quadros — a economia de banda depende
// disso, filtrar só na exibição gastaria a mesma saída.
const available = new Map(); // slot -> { userId, config }
const watching = new Set(); // slots que eu pedi para assistir

// Quem tem aba de captura aberta, segundo o servidor. É o que decide entre
// falar com a aba existente e abrir outra.
const abas = new Set();

let sdk = null;
let session = null;
let clientId = null;
let ws = null;
let participants = [];
let reconnectDelay = 1000;
let lagTimer = null;
// Transmissão nascida aqui dentro, quando o Discord permite capturar no iframe.
let myBroadcast = null;
// Volume de tudo que chega, de 0 a 1. Vale para todas as telas e sobrevive a
// trocar de sala: é preferência de quem assiste, não estado de uma transmissão.
// Zero é o mudo — um número só, em vez de dois estados que precisam concordar.
let volume = Math.min(1, Math.max(0, Number(read('volume') ?? 1)));

/**
 * Volume de cada pessoa, separado do volume geral.
 *
 * Como no Discord: o cursor do dock é o volume de tudo, e cada transmissão tem
 * o seu, guardado por pessoa e não por sessão — quem sempre chega alto demais
 * continua ajustado amanhã. O que sai no alto-falante é o produto dos dois.
 */
const volumePessoa = lerVolumes();

function lerVolumes() {
  try {
    return new Map(Object.entries(JSON.parse(read('volumePessoa') ?? '{}')));
  } catch {
    return new Map();
  }
}

const gravarVolumes = () => store('volumePessoa', JSON.stringify(Object.fromEntries(volumePessoa)));

const volumeEfetivo = (userId) => volume * (volumePessoa.get(userId) ?? 1);

/** Reaplica o volume de um stream depois de qualquer um dos dois mudar. */
function aplicarVolume(slot) {
  const s = streams.get(slot);
  s?.audio?.setVolume(volumeEfetivo(s.userId));
}
// Para onde o botão de silenciar volta. Sem isto, desmutar cairia sempre em
// 100%, ignorando o ajuste que a pessoa tinha feito.
let volumeAntes = volume || 1;
// Qual tela está no palco, e se ela ocupa tudo. Guardados fora do render
// porque a grade é reconstruída a cada mudança de estado da sala, e a escolha
// de quem assiste precisa sobreviver a isso.
let activeSlot = null;
let telaCheia = false;

// ------------------------------------------------------------------- helpers

let toastTimer = null;
function toast(msg, isError = false) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 6000);
}

function setEmpty(title, text) {
  $('emptyTitle').textContent = title;
  $('emptyText').textContent = text;
}

/** Cor estável por usuário — mesma pessoa, mesma cor, em qualquer sessão. */
function colorFor(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return `hsl(${Math.abs(hash) % 360} 45% 42%)`;
}

/**
 * Avatares passam pelo nosso próprio servidor, não pelo CDN do Discord.
 *
 * O CSP da Activity bloqueia cdn.discordapp.com, e o proxy do Discord só
 * repassa domínios mapeados no portal do desenvolvedor — sem esse mapeamento a
 * foto caía sempre nas iniciais. Pela nossa rota a URL é a mesma dentro e fora
 * da Activity, e não depende de configuração que ninguém lembra de fazer.
 */
function avatarUrl(p) {
  if (!p.avatar) return null;
  return `${P}/api/avatar/${p.id}/${p.avatar}`;
}

function initials(name) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => [...w][0] ?? '')
    .join('')
    .toUpperCase();
}

/** Todas as transmissões de uma pessoa — hoje até duas: a tela e a câmera. */
const slotsOf = (userId) =>
  [...available.entries()].filter(([, a]) => a.userId === userId).map(([slot]) => slot);

/**
 * O que o grid desenha: uma entrada por transmissão, mais uma por pessoa que
 * não está transmitindo.
 *
 * Antes era uma entrada por pessoa, com o slot deduzido dela. Bastava enquanto
 * ninguém podia ter duas — a partir da câmera, a segunda transmissão
 * simplesmente não aparecia, e o motivo não ficava visível em lugar nenhum.
 */
function entradasDoGrid() {
  const saida = [];
  for (const p of participants) {
    const slots = p.broadcasting ? slotsOf(p.id) : [];
    if (!slots.length) saida.push({ p, slot: null });
    else for (const slot of slots) saida.push({ p, slot });
  }
  return saida;
}

function watchSlot(slot) {
  const info = available.get(slot);
  if (!info) return;
  watching.add(slot);
  ws?.send(JSON.stringify({ type: 'watch', slot }));
  // O config pode já ter chegado; se não, ele chega logo e dispara o start.
  if (info.config) {
    openStream(slot, info.userId);
    startStream(slot, info.config);
  }
  renderGrid();
}

function unwatchSlot(slot) {
  watching.delete(slot);
  ws?.send(JSON.stringify({ type: 'unwatch', slot }));
  closeStream(slot);
  renderGrid();
  renderBar();
}

// --------------------------------------------------------------------- grade

/** Colunas aproximando o layout da call do Discord: quadrado, crescendo em passos. */
function columnsFor(n) {
  if (n <= 1) return 1;
  if (n <= 4) return 2;
  if (n <= 9) return 3;
  return 4;
}

// Largura da barra lateral. É preferência de quem assiste, não estado da sala —
// por isso vive no localStorage, e não no servidor.
const STRIP_DEFAULT = 300;
const STRIP_MIN = 200;
let stripW = Number(read('stripW')) || STRIP_DEFAULT;

const divider = document.createElement('div');
divider.className = 'divider';
divider.title = 'Arraste para redimensionar · duplo clique restaura';

/** Aplica a largura guardada, respeitando o teto da janela atual. */
function applyStrip() {
  // O teto acompanha a janela: uma largura guardada grande demais engoliria o
  // palco depois de alguém encolher o Discord.
  const max = Math.max(STRIP_MIN, $('grid').clientWidth * 0.45);
  $('grid').style.setProperty('--strip', `${Math.round(Math.min(max, stripW))}px`);
}

function setStrip(px) {
  stripW = Math.max(STRIP_MIN, Math.round(px));
  applyStrip();
  store('stripW', String(stripW));
}

divider.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  divider.classList.add('dragging');

  // Os ouvintes vão na janela, não no divisor: a grade é reconstruída a cada
  // mudança de estado da sala, e o arrasto não pode morrer no meio disso.
  // 21px = os 16 de padding da grade mais a meia largura do divisor.
  const move = (ev) => setStrip($('grid').getBoundingClientRect().right - ev.clientX - 21);
  const up = () => {
    divider.classList.remove('dragging');
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  };

  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
});

divider.addEventListener('dblclick', () => setStrip(STRIP_DEFAULT));
window.addEventListener('resize', () => inRoom() && applyStrip());

/**
 * Duas formas de mostrar a sala, e o que decide é ter alguém transmitindo.
 *
 * Sem transmissão, uma grade de pessoas — a sala de espera. Com transmissão, um
 * palco: a tela escolhida ocupa a área principal e, ao lado, ficam as outras
 * telas em cima e as pessoas embaixo. Dar a grade inteira à tela esconderia
 * quem está junto, e é a call que se perde nisso.
 */
function renderGrid() {
  const grid = $('grid');

  // Fora de uma sala quem manda é o lobby. Sem esta guarda, o render disparado
  // pelo fechamento do WebSocket mostrava o painel "Ninguém na sala" por cima
  // da lista de salas.
  if (!inRoom()) {
    grid.hidden = true;
    $('empty').hidden = true;
    $('fullscreen').hidden = true;
    $('app').classList.remove('cheia');
    return;
  }

  const hasPeople = participants.length > 0;
  $('empty').hidden = hasPeople;
  grid.hidden = !hasPeople;

  const casters = participants.filter((p) => p.broadcasting);

  if (!casters.length) {
    activeSlot = null;
    telaCheia = false;
  } else if (activeSlot === null || !available.has(activeSlot)) {
    // Sempre há uma tela em destaque quando existe transmissão: chegar numa
    // sala com tela no ar e ver só avatares esconderia o que importa.
    activeSlot = entradasDoGrid().find((e) => e.slot !== null)?.slot ?? null;
  }

  const noPalco = activeSlot !== null;
  $('fullscreen').hidden = !noPalco;
  // A classe vai no #app, e não na grade: quem sai do layout são as barras, que
  // são irmãs dela. Fica acima do `return` de sala vazia — senão as barras
  // continuariam flutuando sobre o painel de "ninguém na sala".
  $('app').classList.toggle('cheia', noPalco && telaCheia);
  $('fullscreen').classList.toggle('on', telaCheia);
  // A dica e o nome acessível andam juntos: o botão faz duas coisas conforme o
  // estado, e anunciar sempre a mesma coisa mentiria para quem usa leitor.
  const rotulo = telaCheia ? 'Sair da tela cheia' : 'Tela cheia';
  $('fullscreen').dataset.tip = rotulo;
  $('fullscreen').setAttribute('aria-label', rotulo);

  if (!hasPeople) return;

  grid.classList.toggle('palco', noPalco);
  grid.classList.toggle('cheia', noPalco && telaCheia);

  // Com a lateral no ar, a contagem no topo repete o que está logo ali — e
  // custa uma faixa inteira de altura, que é o que falta para a tela. Vazia, a
  // barra de cima se recolhe sozinha.
  $('people').hidden = noPalco && !telaCheia;

  // Os canvas são reanexados abaixo; removê-los daqui não perde o conteúdo.
  grid.replaceChildren();

  if (!noPalco) {
    const entradas = entradasDoGrid();
    grid.style.setProperty('--cols', columnsFor(entradas.length));
    grid.append(...entradas.map((e) => buildTile(e.p, { slot: e.slot }).el));
    return;
  }

  const dono = available.get(activeSlot)?.userId;
  const emCena = participants.find((p) => p.id === dono) ?? {
    id: dono ?? 'desconhecido',
    name: 'Transmitindo',
    broadcasting: true,
  };
  // O slot em destaque, e não o da pessoa: cada transmissão tem um nó de canvas
  // só, então montar o palco com o slot errado o arranca do tile que o estava
  // mostrando — e um dos dois fica preto, conforme a ordem do desenho.
  grid.append(buildTile(emCena, { palco: true, slot: activeSlot }).el);

  if (telaCheia) return;

  applyStrip();
  grid.append(divider, buildSidebar());
}

/**
 * Barra lateral: as outras telas em cima, as pessoas embaixo.
 *
 * Telas primeiro porque é o que se olha; pessoas depois porque é o que se
 * confere. Cada uma no formato que merece — a tela como miniatura, a pessoa
 * como linha, que cabe muito mais gente no mesmo espaço.
 */
function buildSidebar() {
  const barra = document.createElement('aside');
  barra.className = 'sidebar';

  // Por transmissão, e não por pessoa: quem divide tela e câmera tem duas
  // miniaturas aqui, e a que está no palco é a única que não se repete.
  const outras = entradasDoGrid().filter((e) => e.slot !== null && e.slot !== activeSlot);
  if (outras.length) {
    barra.append(secaoTitulo(outras.length === 1 ? 'Outra transmissão' : 'Outras transmissões'));
    for (const e of outras) barra.append(buildTile(e.p, { slot: e.slot }).el);
  }

  barra.append(contagemPessoas());

  // semVideo é obrigatório aqui: o canvas de cada transmissão é um nó de DOM
  // só, e anexá-lo neste tile o arrancaria do palco — que ficaria preto
  // enquanto a miniatura ao lado mostrava a tela.
  const gente = document.createElement('div');
  gente.className = 'sidebar-people';
  for (const p of participants) gente.append(buildTile(p, { semVideo: true }).el);
  barra.append(gente);

  return barra;
}

function secaoTitulo(texto) {
  const t = document.createElement('h2');
  t.className = 'sidebar-title';
  t.textContent = texto;
  return t;
}

/**
 * Quantas pessoas na sala, na mesma pílula usada no resto da interface.
 *
 * Era um título em caixa alta, que gastava uma faixa inteira da lateral para
 * dizer o que um número diz — e a lateral é justamente onde falta espaço.
 */
function contagemPessoas() {
  const chip = document.createElement('div');
  chip.className = 'sidebar-count';
  chip.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 20v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>' +
    '<circle cx="9" cy="7" r="4"/><path d="M23 20v-2a4 4 0 0 0-3-3.87"/>' +
    '<path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>';
  chip.append(document.createTextNode(String(participants.length)));
  chip.title =
    participants.length === 1 ? '1 pessoa na sala' : `${participants.length} pessoas na sala`;
  return chip;
}

/**
 * Um tile: a tela de quem transmite, ou o avatar de quem só assiste.
 *
 * `palco` distingue o tile em destaque dos da lateral, e é o que decide o que o
 * clique faz: no palco, alterna tela cheia; na lateral, promove aquela tela.
 *
 * `semVideo` força o avatar mesmo para quem está transmitindo. É o que permite
 * a mesma pessoa aparecer no palco e na lista de pessoas sem que os dois
 * disputem o único canvas daquela transmissão.
 */
function buildTile(p, { palco = false, semVideo = false, slot: slotDado = null } = {}) {
  // O slot é obrigatório para quem quer vídeo, e não deduzido da pessoa: com
  // duas fontes por pessoa não existe "a transmissão dela". Quem passa
  // `semVideo` quer só o avatar, e aí não há slot para acertar.
  const slot = p.broadcasting && !semVideo ? slotDado : null;
  const stream = slot !== null ? streams.get(slot) : null;
  const isMe = p.id === session?.user?.id;

  const tile = document.createElement('div');
  tile.className = p.broadcasting ? 'tile sharing' : 'tile';
  if (palco) tile.classList.add('tile-palco');

  // Com a forma do vídeo no próprio tile, a moldura passa a abraçar a imagem.
  // Sem isto, uma tela 16:9 dentro de um palco largo e baixo encolhia até caber
  // na altura e sobrava um retângulo preto ocupando metade da área.
  if (palco && stream?.canvas.width) {
    tile.style.aspectRatio = `${stream.canvas.width} / ${stream.canvas.height}`;
  }

  // Sem rótulo, dois tiles da mesma pessoa lado a lado no grid não se
  // distinguem até alguém clicar em um deles.
  if (slot !== null && available.get(slot)?.fonte === 'camera') {
    const marca = document.createElement('span');
    marca.className = 'tile-fonte';
    marca.textContent = 'Câmera';
    tile.append(marca);
  }

  const aoClicar = () => {
    if (palco) telaCheia = !telaCheia;
    else activeSlot = slot;
    renderGrid();
  };

  if (stream) {
    tile.append(stream.canvas);
    tile.title = palco
      ? telaCheia
        ? 'Clique para sair da tela cheia'
        : 'Clique para ver em tela cheia'
      : 'Clique para ver em destaque';
    tile.addEventListener('click', aoClicar);
    // Botão direito para largar a tela, sem precisar caçar controle.
    tile.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openTileMenu(e.clientX, e.clientY, slot, p.name);
    });

    // Entre pedir para assistir e o primeiro quadro chegar existe uma espera
    // real: sem este aviso ela é indistinguível de um travamento.
    if (!stream.started) tile.append(buildLoading());

    // O clique direito pode ser capturado pelo cliente do Discord antes de
    // chegar aqui, então o botão visível é o caminho garantido.
    const stop = document.createElement('button');
    stop.className = 'tile-stop';
    stop.dataset.tip = 'Parar de assistir';
    stop.setAttribute('aria-label', `Parar de assistir ${p.name}`);
    stop.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    stop.addEventListener('click', (e) => {
      e.stopPropagation();
      unwatchSlot(slot);
    });
    tile.append(stop);
  } else if (slot !== null) {
    // O convite tem botão próprio, que para o clique antes de chegar no tile.
    if (!palco) tile.addEventListener('click', aoClicar);
    tile.append(buildWatchPrompt(slot, p.name, isMe));
  } else {
    tile.append(buildAvatar(p));
  }

  const footer = document.createElement('div');
  footer.className = 'tile-footer';

  const badge = document.createElement('div');
  badge.className = 'tile-name';
  if (p.broadcasting) {
    const dot = document.createElement('span');
    dot.className = 'dot';
    badge.append(dot);
  }
  badge.append(document.createTextNode(p.name));
  footer.append(badge);

  if (slot !== null) footer.append(buildWatchers(slot));
  tile.append(footer);

  if (isMe) {
    const you = document.createElement('span');
    you.className = 'tile-you';
    you.textContent = 'você';
    tile.append(you);
  }

  return { el: tile, slot };
}

/** Espera pelo primeiro quadro. Sai sozinha quando o decoder desenha. */
function buildLoading() {
  const wrap = document.createElement('div');
  wrap.className = 'tile-loading';
  wrap.innerHTML = '<span class="spinner"></span>';
  wrap.append(document.createTextNode('Conectando…'));
  return wrap;
}

/** Quantas pessoas assistem esta tela; a lista aparece ao passar o mouse. */
function buildWatchers(slot) {
  const people = available.get(slot)?.watchers ?? [];

  const badge = document.createElement('div');
  badge.className = 'tile-watchers';
  badge.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>' +
    '<circle cx="12" cy="7" r="4"/></svg>';
  badge.append(document.createTextNode(String(people.length)));
  badge.title = people.length === 1 ? '1 pessoa assistindo' : `${people.length} pessoas assistindo`;

  const list = document.createElement('div');
  list.className = 'hover-list';

  if (!people.length) {
    const empty = document.createElement('span');
    empty.className = 'hover-empty';
    empty.textContent = 'Ninguém assistindo';
    list.append(empty);
  } else {
    for (const w of people) {
      const row = document.createElement('span');
      row.className = 'hover-row';
      row.append(buildAvatar(w));
      // textContent, nunca innerHTML: o nome vem do Discord, é conteúdo de terceiro.
      row.append(document.createTextNode(w.name));
      list.append(row);
    }
  }

  badge.append(list);
  return badge;
}

/** Tela cinza com o convite para assistir — nada é baixado até clicar. */
function buildWatchPrompt(slot, name, isMe) {
  const camera = available.get(slot)?.fonte === 'camera';
  const wrap = document.createElement('div');
  wrap.className = 'watch-prompt';

  const btn = document.createElement('button');
  btn.className = 'btn go';
  btn.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5h18v11H3z"/><path d="M8 20h8"/></svg>';
  btn.append(
    document.createTextNode(
      camera
        ? isMe
          ? 'Ver minha câmera'
          : 'Assistir câmera'
        : isMe
          ? 'Ver minha tela'
          : 'Assistir tela',
    ),
  );
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    watchSlot(slot);
  });

  const who = document.createElement('span');
  who.className = 'watch-who';
  // Ver a própria tela é conferência, não bisbilhotice: o texto precisa dizer
  // que o que está no ar é a sua, não a de outra pessoa com o seu nome.
  who.textContent = isMe
    ? 'Sua transmissão está no ar'
    : `${name} está ${camera ? 'com a câmera ligada' : 'transmitindo'}`;

  wrap.append(btn, who);
  return wrap;
}

// -------------------------------------------------------------------- perfil

function renderProfileButton() {
  if (!session) return;
  const me = participants.find((p) => p.id === session.user.id) ?? session.user;

  $('profile').replaceChildren(buildAvatar({ ...me, id: session.user.id }));

  // Mesma identidade, duas superfícies: bolinha no dock dentro da sala,
  // bolinha com nome no cabeçalho do lobby.
  const name = document.createElement('span');
  name.textContent = me.name;
  $('lobbyUser').replaceChildren(buildAvatar({ ...me, id: session.user.id }), name);
  $('lobbyUser').hidden = false;
}

$('lobbyUser').addEventListener('click', openProfile);
$('profile').addEventListener('click', openProfile);

function openProfile() {
  if (!session) return;
  const me = participants.find((p) => p.id === session.user.id) ?? session.user;

  $('profileAvatar').replaceChildren(buildAvatar({ ...me, id: session.user.id }));
  $('profileName').textContent = me.name;
  $('profileId').textContent = inDiscord ? `Discord · ${session.user.id}` : 'modo local';
  $('profileInput').value = me.name;

  $('profileModal').hidden = false;
  $('profileInput').focus();
  $('profileInput').select();
}

const closeProfile = () => {
  $('profileModal').hidden = true;
};

$('profileCancel').addEventListener('click', closeProfile);

$('profileModal').addEventListener('click', (e) => {
  if (e.target === $('profileModal')) closeProfile();
});

$('profileInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('profileSave').click();
});

$('profileSave').addEventListener('click', () => {
  const name = $('profileInput').value.replace(/\s+/g, ' ').trim().slice(0, 32);
  if (name) {
    session.user.name = name;
    storeName(name);
    ws?.send(JSON.stringify({ type: 'rename', name }));
    renderProfileButton();
  }
  closeProfile();
});

/**
 * O apelido vive no localStorage, não no servidor.
 *
 * Os acessos vão em try/catch porque dentro de um iframe de terceiro o
 * armazenamento pode estar particionado ou bloqueado — e perder o apelido é
 * bem melhor do que a sala não abrir.
 */
const storedName = () => read('displayName');
const storeName = (name) => store('displayName', name);

/** Menu de contexto do tile. Some ao primeiro clique ou tecla em qualquer lugar. */
function openTileMenu(x, y, slot, name) {
  document.querySelector('.tile-menu')?.remove();

  const menu = document.createElement('div');
  menu.className = 'tile-menu';
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  // O cursor só aparece onde há som para ajustar: oferecer um controle que não
  // faz nada é pior do que não oferecer nenhum.
  const stream = streams.get(slot);
  if (stream?.audio) menu.append(buildMenuVolume(stream.userId, name, slot));

  const item = document.createElement('button');
  item.textContent = `Parar de assistir ${name}`;
  item.addEventListener('click', () => {
    menu.remove();
    unwatchSlot(slot);
  });

  menu.append(item);
  document.body.append(menu);

  // Mantém o menu dentro da janela quando o clique acontece perto das bordas.
  const box = menu.getBoundingClientRect();
  if (x + box.width > window.innerWidth) menu.style.left = `${window.innerWidth - box.width - 8}px`;
  if (y + box.height > window.innerHeight)
    menu.style.top = `${window.innerHeight - box.height - 8}px`;

  // setTimeout: sem ele, o próprio clique que abriu o menu já o fecharia.
  setTimeout(() => {
    const close = (e) => {
      // pointerdown dispara ANTES do click. Sem esta guarda, clicar no item
      // removia o menu do DOM e o click nunca chegava ao botão — era por isso
      // que "parar de assistir" não fazia nada.
      if (e.type === 'pointerdown' && menu.contains(e.target)) return;
      menu.remove();
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', close);
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', close);
  }, 0);
}

/** Cursor de volume de uma pessoa, no menu do botão direito. */
function buildMenuVolume(userId, name, slot) {
  const bloco = document.createElement('div');
  bloco.className = 'menu-volume';

  const rotulo = document.createElement('span');
  rotulo.className = 'menu-volume-nome';
  // textContent, nunca innerHTML: nome vem do Discord, é conteúdo de terceiro.
  rotulo.textContent = `Volume de ${name}`;

  const linha = document.createElement('div');
  linha.className = 'menu-volume-linha';

  const barra = document.createElement('input');
  barra.type = 'range';
  barra.min = '0';
  barra.max = '200';
  barra.step = '5';
  barra.setAttribute('aria-label', `Volume de ${name}`);

  const valor = document.createElement('span');
  valor.className = 'menu-volume-valor';

  const mostrar = () => {
    valor.textContent = `${barra.value}%`;
  };

  barra.value = String(Math.round((volumePessoa.get(userId) ?? 1) * 100));
  mostrar();

  barra.addEventListener('input', () => {
    const nivel = Number(barra.value) / 100;
    // 100% é o padrão: não guardar significa "nunca foi mexido", e é o que
    // mantém o armazenamento pequeno depois de muita gente passar pela sala.
    if (nivel === 1) volumePessoa.delete(userId);
    else volumePessoa.set(userId, nivel);
    gravarVolumes();
    aplicarVolume(slot);
    mostrar();
  });

  linha.append(barra, valor);
  bloco.append(rotulo, linha);
  return bloco;
}

function buildAvatar(p) {
  const url = avatarUrl(p);

  const fallback = () => {
    const div = document.createElement('div');
    div.className = 'avatar';
    div.style.background = colorFor(p.id);
    div.textContent = initials(p.name);
    return div;
  };

  if (!url) return fallback();

  const img = document.createElement('img');
  img.className = 'avatar';
  img.src = url;
  img.alt = p.name;
  img.addEventListener('error', () => img.replaceWith(fallback()), { once: true });
  return img;
}

/**
 * Quem está na sala, listado na pílula do topo.
 *
 * Com telas no ar a grade passa a ser delas, então é aqui que ainda dá para ver
 * a sala inteira — inclusive quem só assiste.
 */
function buildPeopleList() {
  const list = document.createElement('div');
  list.className = 'hover-list';

  if (!participants.length) {
    const empty = document.createElement('span');
    empty.className = 'hover-empty';
    empty.textContent = 'Ninguém na sala';
    list.append(empty);
    return list;
  }

  for (const p of participants) {
    const row = document.createElement('span');
    row.className = 'hover-row';
    if (p.broadcasting) {
      const dot = document.createElement('span');
      dot.className = 'dot';
      row.append(dot);
    }
    // textContent, nunca innerHTML: nome vem do Discord, é conteúdo de terceiro.
    row.append(document.createTextNode(p.id === session?.user?.id ? `${p.name} (você)` : p.name));
    list.append(row);
  }

  return list;
}

function renderBar() {
  $('people').replaceChildren();
  $('people').insertAdjacentHTML(
    'afterbegin',
    '<svg viewBox="0 0 24 24"><path d="M17 20v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>' +
      '<circle cx="9" cy="7" r="4"/><path d="M23 20v-2a4 4 0 0 0-3-3.87"/>' +
      '<path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  );
  $('people').append(document.createTextNode(String(participants.length)));
  $('people').append(buildPeopleList());

  const casters = participants.filter((p) => p.broadcasting);

  const minhas = minhasFontes();
  const telaNoAr = minhas.has('tela') || Boolean(myBroadcast);
  const cameraNoAr = minhas.has('camera');

  const btn = $('share');
  btn.classList.toggle('live', telaNoAr);
  btn.disabled = false;

  const rotuloShare = telaNoAr ? 'Parar tela' : 'Compartilhar tela';
  btn.dataset.tip = rotuloShare;
  btn.setAttribute('aria-label', rotuloShare);

  // A câmera tem botão próprio, com o mesmo par ligar/desligar da tela — e a
  // mesma aparência: são a mesma ação em duas fontes, e pintar só uma delas
  // dizia que a outra era secundária.
  const cam = $('camera');
  cam.classList.toggle('live', cameraNoAr);
  const rotuloCam = cameraNoAr ? 'Desligar câmera' : 'Ligar câmera';
  cam.dataset.tip = rotuloCam;
  cam.setAttribute('aria-label', rotuloCam);

  // A engrenagem fica sempre à mão: parada ela edita o que valerá na próxima
  // transmissão, e é o único lugar onde essas opções existem agora. Segue os
  // botões principais para não sobrar sozinha na barra do lobby, onde não há
  // transmissão nenhuma para configurar.
  $('liveSettings').hidden = $('share').hidden;
  // Veio som e ele foi barrado: a engrenagem pisca, porque é atrás dela que
  // está a saída. Sem isso o aviso passa no toast e ninguém acha o caminho.
  const somPendente = Boolean(myBroadcast?.somBloqueado?.());
  $('liveSettings').classList.toggle('atencao', somPendente);
  $('liveSettings').dataset.tip = somPendente
    ? 'Som barrado — clique para escolher a fonte'
    : myBroadcast
      ? 'Ajustes da transmissão'
      : 'Configurações';

  // O controle de som só existe quando há som para controlar.
  const temSom = [...streams.values()].some((s) => s.audio);
  $('volumeBox').hidden = !temSom;
  renderVolume();

  renderProfileButton();

  $('pWho').textContent = casters.length ? casters.map((p) => p.name).join(', ') : 'ninguém';
}

// ------------------------------------------------------------------- streams

/** Prepara o lugar do transmissor; o decoder só nasce quando o config chega. */
function openStream(slot, userId) {
  closeStream(slot);

  const canvas = document.createElement('canvas');
  const s = {
    userId,
    canvas,
    // Vira true no primeiro quadro desenhado. Até lá o tile mostra "Conectando…"
    // em vez de uma caixa preta que não se distingue de um travamento.
    started: false,
    player: createPlayer(canvas, {
      onError: (m) => toast(m, true),
      onTamanho: () => {
        s.started = true;
        renderGrid();
      },
    }),
    // Só nasce quando a transmissão anuncia que tem som — nem toda tem.
    audio: null,
  };

  streams.set(slot, s);
}

/** Liga o som desta transmissão. Chamado quando a config de áudio chega. */
function startAudio(slot, config) {
  const s = streams.get(slot);
  if (!s) return;

  s.audio?.stop();
  s.audio = createAudio({ onError: (m) => toast(m, true), volume: volumeEfetivo(s.userId) });
  if (!s.audio.start(config)) {
    s.audio = null;
    return;
  }
  renderBar();
}

function startStream(slot, config) {
  const s = streams.get(slot);
  if (!s || !s.player.start(config)) return;
  renderGrid();
  renderBar();
  ensureStatsTimer();
}

function closeStream(slot) {
  const s = streams.get(slot);
  if (!s) return;
  s.player.stop();
  s.audio?.stop();
  s.canvas.remove();
  streams.delete(slot);
  // Quem estava no palco saiu: renderGrid escolhe a próxima na próxima passada.
  if (activeSlot === slot) activeSlot = null;
}

function endStream(slot) {
  if (!streams.has(slot)) return;
  closeStream(slot);

  if (streams.size === 0) {
    clearInterval(lagTimer);
    lagTimer = null;
    for (const id of ['pLag', 'pFps', 'pRes']) $(id).textContent = '—';
  }

  renderGrid();
  renderBar();
}

function closeAllStreams() {
  for (const slot of [...streams.keys()]) closeStream(slot);
  clearInterval(lagTimer);
  lagTimer = null;
}

/**
 * O painel mostra os números de um stream por vez: o ampliado, ou o primeiro.
 * Somar latências de fontes diferentes não significaria nada.
 */
function ensureStatsTimer() {
  if (lagTimer) return;
  lagTimer = setInterval(() => {
    const selected = streams.has(activeSlot)
      ? [activeSlot, streams.get(activeSlot)]
      : streams.entries().next().value;
    const [slot, s] = selected ?? [];
    if (!s) return;
    $('pLag').textContent = `${Math.max(0, s.player.getLag())} ms`;
    const telemetry = s.player.takeTelemetry(1);
    $('pFps').textContent = `${telemetry.renderedFps} fps`;
    const details = $('viewerDetails');
    if (details) {
      details.textContent =
        `recebidos ${telemetry.receivedFps} fps · decodificados ${telemetry.decodedFps} fps · ` +
        `fila ${telemetry.decodeQueueSize} · descartados ${telemetry.droppedFrames} · ` +
        `latência estimada ${telemetry.estimatedLatencyMs} ms`;
    }
    if (ws?.readyState === WebSocket.OPEN && Number.isInteger(slot)) {
      ws.send(JSON.stringify({
        type: 'viewer-feedback',
        slot,
        telemetry,
      }));
    }
    $('pRes').textContent = s.player.getSizes().video;

    // Quatro estados diferentes que, sem isto, parecem todos "sem som".
    if (!s.audio) $('pSom').textContent = 'a transmissão não tem áudio';
    else if (!s.audio.temSom()) $('pSom').textContent = 'aguardando o áudio…';
    else if (volume === 0) $('pSom').textContent = 'silenciado aqui';
    else $('pSom').textContent = `tocando · ${Math.round(volume * 100)}%`;
  }, 1000);
}

// ------------------------------------------------------------------- arranque

boot().catch((err) => {
  console.error(err);
  setEmpty('Não foi possível entrar', err.message);
});

async function boot() {
  // O painel inicial é estático. Sem este vigia, qualquer espera que não
  // termine fica com a cara de "Conectando…" para sempre, sem dizer o que
  // está faltando — que foi exatamente como este arranque ja travou.
  const vigia = setTimeout(() => {
    setEmpty('Está demorando…', 'Sem resposta do servidor. Ele está no ar?');
  }, 8000);

  // Buscada em paralelo, nunca antes: ela traz o diagnóstico de versão e o
  // client id de reserva, e nenhum dos dois vale segurar o login.
  const config = loadConfig();

  // Sem login o lobby ainda abre: dá para ver as salas antes de entrar. Só
  // criar e entrar é que pedem identidade.
  session = inDiscord ? await authDiscord(config) : await authWeb();

  clientId = params.get('client_id') || (await config).clientId || null;
  checkVersion((await config).asset);
  clearTimeout(vigia);

  renderProfileButton();

  // Dentro do Discord não existe lobby: a atividade já É a sala daquela call, e
  // oferecer uma lista de salas ali seria oferecer uma escolha entre uma opção.
  // No site é o contrário — não há call nenhuma para herdar, então a lista de
  // salas é a única forma de as pessoas se encontrarem.
  if (inDiscord) return entrarNaCall();

  // Lido antes de showLobby, que limpa o parâmetro da URL ao voltar ao lobby.
  const alvo = new URLSearchParams(location.search).get('sala');

  await showLobby();
  if (session && alvo) await joinById(alvo);
}

/** Abre a sala desta call, criando-a na primeira pessoa que chega. */
async function entrarNaCall() {
  setEmpty('Entrando…', 'Sala desta call');
  try {
    const tokens = await post(`${P}/api/rooms/call`, { identity: session.identity });
    openRoom(tokens, { id: tokens.roomId, name: 'Sala da call' });
  } catch (err) {
    setEmpty('Não foi possível entrar', err.message);
  }
}

// ---------------------------------------------------------------- login web

$('loginBtn').addEventListener('click', () => {
  // Sobe de convidado para conta do Discord: a identidade nova substitui a
  // antiga, então as salas criadas como convidado ficam sem dono.
  remove('identity');
  location.href = '/auth/login';
});

/**
 * Identidade fora do Discord.
 *
 * O callback do OAuth devolve o token no fragmento da URL — que não é enviado
 * ao servidor nem entra em log de proxy. Lemos, guardamos e limpamos a barra
 * de endereço para o token não ficar visível nem no histórico.
 */
async function authWeb() {
  const fragment = new URLSearchParams(location.hash.slice(1));
  const fromLogin = fragment.get('identity');

  if (fromLogin) {
    store('identity', fromLogin);
    history.replaceState(null, '', location.pathname + location.search);
  }

  let identity = fromLogin ?? read('identity');

  // Sem identidade nenhuma: entra como convidado. O login do Discord é uma
  // melhoria opcional, não um pedágio para assistir uma tela.
  if (!identity) {
    const guest = await post('/api/session-guest', { name: storedName() }, { retry: false });
    store('identity', guest.identity);
    identity = guest.identity;
  }

  const payload = decodeIdentity(identity);
  if (!payload) {
    remove('identity');
    return null;
  }

  return {
    identity,
    isGuest: String(payload.uid).startsWith('guest-'),
    call: payload.call ?? null,
    user: { id: payload.uid, name: payload.name, avatar: payload.av ?? null },
  };
}

function decodeIdentity(token) {
  try {
    const p = JSON.parse(atob(token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/')));
    // O servidor revalida a assinatura; aqui só descartamos o que já venceu,
    // para não tentar usar um token morto e cair num erro sem explicação.
    if (p.exp && p.exp * 1000 < Date.now()) return null;
    return p;
  } catch {
    return null;
  }
}

// O armazenamento pode estar bloqueado num iframe de terceiro, então todo
// acesso é protegido — perder a sessão é melhor do que a página não abrir.
function read(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* sessão só em memória */
  }
}

function remove(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* nada a limpar */
  }
}

// -------------------------------------------------------------------- lobby

/** Tokens da sala atual. null = estamos no lobby. */
let roomTokens = null;
let roomInfo = null;
let joinTarget = null;
let lastRoomState = null;
let lobbyRooms = [];

function inRoom() {
  return roomTokens !== null;
}

// A lista precisa se atualizar sozinha: salas abrem, enchem e fecham enquanto
// alguém olha o lobby parado.
const LOBBY_REFRESH_MS = 4000;
let lobbyTimer = null;

/**
 * Larga a sala atual por completo.
 *
 * Funil único: sair pelo botão, a sala fechar sozinha e o arranque precisam
 * deixar exatamente o mesmo estado para trás. Parar a transmissão vem primeiro
 * porque a captura da aba externa só para se o servidor avisar, e depois do
 * close() não sobra por onde avisar.
 */
function limparSala() {
  stopMyBroadcast();

  closeAllStreams();
  available.clear();
  watching.clear();
  participants = [];
  lastRoomState = null;
  activeSlot = null;
  telaCheia = false;

  if (roomInfo) remove(`sala:${roomInfo.id}`);
  roomTokens = null;
  roomInfo = null;
  setRoomUrl(null);

  ws?.close();
  ws = null;
}

async function showLobby() {
  limparSala();

  $('lobby').hidden = false;
  $('grid').hidden = true;
  $('empty').hidden = true;
  $('roomPill').hidden = true;
  $('leaveRoom').hidden = true;
  $('roomSettings').hidden = true;
  $('share').hidden = true;
  $('camera').hidden = true;
  $('liveSettings').hidden = true;

  // O dock inteiro sai de cena: todo controle dele é de dentro da sala, e o
  // cabeçalho do lobby já traz perfil e criar sala.
  $('fullscreen').hidden = true;
  $('settings').hidden = true;
  $('settings').classList.remove('on');
  $('panel').hidden = true;
  $('profile').hidden = true;

  // O login só aparece para convidado: quem já entrou pelo Discord não tem o
  // que melhorar.
  $('loginBtn').hidden = inDiscord || !session?.isGuest;
  $('people').hidden = true;

  await loadRooms();

  clearInterval(lobbyTimer);
  lobbyTimer = setInterval(() => {
    // Nenhum modal aberto: recarregar sob o cursor tiraria o card do lugar no
    // meio de um clique.
    const busy = ['createModal', 'joinModal'].some((id) => !$(id).hidden);
    if (!busy && !$('lobby').hidden) loadRooms();
  }, LOBBY_REFRESH_MS);
}

async function loadRooms() {
  const list = $('roomList');

  let rooms;
  try {
    rooms = (await post(`${P}/api/rooms/list`, { identity: session?.identity })).rooms ?? [];
  } catch (err) {
    list.replaceChildren(msgRow(`Não foi possível carregar: ${err.message}`));
    return;
  }

  lobbyRooms = rooms;

  const cards = rooms.map(roomCard);

  if (!cards.length) {
    list.replaceChildren(msgRow('Nenhuma sala aberta. Crie a primeira.'));
    return;
  }

  list.replaceChildren(...cards);
}

function msgRow(text) {
  const el = document.createElement('div');
  el.className = 'lobby-empty';
  el.textContent = text;
  return el;
}

function roomCard(room) {
  const card = document.createElement('button');
  card.className = 'room-card';

  const top = document.createElement('div');
  top.className = 'room-card-top';

  if (room.locked) {
    top.insertAdjacentHTML(
      'afterbegin',
      '<svg viewBox="0 0 24 24"><rect x="4" y="11" width="16" height="10" rx="2"/>' +
        '<path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
    );
  }

  const name = document.createElement('span');
  name.className = 'room-card-name';
  // textContent: nome de sala é escrito por outra pessoa.
  name.textContent = room.name;
  top.append(name);

  const meta = document.createElement('span');
  meta.className = 'room-card-meta';
  const pessoas = room.people === 1 ? '1 pessoa' : `${room.people} pessoas`;
  meta.textContent = `${pessoas} · por ${room.owner}`;

  card.append(top, meta);

  if (room.streams > 0) {
    const live = document.createElement('span');
    live.className = 'room-card-meta room-live';
    live.textContent = room.streams === 1 ? '1 tela no ar' : `${room.streams} telas no ar`;
    card.append(live);
  }

  card.addEventListener('click', () => enterRoom(room));
  return card;
}

async function enterRoom(room, password) {
  if (!session) return;

  try {
    const tokens = await post(`${P}/api/rooms/join`, {
      identity: session.identity,
      roomId: room.id,
      password: password ?? '',
    });
    openRoom(tokens, room);
  } catch (err) {
    // 403 numa sala trancada é o caminho normal: pedir a senha.
    if (err.status === 403 && !password) return askPassword(room);
    if (err.status === 403) return askPassword(room, 'Senha incorreta.');
    if (err.status === 429) return askPassword(room, err.detail);
    if (err.status === 404) {
      toast('Essa sala já fechou.', true);
      remove(`sala:${room.id}`);
      setRoomUrl(null);
      loadRooms();
      return;
    }
    toast(err.message, true);
  }
}

function askPassword(room, error) {
  joinTarget = room;
  $('joinSub').textContent = `"${room.name}" pede uma senha para entrar.`;
  $('joinError').textContent = error ?? '';
  $('joinError').hidden = !error;
  if (!error) $('joinPass').value = '';
  $('joinModal').hidden = false;
  $('joinPass').focus();
}

/**
 * Entra na sala apontada pela URL.
 *
 * Serve para os dois casos: recarregar a página estando numa sala, e abrir um
 * link `?sala=<id>` que alguém mandou.
 */
async function joinById(id) {
  // Token guardado de uma visita anterior: entra sem pedir a senha de novo.
  const saved = read(`sala:${id}`);
  if (saved) {
    try {
      const { tokens, name } = JSON.parse(saved);
      openRoom(tokens, { id, name });
      return;
    } catch {
      remove(`sala:${id}`);
    }
  }

  // Link recebido de fora: usa o fluxo normal, que pede a senha quando precisa.
  // O nome vem da lista já carregada; salas com senha também aparecem nela.
  const known = lobbyRooms.find((r) => r.id === id);
  await enterRoom(known ?? { id, name: 'Sala' });
}

/** Mantém `?sala=` na barra de endereço, preservando os parâmetros do Discord. */
function setRoomUrl(id) {
  const url = new URL(location.href);
  if (id) url.searchParams.set('sala', id);
  else url.searchParams.delete('sala');
  history.replaceState(null, '', url);
}

function openRoom(tokens, room) {
  roomTokens = tokens;
  roomInfo = room;

  setRoomUrl(room.id);
  store(`sala:${room.id}`, JSON.stringify({ tokens, name: room.name }));

  $('lobby').hidden = true;
  $('empty').hidden = false;
  $('share').hidden = false;
  $('camera').hidden = false;
  $('people').hidden = false;
  $('settings').hidden = false;
  $('profile').hidden = false;
  $('loginBtn').hidden = true;

  // Dentro do Discord não há lista para onde voltar nem outra sala com que
  // confundir esta: quem fecha a atividade é o próprio Discord.
  $('roomPill').hidden = inDiscord;
  $('leaveRoom').hidden = inDiscord;

  clearInterval(lobbyTimer);
  lobbyTimer = null;
  $('roomPill').textContent = room.name;

  setEmpty('Entrando…', room.name);
  connect();
}

// A limpeza toda — inclusive parar de transmitir — vive em showLobby.
$('leaveRoom').addEventListener('click', () => showLobby());

/** Client id e versão do bundle, decididos pelo servidor. */
async function loadConfig() {
  try {
    const r = await fetch(`${P}/api/config`, {
      cache: 'no-store',
      // fetch não expira sozinho. Sem prazo, um pedido que trava segura tudo o
      // que vem depois — e nada aqui vale prender o arranque.
      signal: AbortSignal.timeout(6000),
    });
    return await r.json();
  } catch {
    // Nem o id nem o diagnóstico podem impedir a sala de abrir.
    return {};
  }
}

/**
 * Detecta bundle velho e recarrega.
 *
 * O index.html vai com no-store, mas o cliente do Discord pode entregar uma
 * cópia antiga assim mesmo — e o iframe fica preso num build anterior sem
 * nenhum sinal visível, o que já custou horas de diagnóstico enganoso.
 *
 * Comparamos o nome do próprio arquivo (que leva hash de conteúdo) com o que o
 * servidor diz ser o atual.
 */
function checkVersion(asset) {
  const mine = import.meta.url.split('/').pop().split('?')[0];

  // Em desenvolvimento o Vite serve `main.js` sem hash nenhum, enquanto o
  // servidor relata o nome do último build. Comparar os dois acusa uma
  // desatualização que não existe e joga a página num recarregamento eterno.
  //
  // A pergunta "isto é um build?" é respondida pelo próprio nome do arquivo, e
  // não por `import.meta.env.DEV`. O DEV depende de NODE_ENV, que este projeto
  // define como "development" no .env — e o Vite lê esse arquivo. Resultado: no
  // build de produção o DEV vinha true, e a função inteira era removida por
  // codigo morto. Ela existia sem nunca rodar.
  if (!/^index-[A-Za-z0-9_-]+.js$/.test(mine)) return;

  if (!asset || asset === mine) return;

  // Dentro do Discord a página não se recarrega: o iframe pede a página de novo
  // à hospedagem, e basta ela devolver X-Frame-Options para o navegador se
  // recusar a desenhar — vira o retângulo branco. Fechar e reabrir a atividade
  // faz o Discord montar o iframe do jeito certo, e é o que se pede aqui.
  //
  // O aviso continua: detectar a versão velha é o motivo desta função existir,
  // e é dentro do Discord que ela mais serve, porque o cliente serve bundle
  // antigo sem nenhum sinal visível.
  if (inDiscord) {
    toast('Esta atividade está numa versão antiga. Feche e abra de novo para atualizar.', true);
    return;
  }

  // Se recarregar não resolveu, o HTML servido também está velho: avisa em
  // vez de entrar em laço de reload.
  if (sessionStorage.getItem('reloadedFor') === asset) {
    toast('Versão desatualizada e o cache não cede. Recarregue a página.', true);
    return;
  }
  sessionStorage.setItem('reloadedFor', asset);
  location.reload();
}

/**
 * @param {Promise<{clientId?:string}>|string} fonteDoId promessa da config, ou
 * o id direto quando já se sabe qual é (o caminho da renovação de sessão).
 */
async function authDiscord(fonteDoId) {
  // O Discord injeta client_id na URL do iframe. Preferir essa via tira o login
  // da dependência de uma ida ao servidor: quando ela demorava, a atividade
  // ficava parada sem nada para mostrar. A config entra só como reserva.
  const id =
    params.get('client_id') ||
    (typeof fonteDoId === 'string' ? fonteDoId : (await fonteDoId)?.clientId);

  if (!id) {
    throw new Error('O servidor está sem as credenciais do Discord. Rode: npm run configurar');
  }

  const clientId = id;
  sdk = new DiscordSDK(clientId);
  await sdk.ready();

  const { code } = await sdk.commands.authorize({
    client_id: clientId,
    response_type: 'code',
    state: '',
    prompt: 'none',
    // Só precisamos de /users/@me. Menos escopo, menos atrito no consentimento.
    scope: ['identify'],
  });

  const { access_token } = await post(`${P}/api/token`, { code, client_id: clientId });
  await sdk.commands.authenticate({ access_token });

  // guild/channel vão junto para o servidor poder confirmar, pelo Discord, que
  // a pessoa está mesmo naquela call.
  return post(`${P}/api/session`, {
    access_token,
    instance_id: sdk.instanceId,
    guild_id: sdk.guildId,
    channel_id: sdk.channelId,
  });
}

/**
 * Emite uma identidade nova, jogando fora a que o servidor recusou.
 *
 * O crachá vive no localStorage e vale até o servidor trocar o segredo que o
 * assina. Quando isso acontece — reinstalação, mudança de máquina, rotação de
 * segredo —, todo crachá guardado vira inválido de uma vez. Sem isto o cliente
 * insistia no mesmo token para sempre e a pessoa ficava presa em "sessão
 * inválida", sem nada na interface que resolvesse.
 */
async function renovarIdentidade() {
  remove('identity');
  try {
    session = inDiscord ? await authDiscord(clientId) : await authWeb();
    renderProfileButton();
    return session?.identity ?? null;
  } catch {
    return null;
  }
}

/**
 * `retry` existe para a chamada que renova a identidade não cair nela mesma:
 * um 401 ali significa que renovar não resolve, e insistir viraria laço.
 */
async function post(url, body, { retry = true } = {}) {
  let r;
  try {
    r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      // Um pedido pendurado é pior que um pedido que falha: o que falha diz
      // alguma coisa, o pendurado só deixa a tela parada.
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    const msg =
      err.name === 'TimeoutError'
        ? 'O servidor não respondeu a tempo.'
        : 'Não foi possível falar com o servidor.';
    throw Object.assign(new Error(msg), { status: 0 });
  }

  const data = await r.json().catch(() => ({}));

  if (!r.ok) {
    // 401 numa chamada que levava identidade quer dizer crachá morto, não falta
    // de permissão: renova uma vez e repete, em vez de devolver um erro que a
    // pessoa não tem como resolver.
    if (r.status === 401 && retry && body?.identity) {
      const nova = await renovarIdentidade();
      if (nova) return post(url, { ...body, identity: nova }, { retry: false });
    }

    // O status carrega significado (403 = senha, 429 = bloqueio, 404 = sala
    // fechou), então vai junto do erro em vez de virar texto.
    const err = new Error(data.error ?? `Servidor respondeu ${r.status}.`);
    err.status = r.status;
    err.detail = data.error;
    throw err;
  }
  return data;
}

// ----------------------------------------------------------------- websocket

function connect() {
  if (!roomTokens) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(
    `${proto}://${location.host}${P}/ws?t=${encodeURIComponent(roomTokens.viewerToken)}`,
  );
  ws.binaryType = 'arraybuffer';

  let abriu = false;

  ws.addEventListener('open', () => {
    abriu = true;
    reconnectDelay = 1000;
    $('grid').hidden = false;
    setEmpty('Ninguém na sala', 'Aguardando participantes.');

    // O apelido é do cliente, então precisa ser reenviado a cada conexão —
    // inclusive nas reconexões, senão o nome volta ao do Discord sozinho.
    const saved = storedName();
    if (saved && saved !== session.user.name) {
      session.user.name = saved;
      ws.send(JSON.stringify({ type: 'rename', name: saved }));
    }
  });

  ws.addEventListener('message', (e) => {
    // Primeiro byte é o slot, segundo é o tipo: um diz de quem, o outro diz
    // para qual decodificador — som e imagem dividem o mesmo canal.
    if (typeof e.data !== 'string') {
      const view = new DataView(e.data);
      const s = streams.get(view.getUint8(0));
      if (!s) return;
      if (view.getUint8(1) === 3) s.audio?.push(e.data);
      else s.player.push(e.data);
      return;
    }

    const msg = JSON.parse(e.data);

    if (msg.type === 'state') {
      participants = msg.participants ?? [];
      abas.clear();
      for (const uid of msg.abas ?? []) abas.add(uid);

      lastRoomState = msg.room ?? null;

      // A senha da sala só aparece para quem a criou.
      $('roomPill').textContent =
        `${lastRoomState?.locked ? '🔒 ' : ''}${lastRoomState?.name ?? ''}`;
      $('roomSettings').hidden = lastRoomState?.ownerId !== session?.user?.id;
      $('roomSettings').classList.toggle('on', Boolean(lastRoomState?.locked));

      // Limpa o que sumiu sem stream-stop (queda abrupta, por exemplo).
      const live = new Set((msg.streams ?? []).map((s) => s.slot));
      for (const s of msg.streams ?? []) {
        const info = available.get(s.slot) ?? { userId: s.userId, config: null };
        info.watchers = s.watchers ?? [];
        // Servidor antigo não manda fonte; tela é o que sempre houve.
        info.fonte = s.fonte ?? 'tela';
        available.set(s.slot, info);
      }
      for (const slot of [...available.keys()]) if (!live.has(slot)) available.delete(slot);
      for (const slot of [...streams.keys()]) if (!live.has(slot)) closeStream(slot);
      for (const slot of [...watching]) if (!live.has(slot)) watching.delete(slot);
      renderGrid();
      renderBar();
    } else if (msg.type === 'stream-start') {
      // Só anuncia; ninguém assiste até pedir.
      available.set(msg.slot, { userId: msg.userId, fonte: msg.fonte ?? 'tela', config: null });
      watching.delete(msg.slot);
      closeStream(msg.slot);
      renderGrid();
    } else if (msg.type === 'config') {
      const info = available.get(msg.slot);
      if (info) info.config = msg.config;
      if (watching.has(msg.slot)) {
        openStream(msg.slot, info?.userId ?? msg.slot);
        startStream(msg.slot, msg.config);
      }
    } else if (msg.type === 'audio-config') {
      // Pode chegar antes de eu pedir para assistir; aí não há o que ligar, e
      // o servidor reenvia assim que o pedido chegar.
      if (watching.has(msg.slot)) startAudio(msg.slot, msg.config);
    } else if (msg.type === 'stream-stop') {
      available.delete(msg.slot);
      watching.delete(msg.slot);
      endStream(msg.slot);
    } else if (msg.type === 'room-gone') {
      roomTokens = null;
      // No Discord a sala é a da call: ela é recriada e a atividade volta para
      // ela. No site, quem some é a sala escolhida, então o lugar é a lista.
      if (inDiscord) {
        limparSala();
        entrarNaCall();
      } else {
        toast('A sala foi fechada.', true);
        showLobby();
      }
    } else if (msg.type === 'error') {
      toast(msg.message, true);
    }
  });

  ws.addEventListener('close', () => {
    closeAllStreams();
    available.clear();
    watching.clear();
    participants = [];
    renderGrid();

    // Saímos da sala de propósito: nada a reconectar.
    if (!roomTokens) return;

    // Fechou sem nunca abrir: o token da sala foi recusado. Guardado, ele não
    // vale mais depois que o servidor troca o segredo — e reconectar com o
    // mesmo token repete o 401 até o fim dos tempos. Descartar e recomeçar é o
    // único caminho que sai daqui.
    if (!abriu) {
      const id = roomInfo?.id;
      limparSala();
      if (id) remove(`sala:${id}`);
      toast('Sua sessão expirou. Entrando de novo…');
      if (inDiscord) entrarNaCall();
      else showLobby();
      return;
    }

    setEmpty('Reconectando…', 'A conexão com a sala caiu.');
    // Backoff — evita martelar o servidor se ele estiver fora do ar.
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 15_000);
  });

  ws.addEventListener('error', () => ws.close());
}

// --------------------------------------------------------------------- ações

/**
 * Estou transmitindo?
 *
 * myBroadcast entra no OU porque o `state` leva um instante para chegar, e sem
 * isso o botão pisca de volta para "Compartilhar" logo após começar.
 */
/** As fontes que eu estou transmitindo agora, segundo o servidor. */
function minhasFontes() {
  const meu = session?.user?.id;
  if (!meu) return new Set();
  return new Set(slotsOf(meu).map((slot) => available.get(slot)?.fonte ?? 'tela'));
}

/**
 * Existe uma aba de captura minha conectada?
 *
 * Quem responde é o servidor, pela lista `abas` do estado. Antes isto era
 * deduzido do que estava no ar, e errava justamente no caso que mais importa:
 * a aba recém-aberta, ainda sem transmitir, ficava invisível — e um novo clique
 * abria outra em cima dela.
 */
function abaAberta() {
  return abas.has(session?.user?.id);
}

/**
 * As opções da próxima transmissão, editadas pela engrenagem.
 *
 * Ficam no localStorage porque são preferência de quem transmite, não estado da
 * sala: quem escolheu 5 Mb/s uma vez não quer reescolher a cada abertura. E
 * ficam aqui, e não num modal que aparece antes de cada início, porque decidir
 * qualidade toda vez que se quer mostrar a tela é atrito no caminho curto.
 */
const AJUSTES_PADRAO = { bitrate: 2500000, fps: 30 };

let ajustes = (() => {
  try {
    return { ...AJUSTES_PADRAO, ...JSON.parse(read('ajustes') ?? '{}') };
  } catch {
    return { ...AJUSTES_PADRAO };
  }
})();

/**
 * As opções no formato que a página de captura lê da URL.
 *
 * O som não vem aqui: a tela sempre o pede e a câmera nunca, então quem decide
 * é a caixa "Compartilhar o áudio" do seletor do navegador — que já é uma
 * escolha. Repetir a pergunta aqui só criava um jeito de a captura ir muda sem
 * querer, e a câmera não leva o microfone porque a voz já anda pela call.
 */
function opcoesDaFonte() {
  return {
    q: String(ajustes.bitrate),
    fps: String(ajustes.fps),
  };
}

/**
 * Liga uma fonte pelo caminho mais curto que existir para ela.
 *
 * Com uma aba já aberta, o pedido vai por ela em vez de abrir outra: seriam
 * duas janelas para a pessoa manter vivas, e a que existe já faz as duas
 * coisas. A aba resolve o que dá — câmera ela liga sozinha, tela precisa do
 * clique lá, porque getDisplayMedia exige gesto do usuário.
 */
/** Nome da aba de captura, para reencontrá-la em vez de empilhar outra. */
const JANELA_CAPTURA = 'discord-screen-captura';

function ligarFonte(fonte) {
  if (abaAberta()) return trazerAba(fonte);
  abrirCaptura(fonte);
}

/**
 * A aba de captura já existe: leva a pessoa até ela.
 *
 * O pedido pelo WebSocket sozinho não resolvia. Ele chega, a aba atende — mas
 * em segundo plano, onde ninguém vê, e uma aba não consegue se trazer para a
 * frente. Avisar por toast que ela existe deixava a pessoa procurando entre as
 * janelas qual era.
 */
function trazerAba(fonte) {
  // Dentro do Discord a aba foi parar no navegador do sistema, que é outro
  // processo: daqui não há como focá-la. Abrir de novo é o que existe, e a
  // fonte vai na URL, então a aba nova já nasce no que se pediu. Se a antiga
  // continuar aberta, ficam duas — é o preço da fronteira entre os processos.
  if (inDiscord) return abrirLink(fonte);

  // Fora do Discord a aba é nossa, e o nome fixo a encontra. String vazia de
  // propósito: passar a URL faria o navegador *navegar* nela, e navegar é
  // recarregar — mataria a transmissão que estiver no ar ali dentro.
  const aba = window.open('', JANELA_CAPTURA);
  if (!aba) return abrirLink(fonte);

  // `window.open('')` num nome que não existe cria uma aba em branco em vez de
  // achar alguma. Aí ela precisa ser levada para o lugar certo.
  let emBranco = false;
  try {
    emBranco = aba.location.href === 'about:blank';
  } catch {
    /* já navegou para outra origem: é a aba de captura mesmo */
  }
  if (emBranco) {
    aba.location.href = urlDaCaptura(fonte).toString();
    aba.focus();
    return;
  }

  aba.focus();
  // A URL não mudou, então o pedido tem de ir por fora dela. As opções vão
  // junto: a aba pode estar aberta desde antes da última mexida na engrenagem.
  ws?.send(JSON.stringify({ type: 'start-broadcast', fonte, opcoes: opcoesDaFonte() }));
}

async function abrirCaptura(fonte) {
  if (!roomTokens) return;

  // Só a tela tem chance de nascer aqui dentro; o Discord anula o getUserMedia
  // no iframe, então a câmera vai direto para a aba.
  if (fonte === 'tela' && (await broadcastFromHere())) return;

  abrirLink(fonte);
}

/** O endereço da página de captura, já com as opções e a fonte pedida. */
function urlDaCaptura(fonte) {
  const url = new URL(roomTokens.shareUrl);
  for (const [chave, valor] of Object.entries(opcoesDaFonte())) {
    url.searchParams.set(chave, valor);
  }
  url.searchParams.set('fonte', fonte);
  return url;
}

async function abrirLink(fonte) {
  if (!roomTokens) return;
  const url = urlDaCaptura(fonte).toString();

  if (inDiscord) {
    try {
      const res = await sdk.commands.openExternalLink({ url });
      // Clientes antigos devolvem null; só tratamos false como recusa explícita.
      if (res?.opened === false) {
        toast('Você recusou abrir o link. Sem isso não dá para capturar a tela.', true);
      }
    } catch (err) {
      toast(`Não foi possível abrir o link: ${err.message}`, true);
    }
    return;
  }

  window.open(url, JANELA_CAPTURA);
}

/**
 * Encerra a minha transmissão, tenha ela nascido aqui ou na aba externa.
 *
 * Funil único de propósito: parar pelo botão, sair da sala e a sala fechar
 * precisam encerrar do mesmo jeito. Deixar a captura viva depois de sair é
 * vazamento de tela, não detalhe de interface — e a aba externa tem conexão
 * própria, então só o servidor consegue mandá-la parar.
 */
function stopMyBroadcast(fonte = null) {
  // O myBroadcast é sempre a tela: é a única fonte que a atividade consegue
  // capturar por conta própria.
  if (!fonte || fonte === 'tela') {
    myBroadcast?.stop();
    myBroadcast = null;
  }
  if (participants.some((p) => p.broadcasting && p.id === session?.user?.id)) {
    // Sem fonte o servidor derruba tudo — que é o certo para sair da sala.
    ws?.send(JSON.stringify({ type: 'stop-broadcast', ...(fonte ? { fonte } : {}) }));
  }
}

$('share').addEventListener('click', () => {
  if (!session) return;

  if (minhasFontes().has('tela') || myBroadcast) {
    stopMyBroadcast('tela');
    renderBar();
    return;
  }

  ligarFonte('tela');
});

$('camera').addEventListener('click', () => {
  if (!session) return;

  if (minhasFontes().has('camera')) {
    stopMyBroadcast('camera');
    renderBar();
    return;
  }

  ligarFonte('camera');
});

/**
 * O mesmo modal serve para configurar antes e para ajustar no ar.
 *
 * Em 'config' ele edita os padrões guardados e o botão salva; em 'live' vem com
 * os valores da transmissão em curso e o botão aplica na hora. Começar deixou
 * de passar por aqui: os botões da barra iniciam direto com o que está salvo.
 */
let modalMode = 'config';

function openModal(mode) {
  modalMode = mode;
  const live = mode === 'live';

  $('modalTitle').textContent = live ? 'Ajustes da transmissão' : 'Configurações';
  $('modalSub').textContent = live
    ? 'Vale na hora, sem derrubar quem está assistindo.'
    : 'Valem para a próxima vez que você começar a transmitir.';
  $('modalGo').textContent = live ? 'Aplicar' : 'Salvar';
  $('modalSwap').hidden = !live;
  $('modalNote').hidden = live;

  $('modalSom').hidden = !live || !myBroadcast;
  if (live && myBroadcast) {
    $('modalSom').textContent = myBroadcast.temSom()
      ? 'Trocar a fonte do som'
      : 'Som de uma aba ou janela';

    const s = myBroadcast.getSettings();
    $('mQuality').value = String(s.bitrate);
    $('mFps').value = String(s.fps);
  } else {
    $('mQuality').value = String(ajustes.bitrate);
    $('mFps').value = String(ajustes.fps);
  }

  $('modal').hidden = false;
}

// Com algo no ar a engrenagem ajusta aquela transmissão; parada, ela edita o
// que valerá na próxima.
$('liveSettings').addEventListener('click', () => openModal(myBroadcast ? 'live' : 'config'));

/** Espelha o volume atual no botão e no cursor, sem tocar no áudio. */
function renderVolume() {
  const pct = Math.round(volume * 100);
  $('volume').value = String(pct);
  $('volumeVal').textContent = pct + '%';

  const rotulo = volume === 0 ? 'Ligar o som' : 'Silenciar';
  $('mute').setAttribute('aria-label', rotulo);
  $('mute').title = rotulo;
  $('mute').classList.toggle('on', volume === 0);
  $('muteOn').hidden = volume === 0;
  $('muteOff').hidden = volume !== 0;
}

function setVolume(valor) {
  volume = Math.min(1, Math.max(0, valor));
  if (volume > 0) volumeAntes = volume;
  store('volume', String(volume));
  // O geral mudou: cada stream recalcula, porque o dele é o produto dos dois.
  for (const slot of streams.keys()) aplicarVolume(slot);
  renderVolume();
}

// Clique no alto-falante silencia e devolve; o cursor ajusta no meio termo.
$('mute').addEventListener('click', () => setVolume(volume === 0 ? volumeAntes : 0));
$('volume').addEventListener('input', (e) => setVolume(Number(e.target.value) / 100));

$('modalSwap').addEventListener('click', async () => {
  if (!myBroadcast) return;
  try {
    await myBroadcast.changeScreen();
    closeModal();
  } catch (err) {
    // Cancelar o seletor é rotina, não erro.
    if (err.name !== 'NotAllowedError') toast(err.message, true);
  }
});

// A saída para quem quer tela inteira COM som: o vídeo continua o mesmo e o som
// passa a vir de uma aba ou de uma janela, que são as fontes isoladas do Discord.
$('modalSom').addEventListener('click', async () => {
  if (!myBroadcast) return;
  try {
    await myBroadcast.trocarSom();
    toast('Som ligado, vindo da fonte escolhida.');
    closeModal();
    renderBar();
  } catch (err) {
    if (err.name !== 'NotAllowedError') toast(err.message, true);
  }
});

const closeModal = () => {
  $('modal').hidden = true;
};

/**
 * Transmite a partir daqui mesmo, sem abrir aba.
 *
 * Só funciona se o Discord conceder `display-capture` ao iframe da Activity.
 * Retorna true quando o fluxo foi resolvido — transmitindo, ou a pessoa
 * cancelou o seletor — e false quando resta cair para a aba externa.
 *
 * NotAllowedError é ambíguo: vale tanto para "a plataforma bloqueou" quanto
 * para "a pessoa cancelou". O tempo separa os dois — bloqueio de política falha
 * na hora, sem nunca desenhar o seletor, enquanto cancelar exige que alguém
 * tenha visto a janela e clicado.
 */
async function broadcastFromHere() {
  if (!navigator.mediaDevices?.getDisplayMedia || !window.VideoEncoder) return false;

  if (!roomTokens) return false;
  const shareToken = new URL(roomTokens.shareUrl).searchParams.get('t');
  if (!shareToken) return false;

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';

  const b = createBroadcaster({
    wsUrl: `${proto}://${location.host}${P}/ws?t=${encodeURIComponent(shareToken)}`,
    bitrate: ajustes.bitrate,
    fps: ajustes.fps,
    audio: true,
    onAviso: (m) => toast(m, true),
    onEnd: () => {
      myBroadcast = null;
      renderBar();
    },
  });

  const startedAt = performance.now();
  try {
    await b.start();
    myBroadcast = b;
    closeModal();
    renderBar();
    return true;
  } catch (err) {
    const showedPicker = performance.now() - startedAt > 250;
    if (err.name === 'NotAllowedError' && showedPicker) {
      closeModal();
      return true;
    }
    return false;
  }
}

$('modalCancel').addEventListener('click', closeModal);

// Clique no fundo fecha; dentro do card, não.
$('modal').addEventListener('click', (e) => {
  if (e.target === $('modal')) closeModal();
});

$('modalGo').addEventListener('click', () => {
  // Ajuste no ar: aplica e fecha, sem tocar na captura.
  if (modalMode === 'live') {
    const bitrate = Number($('mQuality').value);
    const fps = Number($('mFps').value);
    myBroadcast?.setQuality({ bitrate, fps });
    // Ajustar no ar também é escolher: o que valeu agora vale na próxima.
    ajustes = { ...ajustes, bitrate, fps };
    store('ajustes', JSON.stringify(ajustes));
    closeModal();
    return;
  }

  ajustes = {
    bitrate: Number($('mQuality').value),
    fps: Number($('mFps').value),
  };
  store('ajustes', JSON.stringify(ajustes));

  // A aba precisa saber na hora: ela mostra estas opções e usa a qualidade no
  // que já está no ar. Sem isto o resumo dela envelhecia em silêncio.
  ws?.send(JSON.stringify({ type: 'config-broadcast', opcoes: opcoesDaFonte() }));

  closeModal();
});

// ------------------------------------------------------- modais das salas

$('newRoom').addEventListener('click', () => {
  if (!session) return;
  $('createName').value = '';
  $('createPass').value = '';
  $('createModal').hidden = false;
  $('createName').focus();
});

$('createCancel').addEventListener('click', () => ($('createModal').hidden = true));
$('createModal').addEventListener('click', (e) => {
  if (e.target === $('createModal')) $('createModal').hidden = true;
});

$('createGo').addEventListener('click', async () => {
  const name = $('createName').value.trim();

  try {
    const tokens = await post(`${P}/api/rooms/create`, {
      identity: session.identity,
      name,
      password: $('createPass').value || null,
    });
    $('createModal').hidden = true;
    openRoom(tokens, {
      id: tokens.roomId,
      // O servidor decide o nome quando fica em branco.
      name: name || `Sala de ${session.user.name}`,
      owner: session.user.name,
    });
  } catch (err) {
    toast(err.message, true);
  }
});

$('joinCancel').addEventListener('click', () => ($('joinModal').hidden = true));
$('joinModal').addEventListener('click', (e) => {
  if (e.target === $('joinModal')) $('joinModal').hidden = true;
});
$('joinPass').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('joinGo').click();
});

$('joinGo').addEventListener('click', async () => {
  if (!joinTarget) return;
  $('joinModal').hidden = true;
  await enterRoom(joinTarget, $('joinPass').value);
});

// Ajustes da sala: só o dono muda a senha, e o servidor confere de novo.
$('roomCancel').addEventListener('click', () => ($('roomModal').hidden = true));
$('roomModal').addEventListener('click', (e) => {
  if (e.target === $('roomModal')) $('roomModal').hidden = true;
});

$('roomSave').addEventListener('click', async () => {
  try {
    const r = await post(`${P}/api/rooms/password`, {
      identity: session.identity,
      roomId: roomTokens.roomId,
      password: $('roomPass').value || '',
    });
    $('roomModal').hidden = true;
    toast(r.locked ? 'Sala protegida com senha.' : 'Senha removida.');
  } catch (err) {
    toast(err.message, true);
  }
});

function openRoomSettings() {
  $('roomSub').textContent = roomInfo?.name ?? '';
  $('roomPass').value = '';
  $('roomModal').hidden = false;
  $('roomPass').focus();
}

$('roomSettings').addEventListener('click', openRoomSettings);

// ----------------------------------------------------------------- painel

$('settings').addEventListener('click', () => {
  const panel = $('panel');
  panel.hidden = !panel.hidden;
  $('settings').classList.toggle('on', !panel.hidden);
});

/**
 * As barras somem depois de um tempo com o cursor parado, e voltam ao primeiro
 * movimento. Só têm efeito em tela cheia, onde elas flutuam sobre o vídeo — no
 * modo normal ocupam faixa própria e não há nada a desobstruir.
 *
 * O relógio corre sempre, mesmo fora da tela cheia: um `if` aqui pagaria uma
 * consulta ao estado a cada movimento do mouse para poupar um setTimeout, e
 * quem decide se a classe pinta alguma coisa já é o CSS.
 */
const OCIO = 1500;
let ocioso = null;

function acordarBarras() {
  $('app').classList.remove('ocioso');
  clearTimeout(ocioso);
  ocioso = setTimeout(() => $('app').classList.add('ocioso'), OCIO);
}

// pointerdown junto com o movimento: em tela sensível ao toque não há mousemove
// nenhum, e sem isto as barras sumiriam para sempre no primeiro silêncio.
window.addEventListener('mousemove', acordarBarras);
window.addEventListener('pointerdown', acordarBarras);
acordarBarras();

// O estado visual do botão é decidido por renderGrid, que é quem sabe se há
// tela no palco — aqui só se troca a intenção.
$('fullscreen').addEventListener('click', () => {
  if (activeSlot === null) return;
  telaCheia = !telaCheia;
  renderGrid();
});

window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;

  // Fecha o modal aberto mais recente antes de mexer no modo ampliado.
  for (const id of ['profileModal', 'roomModal', 'joinModal', 'createModal', 'modal']) {
    if (!$(id).hidden) {
      $(id).hidden = true;
      return;
    }
  }

  // Esc sai da tela cheia — é o reflexo de todo mundo.
  if (telaCheia) {
    telaCheia = false;
    renderGrid();
  }
});

/**
 * Diagnóstico: tenta capturar a tela direto de dentro do iframe.
 *
 * Se um dia o Discord conceder `display-capture` ao iframe da Activity, isso
 * funciona e a aba externa deixa de ser necessária.
 */
$('probe').addEventListener('click', async () => {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    toast('getDisplayMedia nem existe neste contexto — iframe sem permissão.', true);
    return;
  }
  try {
    const s = await navigator.mediaDevices.getDisplayMedia({ video: true });
    s.getTracks().forEach((t) => t.stop());
    toast('Funcionou! O iframe permite captura direta — dá para dispensar a aba externa.');
  } catch (err) {
    toast(`Bloqueado (${err.name}): ${err.message}`, true);
  }
});
