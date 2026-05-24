// ui.js — Polished hot-seat UI.
// Two SVG layers: fixed "holes" (background, clickable) and "pegs"
// (foreground, animated via CSS transitions on cx/cy). Each peg has a
// stable DOM element that we move around the board, so hop chains can
// be animated step-by-step.

const SVG_NS = 'http://www.w3.org/2000/svg';
const CELL_RADIUS = 0.42;
const PEG_RADIUS = 0.38;

// Local per-tap pacing while the current player is building a chain.
const HOP_DURATION_MS = 220;
const HOP_GAP_MS = 60;

// Slower pacing used to replay a remote player's committed move, so the
// receiver sees each landing distinctly — the "physical placement" feel.
const PLAYBACK_HOP_MS = 280;
const PLAYBACK_LANDING_PAUSE_MS = 220;

const PLAYER_COLORS = [
  '#e74c3c', // 1: red
  '#3498db', // 2: blue
  '#2ecc71', // 3: green
  '#f1c40f', // 4: yellow
  '#9b59b6', // 5: purple
  '#1abc9c', // 6: teal
];

let gameState = null;
// An in-progress move by the local player. null when no peg is being moved.
// hopPath always starts with fromKey; currentKey is its last element.
let activeMove = null; // { fromKey, hopPath: [k0, k1, ...], currentKey }
// Maps the cell key a peg currently occupies → that peg's SVG element.
let pegElements = new Map();
// Cells of the most recent move, for "last move" highlighting.
let lastMove = null; // { fromKey, toKey }
// Locks input during a hop animation.
let isAnimating = false;
// True when we've requested an undo and are waiting for a decision.
let undoPending = false;

// =============================================================
// Sound (synthesised via Web Audio — zero files, zero deps)
// =============================================================
let audioCtx = null;
let soundEnabled = true;

function ensureAudio() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) audioCtx = new AC();
  }
}

function playTone(freq, duration, type = 'triangle', volume = 0.12) {
  if (!soundEnabled || !audioCtx) return;
  const t = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(volume, t);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start(t);
  osc.stop(t + duration);
}

function soundStep() { playTone(420, 0.08, 'triangle', 0.10); }
function soundHop()  { playTone(560, 0.07, 'triangle', 0.13); }
function soundWin() {
  if (!audioCtx) return;
  [262, 330, 392, 523].forEach((f, i) => {
    setTimeout(() => playTone(f, 0.30, 'triangle', 0.18), i * 90);
  });
}

function toggleSound() {
  soundEnabled = !soundEnabled;
  const btn = document.getElementById('btn-sound');
  if (btn) btn.textContent = soundEnabled ? 'Sound: On' : 'Sound: Off';
}

// =============================================================
// Setup
// =============================================================
function startNewGame(numPlayers) {
  activeMove = null;
  pegElements = new Map();
  lastMove = null;
  isAnimating = false;
  undoPending = false;
  gameState = createGame(numPlayers);
  renderBoard();
  renderHistory();
  clearChat();
  updateStatus();
  updateChatVisibility();
}

function renderBoard() {
  const svg = document.getElementById('board-svg');
  svg.innerHTML = '';

  const pad = 0.6;
  svg.setAttribute('viewBox', `${-pad} ${-pad} ${12 + 2 * pad} ${16 * H + 2 * pad}`);

  // Holes layer (background, clickable).
  const holesLayer = document.createElementNS(SVG_NS, 'g');
  holesLayer.setAttribute('id', 'holes-layer');
  svg.appendChild(holesLayer);

  for (const cell of CELLS) {
    const hole = document.createElementNS(SVG_NS, 'circle');
    hole.setAttribute('cx', cell.x);
    hole.setAttribute('cy', cell.y);
    hole.setAttribute('r', CELL_RADIUS);
    hole.setAttribute('class', 'hole');
    hole.dataset.key = cell.key;
    hole.addEventListener('click', () => onCellClick(cell.key));
    holesLayer.appendChild(hole);
  }

  // Pegs layer (foreground, animated, click-through to holes below).
  const pegsLayer = document.createElementNS(SVG_NS, 'g');
  pegsLayer.setAttribute('id', 'pegs-layer');
  svg.appendChild(pegsLayer);

  for (const [cellKey, playerIdx] of gameState.pegs) {
    const cell = CELL_BY_KEY.get(cellKey);
    const peg = document.createElementNS(SVG_NS, 'circle');
    peg.setAttribute('cx', cell.x);
    peg.setAttribute('cy', cell.y);
    peg.setAttribute('r', PEG_RADIUS);
    peg.setAttribute('fill', PLAYER_COLORS[playerIdx]);
    peg.setAttribute('class', 'peg');
    pegsLayer.appendChild(peg);
    pegElements.set(cellKey, peg);
  }

  refreshHoleClasses();
}

