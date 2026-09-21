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
const coinsText = document.querySelector("#coins");
const volumeMeter = document.querySelector("#volume-meter");
const volumePanel = document.querySelector("#volume-panel");
const gameMessage = document.querySelector("#game-message");
const restartButton = document.querySelector("#restart-button");
const gameOverPanel = document.querySelector("#game-over-panel");
const finalScore = document.querySelector("#final-score");
const gameOverReason = document.querySelector("#game-over-reason");
const runAwards = document.querySelector("#run-awards");
const loudestAward = document.querySelector("#loudest-award");
const loudestPlayer = document.querySelector("#loudest-player");
const quietestAward = document.querySelector("#quietest-award");
const quietestPlayer = document.querySelector("#quietest-player");
const qtePanel = document.querySelector("#qte-panel");
const qteLabel = qtePanel.querySelector(".qte-label");
const qtePrompt = document.querySelector("#qte-prompt");
const qteProgress = document.querySelector("#qte-progress");
const micStatus = document.querySelector("#mic-status");
const voiceStatus = document.querySelector("#voice-status");
const voiceBar = document.querySelector("#voice-bar");
const recording = document.querySelector("#recording");
const recordingTitle = document.querySelector("#recording-title");
const recordingCopy = document.querySelector("#recording-copy");
const recordingProgress = document.querySelector("#recording-progress");
const recordButton = document.querySelector("#record-button");
const clipPreview = document.querySelector("#clip-preview");
const uploadClipButton = document.querySelector("#upload-clip-button");
const rerecordButton = document.querySelector("#rerecord-button");
const recordingPlayers = document.querySelector("#recording-players");
const recordingStartButton = document.querySelector("#recording-start-button");
const recordingUploadStatus = document.querySelector("#recording-upload-status");
const briefingPanel = document.querySelector("#briefing-panel");
const briefingReadyButton = document.querySelector("#briefing-ready-button");
const briefingStatus = document.querySelector("#briefing-status");
const gameRenderer = globalThis.PickleGameRenderer.create(gameCanvas);

let socket;
let socketGeneration = 0;
let heartbeatTimer = null;
let reconnectTimer = null;
const savedRoomKey = "in-a-pickle-room";
let audioContext;
let analyser;
let microphoneStream;
let volumeTimer;
let rawVolumeData;
let calibration = null;
let isCalibrating = false;
let voiceMeeting = null;
let voiceModeGeneration = 0;
let voiceParticipantListeners = null;
const remoteAudioElements = new Map();
const voicePills = new Map();
let latestState = null;
let recordingVoiceMode = null;
let mediaRecorder = null;
let recordingStream = null;
let recordingAudioStream = null;
let recordingCanvas = null;
let recordingVideoTimer = null;
let recordingTimer = null;
let recordingStartedAt = 0;
let recordedChunks = [];
let recordedClip = null;
const recordedClips = new Map();
const recordingSteps = [
  {
    stage: "death",
    prompt: "What sound do you make when you stub your toe on a sharp corner?",
  },
  {
    stage: "start",
    prompt: "What do you say when you're about to go on an 8-hour road trip with your family?",
  },
  {
    stage: "coin",
    prompt: "You just found a shiny coin. What sound do you make?",
  },
];
let previewUrl = null;
let activeRecordingStage = null;
let recordingGeneration = 0;
let uploadingClips = false;

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
  voiceModeGeneration += 1;
  if (voiceParticipantListeners) {
    meeting.participants.joined.off("participantJoined", voiceParticipantListeners.joined);
    meeting.participants.joined.off("participantLeft", voiceParticipantListeners.left);
    meeting.participants.joined.off("audioUpdate", voiceParticipantListeners.audio);
    voiceParticipantListeners = null;
  }
  for (const audio of remoteAudioElements.values()) {
    audio.remove();
  }
  remoteAudioElements.clear();
  try {
    await meeting.leave();
  } catch {
    // The media connection may already be closed.
  }
}

