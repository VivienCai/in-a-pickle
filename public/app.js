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
const startButton = document.querySelector("#start-button");
const calibrateButton = document.querySelector("#calibrate-button");
const calibrationInstructions = document.querySelector("#calibration-instructions");
const game = document.querySelector("#game");
const gameCanvas = document.querySelector("#game-canvas");
const scoreText = document.querySelector("#score");
const volumeMeter = document.querySelector("#volume-meter");
const gameMessage = document.querySelector("#game-message");
const restartButton = document.querySelector("#restart-button");
const micStatus = document.querySelector("#mic-status");
const voiceStatus = document.querySelector("#voice-status");
const voiceBar = document.querySelector("#voice-bar");

let socket;
const savedRoomKey = "in-a-pickle-room";
let audioContext;
let analyser;
let microphoneStream;
let volumeTimer;
let rawVolumeData;
let calibration = null;
let voiceMeeting = null;
const voicePills = new Map();

function showStatus(message) {
  statusText.textContent = message;
  statusText.classList.toggle("hidden", !message);
}

function setVoiceStatus(message) {
  voiceStatus.textContent = `Voice: ${message}`;
}

async function leaveVoice() {
  if (!voiceMeeting) {
    return;
  }

  const meeting = voiceMeeting;
  voiceMeeting = null;
  try {
    await meeting.leave();
  } catch {
    // The media connection may already be closed.
  }
}

async function joinVoice(room) {
  await leaveVoice();
  setVoiceStatus("connecting");

  if (!globalThis.RealtimeKitClient) {
    setVoiceStatus("unavailable");
    return;
  }

  try {
    let voiceToken = room.voiceToken;
    if (!voiceToken) {
      const response = await fetch(
        `/api/rooms/${encodeURIComponent(room.roomCode)}/voice?playerId=${encodeURIComponent(room.playerId)}`,
      );
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error ?? "Could not join voice chat.");
      }

      voiceToken = data.voiceToken;
      if (voiceToken) {
        room.voiceToken = voiceToken;
        localStorage.setItem(savedRoomKey, JSON.stringify(room));
      }
    }

    if (!voiceToken) {
      setVoiceStatus("not configured");
      return;
    }

    const meeting = await globalThis.RealtimeKitClient.init({
      authToken: voiceToken,
      defaults: { audio: true, video: false },
    });
    await meeting.join();
    voiceMeeting = meeting;
    setVoiceStatus("connected");
    void startVolumeMonitoring(meeting.self.audioTrack);
  } catch (error) {
    console.error("RealtimeKit voice connection failed:", error);
    setVoiceStatus("unavailable");
  }
}

function updateVoiceBar(players) {
  const currentIds = new Set(players.map((player) => player.id));

  for (const [playerId, pill] of voicePills) {
    if (!currentIds.has(playerId)) {
      pill.remove();
      voicePills.delete(playerId);
    }
  }

  for (const player of players) {
    let pill = voicePills.get(player.id);
    if (!pill) {
      pill = document.createElement("span");
      pill.className = "voice-pill";
      voiceBar.append(pill);
      voicePills.set(player.id, pill);
    }

    pill.textContent = player.name;
    pill.classList.toggle("speaking", player.speaking);
  }
}

