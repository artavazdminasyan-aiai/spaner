/* Spaner — browser UI: menus, board, clocks, AI driver and online client. */
(function () {
  'use strict';
  const E = window.Spaner, AI = window.SpanerAI, PC = window.SpanerPieces;
  const NAMES = E.NAMES;
  const COLOR = { w: 'White', b: 'Black' };
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem('spaner.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('spaner.' + k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
  };

  const ROSTER = [
    ['P', 'w', 'Pawn', 'One step forward. Recruits diagonally. Promotes at the far edge.'],
    ['B', 'w', 'Bishop', 'Any distance diagonally.'],
    ['N', 'w', 'Knight', 'Jumps in an L, over anything.'],
    ['K', 'b', 'King', 'One step any way. Never recruited — checkmate it.'],
    ['Q', 'w', 'Queen', 'Any distance, straight or diagonal.'],
    ['R', 'b', 'Rook', 'Any distance along a row or column.'],
    ['C', 'n', 'Commander', 'Never moves. Every 5 turns it sends your rooks and bananas forward.'],
    ['D', 'b', 'Dragon', 'Flies anywhere and recruits anywhere — 5 times. Never gives check.'],
    ['A', 'b', 'Banana', 'Moves like a rook. Recruit one and roll a 6 for three.'],
  ];

  const app = {
    mode: null,          // 'ai' | 'local' | 'online'
    gen: 0,              // bumps on every new game, cancels stale async work
    match: null,         // local E.Match (ai / local modes)
    snap: null,          // latest snapshot being shown
    human: 'w',
    aiColor: 'b',
    level: store.get('level', 2),
    seat: null,          // online seat colour, null = spectator
    online: null,        // { room, token, es, offset, info, connected }
    flip: false,
    sel: null,
    drag: null,
    sending: false,
    legalFor: null, legal: [],
    placeFor: null, placeList: [],
    sqEls: [],
    pieceEls: new Map(),
    fxKey: '',
    checkKey: '',
    logKey: '',
    overlayKey: '',
    resultShown: null,
    sound: store.get('sound', true),
    ai: { worker: undefined, busy: false, req: 0 },
  };

  // ======================================================================
  // Sound (tiny WebAudio synth)
  // ======================================================================
  const Sound = (function () {
    let ac = null;
    function ctx() {
      if (!ac) {
        const C = window.AudioContext || window.webkitAudioContext;
        if (!C) return null;
        ac = new C();
      }
      if (ac.state === 'suspended') ac.resume().catch(() => {});
      return ac;
    }
    function tone(f, d, type, vol, delay) {
      if (!app.sound) return;
      const a = ctx();
      if (!a) return;
      const t = a.currentTime + (delay || 0);
      const o = a.createOscillator(), g = a.createGain();
      o.type = type || 'sine';
      o.frequency.setValueAtTime(f, t);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol || 0.08, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d);
      o.connect(g).connect(a.destination);
      o.start(t);
      o.stop(t + d + 0.05);
    }
    return {
      unlock() { if (app.sound) ctx(); },
      move() { tone(330, 0.09, 'triangle', 0.1); tone(196, 0.07, 'sine', 0.06, 0.01); },
      capture() { tone(220, 0.08, 'square', 0.035); tone(440, 0.14, 'triangle', 0.09, 0.05); },
      spawn() { tone(784, 0.2, 'sine', 0.05); tone(1175, 0.26, 'sine', 0.04, 0.09); },
      place() { tone(523, 0.11, 'triangle', 0.08); },
      order() { [392, 494, 587, 784].forEach((f, i) => tone(f, 0.12, 'square', 0.03, i * 0.07)); },
      check() { tone(880, 0.1, 'sawtooth', 0.035); tone(660, 0.18, 'sawtooth', 0.035, 0.1); },
      win() { [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.3, 'triangle', 0.08, i * 0.12)); },
      lose() { [392, 330, 262].forEach((f, i) => tone(f, 0.34, 'triangle', 0.08, i * 0.16)); },
      tick() { tone(1200, 0.035, 'square', 0.018); },
    };
  })();

  // ======================================================================
  // Small helpers
  // ======================================================================
  function toast(msg, ms) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => el.classList.remove('show'), ms || 2600);
  }

  function now() {
    return app.mode === 'online' && app.online ? Date.now() + app.online.offset : Date.now();
  }

  function showScreen(name) {
    $('#menu').hidden = name !== 'menu';
    $('#game').hidden = name !== 'game';
    window.scrollTo(0, 0);
  }

  const boardOf = s => (s.sub ? s.sub.board : s.state.board);
  const sideToAct = s => (s.sub ? s.sub.color : s.state.turn);

  /** The colour the local user may act for right now, or null. */
  function actor() {
    const s = app.snap;
    if (!s || s.phase !== 'play') return null;
    const side = sideToAct(s);
    if (app.mode === 'local') return side;
    if (app.mode === 'ai') return side === app.human ? side : null;
    if (app.mode === 'online') return side === app.seat ? side : null;
    return null;
  }

  /** Which colour "I" am for labels (null in pass & play / spectating). */
  function myColor() {
    if (app.mode === 'ai') return app.human;
    if (app.mode === 'online') return app.seat;
    return null;
  }

  function legalNow() {
    const s = app.snap;
    if (!s || s.phase !== 'play' || s.sub || !actor()) return [];
    if (app.legalFor !== s.state) { app.legal = E.legalMoves(s.state); app.legalFor = s.state; }
    return app.legal;
  }

  function placeSquares() {
    const s = app.snap;
    if (!s || !s.sub || !s.sub.recruits.length) return [];
    if (app.placeFor !== s.sub.board) {
      app.placeList = E.validPlacements(s.sub.board, s.sub.color, s.sub.recruits.length);
      app.placeFor = s.sub.board;
    }
    return app.placeList;
  }

  const targetsOf = from => legalNow().filter(m => m.from === from);

  function coords(s) {
    const f = s & 7, r = s >> 3;
    return { x: app.flip ? 7 - f : f, y: app.flip ? r : 7 - r };
  }

  function playerInfo(c) {
    if (app.mode === 'ai') {
      if (c === app.human) return { name: store.get('name', '') || 'You', tag: COLOR[c] };
      return { name: 'Computer', tag: AI.LEVELS[app.level].name + ' · ' + COLOR[c] };
    }
    if (app.mode === 'local') return { name: COLOR[c], tag: 'Pass & play' };
    const seats = app.online && app.online.info && app.online.info.seats;
    const seat = seats && seats[c];
    if (!seat) return { name: 'Open seat', tag: 'Waiting for a friend', online: false };
    return { name: seat.name, tag: (c === app.seat ? 'You · ' : '') + COLOR[c], online: seat.online };
  }

  const nameOf = c => {
    const me = myColor();
    if (me && c === me) return 'You';
    if (app.mode === 'ai') return 'Computer';
    if (app.mode === 'online') return playerInfo(c).name;
    return COLOR[c];
  };

  // ======================================================================
  // Menu
  // ======================================================================
  function unitHTML(t, o, name, desc) {
    return '<div class="unit"><div class="art">' + PC.svg(t, o) + '</div><div><b>' + name + '</b><small>' + desc + '</small></div></div>';
  }

  function buildMenu() {
    const lv = $('#levels');
    AI.LEVELS.forEach((L, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'level' + (L.id === 'god' ? ' god' : '');
      b.setAttribute('role', 'radio');
      b.dataset.i = i;
      b.innerHTML = '<b>' + L.name + '</b><small>' + L.blurb + '</small><span class="pips">' +
        AI.LEVELS.map((_, j) => '<i class="' + (j <= i ? 'on' : '') + '"></i>').join('') + '</span>';
      b.addEventListener('click', () => { app.level = i; store.set('level', i); syncLevels(); });
      lv.appendChild(b);
    });
    syncLevels();
    setupSeg('#ai-color', 'aiColor', 'w');
    setupSeg('#online-color', 'onlineColor', 'r');
    $('#player-name').value = store.get('name', '');
    $('#roster').innerHTML = ROSTER.map(r => unitHTML(r[0], r[1], r[2], r[3])).join('');
    $('#rules-roster').innerHTML = ROSTER.map(r => unitHTML(r[0], r[1], r[2], r[3])).join('');
  }

  function syncLevels() {
    if (app.level < 0 || app.level >= AI.LEVELS.length) app.level = 2;
    $$('#levels .level').forEach(b => b.setAttribute('aria-checked', String(Number(b.dataset.i) === app.level)));
  }

  function setupSeg(sel, key, def) {
    const root = $(sel);
    const sync = () => {
      const v = store.get(key, def);
      $$('button', root).forEach(b => b.setAttribute('aria-checked', String(b.dataset.v === v)));
    };
    $$('button', root).forEach(b => b.addEventListener('click', () => { store.set(key, b.dataset.v); sync(); }));
    sync();
  }

  function saveName() {
    const v = $('#player-name').value.trim().slice(0, 16);
    store.set('name', v);
    return v;
  }

  // ======================================================================
  // Starting games
  // ======================================================================
  function stopWorker() {
    if (app.ai.worker) app.ai.worker.terminate();
    app.ai = { worker: undefined, busy: false, req: 0 };
  }

  function leaveOnline() {
    if (app.online && app.online.es) app.online.es.close();
    app.online = null;
    app.seat = null;
    $('#invite').hidden = true;
  }

  function resetGameView() {
    app.sel = null;
    app.drag = null;
    app.snap = null;
    app.legalFor = null;
    app.placeFor = null;
    app.fxKey = '';
    app.checkKey = '';
    app.logKey = '';
    app.overlayKey = '';
    app.resultShown = null;
    for (const el of app.pieceEls.values()) el.remove();
    app.pieceEls.clear();
    $('#result').hidden = true;
    closePromo();
  }

  function newLocalGame(mode, human) {
    leaveOnline();
    stopWorker();
    resetGameView();
    app.gen++;
    app.mode = mode;
    app.human = human;
    app.aiColor = E.opp(human);
    app.flip = mode === 'ai' && human === 'b';
    layoutSquares();
    app.match = new E.Match();
    app.match.start(Date.now(), 3000);
    history.replaceState(null, '', location.pathname);
    showScreen('game');
    refresh();
  }

  function startAI() {
    Sound.unlock();
    const pref = store.get('aiColor', 'w');
    const human = pref === 'r' ? (Math.random() < 0.5 ? 'w' : 'b') : pref;
    newLocalGame('ai', human);
  }

  function startLocal() {
    Sound.unlock();
    newLocalGame('local', 'w');
  }

  function goMenu() {
    const s = app.snap;
    const running = s && (s.phase === 'play' || s.phase === 'countdown');
    if (running && app.mode !== 'online' && !confirm('Leave this game? It will be lost.')) return;
    if (running && app.mode === 'online' && app.seat && !confirm('Leave the table? The clock keeps running — open the invite link again to return to your seat.')) return;
    leaveOnline();
    stopWorker();
    app.gen++;
    app.mode = null;
    app.match = null;
    resetGameView();
    history.replaceState(null, '', location.pathname);
    showScreen('menu');
  }

  // ======================================================================
  // Online play
  // ======================================================================
  async function api(path, body) {
    const opt = body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {};
    let r;
    try { r = await fetch(path, opt); } catch (e) { throw new Error('Cannot reach the Spaner server.'); }
    let j = {};
    try { j = await r.json(); } catch (e) { /* not JSON */ }
    if (!r.ok) throw new Error(j.error || (r.status === 404 ? 'Online play needs the Spaner server (npm start).' : 'Server error (' + r.status + ').'));
    return j;
  }

  function serverAvailable() {
    if (location.protocol === 'file:') {
      toast('Online play needs the Spaner server — run "npm start" and open the page it prints.', 4200);
      return false;
    }
    return true;
  }

  async function createRoom() {
    Sound.unlock();
    if (!serverAvailable()) return;
    const name = saveName();
    const pref = store.get('onlineColor', 'r');
    const btn = $('#create-room');
    btn.disabled = true;
    try {
      const j = await api('api/rooms', { name, color: pref === 'r' ? null : pref });
      store.set('seat.' + j.room, j.token);
      enterRoom(j.room, j.token);
    } catch (e) {
      toast(e.message, 4200);
    } finally {
      btn.disabled = false;
    }
  }

  function parseCode(v) {
    v = (v || '').trim();
    const m = v.match(/room=([A-Za-z0-9]{6})/);
    if (m) return m[1].toUpperCase();
    return /^[A-Za-z0-9]{6}$/.test(v) ? v.toUpperCase() : '';
  }

  async function joinRoom(raw) {
    Sound.unlock();
    const code = parseCode(raw);
    if (!code) { toast('Enter a 6-character room code or paste the invite link.'); return; }
    if (!serverAvailable()) return;
    try {
      const token = store.get('seat.' + code, null);
      const j = await api('api/rooms/' + code + '/join', { token, name: saveName() });
      if (j.token) store.set('seat.' + code, j.token);
      if (j.spectator) toast('That table is full — you are watching the game.', 3600);
      enterRoom(code, j.token);
    } catch (e) {
      toast(e.message, 4200);
      history.replaceState(null, '', location.pathname);
      showScreen('menu');
    }
  }

  const inviteUrl = room => location.origin + location.pathname + '?room=' + room;

  function enterRoom(room, token) {
    leaveOnline();
    stopWorker();
    resetGameView();
    app.gen++;
    app.mode = 'online';
    app.match = null;
    app.seat = null;
    app.flip = false;
    app.online = { room, token, es: null, offset: 0, info: null, connected: false };
    history.replaceState(null, '', location.pathname + '?room=' + room);
    $('#invite').hidden = false;
    $('#invite-url').value = inviteUrl(room);
    $('#invite-code').textContent = room;
    layoutSquares();
    showScreen('game');
    renderOverlay();
    connect();
  }

  function connect() {
    const o = app.online;
    if (!o) return;
    if (o.es) o.es.close();
    const es = new EventSource('api/rooms/' + o.room + '/stream?token=' + encodeURIComponent(o.token || ''));
    o.es = es;
    es.onmessage = e => {
      if (app.online !== o) return;
      let msg;
      try { msg = JSON.parse(e.data); } catch (err) { return; }
      o.offset = msg.now - Date.now();
      o.info = msg;
      o.connected = true;
      const seat = msg.you || null;
      if (seat !== app.seat) { app.seat = seat; app.flip = seat === 'b'; layoutSquares(); }
      setSnap(msg.match);
    };
    es.onerror = () => {
      if (app.online !== o) return;
      o.connected = false;
      renderStatus();
    };
  }

  async function onlineAction(body) {
    const o = app.online;
    if (!o || !o.token) return;
    app.sending = true;
    try {
      await api('api/rooms/' + o.room + '/action', Object.assign({ token: o.token }, body));
    } catch (e) {
      toast(e.message);
    } finally {
      app.sending = false;
    }
  }

  async function copyInvite() {
    const url = $('#invite-url').value;
    try {
      await navigator.clipboard.writeText(url);
      toast('Invite link copied — send it to your friend.');
    } catch (e) {
      $('#invite-url').select();
      toast('Select the link and copy it.');
    }
  }

  async function shareInvite() {
    const url = $('#invite-url').value;
    if (navigator.share) {
      try { await navigator.share({ title: 'Spaner', text: 'Join my game of Spaner', url }); return; } catch (e) { /* cancelled */ }
    }
    copyInvite();
  }

  // ======================================================================
  // Actions
  // ======================================================================
  function refresh() {
    if (app.match) setSnap(app.match.snapshot());
  }

  function sendMove(mv) {
    const me = actor();
    if (!me) return;
    app.sel = null;
    if (app.mode === 'online') { onlineAction({ type: 'move', from: mv.from, to: mv.to, promo: mv.promo || null }); return; }
    const r = app.match.move(me, mv, Date.now());
    if (!r.ok) toast(r.error);
    refresh();
  }

  function sendPlace(sq) {
    const me = actor();
    if (!me) return;
    if (app.mode === 'online') { onlineAction({ type: 'place', sq }); return; }
    const r = app.match.place(me, sq, Date.now());
    if (!r.ok) toast(r.error);
    refresh();
  }

  function tryMove(from, to) {
    const ms = targetsOf(from).filter(m => m.to === to);
    if (!ms.length) return false;
    if (ms[0].promo) { openPromo(from, to, ms.map(m => m.promo)); return true; }
    sendMove({ from, to });
    return true;
  }

  function resign() {
    const s = app.snap;
    if (!s || (s.phase !== 'play' && s.phase !== 'countdown')) return;
    let color;
    if (app.mode === 'ai') color = app.human;
    else if (app.mode === 'local') color = s.phase === 'play' ? sideToAct(s) : 'w';
    else color = app.seat;
    if (!color) return;
    if (!confirm((app.mode === 'local' ? COLOR[color] + ': resign' : 'Resign') + ' this game?')) return;
    if (app.mode === 'online') { onlineAction({ type: 'resign' }); return; }
    app.match.resign(color, Date.now());
    refresh();
  }

  function rematch() {
    $('#result').hidden = true;
    if (app.mode === 'ai') { startAI(); return; }
    if (app.mode === 'local') { startLocal(); return; }
    if (app.mode === 'online') {
      if (!app.seat) { toast('Only the two players can start a rematch.'); return; }
      onlineAction({ type: 'rematch' });
    }
  }

  // ======================================================================
  // AI driver
  // ======================================================================
  function aiWorker() {
    if (app.ai.worker !== undefined) return app.ai.worker;
    try { app.ai.worker = new Worker('ai-worker.js'); } catch (e) { app.ai.worker = null; }
    return app.ai.worker;
  }

  function askAI(state, level, frac) {
    return new Promise(resolve => {
      const fallback = () => setTimeout(() => resolve(AI.think(state, { level, frac })), 20);
      const w = aiWorker();
      if (!w) { fallback(); return; }
      const id = ++app.ai.req;
      // Safety net: if the worker stalls, move quickly on the main thread rather than lose on time.
      const guard = setTimeout(() => {
        cleanup();
        if (app.ai.worker === w) { w.terminate(); app.ai.worker = undefined; }
        resolve(AI.think(state, { level: Math.min(level, 3), frac, time: 400 }));
      }, 14000);
      const cleanup = () => { clearTimeout(guard); w.removeEventListener('message', onMsg); w.removeEventListener('error', onErr); };
      const onMsg = e => { if (e.data && e.data.id === id) { cleanup(); resolve(e.data.move); } };
      const onErr = ev => { if (ev && ev.preventDefault) ev.preventDefault(); cleanup(); app.ai.worker = null; fallback(); };
      w.addEventListener('message', onMsg);
      w.addEventListener('error', onErr);
      w.postMessage({ id, state, level, frac });
    });
  }

  async function maybeAI() {
    if (app.mode !== 'ai' || app.ai.busy) return;
    const m = app.match;
    if (!m || m.phase !== 'play' || m.sub || m.state.turn !== app.aiColor) return;
    app.ai.busy = true;
    const gen = app.gen;
    const ply = m.state.ply;
    const L = AI.LEVELS[app.level];
    const t0 = Date.now();
    const frac = () => (Date.now() - m.startAt) / E.GAME_MS;
    let mv = await askAI(m.state, app.level, frac());
    const minWait = L.think[0] + Math.random() * (L.think[1] - L.think[0]);
    const wait = t0 + minWait - Date.now();
    if (wait > 0) await sleep(wait);
    if (gen !== app.gen) return;
    if (m.phase !== 'play' || m.sub || m.state.turn !== app.aiColor || m.state.ply !== ply) { app.ai.busy = false; return; }
    const legal = m.legal();
    if (!mv || !legal.some(x => x.from === mv.from && x.to === mv.to && (x.promo || null) === (mv.promo || null))) {
      // a new piece appeared while thinking and changed the position: decide again quickly
      mv = AI.think(m.state, { level: Math.min(app.level, 3), frac: frac(), time: 250 }) || legal[0];
    }
    if (!mv) { app.ai.busy = false; return; }
    m.move(app.aiColor, mv, Date.now());
    refresh();
    while (m.sub && m.sub.color === app.aiColor && m.phase === 'play') {
      await sleep(420);
      if (gen !== app.gen) return;
      const sub = m.sub;
      if (!sub || m.phase !== 'play') break;
      let sq = AI.choosePlacement(sub.board, app.aiColor, sub.recruits[0], sub.recruits.slice(1), { level: app.level, frac: frac() });
      let r = m.place(app.aiColor, sq, Date.now());
      if (!r.ok) {
        const v = E.validPlacements(sub.board, app.aiColor, sub.recruits.length);
        if (v.length) m.place(app.aiColor, v[0], Date.now());
      }
      refresh();
    }
    app.ai.busy = false;
  }

  // ======================================================================
  // Board
  // ======================================================================
  function buildBoard() {
    const wrap = $('#board .squares');
    for (let s = 0; s < 64; s++) {
      const d = document.createElement('div');
      d.className = 'sq ' + (((s & 7) + (s >> 3)) % 2 === 0 ? 'd' : 'l');
      wrap.appendChild(d);
      app.sqEls[s] = d;
    }
    layoutSquares();
    const board = $('#board');
    board.addEventListener('pointerdown', onDown);
    board.addEventListener('pointermove', onMove);
    board.addEventListener('pointerup', onUp);
    board.addEventListener('pointercancel', onCancel);
    board.addEventListener('contextmenu', e => e.preventDefault());
  }

  function layoutSquares() {
    for (let s = 0; s < 64; s++) {
      const { x, y } = coords(s);
      const el = app.sqEls[s];
      el.style.gridColumn = String(x + 1);
      el.style.gridRow = String(y + 1);
      let html = '';
      if (x === 0) html += '<span class="cr rk">' + ((s >> 3) + 1) + '</span>';
      if (y === 7) html += '<span class="cr fl">' + 'abcdefgh'[s & 7] + '</span>';
      el.innerHTML = html;
    }
    for (const el of app.pieceEls.values()) {
      const s = Number(el.dataset.sq);
      if (s >= 0) { const { x, y } = coords(s); el.style.transform = 'translate(' + x * 100 + '%,' + y * 100 + '%)'; }
    }
  }

  function pieceKey(p) { return p.t + p.o + (p.d || 0) + (p.c || 0); }

  function pieceInner(p) {
    let h = PC.svg(p.t, p.o);
    if (p.t === 'D') {
      const left = E.DRAGON_LIMIT - (p.d || 0);
      h += '<span class="dpips" title="' + left + ' recruits left">' +
        Array.from({ length: E.DRAGON_LIMIT }, (_, i) => '<i class="' + (i < left ? '' : 'off') + '"></i>').join('') + '</span>';
    }
    if (p.t === 'C' && p.o !== 'n') {
      const n = E.ORDER_EVERY - (p.c || 0);
      h += '<span class="badge' + (n === 1 ? ' hot' : '') + '" title="Orders an advance in ' + n + ' turn' + (n === 1 ? '' : 's') + '">' + n + '</span>';
    }
    return h;
  }

  function renderPieces() {
    const s = app.snap;
    if (!s) return;
    const board = boardOf(s);
    const layer = $('#board .pieces');
    const seen = new Set();
    for (let sq = 0; sq < 64; sq++) {
      const p = board[sq];
      if (!p) continue;
      seen.add(p.id);
      const { x, y } = coords(sq);
      const tf = 'translate(' + x * 100 + '%,' + y * 100 + '%)';
      let el = app.pieceEls.get(p.id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'piece enter';
        el.style.transform = tf;
        layer.appendChild(el);
        app.pieceEls.set(p.id, el);
        const ref = el;
        setTimeout(() => ref.classList.remove('enter'), 460);
      }
      const key = pieceKey(p);
      if (el.dataset.key !== key) {
        el.innerHTML = pieceInner(p);
        el.dataset.key = key;
        el.classList.remove('w', 'b', 'n');
        el.classList.add(p.o);
        el.setAttribute('aria-label', (p.o === 'n' ? 'Neutral' : COLOR[p.o]) + ' ' + NAMES[p.t] + ' on ' + E.sqName(sq));
      }
      el.dataset.sq = String(sq);
      if (!(app.drag && app.drag.moved && app.drag.el === el)) el.style.transform = tf;
    }
    for (const [id, el] of app.pieceEls) {
      if (seen.has(id)) continue;
      app.pieceEls.delete(id);
      el.classList.add('leave');
      setTimeout(() => el.remove(), 220);
    }
  }

  function renderHighlights() {
    const s = app.snap;
    if (!s) return;
    const board = boardOf(s);
    const cls = new Array(64).fill('');
    if (s.last) { cls[s.last.from] += ' last'; cls[s.last.to] += ' last'; }
    if (s.phase !== 'ready') {
      for (const c of ['w', 'b']) {
        const k = E.kingSq(board, c);
        if (k >= 0 && E.attacked(board, k, E.opp(c))) cls[k] += ' check';
      }
    }
    const me = actor();
    const placing = !!(s.sub && me && s.sub.color === me);
    if (placing) for (const sq of placeSquares()) cls[sq] += ' place';
    if (!placing && app.sel !== null) {
      cls[app.sel] += ' sel';
      const seen = new Set();
      for (const m of targetsOf(app.sel)) {
        if (seen.has(m.to)) continue;
        seen.add(m.to);
        cls[m.to] += board[m.to] ? ' cap' : ' mv';
      }
    }
    for (let sq = 0; sq < 64; sq++) {
      const el = app.sqEls[sq];
      const flash = (el.className.match(/flash-\w+/g) || []).join(' ');
      el.className = 'sq ' + (((sq & 7) + (sq >> 3)) % 2 === 0 ? 'd' : 'l') + cls[sq] + (flash ? ' ' + flash : '');
    }
    $('#board').classList.toggle('placing', placing);
  }

  function flash(sq, kind) {
    const el = app.sqEls[sq];
    if (!el) return;
    const c = 'flash-' + kind;
    el.classList.remove(c);
    void el.offsetWidth;
    el.classList.add(c);
    clearTimeout(el['t' + kind]);
    el['t' + kind] = setTimeout(() => el.classList.remove(c), 1200);
  }

  // ---- pointer input ----
  function squareAt(x, y) {
    const r = $('#board').getBoundingClientRect();
    const cx = Math.floor((x - r.left) / (r.width / 8));
    const cy = Math.floor((y - r.top) / (r.height / 8));
    if (cx < 0 || cx > 7 || cy < 0 || cy > 7) return -1;
    const f = app.flip ? 7 - cx : cx;
    const rk = app.flip ? cy : 7 - cy;
    return rk * 8 + f;
  }

  function onDown(e) {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    Sound.unlock();
    const s = app.snap;
    const me = actor();
    if (!s || !me || app.sending) return;
    const sq = squareAt(e.clientX, e.clientY);
    if (sq < 0) return;
    if (s.sub) {
      if (s.sub.color === me && placeSquares().indexOf(sq) >= 0) sendPlace(sq);
      else toast('Place your recruit on a glowing square.');
      return;
    }
    if (app.sel !== null && targetsOf(app.sel).some(m => m.to === sq)) {
      tryMove(app.sel, sq);
      renderHighlights();
      return;
    }
    const p = s.state.board[sq];
    if (p && p.o === me && targetsOf(sq).length) {
      const wasSel = app.sel === sq;
      app.sel = sq;
      const el = Array.from(app.pieceEls.values()).find(x => Number(x.dataset.sq) === sq) || null;
      app.drag = { sq, x: e.clientX, y: e.clientY, moved: false, wasSel, el, pid: e.pointerId };
      try { $('#board').setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      e.preventDefault();
    } else {
      if (p && p.o === me && p.t === 'C') toast('The commander never moves — it gives orders.');
      app.sel = null;
    }
    renderHighlights();
  }

  function onMove(e) {
    const d = app.drag;
    if (!d || e.pointerId !== d.pid) return;
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 6) return;
    d.moved = true;
    if (!d.el) return;
    const r = $('#board').getBoundingClientRect();
    const sz = r.width / 8;
    d.el.classList.add('dragging');
    d.el.style.transform = 'translate(' + (e.clientX - r.left - sz / 2) + 'px,' + (e.clientY - r.top - sz / 2) + 'px)';
  }

  function onUp(e) {
    const d = app.drag;
    if (!d || e.pointerId !== d.pid) return;
    app.drag = null;
    if (d.el) d.el.classList.remove('dragging');
    if (d.moved) {
      const sq = squareAt(e.clientX, e.clientY);
      if (sq >= 0 && sq !== d.sq && actor() && tryMove(d.sq, sq)) { renderPieces(); renderHighlights(); return; }
      renderPieces();
    } else if (d.wasSel) {
      app.sel = null;
    }
    renderHighlights();
  }

  function onCancel() {
    const d = app.drag;
    app.drag = null;
    if (d && d.el) d.el.classList.remove('dragging');
    renderPieces();
  }

  // ---- promotion ----
  function openPromo(from, to, promos) {
    const c = actor();
    if (!c) return;
    const el = $('#promo');
    el.innerHTML = promos.map(t => '<button type="button" data-t="' + t + '" aria-label="Promote to ' + NAMES[t] + '" title="' + NAMES[t] + '">' + PC.svg(t, c) + '</button>').join('');
    el.hidden = false;
    const r = app.sqEls[to].getBoundingClientRect();
    const w = el.offsetWidth, h = el.offsetHeight;
    const left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), window.innerWidth - w - 8);
    let top = r.top + r.height + 8;
    if (top + h > window.innerHeight - 8) top = r.top - h - 8;
    el.style.left = left + 'px';
    el.style.top = Math.max(8, top) + 'px';
    app.promo = { from, to };
    $$('button', el).forEach(b => b.addEventListener('click', () => {
      const t = b.dataset.t;
      closePromo();
      sendMove({ from, to, promo: t });
    }));
    const first = $('button', el);
    if (first) first.focus();
  }

  function closePromo() {
    $('#promo').hidden = true;
    app.promo = null;
  }

  // ======================================================================
  // Rendering
  // ======================================================================
  function setSnap(s) {
    const prev = app.snap;
    if (prev && s && prev.startAt !== s.startAt) {
      // a new match in the same room (rematch)
      for (const el of app.pieceEls.values()) el.remove();
      app.pieceEls.clear();
      app.resultShown = null;
      app.sel = null;
      $('#result').hidden = true;
    }
    app.snap = s;
    if (!s) return;
    if (app.sel !== null && !targetsOf(app.sel).length) app.sel = null;
    if (app.promo && (!actor() || s.sub)) closePromo();
    effects(s, prev);
    render();
  }

  function effects(s, prev) {
    const fx = s.fx;
    const key = fx ? s.startAt + ':' + fx.id : '';
    if (fx && key !== app.fxKey) {
      const fresh = app.fxKey !== '' || (prev && prev.startAt === s.startAt);
      app.fxKey = key;
      if (fresh) {
        if (fx.spawn != null) { flash(fx.spawn, 'spawn'); Sound.spawn(); }
        if (fx.place != null) { flash(fx.place, 'place'); Sound.place(); }
        if (fx.move) {
          if (fx.cap) Sound.capture(); else Sound.move();
          if (fx.order && fx.order.length) {
            setTimeout(() => Sound.order(), 180);
            for (const o of fx.order) flash(o[1], 'order');
            toast(COLOR[fx.color] + '’s commander orders an advance!');
          }
          if (fx.rolls && fx.rolls.length) {
            const six = fx.rolls.indexOf(6) >= 0;
            toast(six ? '🎲 Rolled a 6 — the banana becomes three!' : '🎲 Banana roll: ' + fx.rolls.join(', ') + ' — no copies.', 2600);
          }
        }
      }
    }
    // check sound
    let ck = '';
    if (s.phase === 'play' && !s.sub) {
      const side = s.state.turn;
      if (E.inCheck(s.state.board, side)) ck = s.startAt + ':' + s.state.ply;
    }
    if (ck && ck !== app.checkKey) Sound.check();
    app.checkKey = ck;
    // end of game
    if (s.phase === 'over' && app.resultShown !== s.startAt) {
      const me = myColor();
      if (s.result.winner && me) (s.result.winner === me ? Sound.win : Sound.lose)();
      else Sound.win();
    }
  }

  function render() {
    const s = app.snap;
    renderOverlay();
    if (!s) { renderStatus(); return; }
    renderPieces();
    renderHighlights();
    renderPlayers();
    renderStatus();
    renderTray();
    renderLog();
    renderButtons();
    renderResult();
    updateClocks();
  }

  function renderPlayers() {
    const s = app.snap;
    const bottom = app.flip ? 'b' : 'w', top = E.opp(bottom);
    const counts = E.countPieces(boardOf(s));
    const side = s.phase === 'play' ? sideToAct(s) : null;
    const fill = (sel, c) => {
      const el = $(sel);
      const info = playerInfo(c);
      const dot = info.online == null ? '' : '<span class="dot' + (info.online ? ' on' : '') + '" title="' + (info.online ? 'Online' : 'Offline') + '"></span>';
      el.innerHTML =
        '<div class="chip">' + PC.svg('K', c) + '</div>' +
        '<div class="who"><b>' + esc(info.name) + '</b><small>' + dot + esc(info.tag) + '</small></div>' +
        (side === c ? '<span class="turn-flag">' + (s.sub ? 'Placing' : 'To move') + '</span>' : '') +
        '<div class="army"><b>' + counts[c] + '</b><small>Army</small></div>';
      el.classList.toggle('active', side === c);
    };
    fill('#pbar-top', top);
    fill('#pbar-bottom', bottom);
  }

  function resultText(s) {
    const r = s.result;
    const me = myColor();
    let title;
    if (!r.winner) title = 'Draw';
    else if (me) title = r.winner === me ? 'Victory' : 'Defeat';
    else title = COLOR[r.winner] + ' wins';
    const loser = r.winner ? E.opp(r.winner) : null;
    const loserName = loser ? (me === loser ? 'You' : nameOf(loser)) : '';
    let reason;
    switch (r.reason) {
      case 'checkmate': reason = 'Checkmate.'; break;
      case 'timeout': reason = loserName + (loserName === 'You' ? ' ran' : ' ran') + ' out of turn time.'; break;
      case 'time': reason = r.winner ? 'Fifteen minutes are up — the larger army wins.' : 'Fifteen minutes are up — the armies are equal.'; break;
      case 'resign': reason = loserName + (loserName === 'You' ? ' resigned.' : ' resigned.'); break;
      case 'stalemate': reason = 'No legal move and no check — a draw.'; break;
      default: reason = '';
    }
    return { title, reason };
  }

  function renderStatus() {
    const el = $('#status');
    const s = app.snap;
    let title = '', sub = '', cls = '';
    if (app.mode === 'online' && app.online && !app.online.connected) {
      title = 'Connecting…';
      sub = 'Reaching the table.';
    } else if (!s) {
      title = 'Loading…';
    } else if (s.phase === 'ready') {
      title = 'Waiting for your friend';
      sub = app.seat ? 'Send them the invite link below.' : 'The table is not full yet.';
    } else if (s.phase === 'countdown') {
      title = 'Get ready';
      sub = 'The first piece arrives 10 seconds after the start.';
    } else if (s.phase === 'over') {
      const t = resultText(s);
      title = t.title;
      sub = t.reason;
    } else {
      const me = actor();
      const side = sideToAct(s);
      if (s.sub) {
        const p = s.sub.recruits[0];
        if (me) {
          const chk = E.inCheck(s.sub.board, side);
          title = (app.mode === 'local' ? COLOR[side] + ': place' : 'Place your') + ' ' + NAMES[p.t];
          sub = chk ? 'Your king is in check — block it with your recruit!' : 'Tap a glowing square in your half.';
          cls = chk ? 'alert' : 'mine';
        } else {
          title = nameOf(side) + ' is placing a recruit';
          sub = NAMES[p.t] + ' joins their army.';
        }
      } else if (me) {
        const chk = E.inCheck(s.state.board, side);
        title = app.mode === 'local' ? COLOR[side] + ' to move' : 'Your move';
        sub = chk ? 'Your king is in check!' : 'Drag or tap a piece.';
        cls = chk ? 'alert' : 'mine';
      } else {
        title = app.mode === 'ai' ? 'Computer is thinking…' : app.mode === 'online' && !app.seat ? COLOR[side] + ' to move' : nameOf(side) + ' to move';
        if (E.inCheck(s.state.board, side)) sub = 'Their king is in check.';
        else if (app.mode === 'online') {
          const seats = app.online.info && app.online.info.seats;
          if (seats && seats[side] && !seats[side].online) sub = 'Opponent disconnected — their turn clock keeps running.';
        }
      }
    }
    el.className = 'status' + (cls ? ' ' + cls : '');
    el.innerHTML = '<div>' + esc(title) + (sub ? '<small>' + esc(sub) + '</small>' : '') + '</div>';
  }

  function renderTray() {
    const s = app.snap;
    const el = $('#tray');
    if (!s.sub || !s.sub.recruits.length || s.phase !== 'play') { el.hidden = true; return; }
    el.hidden = false;
    el.innerHTML = '<span class="tray-label">' + (s.sub.recruits.length > 1 ? 'Recruits to place' : 'Recruit to place') + '</span>' +
      s.sub.recruits.map((p, i) => '<span class="slot' + (i === 0 ? ' now' : '') + '" title="' + NAMES[p.t] + '">' + PC.svg(p.t, p.o) + '</span>').join('');
  }

  function logLine(e) {
    const who = c => (c ? nameOf(c) : '');
    const sq = E.sqName;
    switch (e.k) {
      case 'spawn': return 'A neutral ' + NAMES[e.t] + ' appears on ' + sq(e.sq) + '.';
      case 'skip': return 'The board is full — no piece appears.';
      case 'move': {
        let t = who(e.c) + ': ' + NAMES[e.t] + ' ' + sq(e.from) + '→' + sq(e.to);
        if (e.cap) t += ', recruits ' + (e.capo === 'n' ? 'a neutral ' : 'an enemy ') + NAMES[e.cap];
        if (e.promo) t += ', promotes to ' + NAMES[e.promo];
        return t + '.';
      }
      case 'place': return who(e.c) + ' place' + (who(e.c) === 'You' ? '' : 's') + ' the ' + NAMES[e.t] + ' on ' + sq(e.sq) + '.';
      case 'order': return COLOR[e.c] + '’s commander orders an advance — ' + e.n + ' moved' + (e.rec ? ', ' + e.rec + ' recruited' : '') + '.';
      case 'roll': return COLOR[e.c] + ' rolls a ' + e.die + (e.die === 6 ? ' — three bananas!' : '.');
      case 'lost': return 'No room on the board — the ' + NAMES[e.t] + ' leaves the game.';
      case 'end': {
        const r = resultText(app.snap);
        return r.title + '. ' + r.reason;
      }
      default: return '';
    }
  }

  function renderLog() {
    const s = app.snap;
    const lastE = s.log[s.log.length - 1];
    const key = s.startAt + ':' + s.log.length + ':' + JSON.stringify(lastE || null) + ':' + app.seat;
    if (key === app.logKey) return;
    app.logKey = key;
    const items = s.log.slice(-40).reverse();
    $('#log').innerHTML = items.length
      ? items.map(e => '<li class="k-' + e.k + ' c-' + (e.c || (e.k === 'spawn' ? 'n' : '')) + '">' + esc(logLine(e)) + '</li>').join('')
      : '<li>The board is quiet. The first piece arrives 10 seconds after the start.</li>';
  }

  function renderButtons() {
    const s = app.snap;
    const running = s.phase === 'play' || s.phase === 'countdown';
    const canResign = running && (app.mode !== 'online' || !!app.seat);
    $('#btn-resign').hidden = !canResign;
    const rb = $('#btn-rematch');
    rb.hidden = s.phase !== 'over' || (app.mode === 'online' && !app.seat);
    $('#result-rematch').hidden = rb.hidden;
    let label = 'Rematch';
    if (app.mode === 'online' && app.online && app.online.info && app.seat) {
      const v = app.online.info.rematch || {};
      if (v[app.seat]) label = 'Waiting for opponent…';
      else if (v[E.opp(app.seat)]) label = 'Accept rematch';
    }
    rb.textContent = label;
    $('#result-rematch').textContent = label;
    $('#btn-sound').textContent = app.sound ? 'Sound on' : 'Sound off';
  }

  function renderResult() {
    const s = app.snap;
    if (s.phase !== 'over' || app.resultShown === s.startAt) return;
    app.resultShown = s.startAt;
    const t = resultText(s);
    $('#result-title').textContent = t.title;
    $('#result-reason').textContent = t.reason;
    $('#result-crest').innerHTML = PC.svg('K', s.result.winner || 'n');
    const c = s.result.counts;
    $('#result-score').innerHTML =
      '<div><b>' + c.w + '</b><small>White</small></div><div><b>' + c.b + '</b><small>Black</small></div>';
    setTimeout(() => { if (app.snap === s || (app.snap && app.snap.startAt === s.startAt)) $('#result').hidden = false; }, 700);
  }

  function renderOverlay() {
    const el = $('#overlay');
    const s = app.snap;
    let key = '', html = '';
    if (app.mode === 'online' && (!s || (app.online && !app.online.connected && !s))) {
      key = 'connecting';
      html = '<div><h3>Connecting…</h3><p>Finding your table.</p></div>';
    } else if (s && s.phase === 'ready') {
      const room = app.online ? app.online.room : '';
      key = 'ready:' + room + ':' + app.seat;
      html = '<div><h3>Waiting for your friend</h3><p>Send this link. The game starts as soon as they open it.</p>' +
        '<div class="code">' + esc(room) + '</div>' +
        '<div class="share"><button type="button" class="btn primary" data-act="copy">Copy invite link</button>' +
        (navigator.share ? '<button type="button" class="btn" data-act="share">Share…</button>' : '') + '</div></div>';
    } else if (s && s.phase === 'countdown') {
      const n = Math.max(1, Math.ceil((s.startAt - now()) / 1000));
      key = 'cd:' + n;
      html = '<div class="big">' + n + '</div>';
    }
    if (key === app.overlayKey) return;
    app.overlayKey = key;
    el.hidden = !key;
    el.innerHTML = html;
    const copy = $('[data-act="copy"]', el);
    if (copy) copy.addEventListener('click', copyInvite);
    const share = $('[data-act="share"]', el);
    if (share) share.addEventListener('click', shareInvite);
  }

  // ---- clocks (every 100 ms) ----
  const fmt = ms => {
    const t = Math.max(0, Math.ceil(ms / 1000));
    return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0');
  };
  let lastTickSecond = -1;

  function updateClocks() {
    const s = app.snap;
    if (!s || $('#game').hidden) return;
    const t = now();
    let game = E.GAME_MS, turn = E.TURN_MS;
    if (s.phase === 'play') { game = s.endAt - t; turn = s.turnEndAt - t; }
    else if (s.phase === 'over' && s.result) { game = s.endAt - s.result.at; turn = s.turnEndAt - s.result.at; }
    game = Math.max(0, Math.min(E.GAME_MS, game));
    turn = Math.max(0, Math.min(E.TURN_MS, turn));
    const gs = fmt(game);
    $('#clock-game').textContent = gs.length < 5 ? '0' + gs : gs;
    $('#clock-turn').textContent = fmt(turn);
    const warn = s.phase === 'play' && turn <= 10000;
    $('#lcd-turn').classList.toggle('warn', warn);
    const bar = $('#turnbar');
    bar.style.transform = 'scaleX(' + (turn / E.TURN_MS) + ')';
    bar.classList.toggle('warn', warn);
    $('#turn-label').textContent = s.phase === 'play' ? 'Turn · ' + COLOR[sideToAct(s)] : 'Turn';
    if (warn && actor()) {
      const sec = Math.ceil(turn / 1000);
      if (sec <= 5 && sec !== lastTickSecond) { lastTickSecond = sec; Sound.tick(); }
    }

    // arrivals
    const rate = E.RATE_MS[s.state.rate];
    const rateTxt = [
      'Arrivals every 10 s — slows to 30 s once an army reaches 5.',
      'Arrivals every 30 s — slows to 60 s once both armies reach 10.',
      'Arrivals every 60 s — the slowest rate.',
    ][s.state.rate];
    const spawnIn = $('#spawn-in'), spawnBar = $('#spawnbar');
    if (s.phase === 'play' && s.nextSpawnAt < s.endAt) {
      const left = Math.max(0, s.nextSpawnAt - t);
      const total = Math.max(1, s.nextSpawnAt - (s.spawnFrom || (s.nextSpawnAt - rate)));
      spawnIn.textContent = Math.ceil(left / 1000) + 's';
      spawnBar.style.width = (100 - Math.min(100, (left / total) * 100)) + '%';
    } else if (s.phase === 'countdown' || s.phase === 'ready') {
      spawnIn.textContent = '10s';
      spawnBar.style.width = '0%';
    } else {
      spawnIn.textContent = '—';
      spawnBar.style.width = '0%';
    }
    $('#spawn-rate').textContent = rateTxt;
    if (s.phase === 'countdown') renderOverlay();
  }

  function frame() {
    if (app.match && app.mode !== 'online') {
      if (app.match.tick(Date.now())) refresh();
    }
    if (app.snap && app.snap.phase === 'countdown' && app.mode === 'online') renderOverlay();
    updateClocks();
    maybeAI();
  }

  // ======================================================================
  // Wiring
  // ======================================================================
  function bind() {
    $('#start-ai').addEventListener('click', startAI);
    $('#start-local').addEventListener('click', startLocal);
    $('#create-room').addEventListener('click', createRoom);
    $('#join-form').addEventListener('submit', e => { e.preventDefault(); joinRoom($('#join-code').value); });
    $('#player-name').addEventListener('change', saveName);
    $('#copy-link').addEventListener('click', copyInvite);
    $('#btn-resign').addEventListener('click', resign);
    $('#btn-rematch').addEventListener('click', rematch);
    $('#result-rematch').addEventListener('click', rematch);
    $('#result-view').addEventListener('click', () => { $('#result').hidden = true; });
    $('#result-menu').addEventListener('click', () => { $('#result').hidden = true; goMenu(); });
    $('#btn-menu').addEventListener('click', goMenu);
    $('#btn-flip').addEventListener('click', () => { app.flip = !app.flip; layoutSquares(); render(); });
    $('#btn-sound').addEventListener('click', () => {
      app.sound = !app.sound;
      store.set('sound', app.sound);
      Sound.unlock();
      renderButtons();
    });
    $$('[data-open-rules]').forEach(b => b.addEventListener('click', () => {
      const d = $('#rules');
      if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', '');
    }));
    $('#rules').addEventListener('click', e => { if (e.target === $('#rules')) $('#rules').close(); });
    document.addEventListener('pointerdown', e => {
      if (app.promo && !$('#promo').contains(e.target)) closePromo();
    }, true);
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        if (app.promo) closePromo();
        else if (!$('#result').hidden) $('#result').hidden = true;
        else if (app.sel !== null) { app.sel = null; renderHighlights(); }
      }
    });
    window.addEventListener('resize', () => { if (app.promo) closePromo(); });
  }

  function init() {
    window.SpanerApp = app; // handy for debugging from the console
    PC.inject();
    buildMenu();
    buildBoard();
    bind();
    setInterval(frame, 100);
    const room = parseCode(new URLSearchParams(location.search).get('room') || '');
    if (room) joinRoom(room);
    else showScreen('menu');
  }

  init();
})();