// Updates the "selected" and "last-move" classes on holes. Legal destinations
// are intentionally NOT highlighted — players must figure out their own paths.
function refreshHoleClasses() {
  const svg = document.getElementById('board-svg');
  svg.querySelectorAll('.hole').forEach(h => {
    h.classList.remove('selected', 'last-from', 'last-to');
  });
  if (activeMove) {
    svg.querySelector(`.hole[data-key="${activeMove.currentKey}"]`)?.classList.add('selected');
  }
  if (lastMove) {
    svg.querySelector(`.hole[data-key="${lastMove.fromKey}"]`)?.classList.add('last-from');
    svg.querySelector(`.hole[data-key="${lastMove.toKey}"]`)?.classList.add('last-to');
  }
}

// =============================================================
// Click handling — manual hop model
// =============================================================
// The local player builds their move by tapping cell-by-cell:
//   1. Tap one of your own pegs → start a move (peg is "in hand").
//   2. Tap an adjacent empty cell → auto-commits a single slide.
//   3. Tap a one-hop landing (over a peg, into the empty cell beyond) →
//      peg moves to that landing; chain may continue.
//   4. After ≥1 hop, "End Move" commits and "Undo Hop" backtracks one
//      landing. Once a chain has started, taps on cells that aren't a
//      legal next hop are ignored — use the buttons.
//   5. Before any hops, tapping the origin again or a different own peg
//      cancels / re-selects.
function onCellClick(key) {
  ensureAudio(); // first user gesture unlocks Web Audio
  if (isAnimating) return;
  if (gameState.winner !== null) return;

  // Network mode: you can only act on your own turn.
  if (gameMode !== 'local' && gameState.currentPlayer !== myPlayerIdx) return;

  // --- No active move yet ---
  if (!activeMove) {
    if (gameState.pegs.get(key) === gameState.currentPlayer) {
      startActiveMove(key);
    }
    return;
  }

  // --- Active move in progress ---
  const { fromKey, hopPath, currentKey } = activeMove;
  const hopsSoFar = hopPath.length - 1;

  // Cancel / re-select before any hops have happened.
  if (hopsSoFar === 0) {
    if (key === fromKey) {
      cancelActiveMove();
      return;
    }
    if (gameState.pegs.get(key) === gameState.currentPlayer) {
      cancelActiveMove();
      startActiveMove(key);
      return;
    }
    // Tap an adjacent empty cell → auto-commit a single slide.
    const adjacent = NEIGHBORS.get(fromKey).includes(key);
    const empty = !gameState.pegs.has(key) || key === fromKey;
    if (adjacent && empty) {
      extendChainTo(key, /*sound*/ soundStep).then(commitActiveMove);
      return;
    }
  }

  // Extend the chain by a single hop, if `key` is one hop from currentKey
  // and isn't already on the chain (revisits aren't valid moves).
  const landings = getHopLandings(gameState, fromKey, currentKey)
    .filter(k => !hopPath.includes(k));
  if (landings.includes(key)) {
    extendChainTo(key, /*sound*/ soundHop);
    return;
  }
  // Otherwise ignore — player should use End Move or Undo Hop.
}

function startActiveMove(pegKey) {
  activeMove = { fromKey: pegKey, hopPath: [pegKey], currentKey: pegKey };
  refreshHoleClasses();
  updateMoveButtons();
}

function cancelActiveMove() {
  activeMove = null;
  refreshHoleClasses();
  updateMoveButtons();
}

// Animate the peg from its current cell to `nextKey` (one step) and append
// to the chain. Returns a promise that resolves after the animation window.
async function extendChainTo(nextKey, soundFn) {
  const peg = pegElements.get(activeMove.currentKey);
  if (!peg) return;
  isAnimating = true;
  const cell = CELL_BY_KEY.get(nextKey);
  peg.setAttribute('cx', cell.x);
  peg.setAttribute('cy', cell.y);
  pegElements.delete(activeMove.currentKey);
  pegElements.set(nextKey, peg);
  activeMove.hopPath.push(nextKey);
  activeMove.currentKey = nextKey;
  if (soundFn) soundFn();
  refreshHoleClasses();
  await sleep(HOP_DURATION_MS);
  isAnimating = false;
  updateMoveButtons();
}