async function joinVoice(room, allowTokenRefresh = true) {
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
      defaults: { audio: false, video: false },
    });
    await meeting.join();
    voiceMeeting = meeting;
    recordingVoiceMode = null;
    setupRemoteAudio(meeting);
    setVoiceStatus("connected");
    if (latestState) {
      syncRecordingVoice(latestState);
    }
  } catch (error) {
    console.error("RealtimeKit voice connection failed:", error);
    if (allowTokenRefresh && room.voiceToken) {
      delete room.voiceToken;
      localStorage.setItem(savedRoomKey, JSON.stringify(room));
      await joinVoice(room, false);
      return;
    }
    setVoiceStatus("unavailable");
  }
}

function removeRemoteAudio(participantId) {
  const audio = remoteAudioElements.get(participantId);
  if (audio) {
    audio.remove();
    remoteAudioElements.delete(participantId);
  }
}

function syncRemoteAudio(participant, update = {}) {
  const participantId = participant.id ?? participant.peerId;
  const audioEnabled = update.audioEnabled ?? participant.audioEnabled;
  const audioTrack = update.audioTrack ?? participant.audioTrack;
  if (!participantId || !audioEnabled || !audioTrack) {
    removeRemoteAudio(participantId);
    return;
  }

  let audio = remoteAudioElements.get(participantId);
  if (!audio) {
    audio = document.createElement("audio");
    audio.autoplay = true;
    audio.playsInline = true;
    audio.hidden = true;
    document.body.append(audio);
    remoteAudioElements.set(participantId, audio);
  }

  const currentTrack = audio.srcObject?.getAudioTracks()[0];
  if (currentTrack?.id !== audioTrack.id) {
    audio.srcObject = new MediaStream([audioTrack]);
  }
  audio.muted = recordingVoiceMode !== "open" || isCalibrating;
  if (!audio.muted) {
    void audio.play().catch(() => setVoiceStatus("tap the page to hear players"));
  }
}

function setupRemoteAudio(meeting) {
  const joined = (participant) => syncRemoteAudio(participant);
  const left = (participant) => removeRemoteAudio(participant.id ?? participant.peerId);
  const audio = (participant, update) => syncRemoteAudio(participant, update);
  voiceParticipantListeners = { joined, left, audio };
  meeting.participants.joined.on("participantJoined", joined);
  meeting.participants.joined.on("participantLeft", left);
  meeting.participants.joined.on("audioUpdate", audio);
  for (const participant of meeting.participants.joined.toArray()) {
    syncRemoteAudio(participant);
  }
}

function setRemoteAudioMuted(muted) {
  for (const audio of remoteAudioElements.values()) {
    audio.muted = muted;
    if (!muted) {
      void audio.play().catch(() => setVoiceStatus("tap the page to hear players"));
    }
  }
}

async function syncRecordingVoice(state) {
  const savedRoom = JSON.parse(localStorage.getItem(savedRoomKey) ?? "null");
  const currentPlayer = state.players.find((player) => player.id === savedRoom?.playerId);
  const finishedLocalRecordings = recordedClips.size === recordingSteps.length;
  const mode = isCalibrating
    ? "calibrating"
    : state.status === "recording" && !currentPlayer?.recordingReady && !finishedLocalRecordings
      ? "isolated"
      : "open";
  if (!voiceMeeting || recordingVoiceMode === mode) {
    return;
  }

  const meeting = voiceMeeting;
  const generation = ++voiceModeGeneration;
  setRemoteAudioMuted(mode !== "open");
  try {
    if (mode === "open") {
      await meeting.self.enableAudio();
    } else {
      await meeting.self.disableAudio();
    }
    if (generation !== voiceModeGeneration || meeting !== voiceMeeting) {
      return;
    }

    recordingVoiceMode = mode;
    if (mode === "calibrating") {
      setVoiceStatus("calibrating privately");
    } else if (mode === "isolated") {
      setVoiceStatus("recording privately");
    } else {
      setVoiceStatus("connected");
    }
  } catch (error) {
    if (generation === voiceModeGeneration) {
      recordingVoiceMode = null;
    }
    console.error("Could not update recording-round voice state:", error);
  }
}

