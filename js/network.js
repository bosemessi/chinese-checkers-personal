// network.js — WebRTC peer-to-peer over PeerJS.
// Host-authoritative: the host owns the game state. Guests send move
// requests; host validates, applies, and broadcasts the result.

let gameMode = 'local';        // 'local' | 'host' | 'guest'
let myPlayerIdx = -1;          // assigned at game-start (host=0, guest=1+)

// Host-side state
let peer = null;
const connections = new Map(); // peerId -> DataConnection (all guests, accepted or not)
const acceptedOrder = [];      // peerIds in the order they were accepted
const pendingKnocks = [];      // peerIds waiting for accept/deny

// Guest-side state
let hostConn = null;

function randomRoomId() {
  return Math.random().toString(36).substring(2, 10);
}

// =============================================================
// Host
// =============================================================
function startHosting() {
  const roomId = randomRoomId();
  peer = new Peer(roomId);

  peer.on('open', (id) => {
    const inviteUrl = `${location.origin}${location.pathname}?invite=${id}`;
    document.getElementById('invite-link').value = inviteUrl;
    document.getElementById('lobby-status').textContent =
      'Lobby ready. Share the invite link with friends.';
  });

  peer.on('connection', (conn) => {
    setupGuestConnection(conn);
  });

  peer.on('error', (err) => {
    console.error('Host PeerJS error:', err);
    document.getElementById('lobby-status').textContent =
      'Networking error: ' + err.type;
  });

  gameMode = 'host';
  myPlayerIdx = 0;
}

function setupGuestConnection(conn) {
  const peerId = conn.peer;
  connections.set(peerId, conn);

  conn.on('open', () => {
    pendingKnocks.push(peerId);
    refreshLobbyUI();
  });

  conn.on('data', (data) => onGuestData(peerId, data));

  conn.on('close', () => {
    handleGuestDisconnect(peerId);
  });
}

function handleGuestDisconnect(peerId) {
  connections.delete(peerId);
  const ai = acceptedOrder.indexOf(peerId);
  if (ai !== -1) acceptedOrder.splice(ai, 1);
  const pi = pendingKnocks.indexOf(peerId);
  if (pi !== -1) pendingKnocks.splice(pi, 1);

  if (currentScreen === 'game') {
    broadcastToAll({ type: 'player_disconnected' });
    alert('A player disconnected. Game ended.');
    showScreen('landing');
    teardownNetwork();
  } else {
    refreshLobbyUI();
  }
}

function onGuestData(peerId, data) {
  const playerIdx = acceptedOrder.indexOf(peerId) + 1;
  if (data.type === 'request_move') {
    if (playerIdx <= 0) return;
    if (gameState.currentPlayer !== playerIdx) return;
    const legal = getLegalMoves(gameState, data.fromKey);
    if (!legal.includes(data.toKey)) return;
    doMove(data.fromKey, data.toKey);
    broadcastMove(data.fromKey, data.toKey);
  } else if (data.type === 'chat') {
    // Relay to all OTHER accepted guests (sender already showed it locally).
    appendChatMessage(playerIdx, data.text);
    for (const otherId of acceptedOrder) {
      if (otherId === peerId) continue;
      connections.get(otherId)?.send({ type: 'chat', sender: playerIdx, text: data.text });
    }
  } else if (data.type === 'undo_request') {
    if (playerIdx <= 0) return;
    handleUndoRequest(playerIdx);
  } else if (data.type === 'undo_response') {
    // Decider's response, only meaningful while we have a pending vote.
    finalizeUndoVote(data.accept);
  }
}

function acceptKnock() {
  const peerId = pendingKnocks.shift();
  if (!peerId) return;
  acceptedOrder.push(peerId);
  connections.get(peerId)?.send({ type: 'accepted' });
  refreshLobbyUI();
}

function denyKnock() {
  const peerId = pendingKnocks.shift();
  if (!peerId) return;
  const conn = connections.get(peerId);
  conn?.send({ type: 'denied' });
  setTimeout(() => {
    conn?.close();
    connections.delete(peerId);
  }, 200);
  refreshLobbyUI();
}

function startNetworkGame() {
  const total = 1 + acceptedOrder.length;
  if (![2, 3, 4, 6].includes(total)) {
    alert(`Need 2, 3, 4, or 6 players. Currently: ${total}.`);
    return;
  }
  acceptedOrder.forEach((peerId, i) => {
    connections.get(peerId)?.send({
      type: 'game_init',
      numPlayers: total,
      yourPlayerIdx: i + 1,
    });
  });
  myPlayerIdx = 0;
  startNewGame(total);
  showScreen('game');
}

function broadcastMove(fromKey, toKey) {
  broadcastToAll({ type: 'move_made', fromKey, toKey });
}

function broadcastToAll(msg) {
  for (const peerId of acceptedOrder) {
    connections.get(peerId)?.send(msg);
  }
}

// =============================================================
// Guest
// =============================================================
function joinAsGuest(hostId) {
  peer = new Peer();

  peer.on('open', () => {
    hostConn = peer.connect(hostId);
    hostConn.on('open', () => {
      document.getElementById('guest-status').textContent =
        "Knocking on the host's door…";
    });
    hostConn.on('data', onHostData);
    hostConn.on('close', () => {
      if (currentScreen === 'game') {
        alert('Host disconnected. Game ended.');
        showScreen('landing');
        teardownNetwork();
      } else {
        document.getElementById('guest-status').textContent = 'Disconnected from host.';
      }
    });
  });

  peer.on('error', (err) => {
    console.error('Guest PeerJS error:', err);
    document.getElementById('guest-status').textContent =
      `Could not connect (${err.type}). The invite may be invalid or the host has left.`;
  });

  gameMode = 'guest';
}

