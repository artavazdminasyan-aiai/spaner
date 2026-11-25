/* Rules + AI tests. Run: npm test */
'use strict';
const assert = require('assert');
const E = require('../public/engine.js');
const AI = require('../public/ai.js');

const sq = n => 'abcdefgh'.indexOf(n[0]) + (Number(n[1]) - 1) * 8;
let nextId = 10;
function position(pieces, turn) {
  const board = new Array(64).fill(null);
  for (const [name, t, o, extra] of pieces) board[sq(name)] = Object.assign(E.makePiece(t, o, nextId++), extra || {});
  return { board, turn: turn || 'w', ply: 0, rate: 0, nextId: 1000 };
}
const has = (moves, from, to) => moves.some(m => m.from === sq(from) && m.to === sq(to));
let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + (e.stack || e)); process.exitCode = 1; }
}

console.log('Rules');

test('start: kings on e1/e8, white has 5 king moves', () => {
  const st = E.initialState();
  assert.strictEqual(st.board[sq('e1')].t, 'K');
  assert.strictEqual(st.board[sq('e8')].o, 'b');
  assert.strictEqual(E.legalMoves(st).length, 5);
});

test('recruiting a neutral: mover takes the square, recruit is returned for placement', () => {
  const st = position([['e1', 'K', 'w'], ['e8', 'K', 'b'], ['a1', 'R', 'w'], ['a6', 'N', 'n']]);
  const res = E.playMove(st, { from: sq('a1'), to: sq('a6') }, null);
  assert.strictEqual(res.board[sq('a6')].t, 'R');
  assert.strictEqual(res.recruits.length, 1);
  assert.strictEqual(res.recruits[0].t, 'N');
  assert.strictEqual(res.recruits[0].o, 'w');
  const region = E.validPlacements(res.board, 'w', 1);
  assert.ok(region.every(s => s < 32), 'placement must be in white half');
});

test('kings cannot be recruited; neutral pieces never give check', () => {
  const st = position([['e1', 'K', 'w'], ['e8', 'K', 'b'], ['e5', 'Q', 'n'], ['e4', 'R', 'w']]);
  assert.ok(!E.inCheck(st.board, 'w'));
  const moves = E.legalMoves(st);
  assert.ok(!has(moves, 'e4', 'e8'), 'rook blocked by neutral queen anyway');
  const st2 = position([['e1', 'K', 'w'], ['e8', 'K', 'b'], ['e4', 'R', 'w']]);
  assert.ok(!has(E.legalMoves(st2), 'e4', 'e8'), 'cannot capture king');
});

test('dragon never gives check and its attacks do not restrict the king', () => {
  const st = position([['e1', 'K', 'w'], ['e8', 'K', 'b'], ['e7', 'D', 'b']]);
  assert.ok(!E.inCheck(st.board, 'w'));
  assert.strictEqual(E.legalMoves(st).length, 5);
});

test('dragon recruits anywhere, 5 times in its lifetime, then can only fly', () => {
  const st = position([['e1', 'K', 'w'], ['e8', 'K', 'b'], ['a1', 'D', 'w', { d: 4 }], ['h8', 'Q', 'b']]);
  assert.ok(has(E.legalMoves(st), 'a1', 'h8'));
  const res = E.playMove(st, { from: sq('a1'), to: sq('h8') }, null);
  assert.strictEqual(res.board[sq('h8')].d, 5);
  const st2 = position([['e1', 'K', 'w'], ['e8', 'K', 'b'], ['a1', 'D', 'w', { d: 5 }], ['h8', 'Q', 'b']]);
  const m2 = E.legalMoves(st2);
  assert.ok(!has(m2, 'a1', 'h8'));
  assert.ok(has(m2, 'a1', 'c5'), 'can still fly to empty squares');
});

test('king may not step onto an attacked square', () => {
  const st = position([['e1', 'K', 'w'], ['e8', 'K', 'b'], ['d8', 'R', 'b']]);
  assert.ok(!has(E.legalMoves(st), 'e1', 'd1'));
  assert.ok(!has(E.legalMoves(st), 'e1', 'd2'));
});

test('pawns: one step forward, recruit diagonally, promote at far edge, no double step', () => {
  const st = position([['e1', 'K', 'w'], ['e8', 'K', 'b'], ['b2', 'P', 'w'], ['c3', 'N', 'n'], ['g7', 'P', 'w']]);
  const m = E.legalMoves(st);
  assert.ok(has(m, 'b2', 'b3'));
  assert.ok(!has(m, 'b2', 'b4'));
  assert.ok(has(m, 'b2', 'c3'));
  const promos = m.filter(x => x.from === sq('g7') && x.to === sq('g8')).map(x => x.promo).sort();
  assert.deepStrictEqual(promos, ['B', 'N', 'Q', 'R']);
  const bst = position([['e1', 'K', 'w'], ['e8', 'K', 'b'], ['d5', 'P', 'b']], 'b');
  assert.ok(has(E.legalMoves(bst), 'd5', 'd4'), 'black pawns move down');
});

