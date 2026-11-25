/* Spaner — computer opponent.
 * Iterative-deepening alpha-beta with quiescence search and a transposition table.
 * Runs in a Web Worker in the browser, and in Node for tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine.js'));
  else root.SpanerAI = factory(root.Spaner);
})(typeof self !== 'undefined' ? self : this, function (E) {
  'use strict';
  const W = E.W, B = E.B, N = E.N, opp = E.opp;
  const MATE = 1000000;

  // think: minimum [from, to] ms before the move is shown, so fast levels still feel human.
  const LEVELS = [
    { id: 'beginner', name: 'Beginner', blurb: 'Still learning how the pieces move.', depth: 1, q: 0, time: 300, noise: 260, blunder: 0.35, think: [1100, 2200] },
    { id: 'novice', name: 'Novice', blurb: 'Grabs whatever it can see.', depth: 1, q: 2, time: 500, noise: 120, blunder: 0.12, think: [900, 1800] },
    { id: 'club', name: 'Club', blurb: 'Solid. Rarely hangs a piece.', depth: 2, q: 4, time: 1200, noise: 45, blunder: 0.03, think: [800, 1500] },
    { id: 'expert', name: 'Expert', blurb: 'Spots tactics and traps.', depth: 4, q: 6, time: 2000, noise: 10, blunder: 0, think: [600, 1200] },
    { id: 'master', name: 'Master', blurb: 'Deep search. Punishes mistakes.', depth: 6, q: 8, time: 3000, noise: 0, blunder: 0, think: [500, 900] },
    { id: 'god', name: 'God', blurb: 'Searches as deep as time allows.', depth: 40, q: 10, time: 6500, noise: 0, blunder: 0, think: [300, 600] },
  ];

  const VAL = { K: 0, Q: 900, R: 480, A: 470, B: 320, N: 300, P: 100, C: 230, D: 0, X: 0 };
  const val = p => (p.t === 'D' ? 150 + 110 * (E.DRAGON_LIMIT - (p.d || 0)) : VAL[p.t]);
  const countWeight = frac => 40 + 260 * Math.min(1, Math.max(0, frac)) ** 2;

  // ---- positional terms ------------------------------------------------------
  const CENTER = [];
  for (let s = 0; s < 64; s++) {
    const f = s & 7, r = s >> 3;
    CENTER[s] = (3.5 - Math.abs(f - 3.5)) + (3.5 - Math.abs(r - 3.5)); // 1..7
  }
  const PAWN_ADV = [0, 0, 6, 12, 22, 38, 65, 0];

  function pos(p, s) {
    const rr = p.o === W ? s >> 3 : 7 - (s >> 3);
    switch (p.t) {
      case 'P': return PAWN_ADV[rr];
      case 'N': return CENTER[s] * 4 - 8;
      case 'B': return CENTER[s] * 2.5;
      case 'Q': return CENTER[s] * 1.5;
      case 'R': case 'A': return rr * 3;
      case 'K': return rr === 0 ? 12 : rr === 1 ? 4 : -8 * rr;
      default: return 0;
    }
  }

  function danger(board, k, c) {
    if (k < 0) return 0;
    const o = opp(c);
    let d = 0;
    const ring = E.KING[k];
    for (let i = 0; i < ring.length; i++) {
      const q = board[ring[i]];
      if (q && q.o === c) d -= 5;
      else if (E.attacked(board, ring[i], o)) d += 16;
    }
    if (E.attacked(board, k, o)) d += 25;
    return d;
  }

  /** Static evaluation from the point of view of `side`. */
  function evaluate(board, side, ctx) {
    let sc = 0, wc = 0, bc = 0, wk = -1, bk = -1;
    for (let s = 0; s < 64; s++) {
      const p = board[s];
      if (!p || p.o === N) continue;
      const v = val(p) + pos(p, s);
      if (p.o === W) { sc += v; wc++; if (p.t === 'K') wk = s; }
      else { sc -= v; bc++; if (p.t === 'K') bk = s; }
    }
    sc += (wc - bc) * ctx.countW;
    if (ctx.kingSafety) { sc -= danger(board, wk, W); sc += danger(board, bk, B); }
    return side === W ? sc : -sc;
  }

  // ---- hashing ----------------------------------------------------------------
  const TIDX = { K: 0, Q: 1, R: 2, B: 3, N: 4, P: 5, C: 6, D: 7, A: 8, X: 9 };
  const OIDX = { w: 0, b: 1, n: 2 };
  const Z1 = new Uint32Array(64 * 180), Z2 = new Uint32Array(64 * 180);
  (function () {
    let x = 0x9e3779b9;
    const rnd = () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return x >>> 0; };
    for (let i = 0; i < Z1.length; i++) { Z1[i] = rnd(); Z2[i] = rnd(); }
  })();
  function hash(st) {
    let h1 = st.turn === W ? 0x1234567 : 0x7654321;
    let h2 = st.turn === W ? 0x2468ace : 0x13579bd;
    const b = st.board;
    for (let s = 0; s < 64; s++) {
      const p = b[s];
      if (!p) continue;
      const extra = p.t === 'D' ? (p.d || 0) : p.t === 'C' ? (p.c || 0) : 0;
      const i = s * 180 + (OIDX[p.o] * 10 + TIDX[p.t]) * 6 + extra;
      h1 ^= Z1[i]; h2 ^= Z2[i];
    }
    return (h1 >>> 0) * 2097152 + (h2 & 0x1fffff);
  }

  // ---- placement --------------------------------------------------------------
  // Preferred placement squares per colour and piece type (own half, best first).
  const PREF = { w: {}, b: {} };
  (function () {
    const score = (t, f, rr) => {
      const cf = 3.5 - Math.abs(f - 3.5);
      switch (t) {
        case 'P': return rr * 10 + cf;
        case 'N': return cf * 3 + rr * 2;
        case 'B': return cf * 2 + rr * 1.5;
        case 'Q': return cf * 2 + rr;
        case 'R': case 'A': return rr * 3 + cf;
        case 'D': case 'C': return (3 - rr) * 3 + cf;
        default: return cf;
      }
    };
    for (const c of [W, B]) {
      for (const t of ['Q', 'R', 'B', 'N', 'P', 'C', 'D', 'A']) {
        const list = [];
        for (let s = 0; s < 64; s++) {
          if (!E.inHalf(s, c)) continue;
          const rr = c === W ? s >> 3 : 7 - (s >> 3);
          list.push([s, score(t, s & 7, rr)]);
        }
        list.sort((a, b) => b[1] - a[1]);
        PREF[c][t] = list.map(x => x[0]);
      }
    }
  })();

  function quickSquare(b, c, t) {
    const pref = PREF[c][t] || PREF[c].Q;
    const o = opp(c);
    let first = -1;
    for (let i = 0; i < pref.length; i++) {
      const s = pref[i];
      if (b[s]) continue;
      if (first < 0) first = s;
      if (!E.attacked(b, s, o)) return s;
    }
    if (first >= 0) return first;
    for (let s = 0; s < 64; s++) if (!b[s]) return s;
    return -1;
  }

  /** Cheap placement used inside the search. Returns null if the king cannot be made safe. */
  function fastPlace(board, c, recruits) {
    const b = board.slice();
    const list = recruits.slice();
    const k = E.kingSq(b, c);
    if (k >= 0 && E.attacked(b, k, opp(c))) {
      const plan = E.blockPlan(b, c, list.length);
      if (!plan) return null;
      list.sort((x, y) => val(x) - val(y)); // block with the cheapest recruits
      for (const s of plan) b[s] = E.landPiece(list.shift(), s);
    }
    for (let i = 0; i < list.length; i++) {
      const s = quickSquare(b, c, list[i].t);
      if (s < 0) break; // board full: remaining recruits leave the game
      b[s] = E.landPiece(list[i], s);
    }
    return b;
  }

  function child(st, mv) {
    const c = st.turn;
    const res = E.playMove(st, mv, null);
    if (!res) return null;
    let board = res.board;
    if (res.recruits.length) {
      board = fastPlace(board, c, res.recruits);
      if (!board) return null;
    } else {
      const k = E.kingSq(board, c);
      if (k >= 0 && E.attacked(board, k, opp(c))) return null;
    }
    return { board, turn: opp(c), ply: st.ply + 1, rate: st.rate, nextId: res.nextId };
  }

  // ---- move lists & ordering --------------------------------------------------
  const SEARCH_OPT = { noFly: true, promos: ['Q', 'N'] };
  const Q_OPT = { capturesOnly: true, noFly: true, promos: ['Q'] };

  /** Moves for the search. Dragon flights are pruned to the useful ones (block a check, flee). */
  function aiMoves(st, inChk) {
    const c = st.turn, b = st.board, o = opp(c);
    const moves = E.genMoves(b, c, SEARCH_OPT);
    for (let s = 0; s < 64; s++) {
      const p = b[s];
      if (!p || p.o !== c || p.t !== 'D') continue;
      if (inChk) {
        const k = E.kingSq(b, c);
        for (const x of E.checkers(b, k, o)) for (const t of x.between) moves.push({ from: s, to: t, cap: false });
      } else if (E.attacked(b, s, o)) {
        let n = 0;
        for (const t of PREF[c].D) {
          if (!b[t] && !E.attacked(b, t, o)) { moves.push({ from: s, to: t, cap: false }); if (++n >= 3) break; }
        }
      }
    }
    return moves;
  }

  const sameMove = (a, b) => !!a && !!b && a.from === b.from && a.to === b.to && (a.promo || null) === (b.promo || null);
  const gain = (q, ctx) => (q.o === N ? val(q) + ctx.countW : 2 * (val(q) + ctx.countW));

  function orderMoves(st, moves, ttMove, killers, ctx) {
    const b = st.board;
    for (const m of moves) {
      let s = 0;
      if (ttMove && sameMove(m, ttMove)) s = 1e9;
      else {
        const q = b[m.to];
        if (q) s = 1e6 + gain(q, ctx) * 8 - val(b[m.from]) / 8;
        if (m.promo) s += 5e5 + VAL[m.promo];
        if (!q && killers && (sameMove(m, killers[0]) || sameMove(m, killers[1]))) s += 4e5;
      }
      m.o = s;
    }
    moves.sort((x, y) => y.o - x.o);
  }

  // ---- search -------------------------------------------------------------------
  function timeUp(ctx) {
    if ((++ctx.nodes & 255) === 0 && Date.now() > ctx.deadline) ctx.stop = true;
    return ctx.stop;
  }

  function qsearch(st, alpha, beta, ply, qd, ctx) {
    if (timeUp(ctx)) return 0;
    const stand = evaluate(st.board, st.turn, ctx);
    if (qd >= ctx.qmax) return stand;
    if (stand >= beta) return stand;
    if (stand > alpha) alpha = stand;
    const b = st.board;
    const moves = E.genMoves(b, st.turn, Q_OPT);
    if (!moves.length) return stand;
    for (const m of moves) {
      const q = b[m.to];
      m.o = q ? gain(q, ctx) * 16 - val(b[m.from]) / 8 : 800;
    }
    moves.sort((x, y) => y.o - x.o);
    let best = stand, dragonCaps = 0;
    for (const mv of moves) {
      if (b[mv.from].t === 'D' && ++dragonCaps > 2) continue;
      const q = b[mv.to];
      if (q && stand + gain(q, ctx) + 200 < alpha) continue; // delta pruning
      const ch = child(st, mv);
      if (!ch) continue;
      const sc = -qsearch(ch, -beta, -alpha, ply + 1, qd + 1, ctx);
      if (ctx.stop) return 0;
      if (sc > best) best = sc;
      if (sc >= beta) return sc;
      if (sc > alpha) alpha = sc;
    }
    return best;
  }

  function negamax(st, depth, alpha, beta, ply, ctx) {
    if (timeUp(ctx)) return 0;
    if (depth <= 0) return qsearch(st, alpha, beta, ply, 0, ctx);
    const key = hash(st);
    const tte = ctx.tt.get(key);
    let ttMove = null;
    if (tte) {
      ttMove = tte.m;
      if (tte.d >= depth) {
        if (tte.f === 0) return tte.s;
        if (tte.f === 1 && tte.s >= beta) return tte.s;
        if (tte.f === 2 && tte.s <= alpha) return tte.s;
      }
    }
    const c = st.turn;
    const inChk = E.inCheck(st.board, c);
    const moves = aiMoves(st, inChk);
    orderMoves(st, moves, ttMove, ctx.killers[ply], ctx);
    const a0 = alpha;
    let best = -Infinity, bestMove = null, legal = 0;
    for (let i = 0; i < moves.length; i++) {
      const mv = moves[i];
      const ch = child(st, mv);
      if (!ch) continue;
      legal++;
      const sc = -negamax(ch, depth - 1, -beta, -alpha, ply + 1, ctx);
      if (ctx.stop) return 0;
      if (sc > best) { best = sc; bestMove = mv; }
      if (sc > alpha) alpha = sc;
      if (alpha >= beta) {
        if (!mv.cap) {
          const k = ctx.killers[ply] || (ctx.killers[ply] = []);
          if (!sameMove(k[0], mv)) { k[1] = k[0]; k[0] = mv; }
        }
        break;
      }
    }
    if (!legal) {
      // Only pruned dragon flights were legal: rare, use the static score.
      if (E.legalMoves(st).length) return evaluate(st.board, c, ctx);
      return inChk ? -MATE + ply : 0;
    }
    if (ctx.tt.size > 400000) ctx.tt.clear();
    ctx.tt.set(key, { d: depth, s: best, f: best <= a0 ? 2 : best >= beta ? 1 : 0, m: bestMove });
    return best;
  }

  function makeCtx(L, frac, ms) {
    return {
      deadline: Date.now() + ms, nodes: 0, stop: false, tt: new Map(), killers: [],
      countW: countWeight(frac), qmax: L.q, kingSafety: L.depth >= 2,
    };
  }

  const isFly = (st, m) => !m.cap && st.board[m.from].t === 'D';

  /**
   * Pick a move for st.turn.
   * opt: {level: 0..5, frac: elapsed share of the 15-minute game, time?: ms override}
   */
  function think(st, opt) {
    opt = opt || {};
    const L = LEVELS[opt.level == null ? 2 : opt.level] || LEVELS[2];
    const rng = opt.rng || Math.random;
    const legal = E.legalMoves(st);
    if (!legal.length) return null;
    if (legal.length === 1) return legal[0];
    if (L.blunder && rng() < L.blunder) return legal[Math.floor(rng() * legal.length)];

    // Scale thinking time with how busy the board is.
    let pieces = 0;
    for (let s = 0; s < 64; s++) if (st.board[s]) pieces++;
    const ms = opt.time || Math.round(L.time * Math.min(1, Math.max(0.3, pieces / 14)));
    const ctx = makeCtx(L, opt.frac || 0, ms);

    const inChk = E.inCheck(st.board, st.turn);
    const useful = new Set(aiMoves(st, inChk).filter(m => isFly(st, m)).map(m => m.from * 64 + m.to));
    let roots = legal.filter(m => (!isFly(st, m) || useful.has(m.from * 64 + m.to)) && (!m.promo || m.promo === 'Q' || m.promo === 'N'));
    if (!roots.length) roots = legal;
    let items = roots.map(m => ({ m, ch: child(st, m), s: 0, f: -Infinity })).filter(x => x.ch);
    if (!items.length) return legal[0];
    orderMoves(st, items.map(x => x.m), null, null, ctx);
    items.sort((a, b) => b.m.o - a.m.o);

    const exact = L.noise > 0; // weak levels need real scores for every move to add noise
    let done = 0, stable = 0, prevBest = null;
    for (let d = 1; d <= L.depth; d++) {
      let alpha = -Infinity;
      for (const x of items) {
        const sc = exact
          ? -negamax(x.ch, d - 1, -Infinity, Infinity, 1, ctx)
          : -negamax(x.ch, d - 1, -Infinity, -alpha, 1, ctx);
        if (ctx.stop) break;
        x.s = sc;
        if (sc > alpha) alpha = sc;
      }
      if (ctx.stop) {
        // keep a partial result only if it already beat the previous best
        const lead = items[0];
        let bestPartial = null;
        for (const x of items) if (x.s !== x.f && x.s > lead.f && x !== lead && (!bestPartial || x.s > bestPartial.s)) bestPartial = x;
        if (bestPartial && done) { bestPartial.f = bestPartial.s + 1; items.sort((a, b) => b.f - a.f); }
        break;
      }
      for (const x of items) x.f = x.s;
      items.sort((a, b) => b.f - a.f);
      done = d;
      if (Math.abs(items[0].f) > MATE - 1000) break;
      stable = prevBest && sameMove(prevBest, items[0].m) ? stable + 1 : 0;
      prevBest = items[0].m;
      if (d >= 7 && stable >= 3 && Date.now() > ctx.deadline - ms * 0.6) break;
    }
    if (opt.stats) { opt.stats.depth = done; opt.stats.nodes = ctx.nodes; opt.stats.score = items[0].f; }
    if (!done) return items[0].m;
    if (L.noise) {
      let best = items[0], bs = -Infinity;
      for (const x of items) {
        const v = x.f + (rng() + rng() + rng() - 1.5) * L.noise;
        if (v > bs) { bs = v; best = x; }
      }
      return best.m;
    }
    return items[0].m;
  }

  /**
   * Choose where to place a recruit. `rest` = recruits still to place after this one.
   * Returns a square, or -1 if nothing fits.
   */
  function choosePlacement(board, c, piece, rest, opt) {
    opt = opt || {};
    rest = rest || [];
    const L = LEVELS[opt.level == null ? 2 : opt.level] || LEVELS[2];
    const valid = E.validPlacements(board, c, rest.length + 1);
    if (!valid.length) return -1;
    if (valid.length === 1) return valid[0];
    if (L.noise >= 200) return valid[Math.floor(Math.random() * valid.length)];
    const o = opp(c);
    const ctx = makeCtx(L, opt.frac || 0, 50);
    ctx.qmax = Math.min(Math.max(L.q, 2), 4);
    ctx.kingSafety = true;
    let best = valid[0], bs = -Infinity;
    // Runs on the UI thread: keep the whole decision well under a quarter second.
    const budgetEnd = Date.now() + 220;
    const per = Math.max(3, Math.floor(200 / valid.length));
    for (const s of valid) {
      const b = board.slice();
      b[s] = E.landPiece(piece, s);
      const b2 = rest.length ? fastPlace(b, c, rest) : b;
      if (!b2) continue;
      ctx.stop = false; ctx.nodes = 0; ctx.deadline = Math.min(budgetEnd, Date.now() + per);
      let sc = -qsearch({ board: b2, turn: o, ply: 0, rate: 0, nextId: 0 }, -Infinity, Infinity, 0, 0, ctx);
      if (ctx.stop) sc = evaluate(b2, c, ctx);
      // reward threats from the new square
      let threat = 0;
      for (const m of E.movesFrom(b2, s, { capturesOnly: true, noFly: true })) {
        const q = b2[m.to];
        const g = q.o === N ? val(q) * 0.2 + 20 : val(q) * 0.3 + 30;
        if (g > threat) threat = g;
      }
      const ok = E.kingSq(b2, o);
      if (ok >= 0 && b2[s].t !== 'D' && E.attacked(b2, ok, c)) threat += 50;
      sc += threat;
      if (L.noise) sc += (Math.random() - 0.5) * L.noise;
      if (sc > bs) { bs = sc; best = s; }
    }
    return best;
  }

  return { LEVELS, think, choosePlacement, evaluate, val, countWeight };
});
