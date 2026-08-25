import { DurableObject } from "cloudflare:workers";
import { addParticipant, createMeeting } from "./realtimeKit";
import type {
  ClientMessage,
  LiveGameState,
  Obstacle,
  Player,
  RoomState,
  ServerMessage,
} from "./types";

interface Env {
  GAME_ROOMS: DurableObjectNamespace;
  ASSETS: Fetcher;
  CLOUDFLARE_ACCOUNT_ID: string;
  REALTIMEKIT_APP_ID: string;
  REALTIMEKIT_PRESET_NAME: string;
  CLOUDFLARE_API_TOKEN: string;
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

interface MeetingRow {
  meeting_id: string | null;
}

const RECONNECT_GRACE_MS = 5 * 60 * 1000;
const TICK_MS = 50;
const RUN_SPEED = 180;
const WORLD_HEIGHT = 350;
const PICKLE_HEIGHT = 48;
const CEILING_SPIKE_HEIGHT = 60;
const SPEAKING_VOLUME_THRESHOLD = 0.15;

export class GameRoom extends DurableObject<Env> {
  private readonly sockets = new Map<WebSocket, string>();
  private readonly micReady = new Set<string>();
  private readonly playerVolumes = new Map<string, { volume: number; lastReportedAt: number }>();
  private game: LiveGameState | null = null;
  private gameLoop: ReturnType<typeof setInterval> | null = null;
  private lastLobbyVoiceBroadcastAt = 0;
  private randomState = 1;
  private nextObstacleX = 500;
  private nextObstacleId = 1;

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
    this.ensureRoomColumn("meeting_id", "TEXT");
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

