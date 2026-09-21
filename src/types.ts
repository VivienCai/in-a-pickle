export type RoomStatus = "lobby" | "recording" | "briefing" | "playing" | "finished";

export interface Player {
  id: string;
  name: string;
  isHost: boolean;
  micReady: boolean;
  speaking: boolean;
  recordingReady: boolean;
  briefingReady: boolean;
  hasDeathClip: boolean;
  hasStartClip: boolean;
  hasCoinClip: boolean;
}

export interface RoomState {
  roomCode: string;
  status: RoomStatus;
  recordingStage: "sounds" | null;
  soundsReady: boolean;
  stageSoundsReady: boolean;
  recordingsSubmitted: boolean;
  briefingComplete: boolean;
  hasDisconnectedPlayers: boolean;
  players: Player[];
}

export interface Obstacle {
  id: number;
  kind: "floor" | "utensil";
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VoiceQte {
  type: "quiet" | "steady" | "solo";
  prompt: string;
  targetPlayerId: string | null;
  targetPlayerName: string | null;
  remainingTicks: number;
  totalTicks: number;
  successfulTicks: number;
}

export interface QteResult {
  success: boolean;
  message: string;
  remainingTicks: number;
}

export interface RunAwards {
  loudestPlayer: string | null;
  quietestPlayer: string | null;
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
  awards: RunAwards;
  qte: VoiceQte | null;
  qteResult: QteResult | null;
  nextQteTick: number;
}

export type ClientMessage =
  | { type: "ping" }
  | { type: "getState" }
  | { type: "startGame" }
  | { type: "restartGame" }
  | { type: "briefingReady" }
  | { type: "micReady" }
  | { type: "micNotReady" }
  | { type: "reportVolume"; volume: number };

export type ServerMessage =
  | { type: "state"; state: RoomState; game: LiveGameState | null }
  | { type: "pong" }
  | { type: "error"; message: string; resetRecordings?: boolean }
  | { type: "gameOver"; finalScore: number; reason: string }
  | { type: "playSound"; url: string };
