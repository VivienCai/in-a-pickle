import { DurableObject } from "cloudflare:workers";
import type { ClientMessage, Player, RoomState, ServerMessage } from "./types";

interface Env {
  GAME_ROOMS: DurableObjectNamespace;
  ASSETS: Fetcher;
}

interface StoredPlayer {
  id: string;
  room_code: string;
  name: string;
  is_host: number;
  connected: number;
  last_seen_at: number;
}

interface RoomRow {
  code: string;
  status: RoomState["status"];
}

const RECONNECT_GRACE_MS = 5 * 60 * 1000;

export class GameRoom extends DurableObject {
  private readonly sockets = new Map<WebSocket, string>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS rooms (
        code TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'lobby',
        created_at INTEGER NOT NULL
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS players (
        id TEXT PRIMARY KEY,
        room_code TEXT NOT NULL,
        name TEXT NOT NULL,
        is_host INTEGER NOT NULL DEFAULT 0,
        joined_at INTEGER NOT NULL,
        connected INTEGER NOT NULL DEFAULT 0,
        last_seen_at INTEGER NOT NULL DEFAULT 0
      )
    `);
    this.ensurePlayerColumn("connected", "INTEGER NOT NULL DEFAULT 0");
    this.ensurePlayerColumn("last_seen_at", "INTEGER NOT NULL DEFAULT 0");
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/internal/create" && request.method === "POST") {
      return this.createRoom(request);
    }

    if (url.pathname === "/internal/join" && request.method === "POST") {
      return this.joinRoom(request);
    }

    if (url.pathname === "/internal/state" && request.method === "GET") {
      const state = this.getState();
      if (!state.roomCode) {
        return Response.json({ error: "Room does not exist." }, { status: 404 });
      }

      return Response.json(state);
    }

    if (url.pathname === "/ws" && request.headers.get("Upgrade") === "websocket") {
      return this.connectWebSocket(request);
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  }

  private async createRoom(request: Request): Promise<Response> {
    const body = (await request.json()) as { roomCode?: string; name?: string };
    const roomCode = body.roomCode?.toUpperCase();
    const name = body.name?.trim();

    if (!roomCode || !name) {
      return Response.json({ error: "Room code and name are required." }, { status: 400 });
    }

    const existing = this.ctx.storage.sql.exec("SELECT code FROM rooms WHERE code = ?", roomCode).toArray();
    if (existing.length > 0) {
      return Response.json({ error: "Room already exists." }, { status: 409 });
    }

    const now = Date.now();
    const playerId = crypto.randomUUID();
    this.ctx.storage.sql.exec("INSERT INTO rooms (code, status, created_at) VALUES (?, 'lobby', ?)", roomCode, now);
    this.ctx.storage.sql.exec(
      "INSERT INTO players (id, room_code, name, is_host, joined_at) VALUES (?, ?, ?, 1, ?)",
      playerId,
      roomCode,
      name,
      now,
    );

    return Response.json({ roomCode, playerId, isHost: true });
  }

  private async joinRoom(request: Request): Promise<Response> {
    const body = (await request.json()) as { roomCode?: string; name?: string };
    const roomCode = body.roomCode?.toUpperCase();
    const name = body.name?.trim();

    if (!roomCode || !name) {
      return Response.json({ error: "Room code and name are required." }, { status: 400 });
    }

    const room = this.ctx.storage.sql.exec("SELECT code, status FROM rooms WHERE code = ?", roomCode).toArray();
    if (room.length === 0) {
      return Response.json({ error: "Room does not exist." }, { status: 404 });
    }

    const playerCount = this.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM players WHERE room_code = ?", roomCode).toArray() as Array<{ count: number }>;
    if ((playerCount[0]?.count ?? 0) >= 8) {
      return Response.json({ error: "Room is full." }, { status: 409 });
    }

    const playerId = crypto.randomUUID();
    this.ctx.storage.sql.exec(
      "INSERT INTO players (id, room_code, name, is_host, joined_at, connected, last_seen_at) VALUES (?, ?, ?, 0, ?, 0, ?)",
      playerId,
      roomCode,
      name,
      Date.now(),
      Date.now(),
    );

    this.broadcastState();
    return Response.json({ roomCode, playerId, isHost: false });
  }

  private connectWebSocket(request: Request): Response {
    const url = new URL(request.url);
    const roomCode = url.searchParams.get("roomCode")?.toUpperCase();
    const playerId = url.searchParams.get("playerId");

    if (!roomCode || !playerId || !this.playerExists(roomCode, playerId)) {
      return Response.json({ error: "Invalid room or player." }, { status: 401 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    this.ctx.storage.sql.exec(
      "UPDATE players SET connected = 1, last_seen_at = ? WHERE id = ? AND room_code = ?",
      Date.now(),
      playerId,
      roomCode,
    );
    this.sockets.set(server, playerId);
    server.addEventListener("message", (event) => this.handleMessage(server, event.data));
    server.addEventListener("close", () => this.disconnectPlayer(server));
    server.addEventListener("error", () => this.disconnectPlayer(server));
    this.sendState(server);
    this.broadcastState();

    return new Response(null, { status: 101, webSocket: client });
  }

  private handleMessage(socket: WebSocket, rawMessage: string | ArrayBuffer): void {
    if (typeof rawMessage !== "string") {
      return;
    }

    try {
      const message = JSON.parse(rawMessage) as ClientMessage;
      if (message.type === "ping") {
        this.send(socket, { type: "pong" });
      } else if (message.type === "getState") {
        this.sendState(socket);
      }
    } catch {
      this.send(socket, { type: "error", message: "Invalid WebSocket message." });
    }
  }

  private getState(): RoomState {
    const roomRows = this.ctx.storage.sql.exec("SELECT code, status FROM rooms LIMIT 1").toArray() as unknown as RoomRow[];
    const playerRows = this.ctx.storage.sql.exec("SELECT id, name, is_host, connected, last_seen_at FROM players WHERE connected = 1 ORDER BY joined_at").toArray() as unknown as StoredPlayer[];

    return {
      roomCode: roomRows[0]?.code ?? "",
      status: roomRows[0]?.status ?? "lobby",
      players: playerRows.map((player): Player => ({
        id: player.id,
        name: player.name,
        isHost: player.is_host === 1,
      })),
    };
  }

  private playerExists(roomCode: string, playerId: string): boolean {
    const rows = this.ctx.storage.sql.exec("SELECT id FROM players WHERE id = ? AND room_code = ?", playerId, roomCode).toArray();
    return rows.length > 0;
  }

  private sendState(socket: WebSocket): void {
    this.send(socket, { type: "state", state: this.getState() });
  }

  private broadcastState(): void {
    for (const socket of this.sockets.keys()) {
      this.sendState(socket);
    }
  }

  async alarm(): Promise<void> {
    const cutoff = Date.now() - RECONNECT_GRACE_MS;
    this.ctx.storage.sql.exec(
      "DELETE FROM players WHERE connected = 0 AND last_seen_at <= ?",
      cutoff,
    );

    if (this.activePlayerCount() === 0) {
      this.closeRoom();
      return;
    }

    const disconnected = this.ctx.storage.sql.exec(
      "SELECT id FROM players WHERE connected = 0 AND last_seen_at > ?",
      cutoff,
    ).toArray();
    if (disconnected.length > 0) {
      this.ctx.storage.setAlarm(Date.now() + RECONNECT_GRACE_MS);
    }
  }

  private ensurePlayerColumn(name: string, definition: string): void {
    const columns = this.ctx.storage.sql.exec("PRAGMA table_info(players)").toArray() as unknown as Array<{ name: string }>;
    if (!columns.some((column) => column.name === name)) {
      this.ctx.storage.sql.exec(`ALTER TABLE players ADD COLUMN ${name} ${definition}`);
    }
  }

  private activePlayerCount(): number {
    const rows = this.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM players WHERE connected = 1").toArray() as unknown as Array<{ count: number }>;
    return rows[0]?.count ?? 0;
  }

  private closeRoom(): void {
    this.ctx.storage.sql.exec("DELETE FROM players");
    this.ctx.storage.sql.exec("DELETE FROM rooms");
    this.ctx.storage.deleteAlarm();
  }

  private disconnectPlayer(socket: WebSocket): void {
    const playerId = this.sockets.get(socket);
    if (!playerId) {
      return;
    }

    this.sockets.delete(socket);
    this.ctx.storage.sql.exec(
      "UPDATE players SET connected = 0, last_seen_at = ? WHERE id = ?",
      Date.now(),
      playerId,
    );
    this.reassignHostIfNeeded(playerId);

    if (this.activePlayerCount() === 0) {
      this.closeRoom();
      return;
    }

    this.ctx.storage.setAlarm(Date.now() + RECONNECT_GRACE_MS);
    this.broadcastState();
  }

  private reassignHostIfNeeded(leavingPlayerId: string): void {
    const connectedHosts = this.ctx.storage.sql
      .exec("SELECT id FROM players WHERE is_host = 1 AND connected = 1")
      .toArray();
    if (connectedHosts.length > 0) {
      return;
    }

    const candidates = this.ctx.storage.sql
      .exec("SELECT id FROM players WHERE connected = 1 AND id != ? ORDER BY RANDOM() LIMIT 1", leavingPlayerId)
      .toArray() as unknown as Array<{ id: string }>;
    const newHostId = candidates[0]?.id;
    if (!newHostId) {
      return;
    }

    this.ctx.storage.sql.exec("UPDATE players SET is_host = 0");
    this.ctx.storage.sql.exec("UPDATE players SET is_host = 1 WHERE id = ?", newHostId);
  }

  private send(socket: WebSocket, message: ServerMessage): void {
    try {
      socket.send(JSON.stringify(message));
    } catch {
      this.sockets.delete(socket);
    }
  }
}
