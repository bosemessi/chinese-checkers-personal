// ui.js — Polished hot-seat UI.
// Two SVG layers: fixed "holes" (background, clickable) and "pegs"
// (foreground, animated via CSS transitions on cx/cy). Each peg has a
// stable DOM element that we move around the board, so hop chains can
// be animated step-by-step.

const SVG_NS = 'http://www.w3.org/2000/svg';
const CELL_RADIUS = 0.42;
const PEG_RADIUS = 0.38;
const HOP_DURATION_MS = 220;   // per hop / step
const HOP_GAP_MS = 60;         // pause between hops in a chain

const PLAYER_COLORS = [
  '#e74c3c', // 1: red
  '#3498db', // 2: blue
  '#2ecc71', // 3: green
  '#f1c40f', // 4: yellow
  '#9b59b6', // 5: purple
  '#1abc9c', // 6: teal
];

let gameState = null;
let selectedPeg = null;
let legalDestinations = [];
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
  selectedPeg = null;
  legalDestinations = [];
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
  if (selectedPeg) {
    svg.querySelector(`.hole[data-key="${selectedPeg}"]`)?.classList.add('selected');
  }
  if (lastMove) {
    svg.querySelector(`.hole[data-key="${lastMove.fromKey}"]`)?.classList.add('last-from');
    svg.querySelector(`.hole[data-key="${lastMove.toKey}"]`)?.classList.add('last-to');
  }
}

// =============================================================
// Click handling
// =============================================================
function onCellClick(key) {
  ensureAudio(); // first user gesture unlocks Web Audio
  if (isAnimating) return;
  if (gameState.winner !== null) return;

  // Network mode: you can only act on your own turn.
  if (gameMode !== 'local' && gameState.currentPlayer !== myPlayerIdx) return;

  // 1. Click a legal destination → make the move.
  if (selectedPeg && legalDestinations.includes(key)) {
    // Capture before doMove() clears the global `selectedPeg`.
    const fromKey = selectedPeg;
    if (gameMode === 'guest') {
      // Send to host; the resulting `move_made` broadcast will animate locally.
      sendNetworkMove(fromKey, key);
      selectedPeg = null;
      legalDestinations = [];
      refreshHoleClasses();
    } else {
      // 'local' or 'host': apply directly. Host also broadcasts.
      doMove(fromKey, key);
      if (gameMode === 'host') broadcastMove(fromKey, key);
    }
    return;
  }

  // 2. Click one of the current player's pegs → select it.
  if (gameState.pegs.get(key) === gameState.currentPlayer) {
    selectedPeg = key;
    legalDestinations = getLegalMoves(gameState, key);
    refreshHoleClasses();
    return;
  }

  // 3. Anything else → deselect.
  selectedPeg = null;
  legalDestinations = [];
  refreshHoleClasses();
}

async function doMove(fromKey, toKey) {
  const path = getMovePath(gameState, fromKey, toKey);
  if (!path) return;

  isAnimating = true;
  selectedPeg = null;
  legalDestinations = [];
  refreshHoleClasses();

  applyMove(gameState, fromKey, toKey);
  lastMove = { fromKey, toKey };

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
    if (i === 1 && path.length === 2) soundStep();
    else soundHop();
    await sleep(HOP_DURATION_MS + (i < path.length - 1 ? HOP_GAP_MS : 0));
  }
  pegElements.set(toKey, peg);

  isAnimating = false;
  refreshHoleClasses();
  renderHistory();
  updateStatus();
  if (gameState.winner !== null) soundWin();
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
  selectedPeg = null;
  legalDestinations = [];
  lastMove = gameState.moveHistory.length > 0
    ? {
        fromKey: gameState.moveHistory.at(-1).fromKey,
        toKey: gameState.moveHistory.at(-1).toKey,
      }
    : null;
  refreshHoleClasses();
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
  const btnUndo = document.getElementById('btn-undo');
  if (gameState.moveHistory.length === 0 || isAnimating) {
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
