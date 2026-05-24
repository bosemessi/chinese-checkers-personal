// gameLogic.js — Pure game engine for Chinese Checkers.
// No DOM access; safe to run anywhere (browser, Node, tests).

// =============================================================
// Board layout
// =============================================================
// 17 rows. Row widths form the classic star:
//   - rows 0-3: north point (1, 2, 3, 4 cells)
//   - rows 4-12: hexagon center with side points on the left & right
//   - rows 13-16: south point (4, 3, 2, 1 cells)
// Total cells: 1+2+3+4 + 13+12+11+10+9+10+11+12+13 + 4+3+2+1 = 121.
const ROW_WIDTHS = [1, 2, 3, 4, 13, 12, 11, 10, 9, 10, 11, 12, 13, 4, 3, 2, 1];
const NUM_ROWS = ROW_WIDTHS.length;

// Hex geometry: cell diameter = 1. Vertical spacing between rows is sqrt(3)/2.
const H = Math.sqrt(3) / 2;

// Horizontal offset of a row's col-0 cell, chosen so the whole board is
// centered on x = 6 and every cell sits on a valid hex-grid position.
function rowOffsetX(row) {
  const w = ROW_WIDTHS[row];
  if (row <= 3 || row >= 13) {
    // Triangle points (north/south): centered on x = 6.
    return 6 - (w - 1) / 2;
  }
  // Hexagon rows: max width is 13, so center each on the max-width axis.
  return (13 - w) / 2;
}

// Which region a cell belongs to:
//   N, S            — north / south triangular points
//   UW, UE, LW, LE  — upper/lower west/east triangular points
//   H               — central hexagon (no player starts here)
function classifyRegion(row, col) {
  if (row <= 3) return 'N';
  if (row >= 13) return 'S';
  const w = ROW_WIDTHS[row];
  if (row >= 4 && row <= 7) {
    const sideWidth = 4 - (row - 4); // 4, 3, 2, 1
    if (col < sideWidth) return 'UW';
    if (col >= w - sideWidth) return 'UE';
    return 'H';
  }
  if (row === 8) return 'H';
  // rows 9-12
  const sideWidth = row - 8; // 1, 2, 3, 4
  if (col < sideWidth) return 'LW';
  if (col >= w - sideWidth) return 'LE';
  return 'H';
}

// Build the cell table.
const CELLS = []; // { row, col, x, y, key, region }
const CELL_BY_KEY = new Map();
const CELLS_BY_REGION = { N: [], S: [], UW: [], UE: [], LW: [], LE: [], H: [] };

for (let row = 0; row < NUM_ROWS; row++) {
  const offsetX = rowOffsetX(row);
  for (let col = 0; col < ROW_WIDTHS[row]; col++) {
    const cell = {
      row,
      col,
      x: offsetX + col,
      y: row * H,
      key: `${row},${col}`,
      region: classifyRegion(row, col),
    };
    CELLS.push(cell);
    CELL_BY_KEY.set(cell.key, cell);
    CELLS_BY_REGION[cell.region].push(cell.key);
  }
}

// =============================================================
// Neighbors (precomputed from pixel distance)
// =============================================================
// Two cells are neighbors iff their centers are exactly one cell-diameter
// apart. We compute this once at load time.
const NEIGHBORS = new Map();
for (const cell of CELLS) {
  const ns = [];
  for (const other of CELLS) {
    if (other === cell) continue;
    const dx = other.x - cell.x;
    const dy = other.y - cell.y;
    if (Math.abs(Math.hypot(dx, dy) - 1) < 0.01) ns.push(other.key);
  }
  NEIGHBORS.set(cell.key, ns);
}

// Look up a cell by exact pixel position (used for hop "landing" checks).
function cellAt(x, y) {
  for (const cell of CELLS) {
    if (Math.hypot(cell.x - x, cell.y - y) < 0.01) return cell.key;
  }
  return null;
}

// =============================================================
// Players & starting positions
// =============================================================
// Opposite-point pairs determine each player's home and target.
const OPPOSITE_POINT = {
  N: 'S', S: 'N',
  UE: 'LW', LW: 'UE',
  LE: 'UW', UW: 'LE',
};

function startingPoints(numPlayers) {
  switch (numPlayers) {
    case 2: return ['N', 'S'];
    case 3: return ['N', 'LE', 'LW'];
    case 4: return ['N', 'S', 'UE', 'LW'];
    case 6: return ['N', 'UE', 'LE', 'S', 'LW', 'UW'];
    default: throw new Error(`Unsupported player count: ${numPlayers}`);
  }
}

