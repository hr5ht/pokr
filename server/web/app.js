'use strict';

// Timing matches the phone app and the server.
const PING_MS = 5000;
const SILENT_MS = 12000; // a dead connection can look open for minutes, so go by replies
const SWAP_SOCKET_MS = 270000; // Vercel closes sockets at 5 minutes, so move on first
const WATCH_MS = 1000;
const WARN_AFTER_MS = 2000; // a quick reconnect shouldn't flash a warning
const ERROR_SHOWN_MS = 3000;
const SENT_LOCK_MS = 3000;
const FOLD_PAUSE_MS = 3000;
const SHOWDOWN_PAUSE_MS = 7000;
const REQUEST_TIMEOUT_MS = 15000;
const SHEET_CLOSE_MS = 300;
const DRAG_TO_CLOSE = 110;
const BAD_MESSAGE = 4400;
const NOT_AT_TABLE = new Set([4001, 4003, 4004]);

const NAMES = ['Lucky Duck', 'River Rat', 'Big Blind', 'Card Shark', 'Pocket Rocket', 'Slow Roll', 'Fish Taco', 'Ace Ventura'];
const OPTIONS = [
  { key: 'bb', title: 'Big blind', values: [2, 10, 20, 50, 100] },
  { key: 'stack', title: 'Starting chips', values: [500, 1000, 2000, 5000] },
  { key: 'timer', title: 'Seconds per turn', values: [15, 30, 60] },
];
// Strongest first. `counts` is how many cards make the hand; the rest are dimmed.
const HANDS = [
  { name: 'Royal Flush', note: '10 to Ace, same suit', cards: ['As', 'Ks', 'Qs', 'Js', 'Ts'], counts: 5 },
  { name: 'Straight Flush', note: 'Five in a row, same suit', cards: ['9h', '8h', '7h', '6h', '5h'], counts: 5 },
  { name: 'Four of a Kind', note: 'Four of one rank', cards: ['Kd', 'Kh', 'Ks', 'Kc', '3d'], counts: 4 },
  { name: 'Full House', note: 'Three plus a pair', cards: ['Qd', 'Qh', 'Qs', '7c', '7d'], counts: 5 },
  { name: 'Flush', note: 'Five of the same suit', cards: ['Ad', 'Jd', '8d', '5d', '2d'], counts: 5 },
  { name: 'Straight', note: 'Five in a row', cards: ['Tc', '9d', '8h', '7s', '6c'], counts: 5 },
  { name: 'Three of a Kind', note: 'Three of one rank', cards: ['8c', '8d', '8h', 'Ks', '4d'], counts: 3 },
  { name: 'Two Pair', note: 'Two different pairs', cards: ['Jc', 'Jh', '4d', '4s', 'Ah'], counts: 4 },
  { name: 'Pair', note: 'Two of one rank', cards: ['As', 'Ad', 'Qc', '8h', '3s'], counts: 2 },
  { name: 'High Card', note: 'Nothing else: highest card', cards: ['Ah', 'Jd', '8c', '5s', '2h'], counts: 1 },
];

const $ = (id) => document.getElementById(id);
const app = $('app');

/** Names come from other players, so everything goes through this before it reaches HTML. */
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const pick = (list) => list[Math.floor(Math.random() * list.length)];

function html(markup) {
  const box = document.createElement('template');
  box.innerHTML = markup.trim();
  return box.content.firstChild;
}

/** Touches the page only when the markup changed, so animations and scrolling survive updates. */
const painted = new WeakMap();
function patch(node, markup) {
  if (!node || painted.get(node) === markup) return false;
  painted.set(node, markup);
  node.innerHTML = markup;
  return true;
}

function patchList(parent, items, className) {
  const keep = new Set(items.map((i) => i.key));
  [...parent.children].forEach((child) => keep.has(child.dataset.key) || child.remove());
  items.forEach((item, index) => {
    let node = [...parent.children].find((c) => c.dataset.key === item.key);
    if (!node) {
      node = document.createElement('div');
      node.dataset.key = item.key;
    }
    if (parent.children[index] !== node) parent.insertBefore(node, parent.children[index] ?? null);
    node.className = `${className} ${item.cls ?? ''}`;
    if (patch(node, item.html)) startCountdowns(node);
  });
}

// --- storage and API ---------------------------------------------------------

const PROFILE_KEY = 'pokr.profile';
const RECENT_KEY = 'pokr.recentTeams';

function read(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}
function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage blocked: the player can still play until they close the tab.
  }
}
function forget(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    // Nothing was stored.
  }
}

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
class AuthError extends ApiError {}

async function request(path, method, token, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new Error("Can't reach the server. Check your connection.");
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) throw new AuthError(401, 'Your profile was not found. Please set it up again.');
  if (!res.ok) throw new ApiError(res.status, typeof data.detail === 'string' ? data.detail : 'That did not work.');
  return data;
}

// --- cards -------------------------------------------------------------------

const SUITS = {
  s: { glyph: '♠︎', name: 'spades', red: false },
  h: { glyph: '♥︎', name: 'hearts', red: true },
  d: { glyph: '♦︎', name: 'diamonds', red: true },
  c: { glyph: '♣︎', name: 'clubs', red: false },
};
const RANK_NAMES = { T: 'Ten', J: 'Jack', Q: 'Queen', K: 'King', A: 'Ace' };

const cardBack = () => '<div class="card back" role="img" aria-label="Face-down card"></div>';

