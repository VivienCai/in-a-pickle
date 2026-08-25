const entry = document.querySelector("#entry");
const lobby = document.querySelector("#lobby");
const statusText = document.querySelector("#status");
const roomCodeText = document.querySelector("#room-code");
const playersList = document.querySelector("#players");
const disconnectActions = document.querySelector("#disconnect-actions");
const rejoinButton = document.querySelector("#rejoin-button");
const newRoomButton = document.querySelector("#new-room-button");
const rejoinPrompt = document.querySelector("#rejoin-prompt");
const rejoinCodeText = document.querySelector("#rejoin-code");
const rejoinYesButton = document.querySelector("#rejoin-yes");

let socket;
const savedRoomKey = "in-a-pickle-room";

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
  localStorage.setItem(savedRoomKey, JSON.stringify(room));
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${protocol}//${location.host}/ws?roomCode=${encodeURIComponent(room.roomCode)}&playerId=${encodeURIComponent(room.playerId)}`;
  socket = new WebSocket(url);
  let connected = false;

  socket.addEventListener("open", () => {
    connected = true;
    rejoinPrompt.classList.add("hidden");
    entry.classList.add("hidden");
    lobby.classList.remove("hidden");
    disconnectActions.classList.add("hidden");
    showStatus("Connected to the room.");
  });

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "state") {
      renderState(message.state);
    }
  });

  socket.addEventListener("close", () => {
    if (!connected) {
      localStorage.removeItem(savedRoomKey);
      rejoinPrompt.classList.add("hidden");
      lobby.classList.add("hidden");
      disconnectActions.classList.add("hidden");
      entry.classList.remove("hidden");
      showStatus(`Room ${room.roomCode} is no longer available.`);
      return;
    }

    showStatus("");
    disconnectActions.classList.remove("hidden");
    rejoinButton.textContent = `Rejoin Room ${room.roomCode}`;
  });
}

rejoinButton.addEventListener("click", () => {
  const savedRoom = localStorage.getItem(savedRoomKey);
  if (!savedRoom) {
    showStatus("Your room information is no longer available.");
    return;
  }

  try {
    connectToRoom(JSON.parse(savedRoom));
    showStatus("Rejoining room...");
  } catch {
    localStorage.removeItem(savedRoomKey);
    showStatus("Your room information is invalid.");
  }
});

newRoomButton.addEventListener("click", () => {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.close();
  }

  localStorage.removeItem(savedRoomKey);
  lobby.classList.add("hidden");
  entry.classList.remove("hidden");
  disconnectActions.classList.add("hidden");
  rejoinPrompt.classList.add("hidden");
  showStatus("Ready to join a new room.");
});

function showRejoinPrompt() {
  const savedRoom = localStorage.getItem(savedRoomKey);
  if (!savedRoom) {
    return;
  }

  let room;
  try {
    room = JSON.parse(savedRoom);
  } catch {
    localStorage.removeItem(savedRoomKey);
    return;
  }

  if (!room.roomCode || !room.playerId) {
    localStorage.removeItem(savedRoomKey);
    return;
  }

  rejoinCodeText.textContent = room.roomCode;
  rejoinYesButton.textContent = `Rejoin Room ${room.roomCode}`;
  rejoinPrompt.classList.remove("hidden");
}

rejoinYesButton.addEventListener("click", () => {
  const savedRoom = localStorage.getItem(savedRoomKey);
  if (!savedRoom) {
    rejoinPrompt.classList.add("hidden");
    return;
  }

  const room = JSON.parse(savedRoom);
  showStatus(`Rejoining Room ${room.roomCode}...`);
  connectToRoom(room);
});

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

showRejoinPrompt();
