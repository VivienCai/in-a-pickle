import assert from "node:assert/strict";

const baseUrl = process.env.TEST_BASE_URL ?? "http://127.0.0.1:8787";

function waitForEvent(target, type, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${type}.`)), timeoutMs);
    target.addEventListener(type, (event) => {
      clearTimeout(timeout);
      resolve(event);
    }, { once: true });
  });
}

async function connect(room) {
  const wsUrl = new URL("/ws", baseUrl);
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  wsUrl.searchParams.set("roomCode", room.roomCode);
  wsUrl.searchParams.set("playerId", room.playerId);
  const socket = new WebSocket(wsUrl);
  await waitForEvent(socket, "open");
  return socket;
}

function waitForState(socket, predicate, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for room state.")), timeoutMs);
    const onMessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "state" && predicate(message.state)) {
        clearTimeout(timeout);
        socket.removeEventListener("message", onMessage);
        resolve(message.state);
      }
    };
    socket.addEventListener("message", onMessage);
  });
}

const createdResponse = await fetch(`${baseUrl}/api/rooms`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "Reconnect Smoke" }),
});
assert.equal(createdResponse.ok, true);
const room = await createdResponse.json();

const initialValidation = await fetch(
  `${baseUrl}/api/rooms/${room.roomCode}/rejoin?playerId=${room.playerId}`,
).then((response) => response.json());
assert.equal(initialValidation.canRejoin, true);

const firstSocket = await connect(room);
const replacementSocket = await connect(room);

await new Promise((resolve) => setTimeout(resolve, 100));
const connectedState = await fetch(`${baseUrl}/api/rooms/${room.roomCode}/state`).then((response) => response.json());
assert.equal(connectedState.players.some((player) => player.id === room.playerId), true);
firstSocket.close();

const recordingStatePromise = waitForState(
  replacementSocket,
  (state) => state.status === "recording" && state.recordingStage === "death",
);
replacementSocket.send(JSON.stringify({ type: "startGame" }));
await recordingStatePromise;

replacementSocket.close();
await new Promise((resolve) => setTimeout(resolve, 300));

const disconnectedState = await fetch(`${baseUrl}/api/rooms/${room.roomCode}/state`).then((response) => response.json());
assert.equal(disconnectedState.players.some((player) => player.id === room.playerId), false);
assert.equal(disconnectedState.hasDisconnectedPlayers, true);

const reconnectValidation = await fetch(
  `${baseUrl}/api/rooms/${room.roomCode}/rejoin?playerId=${room.playerId}`,
).then((response) => response.json());
assert.equal(reconnectValidation.canRejoin, true);

console.log(`room reconnect smoke passed for ${room.roomCode}`);
process.exit(0);