test('commander: order after five completed turns, front pieces first, recruits on the way', () => {
  let st = position([['e1', 'K', 'w'], ['h8', 'K', 'b'], ['d4', 'C', 'w', { c: 4 }],
    ['a2', 'R', 'w'], ['a3', 'A', 'w'], ['c3', 'R', 'w'], ['c4', 'B', 'n'], ['h3', 'R', 'w'], ['h4', 'Q', 'w']]);
  const res = E.playMove(st, { from: sq('e1'), to: sq('f1') }, null);
  const b = res.board;
  assert.strictEqual(b[sq('a4')].t, 'A', 'banana a3→a4');
  assert.strictEqual(b[sq('a3')].t, 'R', 'rook a2 follows into vacated a3');
  assert.strictEqual(b[sq('c4')].t, 'R', 'rook c3 recruits neutral bishop on c4');
  assert.strictEqual(b[sq('h3')].t, 'R', 'rook h3 blocked by own queen');
  assert.strictEqual(res.recruits.length, 1);
  assert.strictEqual(res.recruits[0].t, 'B');
  assert.strictEqual(b[sq('d4')].c, 0, 'count resets');
});

test('commander count starts the turn after it is recruited, and resets on side change', () => {
  const st = position([['e1', 'K', 'w'], ['h8', 'K', 'b'], ['a1', 'R', 'w'], ['a7', 'C', 'b', { c: 3 }]]);
  const res = E.playMove(st, { from: sq('a1'), to: sq('a7') }, null);
  assert.strictEqual(res.recruits[0].t, 'C');
  assert.strictEqual(res.recruits[0].c, 0);
});

test('banana: a 6 gives three bananas; copies do not roll again', () => {
  const st = position([['e1', 'K', 'w'], ['e8', 'K', 'b'], ['a1', 'R', 'w'], ['a5', 'A', 'n']]);
  let rolls = 0;
  const res = E.playMove(st, { from: sq('a1'), to: sq('a5') }, () => { rolls++; return 6; });
  assert.strictEqual(rolls, 1);
  assert.strictEqual(res.recruits.filter(p => p.t === 'A').length, 3);
});

test('recruit placement can block a check (legal), and placement squares are restricted', () => {
  // Black rook checks along the e-file; white recruits a neutral far away and must block on e2..e4.
  const st = position([['e1', 'K', 'w'], ['h8', 'K', 'b'], ['e7', 'R', 'b'], ['a1', 'R', 'w'], ['a6', 'N', 'n']]);
  assert.ok(E.inCheck(st.board, 'w'));
  const m = E.legalMoves(st);
  assert.ok(has(m, 'a1', 'a6'), 'capture is legal because the recruit can block');
  assert.ok(!has(m, 'a1', 'a5'), 'quiet rook move does not stop the check');
  const res = E.playMove(st, { from: sq('a1'), to: sq('a6') }, null);
  const v = E.validPlacements(res.board, 'w', 1).sort((a, b) => a - b);
  assert.deepStrictEqual(v, [sq('e2'), sq('e3'), sq('e4')]);
});

test('knight checks cannot be blocked by placement', () => {
  const st = position([['e1', 'K', 'w'], ['h8', 'K', 'b'], ['d3', 'N', 'b'], ['a1', 'R', 'w'], ['a6', 'N', 'n']]);
  const m = E.legalMoves(st);
  assert.ok(!has(m, 'a1', 'a6'));
});

test('half full: recruit goes anywhere empty; board full: recruit leaves', () => {
  const pieces = [['e1', 'K', 'w'], ['e8', 'K', 'b']];
  for (let s = 0; s < 32; s++) if (s !== sq('e1')) pieces.push([E.sqName(s), 'P', 'n']);
  const st = position(pieces);
  const r = E.placeRegion(st.board, 'w');
  assert.ok(r.length > 0 && r.every(s => s >= 32));
});

test('checkmate and stalemate detection', () => {
  const mate = position([['a1', 'K', 'w'], ['h8', 'K', 'b'], ['b8', 'R', 'b'], ['h1', 'R', 'b'], ['a8', 'Q', 'b']]);
  assert.ok(E.inCheck(mate.board, 'w'));
  assert.strictEqual(E.legalMoves(mate).length, 0);
  const stale = position([['a1', 'K', 'w'], ['h8', 'K', 'b'], ['b8', 'R', 'b'], ['h2', 'R', 'b']]);
  assert.ok(!E.inCheck(stale.board, 'w'));
  assert.strictEqual(E.legalMoves(stale).length, 0);
});

console.log('Match (clocks & spawns)');

test('first piece at 10s, then every 10s; turn timeout loses', () => {
  const m = new E.Match({ rng: () => 0.3 });
  m.start(0, 0);
  m.tick(9999);
  assert.strictEqual(E.countPieces(m.state.board).n, 0);
  m.tick(10000);
  assert.strictEqual(E.countPieces(m.state.board).n, 1);
  m.tick(20000);
  assert.strictEqual(E.countPieces(m.state.board).n, 2);
  m.tick(30000);
  assert.strictEqual(m.phase, 'over');
  assert.strictEqual(m.result.reason, 'timeout');
  assert.strictEqual(m.result.winner, 'b');
});

