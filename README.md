# Spaner

*Start with one king. Recruit an army. Checkmate the other king.*

A browser game built on the Spaner rules. You can play the computer at six levels from **Beginner** to **God**, play a friend online through a shared link, or pass and play on one device.

## Run it

Requires Node 18 or newer. There are no dependencies to install.

```bash
cd spaner
npm start
```

Open http://localhost:3000.

Run the rules and AI tests with:

```bash
npm test
```

## Game modes

| Mode | How it works |
|---|---|
| **Versus Computer** | Pick a level and a colour. The AI runs in a Web Worker so the board never freezes. |
| **Play a Friend** | Click **Create invite link** and send the link (or the 6-letter room code). The game starts with a 3-second countdown when your friend opens it. |
| **Same Device** | Two players take turns on one screen. |

### Online sessions

- The server owns the clocks, the piece arrivals and the rules, so neither player can cheat by editing the page.
- Your seat is saved in the browser. If you reload or reopen the invite link, you go straight back to your seat.
- The same browser always gets the same seat. To try both sides yourself, open the link in a private window or a different browser.
- A third person who opens the link watches the game as a spectator.
- After a game, both players press **Rematch** and the colours swap.

### Playing with a friend who is not on your network

- **Same Wi-Fi:** `npm start` prints a `Network:` address such as `http://192.168.1.20:3000`. Your friend can use that address.
- **Quick share over the internet:** run a tunnel in a second terminal and send the public URL it prints:

  ```bash
  npx localtunnel --port 3000
  ```

  `cloudflared tunnel --url http://localhost:3000` also works if you have Cloudflare's tool installed.
- **Permanent hosting:** deploy the `spaner` folder to any Node host, such as Render, Railway, Fly.io or a VPS. Use `npm start` as the start command. The server reads `PORT` from the environment.

Rooms live in memory. Restarting the server closes all open tables. A room is removed after 30 minutes with nobody connected, or after 12 hours.

## AI levels

| Level | Search | Character |
|---|---|---|
| Beginner | 1 ply, no tactics, often random | Still learning how the pieces move |
| Novice | 1 ply + short capture lookahead | Grabs whatever it can see |
| Club | 2 ply + captures | Solid, rarely hangs a piece |
| Expert | 4 ply + captures | Spots tactics and traps |
| Master | 6 ply + deep captures | Punishes mistakes |
| God | Iterative deepening to about 9–10 ply in ~6 s | Searches as deep as time allows |

The engine is an alpha-beta search with a quiescence search, a transposition table and killer-move ordering. Its evaluation counts material and army size, and the army size counts for more as the 15-minute mark gets close, because that is how the game is scored. It also weighs pawn advancement, centralisation and king safety. It chooses recruit placements by checking which squares are safe and which threaten something.

## How some rule questions were settled

The rules leave a few cases open. These are the choices this version makes:

- **Clocks:** there is one shared 15-minute game clock, plus a 30-second limit on every turn. The turn time includes the commander's order and placing recruits.
- **Placing a recruit can block check.** A capture that leaves your king in check is legal if the recruit can be placed in the way. The placement squares are then limited to squares that block.
- **Banana copies are never counted on.** A move is legal only if it works without the extra bananas from rolling a 6. Copies only add pieces, so they can never make a legal move illegal.
- **Neutral pieces never attack**, but they do block lines, for checks too.
- **Kings can recruit.** A king may capture a neutral or enemy piece if the square it lands on is not attacked.
- **Dragons** cannot capture a king and never give check. Their reach therefore never limits where the enemy king may move.
- **Pieces that arrive mid-turn**, while someone is placing recruits, land on a square that is empty both before and after that turn's move.
- **A pawn placed on its own far edge** becomes a queen. This can only happen when your half of the board is full.
- **Checkmate and stalemate** are checked after every completed turn and after every piece arrival.

## Files

```
spaner/
├── server.js            Node server: static files + online rooms (Server-Sent Events)
├── package.json
├── public/
│   ├── index.html       Menu, game screen, rules dialog
│   ├── style.css
│   ├── engine.js        Rules engine + real-time Match (shared by browser, worker, server)
│   ├── ai.js            Computer opponent
│   ├── ai-worker.js     Runs the AI off the main thread
│   ├── pieces.js        SVG artwork for all nine pieces
│   └── app.js           UI, input, AI driver, online client
└── test/engine.test.js  Rules, clock and AI tests
```

`public/` also works as a static site for the computer and same-device modes. Online play needs `server.js`.
