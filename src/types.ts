export type RoomStatus = "lobby" | "recording" | "playing" | "finished";

export interface Player {
  id: string;
  name: string;
  isHost: boolean;
  micReady: boolean;
  speaking: boolean;
  recordingReady: boolean;
  hasDeathClip: boolean;
  hasTriumphClip: boolean;
}

export interface RoomState {
  roomCode: string;
  status: RoomStatus;
  recordingStage: "death" | "triumph" | null;
  soundsReady: boolean;
  stageSoundsReady: boolean;
  recordingsSubmitted: boolean;
  hasDisconnectedPlayers: boolean;
  players: Player[];
}

export interface Obstacle {
  id: number;
  x: number;
  width: number;
  height: number;
  fromTop: boolean;
}

export interface VoiceQte {
  type: "quiet" | "steady";
  prompt: string;
  remainingTicks: number;
  totalTicks: number;
  successfulTicks: number;
}

export interface QteResult {
  success: boolean;
  message: string;
  remainingTicks: number;
}

export interface LiveGameState {
  tick: number;
  character: {
    x: number;
    y: number;
  };
  score: number;
  coins: number;
  averageVolume: number;
  levelSeed: number;
  obstacles: Obstacle[];
  gameOverReason: string | null;
  qte: VoiceQte | null;
  qteResult: QteResult | null;
  nextQteTick: number;
}

export type ClientMessage =
  | { type: "ping" }
  | { type: "getState" }
  | { type: "startGame" }
  | { type: "restartGame" }
  | { type: "micReady" }
  | { type: "micNotReady" }
  | { type: "reportVolume"; volume: number };

export type ServerMessage =
  | { type: "state"; state: RoomState; game: LiveGameState | null }
  | { type: "pong" }
  | { type: "error"; message: string }
  | { type: "gameOver"; finalScore: number; reason: string }
  | { type: "playSound"; url: string };