// Step back one landing in the in-progress chain.
async function undoHop() {
  if (isAnimating || !activeMove) return;
  if (activeMove.hopPath.length < 2) return;
  const peg = pegElements.get(activeMove.currentKey);
  if (!peg) return;
  isAnimating = true;
  const popped = activeMove.hopPath.pop();
  activeMove.currentKey = activeMove.hopPath[activeMove.hopPath.length - 1];
  const cell = CELL_BY_KEY.get(activeMove.currentKey);
  peg.setAttribute('cx', cell.x);
  peg.setAttribute('cy', cell.y);
  pegElements.delete(popped);
  pegElements.set(activeMove.currentKey, peg);
  soundStep();
  refreshHoleClasses();
  await sleep(HOP_DURATION_MS);
  isAnimating = false;
  updateMoveButtons();
}

// Commit the current chain as a turn. Validates, applies, and (in network
// mode) sends or broadcasts the path. The peg is already where it needs
// to be visually, so no playback animation is needed locally.
function commitActiveMove() {
  if (isAnimating || !activeMove) return;
  if (activeMove.hopPath.length < 2) return;
  const path = activeMove.hopPath.slice();

  if (gameMode === 'guest') {
    // Optimistic local apply, then send to host. Host re-broadcasts to other
    // guests but must skip us (we've already applied).
    const result = applyMoveByPath(gameState, path);
    if (!result.ok) {
      cancelActiveMove();
      return;
    }
    sendNetworkMove(path);
  } else {
    const result = applyMoveByPath(gameState, path);
    if (!result.ok) {
      cancelActiveMove();
      return;
    }
    if (gameMode === 'host') broadcastMove(path);
  }

  lastMove = { fromKey: path[0], toKey: path[path.length - 1] };
  activeMove = null;
  refreshHoleClasses();
  updateMoveButtons();
  renderHistory();
  updateStatus();
  if (gameState.winner !== null) soundWin();
}

// Animate a remote player's committed move on the receiver's screen.
// Slower than the local per-tap pacing so each landing reads as a
// deliberate placement, not a blur.
async function playMovePath(path) {
  const result = applyMoveByPath(gameState, path);
  if (!result.ok) return;

  isAnimating = true;
  const fromKey = path[0];
  const toKey = path[path.length - 1];
  const peg = pegElements.get(fromKey);
  if (!peg) {
    isAnimating = false;
    return;
  }
  pegElements.delete(fromKey);
  for (let i = 1; i < path.length; i++) {
    const cell = CELL_BY_KEY.get(path[i]);
    peg.setAttribute('cx', cell.x);
    peg.setAttribute('cy', cell.y);
    if (path.length === 2) soundStep();
    else soundHop();
    await sleep(PLAYBACK_HOP_MS);
    if (i < path.length - 1) await sleep(PLAYBACK_LANDING_PAUSE_MS);
  }
  pegElements.set(toKey, peg);
  lastMove = { fromKey, toKey };

  isAnimating = false;
  refreshHoleClasses();
  updateMoveButtons();
  renderHistory();
  updateStatus();
  if (gameState.winner !== null) soundWin();
}