document.addEventListener("click", () => {
  if (recordingVoiceMode === "open" && !isCalibrating) {
    setRemoteAudioMuted(false);
  }
});

function resetClipPreview() {
  if (previewUrl) {
    URL.revokeObjectURL(previewUrl);
    previewUrl = null;
  }
  recordedClip = null;
  clipPreview.removeAttribute("src");
  clipPreview.classList.add("hidden");
  uploadClipButton.classList.add("hidden");
  uploadClipButton.disabled = false;
  uploadClipButton.textContent = activeRecordingStage === "coin"
    ? "Upload All Sounds"
    : "Keep Sound & Continue";
  rerecordButton.classList.add("hidden");
  rerecordButton.disabled = false;
  recordButton.classList.remove("hidden", "recording");
  recordButton.disabled = false;
  recordButton.textContent = "Start recording";
}

function stopClipRecording() {
  if (mediaRecorder?.state === "recording") {
    mediaRecorder.stop();
  }
}

function cancelClipRecording() {
  if (mediaRecorder?.state !== "recording") {
    return;
  }

  recordingGeneration += 1;
  mediaRecorder.stop();
  clearInterval(recordingTimer);
  recordingTimer = null;
  recordingProgress.classList.add("hidden");
}

async function startClipRecording() {
  if (mediaRecorder?.state === "recording") {
    return;
  }

  resetClipPreview();
  recordButton.disabled = true;
  recordButton.textContent = "Starting microphone...";
  try {
    if (typeof MediaRecorder === "undefined") {
      throw new Error("This browser does not support microphone recording.");
    }

    const gameplayTrack = microphoneStream?.getAudioTracks()
      .find((track) => track.readyState === "live");
    recordingAudioStream = gameplayTrack
      ? new MediaStream([gameplayTrack.clone()])
      : await navigator.mediaDevices.getUserMedia({ audio: true });
    recordingCanvas = document.createElement("canvas");
    recordingCanvas.width = 160;
    recordingCanvas.height = 90;
    const recordingContext = recordingCanvas.getContext("2d");
    let videoFrame = 0;
    const drawRecordingFrame = () => {
      if (!recordingContext) {
        return;
      }
      recordingContext.fillStyle = videoFrame % 2 === 0 ? "#4b842f" : "#526141";
      recordingContext.fillRect(0, 0, recordingCanvas.width, recordingCanvas.height);
      recordingContext.fillStyle = "#fff8df";
      recordingContext.fillRect(16 + (videoFrame % 8) * 16, 34, 16, 22);
      videoFrame += 1;
    };
    drawRecordingFrame();
    recordingVideoTimer = setInterval(drawRecordingFrame, 150);
    if (typeof recordingCanvas.captureStream !== "function") {
      throw new Error("This browser cannot create a compatible recording.");
    }
    const videoStream = recordingCanvas.captureStream(5);
    recordingStream = new MediaStream([
      ...videoStream.getVideoTracks(),
      ...recordingAudioStream.getAudioTracks(),
    ]);
    recordedChunks = [];
    const mimeType = [
      "video/webm;codecs=vp8,opus",
      "video/webm;codecs=vp9,opus",
      "video/webm",
      "video/mp4;codecs=avc1,mp4a.40.2",
      "video/mp4",
    ].find((type) => MediaRecorder.isTypeSupported(type));
    const currentRecordingGeneration = ++recordingGeneration;
    const recorder = mimeType
      ? new MediaRecorder(recordingStream, { mimeType })
      : new MediaRecorder(recordingStream);
    mediaRecorder = recorder;
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) {
        recordedChunks.push(event.data);
      }
    });
    recorder.addEventListener("stop", () => {
      clearInterval(recordingTimer);
      recordingTimer = null;
      clearInterval(recordingVideoTimer);
      recordingVideoTimer = null;
      recordingStream?.getTracks().forEach((track) => track.stop());
      recordingStream = null;
      recordingAudioStream = null;
      recordingCanvas = null;
      recordButton.classList.remove("recording");
      recordingProgress.classList.add("hidden");

      if (currentRecordingGeneration !== recordingGeneration) {
        recordedChunks = [];
        return;
      }

      recordButton.classList.add("hidden");

      recordedClip = new Blob(recordedChunks, { type: recorder.mimeType || "audio/webm" });
      if (recordedClip.size === 0) {
        recordingCopy.textContent = "That recording was empty. Try again.";
        recordButton.classList.remove("hidden");
        recordButton.textContent = "Try recording again";
        return;
      }

      previewUrl = URL.createObjectURL(recordedClip);
      clipPreview.src = previewUrl;
      clipPreview.classList.remove("hidden");
      uploadClipButton.classList.remove("hidden");
      rerecordButton.classList.remove("hidden");
      recordingCopy.textContent = "Listen to it, then keep it or record it again.";
    });
    recorder.start();
    recordingStartedAt = Date.now();
    recordingProgress.classList.remove("hidden");
    recordingProgress.value = 0;
    recordButton.classList.add("hidden");
    recordButton.disabled = false;
    recordingCopy.textContent = "Recording... you have three seconds.";
    recordingTimer = setInterval(() => {
      const elapsedSeconds = (Date.now() - recordingStartedAt) / 1000;
      recordingProgress.value = Math.min(3, elapsedSeconds);
      if (elapsedSeconds >= 3) {
        stopClipRecording();
      }
    }, 50);
  } catch (error) {
    console.error("Could not start sound recording:", error);
    recordingStream?.getTracks().forEach((track) => track.stop());
    recordingAudioStream?.getTracks().forEach((track) => track.stop());
    clearInterval(recordingVideoTimer);
    recordingVideoTimer = null;
    recordingStream = null;
    recordingAudioStream = null;
    recordingCanvas = null;
    recordButton.classList.remove("hidden");
    recordButton.disabled = false;
    recordButton.textContent = "Try recording again";
    recordingCopy.textContent = error instanceof Error
      ? error.message
      : "Microphone access is needed to record your sound.";
  }
}

