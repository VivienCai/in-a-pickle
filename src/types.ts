export type RoomStatus = "lobby" | "playing" | "finished";

export interface Player {
  id: string;
  name: string;
  isHost: boolean;
  micReady: boolean;
  speaking: boolean;
}

export interface RoomState {
  roomCode: string;
  status: RoomStatus;
  players: Player[];
}

export interface Obstacle {
  id: number;
  x: number;
  width: number;
  height: number;
  fromTop: boolean;
}

export interface LiveGameState {
  tick: number;
  character: {
    x: number;
    y: number;
  };
  score: number;
  averageVolume: number;
  levelSeed: number;
  obstacles: Obstacle[];
  gameOverReason: string | null;
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
  | { type: "gameOver"; finalScore: number; reason: string };