function updateMoveButtons() {
  const endBtn = document.getElementById('btn-end-move');
  const undoHopBtn = document.getElementById('btn-undo-hop');
  if (!endBtn || !undoHopBtn) return;
  const inChain = !!activeMove && activeMove.hopPath.length >= 2;
  endBtn.disabled = !inChain || isAnimating;
  undoHopBtn.disabled = !inChain || isAnimating;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// =============================================================
// Undo
// =============================================================
function undo() {
  if (isAnimating) return;
  if (gameState.moveHistory.length === 0) return;
  const last = gameState.moveHistory[gameState.moveHistory.length - 1];
  undoLastMove(gameState);
  // Move the peg back instantly (could animate, but it's a "rewind" — snap).
  const peg = pegElements.get(last.toKey);
  pegElements.delete(last.toKey);
  const fromCell = CELL_BY_KEY.get(last.fromKey);
  peg.setAttribute('cx', fromCell.x);
  peg.setAttribute('cy', fromCell.y);
  pegElements.set(last.fromKey, peg);
  activeMove = null;
  lastMove = gameState.moveHistory.length > 0
    ? {
        fromKey: gameState.moveHistory.at(-1).fromKey,
        toKey: gameState.moveHistory.at(-1).toKey,
      }
    : null;
  refreshHoleClasses();
  updateMoveButtons();
  renderHistory();
  updateStatus();
}

// =============================================================
// Status + history
// =============================================================
function updateStatus() {
  const status = document.getElementById('status');
  const dot = document.getElementById('status-chip');
  if (gameState.winner !== null) {
    let text = `Player ${gameState.winner + 1} wins!`;
    if (gameMode !== 'local' && gameState.winner === myPlayerIdx) text = 'You win!';
    status.textContent = text;
    dot.style.background = PLAYER_COLORS[gameState.winner];
  } else {
    let text = `Player ${gameState.currentPlayer + 1}'s turn`;
    if (gameMode !== 'local' && gameState.currentPlayer === myPlayerIdx) {
      text += ' (you)';
    }
    status.textContent = text;
    dot.style.background = PLAYER_COLORS[gameState.currentPlayer];
  }
  document.getElementById('move-count').textContent = gameState.moveHistory.length;
  // Undo enable logic:
  //   local  → any move can be undone
  //   network → only the player who made the last move can request undo
  //             (and we're not already waiting on a pending request)
  // While the current player is building a chain, block move-level undo
  // so the two undo concepts don't interfere.
  const btnUndo = document.getElementById('btn-undo');
  if (gameState.moveHistory.length === 0 || isAnimating || activeMove) {
    btnUndo.disabled = true;
  } else if (gameMode === 'local') {
    btnUndo.disabled = false;
  } else {
    const lastMover = gameState.moveHistory.at(-1).player;
    btnUndo.disabled = (lastMover !== myPlayerIdx) || undoPending;
  }
  btnUndo.textContent = (gameMode === 'local')
    ? 'Undo'
    : (undoPending ? 'Waiting…' : 'Request Undo');
  updateMoveButtons();
}

function renderHistory() {
  const list = document.getElementById('history-list');
  list.innerHTML = '';
  gameState.moveHistory.forEach((m, i) => {
    const li = document.createElement('li');
    const chip = document.createElement('span');
    chip.className = 'history-chip';
    chip.style.background = PLAYER_COLORS[m.player];
    li.appendChild(chip);
    const txt = document.createElement('span');
    txt.textContent = `${i + 1}. ${m.fromKey} → ${m.toKey}`;
    li.appendChild(txt);
    list.appendChild(li);
  });
  list.scrollTop = list.scrollHeight;
}

// =============================================================
// Chat
// =============================================================
function appendChatMessage(senderIdx, text) {
  const list = document.getElementById('chat-list');
  const li = document.createElement('li');
  const chip = document.createElement('span');
  chip.className = 'history-chip';
  chip.style.background = PLAYER_COLORS[senderIdx];
  li.appendChild(chip);
  const txt = document.createElement('span');
  txt.textContent = `P${senderIdx + 1}: ${text}`;
  li.appendChild(txt);
  list.appendChild(li);
  list.scrollTop = list.scrollHeight;
}

function clearChat() {
  const list = document.getElementById('chat-list');
  if (list) list.innerHTML = '';
}

function sendChatFromInput() {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text) return;
  if (gameMode === 'local') return; // no chat in hot-seat
  // Show locally, then send over the wire.
  appendChatMessage(myPlayerIdx, text);
  sendChatMessage(text); // defined in network.js
  input.value = '';
}

function updateChatVisibility() {
  const panel = document.getElementById('chat-panel');
  if (!panel) return;
  panel.style.display = (gameMode === 'local') ? 'none' : 'block';
}

// =============================================================
// Undo (network-aware wrapper)
// =============================================================
// Called from the Undo button. Routes to local undo or to a network
// undo request depending on game mode.
function requestUndoFromButton() {
  if (isAnimating) return;
  if (gameState.moveHistory.length === 0) return;
  if (gameMode === 'local') {
    undo();
    return;
  }
  // Network mode: only the player who made the most recent move may request.
  const lastMover = gameState.moveHistory.at(-1).player;
  if (lastMover !== myPlayerIdx) return;
  if (undoPending) return;
  undoPending = true;
  updateStatus();
  initiateUndoRequest(); // defined in network.js
}

// Called by network.js when an undo has been agreed by all sides.
function applyAgreedUndo() {
  if (gameState.moveHistory.length === 0) return;
  undo(); // existing local undo applies the same change
  undoPending = false;
  updateStatus();
}

function notifyUndoRejected() {
  undoPending = false;
  updateStatus();
  alert('Your undo request was rejected.');
}
