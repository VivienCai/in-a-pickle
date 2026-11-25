# in a pickle

in a pickle is a multiplayer browser game where you and your friends control one pickle using your voices.

the louder everyone is, the higher the pickle moves. when everyone gets quieter, it moves back down. the goal is to avoid obstacles for as long as possible, which gets kind of difficult when multiple people are yelling at the same pickle.

## how it works

one person creates a room and shares the four-character code with everyone else. each room supports up to eight players.

before the game starts, everyone calibrates their microphone and records three short sound effects. those recordings are used when the run starts, when the team collects a coin, and when the pickle dies.

during the run, the server combines the players' microphone levels to control the pickle. there are also voice challenges where the team has to stay quiet, hold a steady volume, or let one person control the pickle alone. completing a challenge earns a coin.

## why i made it

i wanted to make a multiplayer game where voice chat is part of the actual gameplay instead of something running beside it. the main challenge was keeping every player in sync while processing live microphone input, managing room state, and making reconnects work without ending the game for everyone.

it was also a good excuse to make people record their own death sound.

## built with

- cloudflare workers for the api and frontend
- durable objects and sqlite for room state and the game loop
- websockets for live game updates
- cloudflare realtimekit for voice chat
- cloudflare r2 for player-recorded sound effects
- html, css, javascript, and canvas for the client
- typescript for the worker

each room is managed by its own durable object. it keeps track of connected players, microphone levels, recordings, obstacles, challenges, and the current game state. the server runs the game loop and broadcasts the same state to every player over websockets.

the game also handles reconnecting players, replacing duplicate connections, reassigning the host when someone leaves, and deleting uploaded recordings after players expire.

## running locally

you will need node.js and a cloudflare account with:

- an r2 bucket with a public url
- a realtimekit app
- an audio-only realtimekit participant preset
- an api token with access to realtimekit

clone the repo and install the dependencies:

```bash
git clone git@github.com:VivienCai/in-a-pickle.git
cd in-a-pickle
npm install
```

update the values in `wrangler.toml` for your cloudflare account, r2 bucket, and realtimekit app. then add your api token:

```bash
npx wrangler secret put CLOUDFLARE_API_TOKEN
```

start the local server:

```bash
npm run dev
```

the game will be available at `http://localhost:8787`.

the current r2 binding uses `remote = true`, so recordings made during local development are uploaded to the configured cloudflare bucket.

## scripts

```bash
npm run dev        # start the local worker
npm test           # run the unit tests
npm run typecheck  # run the typescript checks
npm run test:room  # test a room against a running server
npm run deploy     # deploy with wrangler
```

`npm run test:room` uses `http://127.0.0.1:8787` by default. you can test another deployment with:

```bash
TEST_BASE_URL=https://your-worker.example.com npm run test:room
```

## project structure

```text
public/              client, styles, and canvas renderer
src/index.ts         worker routes and room creation
src/gameRoom.ts      room state, websocket handling, and game loop
src/gameRules.ts     collision, movement, and challenge rules
src/realtimeKit.ts   voice meeting setup
src/stream.ts        recording storage and cleanup
tests/               unit tests and room smoke test
```