function showRecordingStep(stage) {
  cancelClipRecording();
  activeRecordingStage = stage;
  resetClipPreview();
  const stepIndex = recordingSteps.findIndex((step) => step.stage === stage);
  recordingTitle.textContent = `Recording Booth (${stepIndex + 1} of ${recordingSteps.length})`;
  recordingCopy.textContent = recordingSteps[stepIndex]?.prompt ?? "Record your sound.";
  recordingProgress.value = 0;
  recordingTitle.classList.remove("hidden");
  recordingCopy.classList.remove("hidden");
}

async function uploadClips() {
  if (recordedClips.size !== recordingSteps.length) {
    return;
  }

  const room = JSON.parse(localStorage.getItem(savedRoomKey) ?? "null");
  if (!room?.roomCode || !room?.playerId) {
    return;
  }

  uploadingClips = true;
  uploadClipButton.disabled = true;
  uploadClipButton.textContent = "Uploading All Sounds...";
  rerecordButton.disabled = true;
  recordingCopy.textContent = "Sit tight, uploading all three sounds to Stream...";
  try {
    const form = new FormData();
    for (const { stage } of recordingSteps) {
      const clip = recordedClips.get(stage);
      const extension = clip.type.includes("mp4") ? "mp4" : "webm";
      form.append(stage, clip, `${stage}.${extension}`);
    }
    const response = await fetch(
      `/api/rooms/${encodeURIComponent(room.roomCode)}/sfx?playerId=${encodeURIComponent(room.playerId)}`,
      {
        method: "POST",
        body: form,
      },
    );
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error ?? "Could not save your sound.");
    }
    recordingCopy.textContent = "All three sounds uploaded. Stream is finishing them now.";
    uploadClipButton.textContent = "Sounds Uploaded";
  } catch (error) {
    recordingCopy.textContent = error.message ?? "Could not save your sounds.";
    uploadClipButton.disabled = false;
    uploadClipButton.textContent = "Try Uploading All Sounds Again";
    rerecordButton.disabled = false;
  } finally {
    uploadingClips = false;
  }
}