test('rate slows to 30s once a player owns 5 pieces, after the current wait', () => {
  const m = new E.Match();
  m.start(0, 0);
  m.state = position([['e1', 'K', 'w'], ['e8', 'K', 'b'], ['a1', 'P', 'w'], ['b1', 'P', 'w'], ['c1', 'P', 'w'], ['d1', 'P', 'w']]);
  m._legal = null;
  const r = m.move('w', { from: sq('e1'), to: sq('f1') }, 1000);
  assert.ok(r.ok, r.error);
  assert.strictEqual(m.state.rate, 1);
  m.tick(10000); // spawn scheduled at 10s still happens
  assert.strictEqual(m.nextSpawnAt, 40000);
});

test('game end at 15 minutes scores pieces', () => {
  const m = new E.Match();
  m.start(0, 0);
  // keep both sides moving so nobody times out
  let t = 0, side = 'w';
  while (m.phase === 'play' && t < E.GAME_MS + 1000) {
    t += 20000;
    m.tick(t);
    if (m.phase !== 'play') break;
    if (m.sub) { const v = E.validPlacements(m.sub.board, m.sub.color, m.sub.recruits.length); m.place(m.sub.color, v[0], t); continue; }
    const legal = m.legal();
    const mv = legal.find(x => x.cap) || legal[0];
    m.move(m.state.turn, mv, t);
    while (m.sub && m.phase === 'play') { const v = E.validPlacements(m.sub.board, m.sub.color, m.sub.recruits.length); m.place(m.sub.color, v[0], t); }
    side = E.opp(side);
  }
  assert.strictEqual(m.phase, 'over');
  assert.ok(['time', 'checkmate', 'stalemate'].includes(m.result.reason), m.result.reason);
});

console.log('AI');

test('AI takes a free queen and finds mate in one', () => {
  const st = position([['e1', 'K', 'w'], ['e8', 'K', 'b'], ['a1', 'R', 'w'], ['a7', 'Q', 'b']]);
  const mv = AI.think(st, { level: 3, time: 500 });
  assert.strictEqual(mv.from, sq('a1')); assert.strictEqual(mv.to, sq('a7'));
  const mate = position([['g6', 'K', 'w'], ['g8', 'K', 'b'], ['a1', 'R', 'w']]);
  const mm = AI.think(mate, { level: 4, time: 800 });
  assert.strictEqual(mm.to, sq('a8'), 'Ra8#');
});

test('every level returns a legal move within its time budget', () => {
  const st = position([['e1', 'K', 'w'], ['e8', 'K', 'b'], ['c3', 'N', 'w'], ['d2', 'P', 'w'], ['f6', 'Q', 'b'],
    ['b5', 'D', 'n'], ['g4', 'A', 'n'], ['c6', 'C', 'b'], ['h1', 'R', 'w'], ['a8', 'R', 'b']]);
  const legal = E.legalMoves(st);
  AI.LEVELS.forEach((L, i) => {
    // CPU time, so a sandbox pausing the process does not count against the AI
    const c0 = process.cpuUsage();
    const mv = AI.think(st, { level: i, frac: 0.3 });
    const c1 = process.cpuUsage(c0);
    const dt = Math.round((c1.user + c1.system) / 1000);
    assert.ok(legal.some(m => m.from === mv.from && m.to === mv.to), L.name + ' illegal');
    assert.ok(dt < L.time + 1500, `${L.name} took ${dt}ms`);
    console.log(`    ${L.name.padEnd(8)} ${String(dt).padStart(5)}ms  ${E.sqName(mv.from)}-${E.sqName(mv.to)}`);
  });
});

test('AI vs AI full games run without errors', () => {
  for (let g = 0; g < 3; g++) {
    const m = new E.Match();
    m.start(0, 0);
    let t = 0;
    while (m.phase === 'play' && m.state.ply < 160) {
      t += 4000;
      m.tick(t);
      if (m.phase !== 'play') break;
      const side = m.state.turn;
      const mv = AI.think(m.state, { level: g, frac: t / E.GAME_MS, time: 60 });
      const r = m.move(side, mv, t);
      assert.ok(r.ok, r.error);
      while (m.sub && m.phase === 'play') {
        const s = AI.choosePlacement(m.sub.board, side, m.sub.recruits[0], m.sub.recruits.slice(1), { level: g });
        const pr = m.place(side, s, t);
        assert.ok(pr.ok, pr.error);
      }
    }
    const n = E.countPieces(m.state.board);
    console.log(`    game ${g + 1}: ${m.phase === 'over' ? m.result.reason : 'ply limit'} after ${m.state.ply} turns, army ${n.w}–${n.b}`);
  }
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
