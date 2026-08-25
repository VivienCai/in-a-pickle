export type RoomStatus = "lobby" | "playing" | "finished";

export interface Player {
  id: string;
  name: string;
  isHost: boolean;
}

export interface RoomState {
  roomCode: string;
  status: RoomStatus;
  players: Player[];
}

export type ClientMessage =
  | { type: "ping" }
  | { type: "getState" };

export type ServerMessage =
  | { type: "state"; state: RoomState }
  | { type: "pong" }
  | { type: "error"; message: string };