function keepRecordedClip() {
  if (!recordedClip || !activeRecordingStage) {
    return;
  }

  recordedClips.set(activeRecordingStage, recordedClip);
  const currentIndex = recordingSteps.findIndex((step) => step.stage === activeRecordingStage);
  const nextStep = recordingSteps[currentIndex + 1];
  if (nextStep) {
    showRecordingStep(nextStep.stage);
    return;
  }

  if (latestState) {
    void syncRecordingVoice(latestState);
  }
  void uploadClips();
}

function playSound(url) {
  const sound = new Audio(url);
  sound.volume = 0.85;
  void sound.play().catch(() => { });
}

function updateVoiceBar(players) {
  const currentIds = new Set(players.map((player) => player.id));
  const savedRoom = JSON.parse(localStorage.getItem(savedRoomKey) ?? "null");

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
      const name = document.createElement("span");
      name.className = "voice-name";
      pill.append(name);
      voiceBar.append(pill);
      voicePills.set(player.id, pill);
    }

    const label = `${player.name}${player.isHost ? " · host" : ""}`;
    pill.querySelector(".voice-name").textContent = label;
    pill.classList.toggle("you", player.id === savedRoom?.playerId);
    pill.classList.toggle("speaking", player.speaking);
    pill.setAttribute("aria-label", `${label}${player.speaking ? ", speaking" : ""}`);
  }
}

async function startVolumeMonitoring() {
  if (microphoneStream?.getAudioTracks().some((track) => track.readyState === "live")) {
    return;
  }

  try {
    if (volumeTimer) {
      clearInterval(volumeTimer);
    }
    if (audioContext) {
      await audioContext.close();
    }
    microphoneStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioContext = new AudioContext();
    await audioContext.resume();
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.2;
    audioContext.createMediaStreamSource(microphoneStream).connect(analyser);
    rawVolumeData = new Uint8Array(analyser.fftSize);

    volumeTimer = setInterval(() => {
      if (!socket || socket.readyState !== WebSocket.OPEN || isCalibrating) {
        return;
      }

      const rawVolume = readRawVolume();
      const volume = calibration ? normalizeVolume(rawVolume) : rawVolume;
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
  isCalibrating = true;
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "micNotReady" }));
    socket.send(JSON.stringify({ type: "reportVolume", volume: 0 }));
  }
  calibrateButton.disabled = true;
  if (latestState) {
    await syncRecordingVoice(latestState);
  }
  try {
    calibrationInstructions.textContent = "Stay quiet for a moment...";
    const quietSamples = await collectVolumeSamples(1500);

    calibrationInstructions.textContent = "Now make the loudest sound you can!";
    await wait(500);
    const loudSamples = await collectVolumeSamples(1800);

    const noiseFloor = percentile(quietSamples, 0.8);
    const loudLevel = percentile(loudSamples, 0.9);
    if (loudLevel - noiseFloor < 0.03) {
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
  } finally {
    isCalibrating = false;
    calibrateButton.disabled = false;
    if (latestState) {
      await syncRecordingVoice(latestState);
    }
  }
}