/** Court cards are typographic: a big letter, no illustration. */
function cardFace(card, { tiny = false, dim = false } = {}) {
  const rank = card[0] === 'T' ? '10' : card[0];
  const suit = SUITS[card[1]];
  const court = 'JQK'.includes(rank);
  const label = `${RANK_NAMES[card[0]] ?? card[0]} of ${suit.name}`;
  const cls = `card ${suit.red ? 'is-red' : 'is-black'}${tiny ? ' tiny' : ''}${dim ? ' dim' : ''}`;
  if (tiny) {
    return `<div class="${cls}" role="img" aria-label="${label}"><span class="rank">${rank}</span><span class="big">${suit.glyph}</span></div>`;
  }
  return `<div class="${cls}" role="img" aria-label="${label}"><span class="rank">${rank}</span>
    <span class="suit">${suit.glyph}</span><span class="big${court ? ' court' : ''}">${court ? rank : suit.glyph}</span></div>`;
}

const flipCard = (card) => `<div class="flip">${cardBack()}${cardFace(card)}</div>`;

// --- shared markup -----------------------------------------------------------

const button = (label, action, { kind = '', arg = '', disabled = false, cls = '' } = {}) =>
  `<button type="button" class="btn ${kind} ${cls}" data-do="${action}" data-arg="${esc(arg)}"${disabled ? ' disabled' : ''}>${esc(label)}</button>`;

const pill = (label, active, action, arg = '') =>
  `<button type="button" class="pill${active ? ' active' : ''}" aria-pressed="${active}" data-do="${action}" data-arg="${esc(arg)}">${esc(label)}</button>`;

const initial = (name) => esc(name[0].toUpperCase());

function playerRow(seat, view) {
  const isHost = view.you === view.host;
  const status = seat.id === view.host || !seat.online ? `<small>${seat.online ? 'Host' : 'Offline'}</small>` : '';
  const kick = isHost && seat.id !== view.you ? button('Kick', 'kick', { kind: 'danger', arg: seat.id, cls: 'kick' }) : '';
  return `<div class="badge">${initial(seat.name)}</div>
    <div class="who"><b>${esc(seat.name)}${seat.id === view.you ? ' (you)' : ''}</b>${status}</div>${kick}`;
}

// --- home --------------------------------------------------------------------

const home = {
  profile: read(PROFILE_KEY, null),
  recent: read(RECENT_KEY, []),
  editing: false,
  busy: false,
  error: '',
  code: '',
  name: '',
};

function renderHome() {
  closeSheet();
  if (!home.profile || home.editing) return renderProfile();
  app.innerHTML = `<div class="page fade"><div class="column">
    <img class="logo" src="/logo.png" alt="">
    <h1 class="title center">Pokr</h1>
    <p class="note center" style="margin-bottom:28px">Private poker with friends</p>
    ${button('Create a team', 'createTeam', { kind: 'primary', disabled: home.busy })}
    <h2 class="heading center">Got a code?</h2>
    <div class="row">
      <input id="code" class="input code-input" aria-label="Team code" inputmode="numeric" autocomplete="off"
        maxlength="4" placeholder="4821" value="${esc(home.code)}">
      ${button('Join', 'joinCode', { cls: 'join', disabled: home.busy || home.code.length !== 4 })}
    </div>
    ${home.error ? `<p class="error pop">${esc(home.error)}</p>` : ''}
    ${home.recent.length ? '<h2 class="heading">Your teams</h2>' : ''}
    ${home.recent.map((team) => `<div class="row">
      ${button(team.code, 'openRecent', { arg: team.code, disabled: home.busy })}
      ${button('✕', 'forgetRecent', { arg: team.teamId, cls: 'small' })}
    </div>`).join('')}
  </div></div>
  <button type="button" class="avatar" aria-label="Profile: ${esc(home.profile.name)}" data-do="editProfile">${initial(home.profile.name)}</button>`;
}

function renderProfile() {
  const { profile } = home;
  home.name = home.name || profile?.name || pick(NAMES);
  app.innerHTML = `<div class="page fade"><div class="column">
    <h1 class="title">${profile ? 'Your profile' : 'Pick a name'}</h1>
    <p class="note">No sign-up. Your profile stays in this browser.</p>
    <input id="name" class="input" aria-label="Your name" maxlength="16" autocomplete="off" value="${esc(home.name)}">
    ${home.error ? `<p class="error pop">${esc(home.error)}</p>` : ''}
    ${button(profile ? 'Save' : "Let's play", 'saveProfile', { kind: 'primary', disabled: home.busy || !home.name.trim() })}
    ${profile ? button('Cancel', 'cancelProfile') : ''}
    ${profile ? button('Reset profile', 'askReset', { kind: 'danger' }) : ''}
  </div></div>`;
}

function clearLocal() {
  forget(PROFILE_KEY);
  forget(RECENT_KEY);
  Object.assign(home, { profile: null, recent: [], editing: false, name: '' });
}

async function enter(open) {
  if (home.busy) return;
  Object.assign(home, { busy: true, error: '' });
  renderHome();
  try {
    const team = await open(home.profile);
    home.recent = [team, ...home.recent.filter((t) => t.teamId !== team.teamId)].slice(0, 5);
    write(RECENT_KEY, home.recent);
    home.code = '';
    home.busy = false;
    location.hash = team.teamId;
  } catch (e) {
    if (e instanceof AuthError) clearLocal();
    home.error = e.message;
    home.busy = false;
    renderHome();
    throw e;
  }
}