    if (url.pathname === "/internal/voice" && request.method === "GET") {
      return this.createVoiceToken(request);
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
    const meetingId = await createMeeting(this.env, roomCode);
    this.ctx.storage.sql.exec(
      "INSERT INTO rooms (code, status, created_at, meeting_id) VALUES (?, 'lobby', ?, ?)",
      roomCode,
      now,
      meetingId,
    );
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
      } else if (message.type === "startGame") {
        this.startGame(socket);
      } else if (message.type === "restartGame") {
        this.restartGame(socket);
      } else if (message.type === "micReady") {
        this.markMicReady(socket);
      } else if (message.type === "micNotReady") {
        this.clearMicReady(socket);
      } else if (message.type === "reportVolume") {
        this.reportVolume(socket, message.volume);
      }
    } catch {
      this.send(socket, { type: "error", message: "Invalid WebSocket message." });
    }
  }

  private getState(): RoomState {
    const roomRows = this.ctx.storage.sql.exec("SELECT code, status FROM rooms LIMIT 1").toArray() as unknown as RoomRow[];
    const playerRows = this.ctx.storage.sql.exec("SELECT id, name, is_host, connected, last_seen_at FROM players WHERE connected = 1 ORDER BY joined_at").toArray() as unknown as StoredPlayer[];
    const now = Date.now();

    return {
      roomCode: roomRows[0]?.code ?? "",
      status: roomRows[0]?.status ?? "lobby",
      players: playerRows.map((player): Player => ({
        id: player.id,
        name: player.name,
        isHost: player.is_host === 1,
        micReady: this.micReady.has(player.id),
        speaking: this.isSpeaking(player.id, now),
      })),
    };
  }

  private async createVoiceToken(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const roomCode = url.searchParams.get("roomCode")?.toUpperCase();
    const playerId = url.searchParams.get("playerId");

    if (!roomCode || !playerId || !this.playerExists(roomCode, playerId)) {
      return Response.json({ error: "Invalid room or player." }, { status: 401 });
    }

    const meetingRows = this.ctx.storage.sql
      .exec("SELECT meeting_id FROM rooms WHERE code = ?", roomCode)
      .toArray() as unknown as MeetingRow[];
    const meetingId = meetingRows[0]?.meeting_id;
    if (!meetingId) {
      return Response.json({ voiceToken: null });
    }

    const playerRows = this.ctx.storage.sql
      .exec("SELECT name FROM players WHERE id = ? AND room_code = ?", playerId, roomCode)
      .toArray() as unknown as Array<{ name: string }>;
    const name = playerRows[0]?.name;
    if (!name) {
      return Response.json({ error: "Player does not exist." }, { status: 404 });
    }

    const voiceToken = await addParticipant(this.env, meetingId, playerId, name);
    return Response.json({ voiceToken });
  }

  private playerExists(roomCode: string, playerId: string): boolean {
    const rows = this.ctx.storage.sql.exec("SELECT id FROM players WHERE id = ? AND room_code = ?", playerId, roomCode).toArray();
    return rows.length > 0;
  }

  private sendState(socket: WebSocket): void {
    this.send(socket, { type: "state", state: this.getState(), game: this.game });
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

  private ensureRoomColumn(name: string, definition: string): void {
    const columns = this.ctx.storage.sql.exec("PRAGMA table_info(rooms)").toArray() as unknown as Array<{ name: string }>;
    if (!columns.some((column) => column.name === name)) {
      this.ctx.storage.sql.exec(`ALTER TABLE rooms ADD COLUMN ${name} ${definition}`);
    }
  }

  private isSpeaking(playerId: string, now: number): boolean {
    const report = this.playerVolumes.get(playerId);
    return Boolean(
      report &&
      now - report.lastReportedAt <= 500 &&
      report.volume >= SPEAKING_VOLUME_THRESHOLD
    );
  }

  private activePlayerCount(): number {
    const rows = this.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM players WHERE connected = 1").toArray() as unknown as Array<{ count: number }>;
    return rows[0]?.count ?? 0;
  }

  private closeRoom(): void {
    if (this.gameLoop) {
      clearInterval(this.gameLoop);
      this.gameLoop = null;
    }
    this.game = null;
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
    this.micReady.delete(playerId);
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

  private startGame(socket: WebSocket): void {
    const playerId = this.sockets.get(socket);
    if (!playerId || !this.isHost(playerId)) {
      this.send(socket, { type: "error", message: "Only the host can start the game." });
      return;
    }

    const room = this.getState();
    if (room.status !== "lobby") {
      this.send(socket, { type: "error", message: "This game has already started." });
      return;
    }

    const seedBytes = new Uint32Array(1);
    crypto.getRandomValues(seedBytes);
    this.beginGame(seedBytes[0] || 1);
  }

  private restartGame(socket: WebSocket): void {
    const playerId = this.sockets.get(socket);
    if (!playerId || !this.isHost(playerId)) {
      this.send(socket, { type: "error", message: "Only the host can restart the game." });
      return;
    }

    const room = this.getState();
    if (room.status !== "finished") {
      this.send(socket, { type: "error", message: "The game is still running." });
      return;
    }

    const seedBytes = new Uint32Array(1);
    crypto.getRandomValues(seedBytes);
    this.beginGame(seedBytes[0] || 1);
  }

  private beginGame(seed: number): void {
    this.randomState = seed;
    this.nextObstacleX = 500;
    this.nextObstacleId = 1;
    this.game = {
      tick: 0,
      character: {
        x: 80,
        y: WORLD_HEIGHT / 2,
      },
      score: 0,
      averageVolume: 0.5,
      levelSeed: this.randomState,
      obstacles: [],
      gameOverReason: null,
    };
    this.ctx.storage.sql.exec("UPDATE rooms SET status = 'playing'");
    this.spawnObstacles();
    this.startGameLoop();
    this.broadcastState();
  }

  private reportVolume(socket: WebSocket, volume: number): void {
    const playerId = this.sockets.get(socket);
    if (!playerId || !Number.isFinite(volume)) {
      return;
    }

    const now = Date.now();
    this.playerVolumes.set(playerId, {
      volume: Math.max(0, Math.min(1, volume)),
      lastReportedAt: now,
    });

    if (!this.game && now - this.lastLobbyVoiceBroadcastAt >= 100) {
      this.lastLobbyVoiceBroadcastAt = now;
      this.broadcastState();
    }
  }

  private markMicReady(socket: WebSocket): void {
    const playerId = this.sockets.get(socket);
    if (!playerId) {
      return;
    }

    this.micReady.add(playerId);
    this.broadcastState();
  }

  private clearMicReady(socket: WebSocket): void {
    const playerId = this.sockets.get(socket);
    if (!playerId) {
      return;
    }

    this.micReady.delete(playerId);
    this.broadcastState();
  }

  private startGameLoop(): void {
    if (this.gameLoop) {
      clearInterval(this.gameLoop);
    }

    this.gameLoop = setInterval(() => this.tickGame(), TICK_MS);
  }

  private tickGame(): void {
    if (!this.game) {
      return;
    }

    const now = Date.now();
    const connectedPlayerIds = [...new Set(this.sockets.values())];
    let totalVolume = 0;
    for (const playerId of connectedPlayerIds) {
      const report = this.playerVolumes.get(playerId);
      if (report && now - report.lastReportedAt <= 500) {
        totalVolume += report.volume;
      }
    }

    const deltaSeconds = TICK_MS / 1000;
    const character = this.game.character;
    const averageVolume = connectedPlayerIds.length > 0
      ? totalVolume / connectedPlayerIds.length
      : 0;
    this.game.averageVolume = averageVolume;
    character.y = Math.max(0, Math.min(WORLD_HEIGHT, averageVolume * WORLD_HEIGHT));

    character.x += RUN_SPEED * deltaSeconds;
    this.game.score = Math.floor(character.x / 10);
    this.game.tick += 1;
    this.spawnObstacles();

    this.game.obstacles = this.game.obstacles.filter(
      (obstacle) => obstacle.x + obstacle.width > character.x - 120,
    );

    if (character.y >= WORLD_HEIGHT - CEILING_SPIKE_HEIGHT) {
      this.endGame("Too loud! The pickle hit the ceiling spikes.");
      return;
    }

    const pickleLeft = character.x + 8;
    const pickleRight = character.x + 32;
    for (const obstacle of this.game.obstacles) {
      const overlapsX = pickleRight > obstacle.x && pickleLeft < obstacle.x + obstacle.width;
      const hitsObstacle = obstacle.fromTop
        ? character.y + PICKLE_HEIGHT > WORLD_HEIGHT - obstacle.height
        : character.y < obstacle.height;
      if (overlapsX && hitsObstacle) {
        this.endGame("The pickle hit a kitchen obstacle.");
        return;
      }
    }

    this.broadcastState();
  }

  private spawnObstacles(): void {
    if (!this.game) {
      return;
    }

    while (this.nextObstacleX < this.game.character.x + 1000) {
      const obstacle: Obstacle = {
        id: this.nextObstacleId,
        x: this.nextObstacleX,
        width: 35 + Math.floor(this.nextRandom() * 45),
        height: 20 + Math.floor(this.nextRandom() * 55),
        fromTop: this.nextObstacleId % 2 === 0,
      };
      this.nextObstacleId += 1;
      this.game.obstacles.push(obstacle);
      this.nextObstacleX += 260 + Math.floor(this.nextRandom() * 220);
    }
  }

  private nextRandom(): number {
    this.randomState = (1664525 * this.randomState + 1013904223) >>> 0;
    return this.randomState / 4294967296;
  }

  private endGame(reason: string): void {
    if (!this.game) {
      return;
    }

    this.game.gameOverReason = reason;
    const finalScore = this.game.score;
    this.ctx.storage.sql.exec("UPDATE rooms SET status = 'finished'");
    if (this.gameLoop) {
      clearInterval(this.gameLoop);
      this.gameLoop = null;
    }

    this.broadcastState();
    this.broadcast({ type: "gameOver", finalScore, reason });
  }

  private broadcast(message: ServerMessage): void {
    for (const socket of this.sockets.keys()) {
      this.send(socket, message);
    }
  }

  private isHost(playerId: string): boolean {
    const rows = this.ctx.storage.sql
      .exec("SELECT id FROM players WHERE id = ? AND is_host = 1 AND connected = 1", playerId)
      .toArray();
    return rows.length > 0;
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