function renderState(state, gameState) {
  latestState = state;
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
  syncRecordingVoice(state);
  startButton.classList.toggle("hidden", state.status !== "lobby" || !currentPlayer?.isHost);
  startButton.disabled = state.hasDisconnectedPlayers;
  startButton.textContent = state.hasDisconnectedPlayers ? "Waiting for Player" : "Let's Start!";
  restartButton.classList.toggle("hidden", state.status !== "finished" || !currentPlayer?.isHost);
  const showBriefing = state.status === "briefing";

  recordingPlayers.replaceChildren();
  for (const player of state.players) {
    const item = document.createElement("li");
    item.className = "player-row";
    item.classList.toggle("speaking", player.recordingReady && player.speaking);
    const name = document.createElement("span");
    name.textContent = `${player.name}${player.id === currentPlayer?.id ? " (you)" : ""}`;
    const readiness = document.createElement("span");
    const playerReady = showBriefing ? player.briefingReady : player.recordingReady;
    readiness.className = playerReady ? "mic-status ready" : "mic-status waiting";
    readiness.textContent = playerReady ? "READY" : showBriefing ? "READING" : "RECORDING";
    item.append(name, readiness);
    recordingPlayers.append(item);
  }

  const inRecordingRound = state.status === "recording";
  const inStaging = inRecordingRound || showBriefing;
  recording.classList.toggle("hidden", !inStaging);
  if (inStaging) {
    lobby.classList.add("hidden");
    game.classList.add("hidden");
    document.body.classList.remove("in-game");
    const isReady = currentPlayer?.recordingReady;
    const everyoneSubmitted = state.recordingsSubmitted;
    const completedAllRecordings = isReady;
    const processingSounds = inRecordingRound && everyoneSubmitted && !state.stageSoundsReady;
    const waitingForReconnect = state.hasDisconnectedPlayers;
    briefingPanel.classList.toggle("hidden", !showBriefing);
    briefingReadyButton.disabled = Boolean(currentPlayer?.briefingReady);
    briefingReadyButton.textContent = currentPlayer?.briefingReady ? "Ready!" : "I'm Ready";
    briefingStatus.textContent = currentPlayer?.briefingReady
      ? state.briefingComplete
        ? "Everyone is ready. The host can start the run."
        : "You're ready. Waiting for the rest of the team..."
      : "Read all four, then ready up.";
    recordingTitle.classList.toggle("hidden", completedAllRecordings);
    recordingCopy.classList.toggle("hidden", completedAllRecordings);
    recordingUploadStatus.classList.toggle("hidden", !processingSounds && !waitingForReconnect);
    recordingUploadStatus.textContent = waitingForReconnect
      ? "Waiting for a disconnected player to rejoin..."
      : processingSounds
        ? "Sit tight, uploading to Stream..."
        : "";
    const canStartInstructions = inRecordingRound && state.soundsReady;
    const showFinalStart = currentPlayer?.isHost && !waitingForReconnect && (canStartInstructions || showBriefing);
    recordingStartButton.classList.toggle("hidden", !showFinalStart);
    recordingStartButton.disabled = showBriefing && !state.briefingComplete;
    recordingStartButton.textContent = canStartInstructions
      ? "Start Instructions"
      : state.briefingComplete
        ? "Start Run"
        : "Waiting for Everyone...";
    if (inRecordingRound && !activeRecordingStage && !isReady) {
      recordedClips.clear();
      showRecordingStep("death");
    }
    if (showBriefing || isReady) {
      recordButton.classList.add("hidden");
      uploadClipButton.classList.add("hidden");
      rerecordButton.classList.add("hidden");
      recordingTitle.classList.add("hidden");
      recordingCopy.classList.add("hidden");
      recordingProgress.classList.add("hidden");
      clipPreview.classList.add("hidden");
    } else if (recordedClips.size === recordingSteps.length && !uploadingClips) {
      uploadClipButton.classList.remove("hidden");
      uploadClipButton.disabled = false;
      uploadClipButton.textContent = "Upload All Sounds";
      rerecordButton.classList.remove("hidden");
    } else if (!recordedClip && mediaRecorder?.state !== "recording") {
      recordButton.classList.remove("hidden");
    }
  }

  if (gameState && (state.status === "playing" || state.status === "finished")) {
    recording.classList.add("hidden");
    lobby.classList.add("hidden");
    game.classList.remove("hidden");
    document.body.classList.add("in-game");
    scoreText.textContent = gameState.score;
    coinsText.textContent = gameState.coins ?? 0;
    finalScore.textContent = gameState.score;
    gameOverReason.textContent = gameState.gameOverReason ?? "";
    gameOverPanel.classList.toggle("hidden", state.status !== "finished");
    const awards = gameState.awards ?? {};
    loudestPlayer.textContent = awards.loudestPlayer ?? "";
    quietestPlayer.textContent = awards.quietestPlayer ?? "";
    loudestAward.classList.toggle("hidden", !awards.loudestPlayer);
    quietestAward.classList.toggle("hidden", !awards.quietestPlayer);
    runAwards.classList.toggle("hidden", !awards.loudestPlayer && !awards.quietestPlayer);
    const teamVolume = gameState.averageVolume;
    volumeMeter.value = teamVolume;
    volumePanel.classList.toggle("quiet", teamVolume < 0.15);
    volumePanel.classList.toggle("danger", teamVolume > 0.8);
    const activeQte = state.status === "playing" ? gameState.qte : null;
    const qteResult = state.status === "playing" ? gameState.qteResult : null;
    qtePanel.classList.toggle("hidden", !activeQte && !qteResult);
    qtePanel.classList.toggle("success", Boolean(qteResult?.success));
    qtePanel.classList.toggle("failure", Boolean(qteResult && !qteResult.success));
    if (activeQte) {
      qteLabel.textContent = activeQte.type === "solo" ? "Solo challenge" : "Quick challenge";
      qtePrompt.textContent = activeQte.prompt;
      qteProgress.classList.remove("hidden");
      qteProgress.max = activeQte.totalTicks;
      qteProgress.value = activeQte.totalTicks - activeQte.remainingTicks;
    } else if (qteResult) {
      qteLabel.textContent = qteResult.success ? "Challenge cleared" : "Challenge missed";
      qtePrompt.textContent = qteResult.message;
      qteProgress.classList.add("hidden");
    }
    gameMessage.textContent = gameState.gameOverReason ?? "Use your voice to steer the pickle. Avoid floor clutter, flying utensils, and ceiling spikes. QTEs are optional; complete them to earn coins.";
    gameRenderer.setState(gameState);
  } else {
    if (!inStaging && activeRecordingStage) {
      cancelClipRecording();
    }
    game.classList.add("hidden");
    document.body.classList.remove("in-game");
    if (!inStaging) {
      activeRecordingStage = null;
      recordedClips.clear();
      uploadingClips = false;
      recordingStartButton.classList.add("hidden");
      recording.classList.add("hidden");
      lobby.classList.remove("hidden");
    }
  }
}