function onHostData(data) {
  if (data.type === 'accepted') {
    document.getElementById('guest-status').textContent =
      "You're in! Waiting for the host to start the game…";
  } else if (data.type === 'denied') {
    document.getElementById('guest-status').textContent =
      'The host denied your entry.';
    hostConn?.close();
  } else if (data.type === 'game_init') {
    myPlayerIdx = data.yourPlayerIdx;
    startNewGame(data.numPlayers);
    showScreen('game');
  } else if (data.type === 'move_made') {
    doMove(data.fromKey, data.toKey);
  } else if (data.type === 'chat') {
    appendChatMessage(data.sender, data.text);
  } else if (data.type === 'undo_vote') {
    // I'm the decider; ask via confirm() dialog.
    const allow = confirm(
      `Player ${data.requester + 1} wants to undo their last move. Allow?`
    );
    hostConn?.send({ type: 'undo_response', accept: !!allow });
  } else if (data.type === 'undo_applied') {
    applyAgreedUndo();
  } else if (data.type === 'undo_rejected') {
    if (data.requester === myPlayerIdx) notifyUndoRejected();
  } else if (data.type === 'player_disconnected') {
    alert('A player disconnected. Game ended.');
    showScreen('landing');
    teardownNetwork();
  }
}

function sendNetworkMove(fromKey, toKey) {
  if (hostConn && hostConn.open) {
    hostConn.send({ type: 'request_move', fromKey, toKey });
  }
}

// =============================================================
// Chat
// =============================================================
// Send a chat message from the local player. The local UI already shows
// the message; this function just puts it on the wire.
function sendChatMessage(text) {
  if (gameMode === 'guest') {
    hostConn?.send({ type: 'chat', text });
  } else if (gameMode === 'host') {
    // From the host's perspective, broadcast directly to everyone.
    for (const peerId of acceptedOrder) {
      connections.get(peerId)?.send({ type: 'chat', sender: myPlayerIdx, text });
    }
  }
}

// =============================================================
// Undo (with consent)
// =============================================================
// Pending vote state on the host side. We only allow one undo vote in
// flight at a time.
let pendingUndo = null; // { requester: playerIdx }

// Called by ui.js when the local player clicks the Undo button in network mode.
function initiateUndoRequest() {
  if (gameMode === 'guest') {
    hostConn?.send({ type: 'undo_request' });
  } else if (gameMode === 'host') {
    handleUndoRequest(0);
  }
}

// Host-side: a player (host or guest) wants to undo their last move.
function handleUndoRequest(requesterIdx) {
  if (gameState.moveHistory.length === 0) return;
  const lastMover = gameState.moveHistory.at(-1).player;
  if (requesterIdx !== lastMover) return;
  if (pendingUndo) return; // already a vote in flight

  pendingUndo = { requester: requesterIdx };
  const deciderIdx = gameState.currentPlayer;

  if (deciderIdx === 0) {
    // Host is the decider; ask via confirm() in this tab.
    const allow = confirm(
      `Player ${requesterIdx + 1} wants to undo their last move. Allow?`
    );
    finalizeUndoVote(allow);
  } else {
    // Decider is a guest; send them the vote request.
    const deciderPeerId = acceptedOrder[deciderIdx - 1];
    connections.get(deciderPeerId)?.send({
      type: 'undo_vote',
      requester: requesterIdx,
    });
  }
}

// Host-side: a decision has been reached (locally or from a guest).
function finalizeUndoVote(accept) {
  if (!pendingUndo) return;
  const requester = pendingUndo.requester;
  pendingUndo = null;
  if (accept) {
    applyAgreedUndo(); // apply locally (host)
    broadcastToAll({ type: 'undo_applied' });
  } else {
    if (requester === 0) {
      notifyUndoRejected(); // host was the requester
    }
    broadcastToAll({ type: 'undo_rejected', requester });
  }
}

// =============================================================
// Cleanup
// =============================================================
function teardownNetwork() {
  for (const conn of connections.values()) {
    try { conn.close(); } catch {}
  }
  connections.clear();
  acceptedOrder.length = 0;
  pendingKnocks.length = 0;
  try { hostConn?.close(); } catch {}
  hostConn = null;
  try { peer?.destroy(); } catch {}
  peer = null;
  gameMode = 'local';
  myPlayerIdx = -1;
}

// =============================================================
// Lobby UI
// =============================================================
function refreshLobbyUI() {
  const list = document.getElementById('player-list');
  list.innerHTML = '';
  const li0 = document.createElement('li');
  li0.textContent = 'Player 1 — You (host)';
  list.appendChild(li0);
  acceptedOrder.forEach((peerId, i) => {
    const li = document.createElement('li');
    li.textContent = `Player ${i + 2} — ${peerId.slice(0, 8)}`;
    list.appendChild(li);
  });

  const knockBox = document.getElementById('knock-box');
  if (pendingKnocks.length > 0) {
    knockBox.style.display = 'block';
    const queueNote = pendingKnocks.length > 1
      ? ` (+${pendingKnocks.length - 1} more waiting)` : '';
    document.getElementById('knock-name').textContent =
      `${pendingKnocks[0].slice(0, 8)} wants to join${queueNote}`;
  } else {
    knockBox.style.display = 'none';
  }

  const startBtn = document.getElementById('btn-start-game');
  const total = 1 + acceptedOrder.length;
  const valid = [2, 3, 4, 6].includes(total);
  startBtn.disabled = !valid;
  startBtn.textContent = `Start Game (${total} player${total === 1 ? '' : 's'})`;
  if (total === 5) {
    startBtn.textContent += ' — 5 not supported';
  }
}
