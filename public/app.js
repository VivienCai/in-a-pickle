const entry = document.querySelector("#entry");
const lobby = document.querySelector("#lobby");
const statusText = document.querySelector("#status");
const roomCodeText = document.querySelector("#room-code");
const playersList = document.querySelector("#players");

let socket;

function showStatus(message) {
  statusText.textContent = message;
}

function renderState(state) {
  roomCodeText.textContent = state.roomCode;
  playersList.replaceChildren();

  for (const player of state.players) {
    const item = document.createElement("li");
    item.textContent = `${player.name}${player.isHost ? " (host)" : ""}`;
    playersList.append(item);
  }
}

function connectToRoom(room) {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${protocol}//${location.host}/ws?roomCode=${encodeURIComponent(room.roomCode)}&playerId=${encodeURIComponent(room.playerId)}`;
  socket = new WebSocket(url);

  socket.addEventListener("open", () => {
    entry.classList.add("hidden");
    lobby.classList.remove("hidden");
    showStatus("Connected to the room.");
  });

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "state") {
      renderState(message.state);
    }
  });

  socket.addEventListener("close", () => {
    showStatus("Disconnected from the room.");
  });

  socket.addEventListener("error", () => {
    showStatus("Could not connect to the room.");
  });
}

async function joinApi(url, name) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error ?? "Request failed.");
  }
  return data;
}

document.querySelector("#create-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  showStatus("Creating room...");

  try {
    const name = document.querySelector("#create-name").value;
    const room = await joinApi("/api/rooms", name);
    connectToRoom(room);
  } catch (error) {
    showStatus(error.message);
  }
});

document.querySelector("#join-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  showStatus("Joining room...");

  try {
    const name = document.querySelector("#join-name").value;
    const code = document.querySelector("#join-code").value.trim().toUpperCase();
    const room = await joinApi(`/api/rooms/${encodeURIComponent(code)}/join`, name);
    connectToRoom(room);
  } catch (error) {
    showStatus(error.message);
  }
});