function connectToRoom(room, reconnectAttempt = 0) {
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  localStorage.setItem(savedRoomKey, JSON.stringify(room));
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${protocol}//${location.host}/ws?roomCode=${encodeURIComponent(room.roomCode)}&playerId=${encodeURIComponent(room.playerId)}`;
  const connectionGeneration = ++socketGeneration;
  const roomSocket = new WebSocket(url);
  socket = roomSocket;
  let connected = false;

  roomSocket.addEventListener("open", () => {
    if (connectionGeneration !== socketGeneration) {
      roomSocket.close();
      return;
    }
    connected = true;
    reconnectAttempt = 0;
    const savedRoom = JSON.parse(localStorage.getItem(savedRoomKey) ?? "null");
    if (savedRoom) {
      delete savedRoom.disconnectedAt;
      savedRoom.lastConnectedAt = Date.now();
      localStorage.setItem(savedRoomKey, JSON.stringify(savedRoom));
    }
    if (calibration) {
      roomSocket.send(JSON.stringify({ type: "micReady" }));
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
    roomSocket.send(JSON.stringify({ type: "ping" }));
    heartbeatTimer = setInterval(() => {
      if (roomSocket.readyState === WebSocket.OPEN) {
        roomSocket.send(JSON.stringify({ type: "ping" }));
      }
    }, 30_000);
    void startVolumeMonitoring();
    void joinVoice(room);
  });

  roomSocket.addEventListener("message", (event) => {
    if (connectionGeneration !== socketGeneration) {
      return;
    }
    const message = JSON.parse(event.data);
    if (message.type === "state") {
      renderState(message.state, message.game);
    } else if (message.type === "gameOver") {
      gameMessage.textContent = `${message.reason} Final score: ${message.finalScore}.`;
      finalScore.textContent = message.finalScore;
      gameOverReason.textContent = message.reason;
    } else if (message.type === "playSound") {
      playSound(message.url);
    } else if (message.type === "error") {
      if (message.resetRecordings) {
        recordedClips.clear();
        activeRecordingStage = null;
        resetClipPreview();
      }
      showStatus(message.message);
    }
  });

  roomSocket.addEventListener("close", (event) => {
    if (connectionGeneration !== socketGeneration) {
      return;
    }
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;

    const cannotReconnect = event.reason === "Reconnected in another tab" || event.reason === "Rejoin window expired";
    if (!cannotReconnect && reconnectAttempt < 4) {
      const delay = Math.min(4_000, 750 * (reconnectAttempt + 1));
      showStatus("Connection interrupted. Reconnecting...");
      reconnectTimer = setTimeout(() => {
        connectToRoom(room, reconnectAttempt + 1);
      }, delay);
      return;
    }

    void leaveVoice();
    cancelClipRecording();
    recording.classList.add("hidden");
    game.classList.add("hidden");
    document.body.classList.remove("in-game");
    entry.classList.add("hidden");
    lobby.classList.remove("hidden");
    disconnectActions.classList.remove("hidden");
    rejoinButton.textContent = `Rejoin Room ${room.roomCode}`;
    showStatus(connected
      ? "Connection lost. You can rejoin for the next five minutes."
      : `Could not connect to Room ${room.roomCode}. Try rejoining.`);

    const savedRaw = localStorage.getItem(savedRoomKey);
    if (savedRaw) {
      try {
        const saved = JSON.parse(savedRaw);
        saved.disconnectedAt = Date.now();
        localStorage.setItem(savedRoomKey, JSON.stringify(saved));
      } catch { }
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
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  socketGeneration += 1;
  const previousSocket = socket;
  socket = undefined;
  previousSocket?.close();

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

  try {
    const response = await fetch(
      `/api/rooms/${encodeURIComponent(room.roomCode)}/rejoin?playerId=${encodeURIComponent(room.playerId)}`,
    );
    if (!response.ok) {
      if (response.status >= 400 && response.status < 500) {
        localStorage.removeItem(savedRoomKey);
        rejoinPrompt.classList.add("hidden");
      }
      return;
    }
    const result = await response.json();
    if (!result.canRejoin) {
      localStorage.removeItem(savedRoomKey);
      rejoinPrompt.classList.add("hidden");
      return;
    }
    rejoinCodeText.textContent = room.roomCode;
    rejoinYesButton.textContent = `Rejoin Room ${room.roomCode}`;
    rejoinPrompt.classList.remove("hidden");
  } catch {
    // A temporary network failure should not offer an unverified stale room.
    return;
  }
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
recordButton.addEventListener("click", startClipRecording);
rerecordButton.addEventListener("click", () => {
  recordedClips.delete(activeRecordingStage);
  if (latestState) {
    void syncRecordingVoice(latestState);
  }
  resetClipPreview();
  recordingProgress.value = 0;
  recordingCopy.textContent = recordingSteps.find(
    (step) => step.stage === activeRecordingStage,
  )?.prompt ?? "Record your sound.";
});
uploadClipButton.addEventListener("click", keepRecordedClip);
briefingReadyButton.addEventListener("click", () => {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "briefingReady" }));
  }
});
recordingStartButton.addEventListener("click", () => {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "startGame" }));
  }
});

restartButton.addEventListener("click", () => {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "restartGame" }));
  }
});

showRejoinPrompt();