function createGame(numPlayers) {
  const homes = startingPoints(numPlayers);
  const pegs = new Map(); // cellKey -> playerIndex
  homes.forEach((region, playerIdx) => {
    for (const key of CELLS_BY_REGION[region]) pegs.set(key, playerIdx);
  });
  return {
    numPlayers,
    homePoints: homes,
    targetPoints: homes.map(r => OPPOSITE_POINT[r]),
    pegs,
    currentPlayer: 0,
    moveHistory: [],
    winner: null,
  };
}

// =============================================================
// Move generation
// =============================================================
// Legal moves from `fromKey`:
//   1. A single step into any adjacent empty cell.
//   2. A chain of hops. Each hop goes over exactly one adjacent peg
//      (any color) in a straight line, landing on the empty cell
//      immediately beyond it. After landing, the peg may stop or
//      continue hopping.
function getLegalMoves(state, fromKey) {
  if (!state.pegs.has(fromKey)) return [];
  if (state.pegs.get(fromKey) !== state.currentPlayer) return [];
  if (state.winner !== null) return [];

  // While computing the move, treat the moving peg's origin as empty.
  const isEmpty = k => !state.pegs.has(k) || k === fromKey;
  const isPeg = k => state.pegs.has(k) && k !== fromKey;

  const destinations = new Set();

  // Single steps.
  for (const nKey of NEIGHBORS.get(fromKey)) {
    if (isEmpty(nKey)) destinations.add(nKey);
  }

  // Chain hops via BFS.
  const visited = new Set([fromKey]);
  const queue = [fromKey];
  while (queue.length > 0) {
    const currKey = queue.shift();
    const curr = CELL_BY_KEY.get(currKey);
    for (const nKey of NEIGHBORS.get(currKey)) {
      if (!isPeg(nKey)) continue; // must hop OVER a peg
      const n = CELL_BY_KEY.get(nKey);
      // The landing cell is the same distance past `n` in the same direction.
      const beyondKey = cellAt(2 * n.x - curr.x, 2 * n.y - curr.y);
      if (!beyondKey) continue;            // off the board
      if (!isEmpty(beyondKey)) continue;   // landing must be empty
      if (visited.has(beyondKey)) continue;
      visited.add(beyondKey);
      destinations.add(beyondKey);
      queue.push(beyondKey);
    }
  }

  destinations.delete(fromKey);
  return Array.from(destinations);
}

// =============================================================
// Apply move
// =============================================================
function applyMove(state, fromKey, toKey) {
  const legal = getLegalMoves(state, fromKey);
  if (!legal.includes(toKey)) return { ok: false, error: 'Illegal move' };

  const player = state.pegs.get(fromKey);
  state.pegs.delete(fromKey);
  state.pegs.set(toKey, player);
  state.moveHistory.push({ player, fromKey, toKey });

  if (checkPlayerWon(state, player)) {
    state.winner = player;
  } else {
    state.currentPlayer = (state.currentPlayer + 1) % state.numPlayers;
  }
  return { ok: true };
}

// =============================================================
// Manual-hop helpers
// =============================================================
// One-hop landings reachable in a single jump from `currentKey`, treating
// `fromKey` (the move's origin) as empty so a chain can pass back through it.
// Used during a player's active move to figure out what cells are legal
// to tap next.
function getHopLandings(state, fromKey, currentKey) {
  const isPeg = k => state.pegs.has(k) && k !== fromKey;
  const isEmpty = k => !state.pegs.has(k) || k === fromKey;
  const curr = CELL_BY_KEY.get(currentKey);
  const landings = [];
  for (const nKey of NEIGHBORS.get(currentKey)) {
    if (!isPeg(nKey)) continue;
    const n = CELL_BY_KEY.get(nKey);
    const beyondKey = cellAt(2 * n.x - curr.x, 2 * n.y - curr.y);
    if (!beyondKey || !isEmpty(beyondKey)) continue;
    if (beyondKey === currentKey) continue;
    landings.push(beyondKey);
  }
  return landings;
}

