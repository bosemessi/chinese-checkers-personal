# Chinese Checkers — Personal

A peer-to-peer, browser-based Chinese Checkers you can host from a single tab and share with friends via link. No accounts, no backend, no build step.

> Click **Host a Game** → copy the link → friends join → you approve them at the door → start the game.

Same architecture as `connect4-personal`:
- Pure HTML / CSS / vanilla JS — drops onto GitHub Pages
- WebRTC via PeerJS for browser-to-browser play (the only runtime dependency)
- Host-authoritative game state with gatekeeper approval

---

## Features

- **Local hot-seat** for 2 / 3 / 4 / 6 players
- **Online play via room link** for 2 / 3 / 4 / 6 players (5 not supported — Chinese Checkers rule)
- **Host approval** before guests enter the lobby
- **Animated piece movement** with per-hop animation for chain jumps
- **Move history sidebar** + **last-move highlight**
- **Local undo**, **multiplayer undo with consent** (the next player accepts or rejects)
- **In-game chat** (host relays guest messages)
- **Sound effects** synthesised via Web Audio (no audio files)
- **Mobile-responsive** layout — board scales, sidebar stacks below on narrow screens

## How to launch locally

```bash
cd /Users/soumyajitbose/repos/chinese_checkers_personal
python3 -m http.server 5500
# then visit http://localhost:5500
```

Or open `index.html` directly. No build step, no install.

## Multiplayer test (two browser windows)

1. Tab A: click **Host a Game** → copy the invite URL.
2. Tab B (incognito or a different browser): paste the invite URL.
3. Tab A shows a "knock" → click **Let them in**.
4. (Optional) Open more tabs/devices and repeat to get to 3, 4, or 6 players.
5. Tab A: click **Start Game**. Both tabs jump to the board.
6. Take turns — only the current player's tab accepts clicks.
7. Use the chat box in the sidebar; click **Request Undo** right after your move to ask the next player for an undo.

## File layout

```
chinese_checkers_personal/
├── index.html
├── css/
│   ├── style.css      # layout, screens, controls, chat, mobile
│   └── board.css      # the SVG star board + animations
├── js/
│   ├── gameLogic.js   # pure engine: board, moves, win detection, undo
│   ├── ui.js          # SVG rendering, click handling, sound, chat UI
│   ├── network.js     # PeerJS host/guest/gatekeeper, chat & undo protocols
│   └── app.js         # screen routing + button wiring
└── README.md
```

## Networking model

```
┌─────────────┐  WebRTC DataChannel   ┌─────────────┐
│  Host's     │ ◄────── via PeerJS ──►│  Guest's    │
│  browser    │ ◄────────────────────►│  browser    │
│  (authoritative)                     │  (renderer) │
└─────────────┘                       └─────────────┘
       ▲
       └── for 3+ players, host is the hub (star topology)
           guests don't talk to each other directly
```

Protocol over the PeerJS data channel:

- **Host → Guest**:
  `accepted`, `denied`, `game_init {numPlayers, yourPlayerIdx}`,
  `move_made {fromKey, toKey}`, `chat {sender, text}`,
  `undo_vote {requester}`, `undo_applied`, `undo_rejected {requester}`,
  `player_disconnected`
- **Guest → Host**:
  `request_move {fromKey, toKey}`, `chat {text}`,
  `undo_request`, `undo_response {accept}`

The host validates every move (current player, legal destination) before applying and broadcasting. Chat from guests is relayed by the host to all other guests. Undo requires consent from the next player (whose turn it currently is).

## Limitations (intentional, for a hobby project)

- **In-memory only**: closing the host tab ends the game. No reconnection.
- **Public PeerJS signaling server**: first connection can take a couple of seconds; if it ever rate-limits, swap in your own PeerJS server.
- **Sound starts working after the first click** in each tab (browsers require a user gesture to unlock Web Audio).
- **No spectator mode**: all accepted guests must play.