const joinTeam = (code) => enter(({ token, name }) => request('/teams/join', 'POST', token, { code, name }));

// The server keeps no profiles: this secret is what proves a seat is yours.
const newToken = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('');

function saveProfile() {
  const name = home.name.trim();
  if (!name) return;
  home.profile = { token: home.profile?.token ?? newToken(), name };
  write(PROFILE_KEY, home.profile);
  Object.assign(home, { editing: false, name: '', error: '' });
  renderHome();
}

// --- table connection --------------------------------------------------------

const ui = { raising: false, sent: false, amount: 0, peek: false, turnKey: '', turnEndsAt: 0, pauseEndsAt: 0, resultKey: '' };
let table = null;

/** Every message from the server is the whole table, so reconnecting needs no catching up. */
function openTable(teamId, { token, name }) {
  table = { teamId, view: null, version: 0, connected: true, removed: false, error: '', sock: null, mode: '' };
  const current = table;
  let stopped = false;
  let attempts = 0;
  let retry;
  let pending = null; // not trusted until the server has answered it
  let startedAt = 0;
  let openedAt = 0;
  let heardAt = Date.now();
  let pingedAt = Date.now();

  const connect = () => {
    const stale = pending;
    const ws = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/ws/${encodeURIComponent(teamId)}`);
    pending = ws;
    startedAt = Date.now();
    stale?.close();

    ws.onopen = () => ws.send(JSON.stringify({ token, name }));
    ws.onmessage = (event) => {
      if (ws === pending) {
        const old = current.sock;
        current.sock = ws;
        pending = null;
        openedAt = Date.now();
        old?.close();
      }
      if (ws !== current.sock) return;
      attempts = 0;
      heardAt = Date.now();
      current.connected = true;
      const res = JSON.parse(event.data);
      if (res.version >= current.version) {
        current.version = res.version;
        current.view = res.view;
      }
      if (res.error) showError(res.error);
      renderTable();
    };
    ws.onclose = (event) => {
      if (stopped) return;
      if (event.code === BAD_MESSAGE) { // this page is older than the server, and retrying won't help
        location.reload();
        return;
      }
      if (NOT_AT_TABLE.has(event.code)) {
        current.removed = true;
        renderTable();
        return;
      }
      if (ws === current.sock) current.sock = null;
      else if (ws === pending) pending = null;
      else return; // an old socket we already replaced
      // A hidden tab can't ping, so stay offline until the player comes back.
      if (!current.sock && !pending && document.visibilityState === 'visible') {
        retry = setTimeout(connect, Math.min(500 * 2 ** attempts++, 8000));
      }
    };
  };

  // close() on a dead connection can take a minute to report back, so don't wait for it.
  const reconnect = () => {
    const dead = current.sock;
    current.sock = null;
    clearTimeout(retry);
    connect();
    dead?.close();
  };

  const watch = () => {
    if (document.visibilityState !== 'visible') return;
    const now = Date.now();
    const ws = current.sock;
    const connected = !!ws || now - heardAt < WARN_AFTER_MS;
    if (connected !== current.connected) {
      current.connected = connected;
      renderTable();
    }
    if (pending) {
      if (now - startedAt > SILENT_MS) connect();
    } else if (ws && now - heardAt > SILENT_MS) {
      reconnect();
    } else if (ws && now - openedAt > SWAP_SOCKET_MS) {
      connect(); // the old socket carries on until this one answers
    }
    if (current.sock?.readyState === WebSocket.OPEN && now - pingedAt >= PING_MS) {
      pingedAt = now;
      current.sock.send(JSON.stringify({ t: 'ping' }));
    }
  };

  // Tabs and phones kill sockets when hidden, so don't wait to notice on return.
  const onReturn = () => {
    if (document.visibilityState === 'visible' && (!current.sock || Date.now() - heardAt > PING_MS)) reconnect();
    if (document.visibilityState === 'visible') keepAwake();
  };

  connect();
  const watcher = setInterval(watch, WATCH_MS);
  document.addEventListener('visibilitychange', onReturn);
  window.addEventListener('online', reconnect);
  keepAwake();

  current.stop = () => {
    stopped = true;
    clearTimeout(retry);
    clearInterval(watcher);
    document.removeEventListener('visibilitychange', onReturn);
    window.removeEventListener('online', reconnect);
    pending?.close();
    current.sock?.close();
    current.sock = null;
    releaseAwake();
  };
}

function send(msg) {
  if (table?.sock?.readyState === WebSocket.OPEN) table.sock.send(JSON.stringify(msg));
  else showError('Reconnecting. Try again in a moment.');
}

function showError(message) {
  if (!table) return;
  table.error = message;
  renderTable();
  clearTimeout(table.errorTimer);
  table.errorTimer = setTimeout(() => {
    if (!table) return;
    table.error = '';
    renderTable();
  }, ERROR_SHOWN_MS);
}

// Browsers refuse to vibrate until the player has tapped the page.
const buzz = (ms) => navigator.userActivation?.hasBeenActive && navigator.vibrate?.(ms);

let wakeLock = null;
async function keepAwake() {
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
  } catch {
    // Not supported or refused; the screen may just dim.
  }
}
function releaseAwake() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

async function shareCode() {
  const code = table?.view?.code;
  if (!code) return;
  const text = `Join my poker team on Pokr. Team code: ${code}\n${location.origin}`;
  try {
    if (navigator.share) await navigator.share({ text });
    else {
      await navigator.clipboard.writeText(text);
      showError('Copied. Paste it to your friends.');
    }
  } catch (e) {
    if (e.name !== 'AbortError') showError(`Your code is ${code}`);
  }
}

// --- table screens -----------------------------------------------------------

function renderTable() {
  if (!table) return;
  const { view } = table;
  if (table.removed && sheet.kind !== 'removed') openSheet('removed');
  if (sheet.kind && sheet.kind !== 'removed') renderSheet();

  if (!view) {
    if (table.mode !== 'wait') {
      table.mode = 'wait';
      app.innerHTML = `<div class="seating fade">${cardBack().replace('class="card back"', 'class="card back" style="--w:84px"')}<p>Finding your seat…</p></div>`;
    }
    return;
  }
  const inGame = view.running || (!!view.hand && !view.hand.result);
  const mode = inGame ? 'game' : 'lobby';
  if (table.mode !== mode) {
    table.mode = mode;
    app.innerHTML = mode === 'game' ? gameShell() : lobbyShell();
  }
  if (mode === 'game') renderGame(view);
  else renderLobby(view);
}

function notices(view) {
  const lines = [];
  if (!table.connected) lines.push('Reconnecting…');
  if (view.paused && table.mode === 'game') lines.push('Paused by the host');
  if (table.error) lines.push(table.error);
  return lines.map((line) => `<p class="pop">${esc(line)}</p>`).join('');
}

function lobbyShell() {
  return `<div class="page fade"><div class="lobby">
    <div class="first">
      <button type="button" class="close" aria-label="Close" data-do="exitTable">✕</button>
      <div id="l-code" class="big-code"></div>
      <p class="note center">Share this code with your friends</p>
      <div style="margin-top:12px">${button('Share code', 'share', { kind: 'primary' })}</div>
      <div id="l-rotate"></div>
      <div id="l-notes" class="error"></div>
    </div>
    <div>
      <h2 id="l-count" class="section"></h2>
      <div id="l-players" class="players"></div>
      <h2 class="section">Table</h2>
      <div id="l-options" class="column" style="max-width:none"></div>
      <div id="l-start" style="margin-top:8px"></div>
      ${button('Leave table', 'leave', { kind: 'danger' })}
    </div>
  </div></div>`;
}

function renderLobby(view) {
  const isHost = view.you === view.host;
  const ready = view.seats.filter((s) => s.online).length;
  patch($('l-code'), `${esc(view.code.slice(0, 2))}<span>${esc(view.code.slice(2))}</span>`);
  patch($('l-rotate'), isHost ? button('Change code', 'host', { arg: 'rotate' }) : '');
  patch($('l-notes'), notices(view));
  patch($('l-count'), `Players ${view.seats.length}/12`);
  patchList($('l-players'), view.seats.map((s) => ({ key: s.id, html: playerRow(s, view) })), 'player');
  patch($('l-options'), OPTIONS.map(({ key, title, values }) => `<div class="option">
    <span class="label">${title}</span>
    ${isHost
      ? `<div class="row wrap">${values.map((v) => pill(v, view.settings[key] === v, 'setting', `${key}:${v}`)).join('')}</div>`
      : `<span class="value">${esc(view.settings[key])}</span>`}
  </div>`).join(''));
  patch($('l-start'), isHost
    ? button(ready < 2 ? 'Waiting for one more player' : 'Start game', 'host', { kind: 'primary', arg: 'start', disabled: ready < 2 })
    : '<p class="waiting">Waiting for the host to start</p>');
}

function gameShell() {
  return `<div class="game fade">
    <header class="top"><strong id="g-code"></strong>
      <button type="button" class="menu" aria-label="Table menu" data-do="openMenu">Menu</button></header>
    <div id="rail" class="rail"></div>
    <section class="middle" aria-live="polite">
      <div id="notes" class="notices"></div>
      <div id="above" class="above"></div>
      <div id="board" class="board"></div>
      <div id="below" class="below"></div>
    </section>
    <div id="hole-area" class="hole-area"></div>
    <p id="me" class="me"></p>
    <div class="bottom">
      <div id="raise" class="raise" role="group" aria-labelledby="raise-title" aria-hidden="true">
        <div class="raise-head">
          <span id="raise-title"></span>
          <button type="button" class="raise-close" aria-label="Close" data-do="closeRaise">✕</button>
        </div>
        <div class="raise-amount">
          <button type="button" class="raise-step" aria-label="Less" data-do="stepRaise" data-arg="-1">−</button>
          <output id="amount" for="slider"></output>
          <button type="button" class="raise-step" aria-label="More" data-do="stepRaise" data-arg="1">+</button>
        </div>
        <input id="slider" type="range">
        <div id="raise-limits" class="raise-limits"><span id="raise-min"></span><span id="raise-max"></span></div>
        <div class="raise-presets">
          <button type="button" id="preset-half" class="pill" data-do="quickRaise" data-arg="half">½ Pot</button>
          <button type="button" id="preset-pot" class="pill" data-do="quickRaise" data-arg="pot">Pot</button>
          <button type="button" id="preset-max" class="pill" data-do="quickRaise" data-arg="max">All in</button>
        </div>
        <button type="button" id="raise-go" class="btn primary" data-do="act" data-arg="raise"></button>
      </div>
      <div id="bottom"></div>
    </div>
  </div>`;
}

const describeResult = (result, seats) =>
  result.winners.map((w) => {
    const name = seats.find((s) => s.id === w.id)?.name ?? 'Someone';
    return `${name} wins ${w.won}${w.name ? ` with ${w.name}` : ''}`;
  }).join(' · ');

// An all-in bet nobody could match goes back to whoever made it.
const describeReturned = ({ id, amount }, view) => {
  const name = view.seats.find((s) => s.id === id)?.name;
  return id === view.you ? `You get ${amount} back` : `${name ?? 'Someone'} gets ${amount} back`;
};

function opponent(seat, view, dimmed) {
  const hand = view.hand;
  const acting = hand?.toAct === seat.id;
  const won = hand?.result?.winners.find((w) => w.id === seat.id);
  const shownName = hand?.result?.names[seat.id];
  const status = seat.allin ? 'All in' : !seat.online ? 'Offline' : seat.sittingOut ? 'Away' : seat.last;
  const move = won ? (won.net > 0 ? `+${won.won}` : 'Split') : shownName ?? status;
  const face = seat.cards
    ? seat.cards.map((c) => cardFace(c, { tiny: true, dim: dimmed(c) })).join('')
    : initial(seat.name);
  const stays = won || shownName || status !== seat.last; // on PC a plain move fades after a few seconds
  const slot = acting && hand && !view.paused
    ? '<div class="track"><i data-count="turn"></i></div>'
    : move ? `<span class="move${won ? ' won' : ''}${stays ? ' keep' : ''} pop">${esc(move)}</span>` : '';
  return `<div class="face${acting ? ' acting' : ''}${seat.cards ? ' shown' : ''}">${face}</div>
    <span class="seat-name">${seat.id === view.you ? 'You' : esc(seat.name)}</span>
    <span class="seat-stack">${seat.stack}</span>
    <div class="move-slot">${slot}</div>`;
}

function syncBoard(cards, dimmed) {
  const board = $('board');
  [...board.children].forEach((node) => cards.includes(node.dataset.card) || node.remove());
  cards.forEach((card, index) => {
    let node = [...board.children].find((n) => n.dataset.card === card);
    if (!node) {
      node = html(`<div class="drop" data-card="${card}" style="--delay:${index < 3 ? index * 130 : 0}ms">${flipCard(card)}</div>`);
      board.append(node);
    }
    node.classList.toggle('dim', dimmed(card));
  });
}

function syncHole(me, faceUp, dimmed) {
  const area = $('hole-area');
  if (!me.cards) {
    area.replaceChildren();
    delete area.dataset.key;
    return;
  }
  const key = me.cards.join();
  if (area.dataset.key !== key) {
    area.dataset.key = key;
    ui.peek = false;
    area.innerHTML = `<button type="button" id="hole" class="hole deal" data-hole>
      ${me.cards.map((c) => `<div class="hole-card" data-c="${c}">${flipCard(c)}</div>`).join('')}</button>`;
  }
  const hole = $('hole');
  hole.classList.toggle('showing', ui.peek || faceUp);
  hole.classList.toggle('folded', !!me.folded);
  hole.setAttribute('aria-label', ui.peek || faceUp ? `Your cards: ${me.cards.join(', ')}` : 'Your cards, face down. Press and hold to peek.');
  hole.querySelectorAll('.hole-card').forEach((n) => n.classList.toggle('dim', faceUp && dimmed(n.dataset.c)));
}

function startCountdowns(root) {
  root.querySelectorAll('[data-count]').forEach((bar) => {
    const kind = bar.dataset.count;
    const total = (kind === 'turn' ? table.view.settings.timer * 1000 : Number(bar.dataset.total)) || 1;
    const left = Math.max((kind === 'turn' ? ui.turnEndsAt : ui.pauseEndsAt) - Date.now(), 0);
    bar.getAnimations().forEach((running) => running.cancel());
    bar.animate(
      [{ transform: `scaleX(${Math.min(left / total, 1)})` }, { transform: 'scaleX(0)' }],
      { duration: left, easing: 'linear', fill: 'forwards' },
    );
  });
}

function trackTurn(view) {
  const hand = view.hand;
  const key = hand && hand.toAct ? `${hand.seq}|${hand.toAct}|${hand.board.length}|${view.paused}` : '';
  if (key !== ui.turnKey) {
    const mineNow = hand?.toAct === view.you;
    ui.turnKey = key;
    ui.turnEndsAt = Date.now() + (hand?.turnMs ?? 0);
    ui.raising = false;
    ui.sent = false;
    clearTimeout(ui.sentTimer);
    if (mineNow && !view.paused) buzz(40);
  }
  const resultKey = hand?.result ? JSON.stringify(hand.result.winners) + hand.board.join() : '';
  if (resultKey !== ui.resultKey) {
    ui.resultKey = resultKey;
    ui.pauseEndsAt = Date.now() + (hand?.result?.shown.length ? SHOWDOWN_PAUSE_MS : FOLD_PAUSE_MS);
  }
}

function renderGame(view) {
  const hand = view.hand;
  const result = hand?.result ?? null;
  const live = !!hand && !result;
  const me = view.seats.find((s) => s.id === view.you);
  const myIndex = view.seats.findIndex((s) => s.id === view.you);
  if (!me) return;
  trackTurn(view);
  // Rotate so the rail reads in betting order, starting from the player on my left.
  const others = [...view.seats.slice(myIndex + 1), ...view.seats.slice(0, Math.max(myIndex, 0))];
  const best = result?.winners.find((w) => w.cards.length)?.cards;
  const dimmed = (card) => !!best && !best.includes(card);
  const myWin = result?.winners.find((w) => w.id === view.you);

  patch($('g-code'), esc(view.code));
  const rail = $('rail');
  rail.style.setProperty('--n', view.seats.length);
  // Your cards stay in your hand, not in your seat.
  patchList(rail, [{ ...me, cards: null }, ...others].map((seat) => ({
    key: seat.id,
    cls: `${seat.folded || !seat.inHand ? 'out' : ''} ${seat.id === view.you ? 'self' : ''}`,
    html: opponent(seat, view, dimmed),
  })), 'opponent');
  const acting = [...rail.children].find((n) => n.dataset.key === hand?.toAct);
  if (acting?.offsetParent && rail.dataset.acting !== hand.toAct) {
    rail.scrollTo({ left: acting.offsetLeft - (rail.clientWidth - acting.clientWidth) / 2, behavior: 'smooth' });
  }
  rail.dataset.acting = hand?.toAct ?? '';

  patch($('notes'), notices(view));
  if (result) {
    patch($('above'), `${myWin
      ? `<p class="win pop">${myWin.net > 0 ? `+${myWin.won}` : 'Split'}</p>`
      : `<p class="pot pop">${esc(describeResult(result, view.seats))}</p>`}
      ${myWin?.name ? `<p class="hand-name">${esc(myWin.name)}</p>` : ''}`);
    patch($('below'), result.returned ? `<p class="hand-name pop">${esc(describeReturned(result.returned, view))}</p>` : '');
  } else {
    patch($('above'), hand
      ? `<div class="pot-badge pop" role="status" aria-label="Pot ${hand.pot}"><i class="chip"></i><small>Pot</small><b>${hand.pot}</b></div>`
      : '<p class="pot pop">Waiting for players…</p>');
    patch($('below'), hand?.handName ? `<p class="hand-name pop">${esc(hand.handName)}</p>` : '<p class="hand-name">&nbsp;</p>');
  }
  syncBoard(hand?.board ?? [], dimmed);
  syncHole(me, !!result?.shown.includes(me.id), dimmed);

  patch($('me'), `${esc(me.name)}<span class="me-sep"> · </span><span class="me-stack">${me.stack}</span>${!me.cards ? ' <small>In next hand</small>' : ''}`);
  renderBottom(view, me, live);
}

const barButton = (label, action, { main = false, wide = false, arg = '', on = true } = {}) =>
  `<button type="button" class="${main ? 'main ' : ''}${wide ? 'wide' : ''}" data-do="${action}" data-arg="${esc(arg)}"${on ? '' : ' disabled'}>${esc(label)}</button>`;

function renderBottom(view, me, live) {
  const hand = view.hand;
  const myTurn = hand?.toAct === view.you && hand.legal && !view.paused;
  const panel = $('raise');
  panel.classList.toggle('open', !!(myTurn && ui.raising));
  panel.parentElement.classList.toggle('raising', !!(myTurn && ui.raising));
  panel.setAttribute('aria-hidden', String(!(myTurn && ui.raising)));

  let markup;
  if (myTurn) {
    const { legal } = hand;
    const word = hand.current ? 'Raise' : 'Bet';
    const free = !ui.sent;
    if (ui.raising) syncRaise(hand, word);
    markup = `<div class="bar">${barButton('Fold', 'act', { arg: 'fold', on: free })
      + (legal.call
        ? barButton(legal.call === me.stack ? `All in ${legal.call}` : `Call ${legal.call}`, 'act', { arg: 'call', on: free })
        : barButton('Check', 'act', { arg: 'check', on: free }))
      + barButton(word, 'openRaise', { main: legal.raiseMin !== null, on: legal.raiseMin !== null && free })}</div>`;
  } else if (me.sittingOut) {
    markup = `<div class="bar">${barButton("I'm back", 'seat', { main: true, arg: 'sit' })}</div>`;
  } else if (me.stack === 0 && !(live && me.inHand)) {
    markup = `<div class="bar">${barButton(`Rebuy ${view.settings.stack}`, 'seat', { main: true, arg: 'rebuy' })}</div>`;
  } else if (hand?.result) {
    const ms = hand.result.shown.length ? SHOWDOWN_PAUSE_MS : FOLD_PAUSE_MS;
    markup = `<div class="strip"><i data-count="pause" data-total="${ms}"></i></div>`;
  } else {
    markup = `<div class="bar">${['Fold', 'Call', 'Raise'].map((l) => barButton(l, 'act', { on: false })).join('')}</div>`;
  }
  const bottom = $('bottom');
  if (patch(bottom, markup)) startCountdowns(bottom);
}

const potRaise = (hand, share) => {
  const { raiseMin, raiseMax, call } = hand.legal;
  return Math.max(raiseMin, Math.min(raiseMax, Math.round(hand.current + (hand.pot + call) * share)));
};

function syncRaise(hand, word) {
  const { raiseMin: min, raiseMax: max } = hand.legal;
  const slider = $('slider');
  const open = max > min;
  slider.min = min;
  slider.max = max;
  slider.value = ui.amount;
  slider.hidden = $('raise-limits').hidden = !open;
  slider.setAttribute('aria-label', `${word} amount`);
  slider.style.setProperty('--fill', `${open ? ((ui.amount - min) / (max - min)) * 100 : 100}%`);
  $('raise-title').textContent = hand.current ? 'Raise' : 'Bet';
  $('amount').textContent = ui.amount;
  $('raise-min').textContent = min;
  $('raise-max').textContent = max;
  [['preset-half', potRaise(hand, 0.5)], ['preset-pot', potRaise(hand, 1)], ['preset-max', max]].forEach(([id, value]) => {
    $(id).classList.toggle('active', ui.amount === value);
    $(id).setAttribute('aria-pressed', String(ui.amount === value));
  });
  const go = $('raise-go');
  go.textContent = ui.amount === max ? `All in ${ui.amount}` : hand.current ? `Raise to ${ui.amount}` : `Bet ${ui.amount}`;
  go.disabled = ui.sent;
}

function chooseAmount(n) {
  const { raiseMin, raiseMax } = table.view.hand.legal;
  ui.amount = Math.max(raiseMin ?? 0, Math.min(raiseMax ?? 0, Math.round(n)));
  renderTable();
}

// --- bottom sheet ------------------------------------------------------------

const sheet = { kind: null };

const sheetContent = {
  menu() {
    const { view } = table;
    if (!view) return '';
    const me = view.seats.find((s) => s.id === view.you);
    const isHost = view.you === view.host;
    return `${button(`Share code ${view.code}`, 'share', { kind: 'primary' })}
      ${button('Hand rankings', 'showHands')}
      ${button(me?.sittingOut ? "I'm back" : 'Sit out', 'sitToggle')}
      ${isHost ? button(view.paused ? 'Resume game' : 'Pause game', 'hostMenu', { arg: view.paused ? 'resume' : 'pause' })
        + button('End game', 'hostMenu', { arg: 'end' })
        + button('Change code', 'hostMenu', { arg: 'rotate' }) : ''}
      <h3 class="menu-heading">Players</h3>
      <div class="players">${view.seats.map((s) => `<div class="player">${playerRow(s, view)}</div>`).join('')}</div>
      ${button('Leave table', 'leave', { kind: 'danger' })}
      ${button('Close', 'dismissSheet')}`;
  },
  hands() {
    const hand = table?.view?.hand;
    const current = hand?.result ? null : hand?.handName;
    return `<h3 class="hands-title">Hand rankings</h3>
      <p class="hands-note">Best at the top, weakest at the bottom</p>
      ${HANDS.map((h, i) => `<div class="hand-row${h.name === current ? ' current' : ''}" style="--order:${HANDS.length - 1 - i}">
        <div><b>${h.name}</b><small>${h.name === current ? 'You have this now' : h.note}</small></div>
        <div class="hand-cards">${h.cards.map((c, n) => cardFace(c, { tiny: true, dim: n >= h.counts })).join('')}</div>
      </div>`).join('')}
      <div style="margin-top:6px">${button('Back', 'showMenu')}</div>`;
  },
  removed: () => `<h3 class="sheet-title">You're off this table</h3>
    <p class="sheet-note">The host may have removed you, or you were away for too long. Ask for the code to join again.</p>
    ${button('Back to home', 'exitTable', { kind: 'primary' })}`,
  reset: () => `<h3 class="sheet-title">Reset your profile?</h3>
    <p class="sheet-note">Your name and your list of teams will be removed from this browser. You'll leave any table you're at. This can't be undone.</p>
    ${button('Reset profile', 'confirmReset', { kind: 'destructive', disabled: home.busy })}
    ${button('Keep my profile', 'dismissSheet')}`,
};

function renderSheet() {
  if (sheet.kind) patch($('sheet-body'), sheetContent[sheet.kind]());
}

function openSheet(kind) {
  clearTimeout(sheet.timer);
  const swapping = sheet.kind && sheet.kind !== kind;
  const show = () => {
    sheet.kind = kind;
    const el = $('sheet');
    el.classList.toggle('tall', kind === 'hands');
    el.classList.add('open');
    el.style.removeProperty('--drag');
    renderSheet();
    $('sheet-body').scrollTop = 0;
  };
  $('scrim').classList.add('open');
  if (swapping && !matchMedia('(min-width: 900px) and (min-height: 521px)').matches) {
    $('sheet').classList.remove('open');
    sheet.timer = setTimeout(show, SHEET_CLOSE_MS);
  } else {
    show();
  }
}

function closeSheet() {
  clearTimeout(sheet.timer);
  sheet.kind = null;
  $('sheet').classList.remove('open');
  $('scrim').classList.remove('open');
}

// A removed player has nowhere to go back to, so closing that sheet leaves the table.
function dismissSheet() {
  if (sheet.kind === 'removed') exitTable();
  else if (sheet.kind === 'hands') actions.showMenu();
  else closeSheet();
}

let drag = null;
$('handle').addEventListener('pointerdown', (e) => {
  drag = e.clientY;
  $('handle').setPointerCapture(e.pointerId);
  $('sheet').classList.add('dragging');
});
$('handle').addEventListener('pointermove', (e) => {
  if (drag !== null) $('sheet').style.setProperty('--drag', `${Math.max(e.clientY - drag, 0)}px`);
});
const endDrag = (e) => {
  if (drag === null) return;
  const moved = e.clientY - drag;
  drag = null;
  $('sheet').classList.remove('dragging');
  $('sheet').style.removeProperty('--drag');
  if (moved > DRAG_TO_CLOSE) dismissSheet();
};
$('handle').addEventListener('pointerup', endDrag);
$('handle').addEventListener('pointercancel', endDrag);

// --- actions -----------------------------------------------------------------

function exitTable() {
  location.hash = '';
}

const actions = {
  createTeam: () => enter(({ token, name }) => request('/teams', 'POST', token, { name })).catch(() => {}),
  joinCode: () => joinTeam(home.code).catch(() => {}),
  async openRecent(code) {
    try {
      await joinTeam(code);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        home.recent = home.recent.filter((t) => t.code !== code);
        write(RECENT_KEY, home.recent);
        renderHome();
      }
    }
  },
  forgetRecent(teamId) {
    home.recent = home.recent.filter((t) => t.teamId !== teamId);
    write(RECENT_KEY, home.recent);
    renderHome();
  },
  editProfile() {
    Object.assign(home, { editing: true, error: '', name: '' });
    renderHome();
  },
  saveProfile,
  cancelProfile() {
    Object.assign(home, { editing: false, name: '', error: '' });
    renderHome();
  },
  askReset: () => openSheet('reset'),
  confirmReset() {
    clearLocal();
    renderHome();
  },

  share: shareCode,
  leave() {
    send({ t: 'leave' });
    exitTable();
  },
  exitTable,
  kick: (target) => send({ t: 'host', op: 'kick', target }),
  host: (op) => send({ t: 'host', op }),
  setting(pair) {
    const [key, value] = pair.split(':');
    send({ t: 'host', op: 'settings', settings: { [key]: Number(value) } });
  },
  seat: (t) => send({ t }),

  act(action) {
    if (ui.sent || !action) return;
    const { hand } = table.view;
    ui.sent = true; // cleared when the turn moves on
    ui.sentTimer = setTimeout(() => {
      ui.sent = false; // a move that got lost can be tried again
      renderTable();
    }, SENT_LOCK_MS);
    send({ t: 'act', seq: hand.seq, action, amount: action === 'raise' ? ui.amount : undefined });
    renderTable();
  },
  openRaise() {
    ui.raising = true;
    ui.amount = table.view.hand.legal.raiseMin ?? 0;
    renderTable();
  },
  closeRaise() {
    ui.raising = false;
    renderTable();
  },
  quickRaise(kind) {
    const { hand } = table.view;
    chooseAmount(kind === 'max' ? hand.legal.raiseMax : potRaise(hand, kind === 'half' ? 0.5 : 1));
  },
  stepRaise: (dir) => chooseAmount(ui.amount + Number(dir) * table.view.settings.bb),

  openMenu: () => openSheet('menu'),
  showHands: () => openSheet('hands'),
  showMenu: () => openSheet('menu'),
  dismissSheet,
  sitToggle() {
    const me = table.view.seats.find((s) => s.id === table.view.you);
    send({ t: me?.sittingOut ? 'sit' : 'sitOut' });
    closeSheet();
  },
  hostMenu(op) {
    send({ t: 'host', op });
    closeSheet();
  },
};

document.addEventListener('click', (e) => {
  const target = e.target.closest('[data-do]');
  if (target && !target.disabled) actions[target.dataset.do]?.(target.dataset.arg);
});

document.addEventListener('input', (e) => {
  const { id, value } = e.target;
  if (id === 'code') {
    e.target.value = home.code = value.replace(/[^0-9]/g, '');
    document.querySelector('[data-do="joinCode"]').disabled = home.busy || home.code.length !== 4;
  } else if (id === 'name') {
    home.name = value;
    document.querySelector('[data-do="saveProfile"]').disabled = home.busy || !value.trim();
  } else if (id === 'slider') {
    // Drag in big-blind steps, but always let the far end reach all-in.
    const { raiseMin: min, raiseMax: max } = table.view.hand.legal;
    const n = Number(value);
    chooseAmount(n >= max ? max : min + Math.round((n - min) / table.view.settings.bb) * table.view.settings.bb);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && sheet.kind) dismissSheet();
  else if (e.key === 'Escape' && ui.raising) actions.closeRaise();
  if (e.key !== 'Enter') return;
  if (e.target.id === 'code' && home.code.length === 4) actions.joinCode();
  if (e.target.id === 'name') saveProfile();
});

// Press and hold the cards to peek; letting go anywhere hides them again.
function setPeek(on) {
  if (ui.peek === on) return;
  ui.peek = on;
  if (on) buzz(10);
  renderTable();
}
document.addEventListener('pointerdown', (e) => {
  if (e.target.closest('[data-hole]')) setPeek(true);
});
['pointerup', 'pointercancel', 'blur'].forEach((name) => window.addEventListener(name, () => setPeek(false)));
document.addEventListener('contextmenu', (e) => {
  if (e.target.closest('[data-hole]')) e.preventDefault(); // a long press would open the browser's menu
});
document.addEventListener('keydown', (e) => {
  if (e.target.id === 'hole' && (e.key === ' ' || e.key === 'Enter')) {
    e.preventDefault();
    setPeek(true);
  }
});
document.addEventListener('keyup', (e) => {
  if (e.target.id === 'hole') setPeek(false);
});

// --- routing -----------------------------------------------------------------

/** The table id lives in the URL, so a refresh puts the player back at their seat. */
function route() {
  table?.stop();
  table = null;
  Object.assign(ui, { raising: false, sent: false, peek: false, turnKey: '', resultKey: '' });
  closeSheet();
  const teamId = location.hash.slice(1);
  if (teamId && home.profile) openTable(teamId, home.profile);
  else renderHome();
}

window.addEventListener('hashchange', route);
route();