// Validate that `path` (>= 2 keys, starting at the moving peg) is a legal
// move: either a single slide into an adjacent empty cell, or a chain of
// one-hop jumps over a peg into the empty cell beyond. Returns { ok }.
function validatePath(state, path) {
  if (!Array.isArray(path) || path.length < 2) return { ok: false, error: 'Path too short' };
  const fromKey = path[0];
  if (!state.pegs.has(fromKey)) return { ok: false, error: 'No peg at origin' };
  if (state.pegs.get(fromKey) !== state.currentPlayer) {
    return { ok: false, error: 'Not your peg' };
  }
  if (state.winner !== null) return { ok: false, error: 'Game over' };

  const isPeg = k => state.pegs.has(k) && k !== fromKey;
  const isEmpty = k => !state.pegs.has(k) || k === fromKey;

  // A length-2 path can be either a single slide (into an adjacent empty
  // cell) or a single hop (over an adjacent peg into the cell beyond).
  // Try the slide interpretation first; otherwise fall through to hop
  // validation, which handles chains of any length.
  if (path.length === 2) {
    const toKey = path[1];
    if (NEIGHBORS.get(fromKey).includes(toKey)) {
      if (!isEmpty(toKey)) return { ok: false, error: 'Destination not empty' };
      return { ok: true };
    }
  }

  // Hop chain. Every step must be a one-hop jump.
  const seen = new Set([fromKey]);
  for (let i = 0; i < path.length - 1; i++) {
    const aKey = path[i];
    const bKey = path[i + 1];
    if (seen.has(bKey)) return { ok: false, error: 'Path revisits a cell' };
    const a = CELL_BY_KEY.get(aKey);
    if (!a) return { ok: false, error: 'Unknown cell in path' };
    const b = CELL_BY_KEY.get(bKey);
    if (!b) return { ok: false, error: 'Unknown cell in path' };
    // The jumped-over cell is the midpoint of a → b.
    const midKey = cellAt((a.x + b.x) / 2, (a.y + b.y) / 2);
    if (!midKey) return { ok: false, error: 'Not a one-hop jump' };
    if (!isPeg(midKey)) return { ok: false, error: 'Must hop over a peg' };
    if (!isEmpty(bKey)) return { ok: false, error: 'Landing not empty' };
    seen.add(bKey);
  }
  return { ok: true };
}

// Apply a move described by its full path. Validates first.
function applyMoveByPath(state, path) {
  const v = validatePath(state, path);
  if (!v.ok) return v;
  const fromKey = path[0];
  const toKey = path[path.length - 1];
  const player = state.pegs.get(fromKey);
  state.pegs.delete(fromKey);
  state.pegs.set(toKey, player);
  state.moveHistory.push({ player, fromKey, toKey, path: path.slice() });

  if (checkPlayerWon(state, player)) {
    state.winner = player;
  } else {
    state.currentPlayer = (state.currentPlayer + 1) % state.numPlayers;
  }
  return { ok: true };
}

// A player wins when every cell of their target region is occupied by
// one of their own pegs.
function checkPlayerWon(state, playerIdx) {
  const target = state.targetPoints[playerIdx];
  for (const key of CELLS_BY_REGION[target]) {
    if (state.pegs.get(key) !== playerIdx) return false;
  }
  return true;
}

// =============================================================
// Move path (for animating hop chains step-by-step)
// =============================================================
// Returns the path [fromKey, ..., toKey] the peg takes, or null if the
// move isn't legal. A single step has length 2; a chain hop has length
// 2 + number_of_hops.
function getMovePath(state, fromKey, toKey) {
  if (!state.pegs.has(fromKey)) return null;

  const isEmpty = k => !state.pegs.has(k) || k === fromKey;
  const isPeg = k => state.pegs.has(k) && k !== fromKey;

  // Direct step.
  if (NEIGHBORS.get(fromKey).includes(toKey) && isEmpty(toKey)) {
    return [fromKey, toKey];
  }

  // Hop chain via BFS with parent pointers.
  const parents = new Map([[fromKey, null]]);
  const queue = [fromKey];
  while (queue.length > 0) {
    const currKey = queue.shift();
    const curr = CELL_BY_KEY.get(currKey);
    for (const nKey of NEIGHBORS.get(currKey)) {
      if (!isPeg(nKey)) continue;
      const n = CELL_BY_KEY.get(nKey);
      const beyondKey = cellAt(2 * n.x - curr.x, 2 * n.y - curr.y);
      if (!beyondKey || !isEmpty(beyondKey) || parents.has(beyondKey)) continue;
      parents.set(beyondKey, currKey);
      if (beyondKey === toKey) {
        const path = [];
        for (let k = toKey; k !== null; k = parents.get(k)) path.unshift(k);
        return path;
      }
      queue.push(beyondKey);
    }
  }
  return null;
}

// =============================================================
// Undo
// =============================================================
function undoLastMove(state) {
  if (state.moveHistory.length === 0) return false;
  const last = state.moveHistory.pop();
  state.pegs.delete(last.toKey);
  state.pegs.set(last.fromKey, last.player);
  state.winner = null;
  state.currentPlayer = last.player;
  return true;
}
