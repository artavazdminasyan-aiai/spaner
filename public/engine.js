/* Spaner — rules engine.
 * Shared by the browser UI, the AI Web Worker and the Node server (UMD).
 * Board squares are 0..63: a1 = 0, h1 = 7, a8 = 56, h8 = 63.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Spaner = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const W = 'w', B = 'b', N = 'n';
  const GAME_MS = 15 * 60 * 1000;
  const TURN_MS = 30 * 1000;
  const FIRST_SPAWN_MS = 10 * 1000;
  const RATE_MS = [10 * 1000, 30 * 1000, 60 * 1000];
  const DRAGON_LIMIT = 5;
  const ORDER_EVERY = 5;
  const SPAWN_TYPES = ['Q', 'R', 'B', 'N', 'P', 'C', 'D', 'A'];
  const PROMOS = ['Q', 'R', 'B', 'N'];
  const NAMES = {
    K: 'King', Q: 'Queen', R: 'Rook', B: 'Bishop', N: 'Knight', P: 'Pawn',
    C: 'Commander', D: 'Dragon', A: 'Banana',
  };

  const opp = c => (c === W ? B : W);
  const fileOf = s => s & 7;
  const rankOf = s => s >> 3;
  const sqName = s => 'abcdefgh'[s & 7] + ((s >> 3) + 1);
  const inHalf = (s, c) => (c === W ? s < 32 : s >= 32);
  const fwd = c => (c === W ? 8 : -8);
  const lastRank = c => (c === W ? 7 : 0);
  const isOrth = t => t === 'Q' || t === 'R' || t === 'A';
  const isDiag = t => t === 'Q' || t === 'B';
  const canTake = (q, c) => q.o !== c && q.t !== 'K';

  // ---- precomputed geometry -------------------------------------------------
  const KNIGHT = [], KING = [], RAYS = [];
  (function () {
    const on = (f, r) => f >= 0 && f < 8 && r >= 0 && r < 8;
    const kd = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
    const gd = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
    // first four directions are orthogonal, last four diagonal
    const dirs = [[0, 1], [0, -1], [1, 0], [-1, 0], [1, 1], [1, -1], [-1, 1], [-1, -1]];
    for (let s = 0; s < 64; s++) {
      const f = s & 7, r = s >> 3;
      KNIGHT[s] = kd.filter(([a, b]) => on(f + a, r + b)).map(([a, b]) => (r + b) * 8 + f + a);
      KING[s] = gd.filter(([a, b]) => on(f + a, r + b)).map(([a, b]) => (r + b) * 8 + f + a);
      RAYS[s] = dirs.map(([a, b]) => {
        const ray = [];
        let x = f + a, y = r + b;
        while (on(x, y)) { ray.push(y * 8 + x); x += a; y += b; }
        return ray;
      });
    }
  })();

  // ---- pieces & state -------------------------------------------------------
  function makePiece(t, o, id) {
    const p = { t, o, id };
    if (t === 'D') p.d = 0; // recruits used (lifetime, survives side changes)
    if (t === 'C') p.c = 0; // completed owner turns since recruited
    return p;
  }

  function initialState() {
    const board = new Array(64).fill(null);
    board[4] = makePiece('K', W, 1);  // e1
    board[60] = makePiece('K', B, 2); // e8
    return { board, turn: W, ply: 0, rate: 0, nextId: 3 };
  }

  // ---- move generation ------------------------------------------------------
  function genFrom(board, s, c, capOnly, noFly, promos, out) {
    const p = board[s];
    const t = p.t;
    if (t === 'P') {
      const to = s + fwd(c);
      if (to < 0 || to > 63) return;
      const promo = rankOf(to) === lastRank(c);
      const add = (dst, cap) => {
        if (promo) for (let i = 0; i < promos.length; i++) out.push({ from: s, to: dst, cap, promo: promos[i] });
        else out.push({ from: s, to: dst, cap });
      };
      if (!board[to] && (!capOnly || promo)) add(to, false);
      const f = s & 7;
      if (f > 0) { const q = board[to - 1]; if (q && canTake(q, c)) add(to - 1, true); }
      if (f < 7) { const q = board[to + 1]; if (q && canTake(q, c)) add(to + 1, true); }
    } else if (t === 'N' || t === 'K') {
      const list = t === 'N' ? KNIGHT[s] : KING[s];
      for (let i = 0; i < list.length; i++) {
        const to = list[i], q = board[to];
        if (!q) { if (!capOnly) out.push({ from: s, to, cap: false }); }
        else if (canTake(q, c)) out.push({ from: s, to, cap: true });
      }
    } else if (t === 'Q' || t === 'R' || t === 'B' || t === 'A') {
      const d0 = t === 'B' ? 4 : 0;
      const d1 = t === 'R' || t === 'A' ? 4 : 8;
      const rays = RAYS[s];
      for (let d = d0; d < d1; d++) {
        const ray = rays[d];
        for (let i = 0; i < ray.length; i++) {
          const to = ray[i], q = board[to];
          if (!q) { if (!capOnly) out.push({ from: s, to, cap: false }); continue; }
          if (canTake(q, c)) out.push({ from: s, to, cap: true });
          break;
        }
      }
    } else if (t === 'D') {
      const left = DRAGON_LIMIT - (p.d || 0);
      for (let to = 0; to < 64; to++) {
        if (to === s) continue;
        const q = board[to];
        if (!q) { if (!capOnly && !noFly) out.push({ from: s, to, cap: false }); }
        else if (left > 0 && canTake(q, c)) out.push({ from: s, to, cap: true });
      }
    }
    // Commander ('C') never moves.
  }

  /** Pseudo-legal moves for colour c. opt: {capturesOnly, noFly, promos} */
  function genMoves(board, c, opt) {
    const capOnly = !!(opt && opt.capturesOnly);
    const noFly = !!(opt && opt.noFly);
    const promos = (opt && opt.promos) || PROMOS;
    const out = [];
    for (let s = 0; s < 64; s++) {
      const p = board[s];
      if (p && p.o === c) genFrom(board, s, c, capOnly, noFly, promos, out);
    }
    return out;
  }

  function movesFrom(board, s, opt) {
    const p = board[s];
    if (!p || p.o === N) return [];
    const out = [];
    genFrom(board, s, p.o, !!(opt && opt.capturesOnly), !!(opt && opt.noFly), (opt && opt.promos) || PROMOS, out);
    return out;
  }

  /** Is square s attacked by colour `by`? Dragons, commanders and neutrals never attack. */
  function attacked(board, s, by) {
    const f = s & 7;
    const pr = by === W ? s - 8 : s + 8;
    if (pr >= 0 && pr < 64) {
      if (f > 0) { const q = board[pr - 1]; if (q && q.o === by && q.t === 'P') return true; }
      if (f < 7) { const q = board[pr + 1]; if (q && q.o === by && q.t === 'P') return true; }
    }
    const kn = KNIGHT[s];
    for (let i = 0; i < kn.length; i++) { const q = board[kn[i]]; if (q && q.o === by && q.t === 'N') return true; }
    const kg = KING[s];
    for (let i = 0; i < kg.length; i++) { const q = board[kg[i]]; if (q && q.o === by && q.t === 'K') return true; }
    const rays = RAYS[s];
    for (let d = 0; d < 8; d++) {
      const ray = rays[d];
      for (let i = 0; i < ray.length; i++) {
        const q = board[ray[i]];
        if (!q) continue;
        if (q.o === by && (d < 4 ? isOrth(q.t) : isDiag(q.t))) return true;
        break;
      }
    }
    return false;
  }

  function kingSq(board, c) {
    for (let s = 0; s < 64; s++) { const p = board[s]; if (p && p.t === 'K' && p.o === c) return s; }
    return -1;
  }

  function inCheck(board, c) {
    const k = kingSq(board, c);
    return k >= 0 && attacked(board, k, opp(c));
  }

  /** Pieces of colour `by` giving check to the king on k, with the empty squares between. */
  function checkers(board, k, by) {
    const res = [];
    const f = k & 7;
    const pr = by === W ? k - 8 : k + 8;
    if (pr >= 0 && pr < 64) {
      if (f > 0) { const q = board[pr - 1]; if (q && q.o === by && q.t === 'P') res.push({ sq: pr - 1, between: [] }); }
      if (f < 7) { const q = board[pr + 1]; if (q && q.o === by && q.t === 'P') res.push({ sq: pr + 1, between: [] }); }
    }
    for (const s of KNIGHT[k]) { const q = board[s]; if (q && q.o === by && q.t === 'N') res.push({ sq: s, between: [] }); }
    for (const s of KING[k]) { const q = board[s]; if (q && q.o === by && q.t === 'K') res.push({ sq: s, between: [] }); }
    for (let d = 0; d < 8; d++) {
      const ray = RAYS[k][d];
      for (let i = 0; i < ray.length; i++) {
        const q = board[ray[i]];
        if (!q) continue;
        if (q.o === by && (d < 4 ? isOrth(q.t) : isDiag(q.t))) res.push({ sq: ray[i], between: ray.slice(0, i) });
        break;
      }
    }
    return res;
  }

  // ---- recruit placement ----------------------------------------------------
  /** Empty squares in c's half; if that half is full, any empty square. */
  function placeRegion(board, c) {
    const res = [];
    const lo = c === W ? 0 : 32;
    for (let s = lo; s < lo + 32; s++) if (!board[s]) res.push(s);
    if (res.length) return res;
    for (let s = 0; s < 64; s++) if (!board[s]) res.push(s);
    return res;
  }

  /**
   * If c's king is in check, find squares where up to n recruits can be placed to block every
   * check. Returns [] when no block is needed, an array of squares, or null if impossible.
   */
  function blockPlan(board, c, n) {
    const k = kingSq(board, c);
    if (k < 0) return [];
    const o = opp(c);
    const ch = checkers(board, k, o);
    if (!ch.length) return [];
    if (ch.length > n) return null;
    for (const x of ch) if (!x.between.length) return null;
    const b = board.slice();
    const stub = { t: 'X', o: c };
    const plan = [];
    const dfs = i => {
      if (i === ch.length) return !attacked(b, k, o);
      const region = placeRegion(b, c);
      for (const s of ch[i].between) {
        if (region.indexOf(s) < 0) continue;
        b[s] = stub; plan.push(s);
        if (dfs(i + 1)) return true;
        b[s] = null; plan.pop();
      }
      return false;
    };
    return dfs(0) ? plan : null;
  }

  /** Squares where the next recruit may go, given `count` recruits still to place (incl. this one). */
  function validPlacements(board, c, count) {
    const region = placeRegion(board, c);
    if (!region.length) return region;
    const k = kingSq(board, c), o = opp(c);
    if (k < 0 || !attacked(board, k, o)) return region;
    const b = board.slice(), stub = { t: 'X', o: c }, res = [];
    for (const s of region) {
      b[s] = stub;
      if (!attacked(b, k, o) || (count > 1 && blockPlan(b, c, count - 1))) res.push(s);
      b[s] = null;
    }
    return res.length ? res : region;
  }

  /** A pawn that lands on its far edge through placement becomes a queen. */
  function landPiece(p, s) {
    if (p.t === 'P' && rankOf(s) === lastRank(p.o)) return { t: 'Q', o: p.o, id: p.id };
    return p;
  }

  // ---- playing a move -------------------------------------------------------
  function recruitInto(q, c, recruits, nextId, roll, fx) {
    const r = Object.assign({}, q, { o: c });
    if (r.t === 'C') r.c = 0; // a commander that changes sides starts counting again
    recruits.push(r);
    if (r.t === 'A' && roll) {
      const die = roll();
      fx.rolls.push(die);
      if (die === 6) {
        recruits.push({ t: 'A', o: c, id: nextId++ });
        recruits.push({ t: 'A', o: c, id: nextId++ });
      }
    }
    return nextId;
  }

  function runOrder(board, c, recruits, nextId, roll, fx) {
    const d = fwd(c);
    const list = [];
    for (let s = 0; s < 64; s++) {
      const q = board[s];
      if (q && q.o === c && (q.t === 'R' || q.t === 'A')) list.push(s);
    }
    // closest to the far edge first; same row from the a-file to the h-file
    list.sort((a, b) => (c === W ? rankOf(b) - rankOf(a) : rankOf(a) - rankOf(b)) || fileOf(a) - fileOf(b));
    const moves = [];
    for (const s of list) {
      const t = s + d;
      if (t < 0 || t > 63) continue;
      const piece = board[s];
      const q = board[t];
      if (!q) {
        board[t] = piece; board[s] = null; moves.push([s, t, 0]);
      } else if (q.o !== c && q.t !== 'K') {
        nextId = recruitInto(q, c, recruits, nextId, roll, fx);
        board[t] = piece; board[s] = null; moves.push([s, t, 1]);
      }
    }
    fx.order = moves;
    return nextId;
  }

  /**
   * Plays the move part of a turn: the move itself, commander counting and any order.
   * Recruits are returned unplaced. `roll` is a d6 function (null = no banana copies).
   * Returns null when the move is illegal (e.g. king stepping onto an attacked square).
   */
  function playMove(state, mv, roll) {
    const c = state.turn, o = opp(c);
    const board = state.board.slice();
    const p = board[mv.from];
    if (!p || p.o !== c) return null;
    const target = board[mv.to];
    const recruits = [];
    const fx = { rolls: [], order: null };
    let nextId = state.nextId;
    let mover = p;
    if (target) {
      if (!canTake(target, c)) return null;
      if (p.t === 'D') mover = Object.assign({}, p, { d: (p.d || 0) + 1 });
      nextId = recruitInto(target, c, recruits, nextId, roll, fx);
    }
    if (mv.promo) mover = { t: mv.promo, o: c, id: p.id };
    board[mv.from] = null;
    board[mv.to] = mover;
    if (p.t === 'K' && attacked(board, mv.to, o)) return null;
    let due = false;
    for (let s = 0; s < 64; s++) {
      const q = board[s];
      if (q && q.t === 'C' && q.o === c) {
        let n = (q.c || 0) + 1;
        if (n >= ORDER_EVERY) { n = 0; due = true; }
        board[s] = { t: 'C', o: c, id: q.id, c: n };
      }
    }
    if (due) nextId = runOrder(board, c, recruits, nextId, roll, fx);
    return { board, recruits, nextId, fx };
  }

  /** Can the mover end this turn with a safe king (placing recruits to block if needed)? */
  function turnIsSafe(res, c) {
    if (!res) return false;
    const k = kingSq(res.board, c);
    if (k < 0 || !attacked(res.board, k, opp(c))) return true;
    return res.recruits.length > 0 && !!blockPlan(res.board, c, res.recruits.length);
  }

  function legalMoves(state, opt) {
    const c = state.turn;
    const out = [];
    for (const mv of genMoves(state.board, c, opt)) {
      if (turnIsSafe(playMove(state, mv, null), c)) out.push(mv);
    }
    return out;
  }

  function countPieces(board) {
    const n = { w: 0, b: 0, n: 0 };
    for (let s = 0; s < 64; s++) { const p = board[s]; if (p) n[p.o]++; }
    return n;
  }

  function endTurn(state, board, nextId) {
    const n = countPieces(board);
    let rate = state.rate;
    if (rate < 1 && (n.w >= 5 || n.b >= 5)) rate = 1;
    if (rate < 2 && n.w >= 10 && n.b >= 10) rate = 2;
    return { board, turn: opp(state.turn), ply: state.ply + 1, rate, nextId };
  }

  // ---- real-time match ------------------------------------------------------
  /**
   * A full game with clocks and spawns. Time is always passed in (ms), so the same class
   * runs in the browser and on the server.
   * phase: 'ready' → 'countdown' → 'play' → 'over'
   */
  class Match {
    constructor(opt) {
      opt = opt || {};
      this.rng = opt.rng || Math.random;
      this.state = initialState();
      this.phase = 'ready';
      this.sub = null; // in-progress turn: {color, board, recruits, nextId}
      this.startAt = 0;
      this.turnStart = 0;
      this.nextSpawnAt = 0;
      this.spawnFrom = 0;
      this.result = null;
      this.log = [];
      this.v = 0;
      this.last = null;
      this.fx = null;
      this.fxSeq = 0;
      this.spawnSeq = 100000;
      this.now = 0;
      this._legal = null;
    }

    get endAt() { return this.startAt + GAME_MS; }
    get turnEndAt() { return this.turnStart + TURN_MS; }

    start(now, delay) {
      delay = delay || 0;
      this.now = now;
      this.startAt = now + delay;
      this.turnStart = this.startAt;
      this.nextSpawnAt = this.startAt + FIRST_SPAWN_MS;
      this.spawnFrom = this.startAt;
      this.phase = delay > 0 ? 'countdown' : 'play';
      this.touch();
    }

    touch() { this.v++; this._legal = null; }
    legal() { if (!this._legal) this._legal = legalMoves(this.state); return this._legal; }
    addLog(e) { this.log.push(e); if (this.log.length > 300) this.log.shift(); }
    setFx(fx) { fx.id = ++this.fxSeq; this.fx = fx; }

    tick(now) {
      const v0 = this.v;
      this.now = Math.max(this.now, now);
      if (this.phase === 'countdown' && now >= this.startAt) { this.phase = 'play'; this.touch(); }
      if (this.phase !== 'play') return this.v !== v0;
      const gEnd = this.endAt;
      while (this.phase === 'play' && this.nextSpawnAt <= now && this.nextSpawnAt < gEnd &&
             this.nextSpawnAt <= this.turnEndAt) {
        const at = this.nextSpawnAt;
        this.spawnOne(at);
        // the wait in progress is finished before a new rate applies
        this.nextSpawnAt = at + RATE_MS[this.state.rate];
        this.spawnFrom = at;
      }
      if (this.phase === 'play') {
        const tEnd = this.turnEndAt;
        if (now >= Math.min(tEnd, gEnd)) {
          if (tEnd < gEnd) this.finish(opp(this.state.turn), 'timeout', tEnd);
          else this.finishOnScore(gEnd);
        }
      }
      return this.v !== v0;
    }

    spawnOne(at) {
      const a = this.state.board, b = this.sub ? this.sub.board : null;
      const empty = [];
      for (let s = 0; s < 64; s++) if (!a[s] && (!b || !b[s])) empty.push(s);
      if (!empty.length) { this.addLog({ k: 'skip', at }); this.touch(); return; }
      const sq = empty[Math.floor(this.rng() * empty.length)];
      const t = SPAWN_TYPES[Math.floor(this.rng() * SPAWN_TYPES.length)];
      const piece = makePiece(t, N, this.spawnSeq++);
      const na = a.slice(); na[sq] = piece;
      this.state = Object.assign({}, this.state, { board: na });
      if (b) { const nb = b.slice(); nb[sq] = piece; this.sub.board = nb; }
      this.setFx({ spawn: sq });
      this.addLog({ k: 'spawn', t, sq, at });
      this.touch();
      if (!this.sub) this.checkEnd(at);
    }

    move(color, mv, now) {
      this.tick(now);
      if (this.phase !== 'play') return { ok: false, error: 'The game is not running.' };
      if (this.state.turn !== color) return { ok: false, error: 'Not your turn.' };
      if (this.sub) return { ok: false, error: 'Place your recruits first.' };
      const m = this.legal().find(x => x.from === mv.from && x.to === mv.to && (x.promo || null) === (mv.promo || null));
      if (!m) return { ok: false, error: 'Illegal move.' };
      const p = this.state.board[m.from], cap = this.state.board[m.to];
      const res = playMove(this.state, m, () => 1 + Math.floor(this.rng() * 6));
      this.sub = { color, board: res.board, recruits: res.recruits, nextId: res.nextId };
      this.last = { from: m.from, to: m.to, color };
      this.setFx({ move: [m.from, m.to], cap: !!cap, order: res.fx.order, rolls: res.fx.rolls, color });
      this.addLog({ k: 'move', c: color, t: p.t, from: m.from, to: m.to, cap: cap ? cap.t : null, capo: cap ? cap.o : null, promo: m.promo || null });
      if (res.fx.order) this.addLog({ k: 'order', c: color, n: res.fx.order.length, rec: res.fx.order.filter(x => x[2]).length });
      for (const d of res.fx.rolls) this.addLog({ k: 'roll', c: color, die: d });
      this.settle(now);
      this.touch();
      return { ok: true };
    }

    place(color, sq, now) {
      this.tick(now);
      if (this.phase !== 'play') return { ok: false, error: 'The game is not running.' };
      if (!this.sub || this.sub.color !== color) return { ok: false, error: 'Nothing to place.' };
      const valid = validPlacements(this.sub.board, color, this.sub.recruits.length);
      if (valid.indexOf(sq) < 0) return { ok: false, error: 'You cannot place a recruit there.' };
      const piece = this.sub.recruits.shift();
      const nb = this.sub.board.slice();
      nb[sq] = landPiece(piece, sq);
      this.sub.board = nb;
      this.setFx({ place: sq, color });
      this.addLog({ k: 'place', c: color, t: piece.t, sq });
      this.settle(now);
      this.touch();
      return { ok: true };
    }

    settle(now) {
      const sub = this.sub;
      while (sub.recruits.length && !placeRegion(sub.board, sub.color).length) {
        const p = sub.recruits.shift(); // whole board full: the recruit leaves the game
        this.addLog({ k: 'lost', c: sub.color, t: p.t });
      }
      if (!sub.recruits.length) this.completeTurn(now);
    }

    completeTurn(now) {
      const sub = this.sub;
      this.state = endTurn(this.state, sub.board, Math.max(sub.nextId, this.state.nextId));
      this.sub = null;
      this.turnStart = Math.max(now, this.startAt);
      this._legal = null;
      this.checkEnd(now);
    }

    checkEnd(at) {
      if (this.legal().length) return;
      const side = this.state.turn;
      if (inCheck(this.state.board, side)) this.finish(opp(side), 'checkmate', at);
      else this.finish(null, 'stalemate', at);
    }

    finishOnScore(at) {
      this.sub = null; // score the position after the last completed turn
      const n = countPieces(this.state.board);
      this.finish(n.w > n.b ? W : n.b > n.w ? B : null, 'time', at);
    }

    finish(winner, reason, at) {
      const n = countPieces(this.sub ? this.sub.board : this.state.board);
      this.phase = 'over';
      this.result = { winner, reason, counts: { w: n.w, b: n.b }, at: at || this.now };
      this.addLog({ k: 'end', winner, reason });
      this.touch();
    }

    resign(color, now) {
      this.tick(now);
      if (this.phase !== 'play' && this.phase !== 'countdown') return { ok: false, error: 'The game is not running.' };
      this.finish(opp(color), 'resign', now);
      return { ok: true };
    }

    snapshot() {
      return {
        v: this.v,
        phase: this.phase,
        state: this.state,
        sub: this.sub ? { color: this.sub.color, board: this.sub.board, recruits: this.sub.recruits.slice() } : null,
        startAt: this.startAt,
        turnStart: this.turnStart,
        nextSpawnAt: this.nextSpawnAt,
        spawnFrom: this.spawnFrom,
        endAt: this.endAt,
        turnEndAt: this.turnEndAt,
        result: this.result,
        last: this.last,
        fx: this.fx,
        log: this.log.slice(-60),
      };
    }
  }

  return {
    W, B, N, GAME_MS, TURN_MS, FIRST_SPAWN_MS, RATE_MS, DRAGON_LIMIT, ORDER_EVERY,
    SPAWN_TYPES, PROMOS, NAMES, KNIGHT, KING, RAYS,
    opp, fileOf, rankOf, sqName, inHalf, fwd, lastRank,
    makePiece, initialState, genMoves, movesFrom, attacked, kingSq, inCheck, checkers,
    placeRegion, blockPlan, validPlacements, landPiece, playMove, turnIsSafe, legalMoves,
    countPieces, endTurn, Match,
  };
});