function drawGame(gameState) {
  const context = gameCanvas.getContext("2d");
  if (!context) {
    return;
  }

  const width = gameCanvas.width;
  const height = gameCanvas.height;
  const groundY = height - 70;
  const ceilingY = 0;
  const cameraX = Math.max(0, gameState.character.x - 150);

  context.clearRect(0, 0, width, height);
  context.fillStyle = "#fff8df";
  context.fillRect(0, 0, width, height);
  context.fillStyle = "#d3e3bc";
  context.fillRect(0, groundY, width, height - groundY);
  context.strokeStyle = "#4b842f";
  context.lineWidth = 4;
  context.beginPath();
  context.moveTo(0, groundY);
  context.lineTo(width, groundY);
  context.stroke();

  context.fillStyle = "#d8523b";
  context.beginPath();
  for (let x = 0; x < width; x += 24) {
    context.moveTo(x, ceilingY);
    context.lineTo(x + 12, ceilingY + 20);
    context.lineTo(x + 24, ceilingY);
  }
  context.fill();

  for (const obstacle of gameState.obstacles) {
    const screenX = obstacle.x - cameraX;
    if (screenX + obstacle.width < 0 || screenX > width) {
      continue;
    }

    context.fillStyle = "#d8523b";
    const screenY = obstacle.fromTop ? ceilingY : groundY - obstacle.height;
    context.fillRect(screenX, screenY, obstacle.width, obstacle.height);
    context.fillStyle = "#f0bd3d";
    const accentY = obstacle.fromTop ? screenY + obstacle.height - 11 : screenY + 6;
    context.fillRect(screenX + 6, accentY, obstacle.width - 12, 5);
  }

  const pickleX = gameState.character.x - cameraX;
  const pickleY = groundY - gameState.character.y - 48;
  context.fillStyle = "#6fa642";
  context.beginPath();
  context.ellipse(pickleX + 22, pickleY + 25, 18, 27, -0.12, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = "#20351f";
  context.beginPath();
  context.arc(pickleX + 15, pickleY + 18, 4, 0, Math.PI * 2);
  context.arc(pickleX + 29, pickleY + 17, 4, 0, Math.PI * 2);
  context.fill();
  context.strokeStyle = "#20351f";
  context.lineWidth = 3;
  context.beginPath();
  context.moveTo(pickleX + 14, pickleY + 57);
  context.lineTo(pickleX + 8, pickleY + 64);
  context.moveTo(pickleX + 30, pickleY + 57);
  context.lineTo(pickleX + 36, pickleY + 64);
  context.stroke();
}

async function startVolumeMonitoring(audioTrack) {
  if (microphoneStream || !audioTrack) {
    return;
  }

  try {
    microphoneStream = new MediaStream([audioTrack]);
    audioContext = new AudioContext();
    await audioContext.resume();
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.2;
    audioContext.createMediaStreamSource(microphoneStream).connect(analyser);
    rawVolumeData = new Uint8Array(analyser.fftSize);

    volumeTimer = setInterval(() => {
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        return;
      }

      const volume = calibration ? normalizeVolume(readRawVolume()) : 0;
      volumeMeter.value = volume;
      socket.send(JSON.stringify({ type: "reportVolume", volume }));
    }, 100);

    calibrateButton.classList.remove("hidden");
    micStatus.textContent = "Needs calibration";
    micStatus.classList.add("pending");
    micStatus.classList.remove("hidden");
    calibrationInstructions.classList.remove("hidden");
    showStatus("");
  } catch {
    showStatus("Microphone could not be connected for volume control.");
  }
}

function readRawVolume() {
  analyser.getByteTimeDomainData(rawVolumeData);
  const squaredTotal = rawVolumeData.reduce((sum, value) => {
    const centeredValue = (value - 128) / 128;
    return sum + centeredValue * centeredValue;
  }, 0);
  const rootMeanSquare = Math.sqrt(squaredTotal / rawVolumeData.length);
  return Math.min(1, rootMeanSquare * 4);
}

function normalizeVolume(volume) {
  const range = calibration.loudLevel - calibration.noiseFloor;
  return Math.max(0, Math.min(1, (volume - calibration.noiseFloor) / range));
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function collectVolumeSamples(duration) {
  const samples = [];
  const endTime = Date.now() + duration;
  while (Date.now() < endTime) {
    samples.push(readRawVolume());
    await wait(50);
  }
  return samples;
}

function percentile(values, percentage) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * percentage)] ?? 0;
}

async function calibrateMicrophone() {
  if (!analyser) {
    return;
  }

  calibration = null;
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "micNotReady" }));
  }
  calibrateButton.disabled = true;
  calibrationInstructions.textContent = "Stay quiet for a moment...";
  const quietSamples = await collectVolumeSamples(1500);

  calibrationInstructions.textContent = "Now make the loudest sound you can!";
  await wait(500);
  const loudSamples = await collectVolumeSamples(1800);

  const noiseFloor = percentile(quietSamples, 0.8);
  const loudLevel = percentile(loudSamples, 0.9);
  if (loudLevel - noiseFloor < 0.03) {
    calibrateButton.disabled = false;
    calibrationInstructions.textContent = "That was too quiet. Try again and make more noise.";
    showStatus("");
    return;
  }

  calibration = { noiseFloor, loudLevel };
  calibrateButton.textContent = "Recalibrate Microphone";
  calibrationInstructions.textContent = "Calibrated. You can recalibrate later if your setup changes.";
  micStatus.textContent = "Microphone calibrated";
  micStatus.classList.remove("pending");
  micStatus.classList.remove("hidden");
  showStatus("");
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "micReady" }));
  }
}

