// app.js — screen routing + button wiring.

let currentScreen = 'landing';

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(`screen-${name}`).classList.add('active');
  currentScreen = name;
}

document.addEventListener('DOMContentLoaded', () => {
  // URL-based routing: ?invite=<peerId> drops you straight into the guest lobby.
  const invite = new URLSearchParams(location.search).get('invite');
  if (invite) {
    showScreen('lobby-guest');
    joinAsGuest(invite);
  } else {
    showScreen('landing');
  }

  // Landing screen
  document.getElementById('btn-host-game').addEventListener('click', () => {
    showScreen('lobby-host');
    startHosting();
    refreshLobbyUI();
  });
  document.getElementById('btn-play-local').addEventListener('click', () => {
    gameMode = 'local';
    myPlayerIdx = -1;
    showScreen('local-setup');
  });

  // Local setup
  document.getElementById('btn-local-start').addEventListener('click', () => {
    const n = parseInt(document.getElementById('player-count').value, 10);
    startNewGame(n);
    showScreen('game');
  });
  document.getElementById('btn-local-back').addEventListener('click', () => {
    showScreen('landing');
  });

  // Host lobby
  document.getElementById('btn-copy-link').addEventListener('click', () => {
    const input = document.getElementById('invite-link');
    input.select();
    navigator.clipboard.writeText(input.value).catch(() => document.execCommand('copy'));
    const btn = document.getElementById('btn-copy-link');
    const original = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = original; }, 1500);
  });
  document.getElementById('btn-accept-knock').addEventListener('click', acceptKnock);
  document.getElementById('btn-deny-knock').addEventListener('click', denyKnock);
  document.getElementById('btn-start-game').addEventListener('click', startNetworkGame);
  document.getElementById('btn-host-back').addEventListener('click', () => {
    teardownNetwork();
    showScreen('landing');
  });

  // Game screen
  document.getElementById('btn-new-game').addEventListener('click', () => {
    if (gameMode === 'local') {
      showScreen('local-setup');
    } else if (gameMode === 'host') {
      const total = 1 + acceptedOrder.length;
      acceptedOrder.forEach((peerId, i) => {
        connections.get(peerId)?.send({
          type: 'game_init',
          numPlayers: total,
          yourPlayerIdx: i + 1,
        });
      });
      startNewGame(total);
    }
    // Guests cannot start a new game.
  });
  document.getElementById('btn-end-move').addEventListener('click', commitActiveMove);
  document.getElementById('btn-undo-hop').addEventListener('click', undoHop);
  document.getElementById('btn-undo').addEventListener('click', requestUndoFromButton);
  document.getElementById('btn-sound').addEventListener('click', () => {
    ensureAudio();
    toggleSound();
  });

  // Chat
  document.getElementById('btn-send-chat').addEventListener('click', sendChatFromInput);
  document.getElementById('chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendChatFromInput();
  });
  document.getElementById('btn-leave-game').addEventListener('click', () => {
    if (gameMode === 'host' || gameMode === 'guest') teardownNetwork();
    showScreen('landing');
  });
});