function renderState(state, gameState) {
  roomCodeText.textContent = state.roomCode;
  playersList.replaceChildren();

  for (const player of state.players) {
    const item = document.createElement("li");
    item.className = "player-row";
    item.classList.toggle("speaking", player.speaking);

    const name = document.createElement("span");
    name.textContent = `${player.name}${player.isHost ? " (host)" : ""}`;

    const playerMicStatus = document.createElement("span");
    playerMicStatus.className = player.micReady ? "mic-status ready" : "mic-status waiting";
    playerMicStatus.textContent = player.micReady ? "MIC READY" : "MIC NEEDED";

    item.append(name, playerMicStatus);
    playersList.append(item);
  }

  updateVoiceBar(state.players);

  const savedRoom = JSON.parse(localStorage.getItem(savedRoomKey) ?? "null");
  const currentPlayer = state.players.find((player) => player.id === savedRoom?.playerId);
  startButton.classList.toggle("hidden", state.status !== "lobby" || !currentPlayer?.isHost);
  startButton.disabled = false;
  startButton.textContent = "Start Run";
  restartButton.classList.toggle("hidden", state.status !== "finished" || !currentPlayer?.isHost);

  if (gameState && (state.status === "playing" || state.status === "finished")) {
    lobby.classList.add("hidden");
    game.classList.remove("hidden");
    document.body.classList.add("in-game");
    scoreText.textContent = gameState.score;
    gameMessage.textContent = gameState.gameOverReason ?? "Use your voice to steer the pickle. Avoid the obstacles and ceiling spikes.";
    drawGame(gameState);
  } else {
    game.classList.add("hidden");
    document.body.classList.remove("in-game");
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
    if (calibration) {
      socket.send(JSON.stringify({ type: "micReady" }));
      calibrateButton.classList.remove("hidden");
      calibrateButton.textContent = "Recalibrate Microphone";
      calibrationInstructions.classList.remove("hidden");
      micStatus.classList.remove("hidden");
      micStatus.textContent = "Microphone calibrated";
      micStatus.classList.remove("pending");
    } else if (microphoneStream) {
      calibrateButton.classList.remove("hidden");
      calibrationInstructions.classList.remove("hidden");
      micStatus.textContent = "Needs calibration";
      micStatus.classList.add("pending");
      micStatus.classList.remove("hidden");
    }
    rejoinPrompt.classList.add("hidden");
    entry.classList.add("hidden");
    lobby.classList.remove("hidden");
    disconnectActions.classList.add("hidden");
    showStatus("");
    void joinVoice(room);
  });

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "state") {
      renderState(message.state, message.game);
    } else if (message.type === "gameOver") {
      gameMessage.textContent = `${message.reason} Final score: ${message.finalScore}.`;
    } else if (message.type === "error") {
      showStatus(message.message);
    }
  });

  socket.addEventListener("close", () => {
    void leaveVoice();
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

    const savedRaw = localStorage.getItem(savedRoomKey);
    if (savedRaw) {
      try {
        const saved = JSON.parse(savedRaw);
        saved.disconnectedAt = Date.now();
        localStorage.setItem(savedRoomKey, JSON.stringify(saved));
      } catch {}
    }
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
  void leaveVoice();
  setVoiceStatus("off");
  lobby.classList.add("hidden");
  entry.classList.remove("hidden");
  disconnectActions.classList.add("hidden");
  rejoinPrompt.classList.add("hidden");
  showStatus("Ready to join a new room.");
});

async function showRejoinPrompt() {
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

  if (room.disconnectedAt && Date.now() - room.disconnectedAt > 5 * 60 * 1000) {
    localStorage.removeItem(savedRoomKey);
    return;
  }

  try {
    const response = await fetch(
      `/api/rooms/${encodeURIComponent(room.roomCode)}/state`,
    );
    if (!response.ok) {
      localStorage.removeItem(savedRoomKey);
      return;
    }
  } catch {
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

startButton.addEventListener("click", () => {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "startGame" }));
  }
});

calibrateButton.addEventListener("click", calibrateMicrophone);

restartButton.addEventListener("click", () => {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "restartGame" }));
  }
});

showRejoinPrompt();
