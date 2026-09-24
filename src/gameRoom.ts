import { DurableObject } from "cloudflare:workers";
import { addParticipant, createMeeting } from "./realtimeKit";
import {
  getQteControlPlayerIds,
  getQteSafetyEndX,
  getRunSpeed,
  hitsCeilingSpikes,
  hitsObstacle,
  isQteSuccess,
  isQtePathClear,
  isQteVolumeInTarget,
  QTE_DURATION_TICKS,
  QTE_FIRST_TICK,
  QTE_INTERVAL_TICKS,
  QTE_RESULT_TICKS,
  TICK_MS,
  WORLD_HEIGHT,
} from "./gameRules";
import { deleteClip, prepareClipAudio, uploadClip } from "./stream";
import type {
  ClientMessage,
  LiveGameState,
  Obstacle,
  Player,
  RunAwards,
  RoomState,
  ServerMessage,
  VoiceQte,
} from "./types";

interface Env {
  GAME_ROOMS: DurableObjectNamespace;
  ASSETS: Fetcher;
  AUDIO_BUCKET: R2Bucket;
  R2_PUBLIC_URL: string;
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
  recording_ready: number;
  briefing_ready: number;
  clips_uploaded_at: number;
  clip_uid: string | null;
  clip_url: string | null;
  start_clip_uid: string | null;
  start_clip_url: string | null;
  coin_clip_uid: string | null;
  coin_clip_url: string | null;
  triumph_clip_uid: string | null;
  triumph_clip_url: string | null;
}

type SoundStage = "death" | "start" | "coin";

const SOUND_COLUMNS = {
  death: { uid: "clip_uid", url: "clip_url" },
  start: { uid: "start_clip_uid", url: "start_clip_url" },
  coin: { uid: "coin_clip_uid", url: "coin_clip_url" },
} as const;

interface RoomRow {
  code: string;
  status: RoomState["status"];
  recording_stage: "sounds" | null;
  final_score: number | null;
  game_over_reason: string | null;
}

interface MeetingRow {
  meeting_id: string | null;
}

const RECONNECT_GRACE_MS = 5 * 60 * 1000;
const SPEAKING_VOLUME_THRESHOLD = 0.15;
const PROCESSING_RETRY_MS = 70 * 1000;
const PROCESSING_TIMEOUT_MS = 3 * 60 * 1000;

export class GameRoom extends DurableObject<Env> {
  private readonly sockets = new Map<WebSocket, string>();
  private readonly micReady = new Set<string>();
  private readonly playerVolumes = new Map<string, { volume: number; lastReportedAt: number }>();
  private readonly runVoiceStats = new Map<string, { totalVolume: number; samples: number }>();
  private game: LiveGameState | null = null;
  private gameLoop: ReturnType<typeof setInterval> | null = null;
  private lastLobbyVoiceBroadcastAt = 0;
  private randomState = 1;
  private nextObstacleX = 650;
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
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS clip_cleanup (
        uid TEXT PRIMARY KEY
      )
    `);
    this.ensurePlayerColumn("connected", "INTEGER NOT NULL DEFAULT 0");
    this.ensurePlayerColumn("last_seen_at", "INTEGER NOT NULL DEFAULT 0");
    this.ensurePlayerColumn("recording_ready", "INTEGER NOT NULL DEFAULT 0");
    this.ensurePlayerColumn("briefing_ready", "INTEGER NOT NULL DEFAULT 0");
    this.ensurePlayerColumn("clips_uploaded_at", "INTEGER NOT NULL DEFAULT 0");
    this.ensurePlayerColumn("clip_uid", "TEXT");
    this.ensurePlayerColumn("clip_url", "TEXT");
    this.ensurePlayerColumn("start_clip_uid", "TEXT");
    this.ensurePlayerColumn("start_clip_url", "TEXT");
    this.ensurePlayerColumn("coin_clip_uid", "TEXT");
    this.ensurePlayerColumn("coin_clip_url", "TEXT");
    this.ensurePlayerColumn("triumph_clip_uid", "TEXT");
    this.ensurePlayerColumn("triumph_clip_url", "TEXT");
    this.ensureRoomColumn("meeting_id", "TEXT");
    this.ensureRoomColumn("recording_stage", "TEXT");
    this.ensureRoomColumn("final_score", "INTEGER");
    this.ensureRoomColumn("game_over_reason", "TEXT");
    this.restoreFinishedGame();
    this.scheduleNextAlarm();
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

    if (url.pathname === "/internal/rejoin" && request.method === "GET") {
      return this.validateRejoin(request);
    }

    if (url.pathname === "/internal/voice" && request.method === "GET") {
      return this.createVoiceToken(request);
    }

    if (url.pathname === "/internal/sfx" && request.method === "POST") {
      return this.saveClip(request);
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
      "INSERT INTO players (id, room_code, name, is_host, joined_at, connected, last_seen_at) VALUES (?, ?, ?, 1, ?, 0, ?)",
      playerId,
      roomCode,
      name,
      now,
      now,
    );
    this.scheduleNextAlarm();

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
    if (room[0]?.status !== "lobby") {
      return Response.json({ error: "This room is already getting ready to play." }, { status: 409 });
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
    this.scheduleNextAlarm();

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
    for (const [existingSocket, existingPlayerId] of this.sockets) {
      if (existingSocket !== server && existingPlayerId === playerId) {
        this.sockets.delete(existingSocket);
        existingSocket.close(1000, "Reconnected in another tab");
      }
    }
    server.addEventListener("message", (event) => this.handleMessage(server, event.data));
    server.addEventListener("close", () => this.disconnectPlayer(server));
    server.addEventListener("error", () => this.disconnectPlayer(server));
    this.sendState(server);
    this.broadcastState();
    this.scheduleNextAlarm();

    return new Response(null, { status: 101, webSocket: client });
  }

  private handleMessage(socket: WebSocket, rawMessage: string | ArrayBuffer): void {
    if (typeof rawMessage !== "string") {
      return;
    }

    try {
      const message = JSON.parse(rawMessage) as ClientMessage;
      if (message.type === "ping") {
        const playerId = this.sockets.get(socket);
        if (playerId) {
          this.ctx.storage.sql.exec(
            "UPDATE players SET connected = 1, last_seen_at = ? WHERE id = ?",
            Date.now(),
            playerId,
          );
          this.scheduleNextAlarm();
        }
        this.send(socket, { type: "pong" });
      } else if (message.type === "getState") {
        this.sendState(socket);
      } else if (message.type === "startGame") {
        this.startGame(socket);
      } else if (message.type === "restartGame") {
        this.restartGame(socket);
      } else if (message.type === "briefingReady") {
        this.markBriefingReady(socket);
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
    const roomRows = this.ctx.storage.sql.exec("SELECT code, status, recording_stage, final_score, game_over_reason FROM rooms LIMIT 1").toArray() as unknown as RoomRow[];
    const playerRows = this.ctx.storage.sql.exec(
      `SELECT id, name, is_host, connected, last_seen_at, recording_ready, briefing_ready,
        clip_uid, clip_url, start_clip_uid, start_clip_url, coin_clip_uid, coin_clip_url,
        triumph_clip_uid, triumph_clip_url
       FROM players WHERE connected = 1 ORDER BY joined_at`,
    ).toArray() as unknown as StoredPlayer[];
    const now = Date.now();

    return {
      roomCode: roomRows[0]?.code ?? "",
      status: roomRows[0]?.status ?? "lobby",
      recordingStage: roomRows[0]?.recording_stage ?? null,
      soundsReady: this.allPlayerClipsReady(),
      stageSoundsReady: this.allPlayerClipsReady(),
      recordingsSubmitted: this.allPlayersReady(),
      briefingComplete: this.allPlayersBriefingReady(),
      hasDisconnectedPlayers: this.hasDisconnectedPlayers(),
      players: playerRows.map((player): Player => ({
        id: player.id,
        name: player.name,
        isHost: player.is_host === 1,
        micReady: this.micReady.has(player.id),
        speaking: this.isSpeaking(player.id, now),
        recordingReady: player.recording_ready === 1,
        briefingReady: player.briefing_ready === 1,
        hasDeathClip: Boolean(player.clip_url),
        hasStartClip: Boolean(player.start_clip_url),
        hasCoinClip: Boolean(player.coin_clip_url),
      })),
    };
  }

  private validateRejoin(request: Request): Response {
    const url = new URL(request.url);
    const roomCode = url.searchParams.get("roomCode")?.toUpperCase();
    const playerId = url.searchParams.get("playerId");
    if (!roomCode || !playerId) {
      return Response.json({ canRejoin: false }, { status: 400 });
    }

    const rows = this.ctx.storage.sql.exec(
      "SELECT last_seen_at FROM players WHERE id = ? AND room_code = ?",
      playerId,
      roomCode,
    ).toArray() as unknown as Array<{ last_seen_at: number }>;
    const player = rows[0];
    const canRejoin = Boolean(
      player && Date.now() - player.last_seen_at <= RECONNECT_GRACE_MS,
    );
    return Response.json({ canRejoin });
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

  private async saveClip(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const roomCode = url.searchParams.get("roomCode")?.toUpperCase();
    const playerId = url.searchParams.get("playerId");
    if (!roomCode || !playerId || !this.playerExists(roomCode, playerId)) {
      return Response.json({ error: "Invalid room or player." }, { status: 401 });
    }

    const state = this.getState();
    if (state.status !== "recording") {
      return Response.json({ error: "Sound recording is not open right now." }, { status: 409 });
    }

    const form = await request.formData();
    const clips = ["death", "start", "coin"].map((stage) => ({
      stage: stage as SoundStage,
      clip: form.get(stage),
    }));
    if (clips.some(({ clip }) => !(clip instanceof File))) {
      return Response.json({ error: "Death, start, and coin recordings are required." }, { status: 400 });
    }
    if (clips.some(({ clip }) => clip instanceof File && (clip.size === 0 || clip.size > 1024 * 1024))) {
      return Response.json({ error: "Each sound must be between 1 byte and 1 MB." }, { status: 413 });
    }

    const uploads = await Promise.all(clips.map(({ clip }) => uploadClip(this.env, clip as File)));
    const failedUpload = uploads.find((result) => !result.ok);
    if (failedUpload && !failedUpload.ok) {
      await this.cleanupClipUids(uploads.flatMap((result) => result.ok ? [result.uid] : []));
      const tokenHelp = /auth|permission/i.test(failedUpload.error)
        ? " Give the API token Account > Stream > Edit permission, then restart Wrangler."
        : "";
      return Response.json({ error: `Could not upload those sounds: ${failedUpload.error}${tokenHelp}` }, { status: 502 });
    }
    const uploadedUids = uploads.map((result) => {
      if (!result.ok) {
        throw new Error(result.error);
      }
      return result.uid;
    });

    const currentRoom = this.ctx.storage.sql.exec(
      "SELECT status FROM rooms WHERE code = ?",
      roomCode,
    ).toArray() as unknown as Array<{ status: RoomState["status"] }>;
    if (
      currentRoom[0]?.status !== "recording" ||
      !this.playerExists(roomCode, playerId)
    ) {
      await this.cleanupClipUids(uploadedUids);
      return Response.json({ error: "The recording round changed while that clip was uploading." }, { status: 409 });
    }

    const existing = this.ctx.storage.sql
      .exec(
        `SELECT clip_uid, start_clip_uid, coin_clip_uid FROM players
         WHERE id = ? AND room_code = ?`,
        playerId,
        roomCode,
      )
      .toArray() as unknown as Array<{
        clip_uid: string | null;
        start_clip_uid: string | null;
        coin_clip_uid: string | null;
      }>;
    const previousUids = existing[0]
      ? [existing[0].clip_uid, existing[0].start_clip_uid, existing[0].coin_clip_uid]
      : [];
    this.ctx.storage.sql.exec(
      `UPDATE players SET
        clip_uid = ?, clip_url = NULL,
        start_clip_uid = ?, start_clip_url = NULL,
        coin_clip_uid = ?, coin_clip_url = NULL,
        recording_ready = 1, clips_uploaded_at = ?
       WHERE id = ? AND room_code = ?`,
      uploadedUids[0],
      uploadedUids[1],
      uploadedUids[2],
      Date.now(),
      playerId,
      roomCode,
    );
    const oldUids = previousUids.filter(
      (uid): uid is string => Boolean(uid && !uploadedUids.includes(uid)),
    );
    if (oldUids.length > 0) {
      this.ctx.waitUntil(this.cleanupClipUids(oldUids));
    }

    this.ctx.waitUntil(Promise.all(
      clips.map(({ stage }, index) => this.preparePlayerClip(roomCode, playerId, stage, uploadedUids[index])),
    ).then(() => undefined));
    this.scheduleNextAlarm();

    this.broadcastState();

    return Response.json({ ok: true });
  }

  private async preparePlayerClip(
    roomCode: string,
    playerId: string,
    stage: SoundStage,
    uid: string,
  ): Promise<void> {
    const result = await prepareClipAudio(this.env, uid);
    const { uid: uidColumn, url: urlColumn } = SOUND_COLUMNS[stage];
    const current = this.ctx.storage.sql
      .exec(
        `SELECT ${uidColumn} AS clip_uid, clips_uploaded_at FROM players WHERE id = ? AND room_code = ?`,
        playerId,
        roomCode,
      )
      .toArray() as unknown as Array<{ clip_uid: string | null; clips_uploaded_at: number }>;
    if (current[0]?.clip_uid !== uid) {
      await this.cleanupClipUids([uid]);
      return;
    }

    if (!result.ok) {
      const processingTimedOut = result.retryable && (
        !current[0]?.clips_uploaded_at || Date.now() - current[0].clips_uploaded_at >= PROCESSING_TIMEOUT_MS
      );
      if (result.retryable && !processingTimedOut) {
        this.scheduleNextAlarm(10_000);
        return;
      }
      await this.cleanupClipUids([uid]);
      this.ctx.storage.sql.exec(
        `UPDATE players SET ${uidColumn} = NULL, ${urlColumn} = NULL, recording_ready = 0 WHERE id = ? AND room_code = ?`,
        playerId,
        roomCode,
      );
      for (const [socket, socketPlayerId] of this.sockets) {
        if (socketPlayerId === playerId) {
          this.send(socket, {
            type: "error",
            message: processingTimedOut
              ? `Stream got stuck processing your ${stage} sound. Please record your three sounds again.`
              : result.error,
            resetRecordings: true,
          });
        }
      }
      this.broadcastState();
      this.scheduleNextAlarm();
      return;
    }

    this.ctx.storage.sql.exec(
      `UPDATE players SET ${urlColumn} = ? WHERE id = ? AND room_code = ? AND ${uidColumn} = ?`,
      result.audioUrl,
      playerId,
      roomCode,
      uid,
    );
    this.broadcastState();
    this.scheduleNextAlarm();
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
    const expired = this.ctx.storage.sql.exec(
      `SELECT id, clip_uid, start_clip_uid, coin_clip_uid, triumph_clip_uid
       FROM players WHERE last_seen_at <= ?`,
      cutoff,
    ).toArray() as unknown as Array<{
      id: string;
      clip_uid: string | null;
      start_clip_uid: string | null;
      coin_clip_uid: string | null;
      triumph_clip_uid: string | null;
    }>;
    const expiredUids = expired.flatMap((player) => [
      player.clip_uid,
      player.start_clip_uid,
      player.coin_clip_uid,
      player.triumph_clip_uid,
    ]);
    this.queueClipCleanup(expiredUids);
    this.ctx.storage.sql.exec(
      "DELETE FROM players WHERE last_seen_at <= ?",
      cutoff,
    );
    const expiredPlayerIds = new Set(expired.map((player) => player.id));
    for (const [socket, playerId] of this.sockets) {
      if (expiredPlayerIds.has(playerId)) {
        this.sockets.delete(socket);
        socket.close(1000, "Rejoin window expired");
      }
    }
    await this.processClipCleanup();

    if (this.totalPlayerCount() === 0) {
      await this.closeRoom();
      return;
    }

    this.reassignHostIfNeeded("");
    const pending = this.pendingClips();
    await Promise.all(pending.map((clip) => this.preparePlayerClip(
      clip.roomCode,
      clip.playerId,
      clip.stage,
      clip.uid,
    )));
    this.scheduleNextAlarm(10_000);
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

  private restoreFinishedGame(): void {
    const rows = this.ctx.storage.sql.exec(
      "SELECT status, final_score, game_over_reason FROM rooms LIMIT 1",
    ).toArray() as unknown as Array<{
      status: RoomState["status"];
      final_score: number | null;
      game_over_reason: string | null;
    }>;
    const room = rows[0];
    if (!room || (room.status !== "playing" && room.status !== "finished")) {
      return;
    }

    const interrupted = room.status === "playing";
    const score = room.final_score ?? 0;
    const reason = interrupted
      ? "The run was interrupted by a server update. The host can restart it."
      : room.game_over_reason ?? "Run finished.";
    if (interrupted) {
      this.ctx.storage.sql.exec(
        "UPDATE rooms SET status = 'finished', final_score = ?, game_over_reason = ?",
        score,
        reason,
      );
    }
    this.game = {
      tick: 0,
      character: { x: Math.max(80, score * 10), y: WORLD_HEIGHT / 2 },
      score,
      coins: 0,
      averageVolume: 0.5,
      levelSeed: 1,
      obstacles: [],
      gameOverReason: reason,
      awards: { loudestPlayer: null, quietestPlayer: null },
      qte: null,
      qteResult: null,
      nextQteTick: QTE_FIRST_TICK,
    };
  }

  private pendingClips(): Array<{
    roomCode: string;
    playerId: string;
    stage: SoundStage;
    uid: string;
  }> {
    const rows = this.ctx.storage.sql.exec(
      `SELECT id, room_code, clip_uid, clip_url,
        start_clip_uid, start_clip_url, coin_clip_uid, coin_clip_url
       FROM players`,
    ).toArray() as unknown as StoredPlayer[];
    return rows.flatMap((player) => {
      const pending: Array<{
        roomCode: string;
        playerId: string;
        stage: SoundStage;
        uid: string;
      }> = [];
      if (player.clip_uid && !player.clip_url) {
        pending.push({ roomCode: player.room_code, playerId: player.id, stage: "death", uid: player.clip_uid });
      }
      if (player.start_clip_uid && !player.start_clip_url) {
        pending.push({ roomCode: player.room_code, playerId: player.id, stage: "start", uid: player.start_clip_uid });
      }
      if (player.coin_clip_uid && !player.coin_clip_url) {
        pending.push({ roomCode: player.room_code, playerId: player.id, stage: "coin", uid: player.coin_clip_uid });
      }
      return pending;
    });
  }

  private queueClipCleanup(uids: Array<string | null | undefined>): void {
    for (const uid of new Set(uids.filter((value): value is string => Boolean(value)))) {
      this.ctx.storage.sql.exec("INSERT OR IGNORE INTO clip_cleanup (uid) VALUES (?)", uid);
    }
  }

  private async processClipCleanup(): Promise<void> {
    const rows = this.ctx.storage.sql.exec("SELECT uid FROM clip_cleanup").toArray() as unknown as Array<{ uid: string }>;
    const results = await Promise.all(rows.map(async ({ uid }) => ({
      uid,
      deleted: await deleteClip(this.env, uid),
    })));
    for (const result of results) {
      if (result.deleted) {
        this.ctx.storage.sql.exec("DELETE FROM clip_cleanup WHERE uid = ?", result.uid);
      }
    }
  }

  private async cleanupClipUids(uids: Array<string | null | undefined>): Promise<void> {
    this.queueClipCleanup(uids);
    await this.processClipCleanup();
    this.scheduleNextAlarm();
  }

  private scheduleNextAlarm(pendingDelayMs = PROCESSING_RETRY_MS): void {
    const deadlines: number[] = [];
    const players = this.ctx.storage.sql.exec(
      "SELECT MIN(last_seen_at) AS last_seen_at FROM players",
    ).toArray() as unknown as Array<{ last_seen_at: number | null }>;
    const lastSeenAt = players[0]?.last_seen_at;
    if (lastSeenAt !== null && lastSeenAt !== undefined) {
      deadlines.push(lastSeenAt + RECONNECT_GRACE_MS);
    }
    if (this.pendingClips().length > 0) {
      deadlines.push(Date.now() + pendingDelayMs);
    }
    const cleanupPending = this.ctx.storage.sql.exec("SELECT 1 FROM clip_cleanup LIMIT 1").toArray().length > 0;
    if (cleanupPending) {
      deadlines.push(Date.now() + pendingDelayMs);
    }

    if (deadlines.length > 0) {
      void this.ctx.storage.setAlarm(Math.max(Date.now() + 100, Math.min(...deadlines)));
    } else {
      void this.ctx.storage.deleteAlarm();
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

  private totalPlayerCount(): number {
    const rows = this.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM players").toArray() as unknown as Array<{ count: number }>;
    return rows[0]?.count ?? 0;
  }

  private hasDisconnectedPlayers(): boolean {
    const rows = this.ctx.storage.sql.exec("SELECT 1 FROM players WHERE connected = 0 LIMIT 1").toArray();
    return rows.length > 0;
  }

  private allPlayersReady(): boolean {
    const rows = this.ctx.storage.sql.exec(
      "SELECT COUNT(*) AS total, SUM(recording_ready) AS ready FROM players",
    ).toArray() as unknown as Array<{ total: number; ready: number | null }>;
    const total = rows[0]?.total ?? 0;
    return total > 0 && (rows[0]?.ready ?? 0) === total;
  }

  private allPlayersBriefingReady(): boolean {
    const rows = this.ctx.storage.sql.exec(
      "SELECT COUNT(*) AS total, SUM(briefing_ready) AS ready FROM players",
    ).toArray() as unknown as Array<{ total: number; ready: number | null }>;
    const total = rows[0]?.total ?? 0;
    return total > 0 && (rows[0]?.ready ?? 0) === total;
  }

  private markBriefingReady(socket: WebSocket): void {
    const playerId = this.sockets.get(socket);
    const room = this.getState();
    if (!playerId || room.status !== "briefing") {
      return;
    }

    this.ctx.storage.sql.exec("UPDATE players SET briefing_ready = 1 WHERE id = ?", playerId);
    this.broadcastState();
  }

  private allPlayerClipsReady(): boolean {
    const rows = this.ctx.storage.sql.exec(
      `SELECT COUNT(*) AS total,
        SUM(CASE WHEN clip_url IS NOT NULL AND start_clip_url IS NOT NULL AND coin_clip_url IS NOT NULL THEN 1 ELSE 0 END) AS ready
       FROM players`,
    ).toArray() as unknown as Array<{ total: number; ready: number | null }>;
    const total = rows[0]?.total ?? 0;
    return total > 0 && (rows[0]?.ready ?? 0) === total;
  }

  private async closeRoom(): Promise<void> {
    if (this.gameLoop) {
      clearInterval(this.gameLoop);
      this.gameLoop = null;
    }
    this.game = null;
    const clips = this.ctx.storage.sql.exec(
      "SELECT clip_uid, start_clip_uid, coin_clip_uid, triumph_clip_uid FROM players",
    ).toArray() as unknown as Array<{
      clip_uid: string | null;
      start_clip_uid: string | null;
      coin_clip_uid: string | null;
      triumph_clip_uid: string | null;
    }>;
    const clipIds = clips.flatMap((clip) => [
      clip.clip_uid,
      clip.start_clip_uid,
      clip.coin_clip_uid,
      clip.triumph_clip_uid,
    ]);
    this.queueClipCleanup(clipIds);
    this.ctx.storage.sql.exec("DELETE FROM players");
    this.ctx.storage.sql.exec("DELETE FROM rooms");
    await this.processClipCleanup();
    this.scheduleNextAlarm(10_000);
  }

  private disconnectPlayer(socket: WebSocket): void {
    const playerId = this.sockets.get(socket);
    if (!playerId) {
      return;
    }

    this.sockets.delete(socket);
    if ([...this.sockets.values()].includes(playerId)) {
      return;
    }
    this.micReady.delete(playerId);
    this.playerVolumes.delete(playerId);
    this.ctx.storage.sql.exec(
      "UPDATE players SET connected = 0, last_seen_at = ? WHERE id = ?",
      Date.now(),
      playerId,
    );
    this.reassignHostIfNeeded(playerId);
    this.scheduleNextAlarm();
    this.broadcastState();
  }

  private startGame(socket: WebSocket): void {
    const playerId = this.sockets.get(socket);
    if (!playerId || !this.isHost(playerId)) {
      this.send(socket, { type: "error", message: "Only the host can start the game." });
      return;
    }

    const room = this.getState();
    if (room.hasDisconnectedPlayers) {
      this.send(socket, { type: "error", message: "Wait for disconnected players to rejoin before continuing." });
      return;
    }
    if (room.status === "recording") {
      if (
        !this.allPlayersReady() ||
        !this.allPlayerClipsReady()
      ) {
        this.send(socket, { type: "error", message: "Everyone's sounds must finish processing first." });
        return;
      }

      this.ctx.storage.sql.exec("UPDATE rooms SET status = 'briefing', recording_stage = NULL");
      this.ctx.storage.sql.exec("UPDATE players SET briefing_ready = 0");
      this.broadcastState();
      return;
    }

    if (room.status === "briefing") {
      if (!this.allPlayersBriefingReady()) {
        this.send(socket, { type: "error", message: "Everyone must ready up before the run starts." });
        return;
      }

      this.beginGame(this.makeSeed());
      return;
    }

    if (room.status !== "lobby") {
      this.send(socket, { type: "error", message: "This game has already started." });
      return;
    }

    this.ctx.storage.sql.exec("UPDATE rooms SET status = 'recording', recording_stage = 'sounds'");
    this.ctx.storage.sql.exec("UPDATE players SET recording_ready = 0, briefing_ready = 0");
    this.broadcastState();
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

    this.beginGame(this.makeSeed());
  }

  private beginGame(seed: number): void {
    this.randomState = seed;
    this.runVoiceStats.clear();
    this.nextObstacleX = 650;
    this.nextObstacleId = 1;
    this.game = {
      tick: 0,
      character: {
        x: 80,
        y: WORLD_HEIGHT / 2,
      },
      score: 0,
      coins: 0,
      averageVolume: 0.5,
      levelSeed: this.randomState,
      obstacles: [],
      gameOverReason: null,
      awards: { loudestPlayer: null, quietestPlayer: null },
      qte: null,
      qteResult: null,
      nextQteTick: QTE_FIRST_TICK,
    };
    this.ctx.storage.sql.exec(
      "UPDATE rooms SET status = 'playing', recording_stage = NULL, final_score = NULL, game_over_reason = NULL",
    );
    this.spawnObstacles();
    this.startGameLoop();
    this.broadcastState();
    this.broadcastRandomClip("start");
  }

  private reportVolume(socket: WebSocket, volume: number): void {
    const playerId = this.sockets.get(socket);
    if (!playerId || !Number.isFinite(volume)) {
      return;
    }

    const now = Date.now();
    const normalizedVolume = Math.max(0, Math.min(1, volume));
    this.playerVolumes.set(playerId, {
      volume: normalizedVolume,
      lastReportedAt: now,
    });
    if (this.game && !this.game.gameOverReason) {
      const stats = this.runVoiceStats.get(playerId) ?? { totalVolume: 0, samples: 0 };
      stats.totalVolume += normalizedVolume;
      stats.samples += 1;
      this.runVoiceStats.set(playerId, stats);
    }

    if ((!this.game || this.game.gameOverReason) && now - this.lastLobbyVoiceBroadcastAt >= 100) {
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
    const controlPlayerIds = getQteControlPlayerIds(this.game.qte, connectedPlayerIds);
    let totalVolume = 0;
    let freshReportCount = 0;
    for (const playerId of controlPlayerIds) {
      const report = this.playerVolumes.get(playerId);
      if (report && now - report.lastReportedAt <= 500) {
        totalVolume += report.volume;
        freshReportCount += 1;
      }
    }

    const deltaSeconds = TICK_MS / 1000;
    const character = this.game.character;
    const averageVolume = controlPlayerIds.length > 0
      ? totalVolume / controlPlayerIds.length
      : 0;
    this.game.averageVolume += (averageVolume - this.game.averageVolume) * 0.18;
    character.y = Math.max(0, Math.min(WORLD_HEIGHT, this.game.averageVolume * WORLD_HEIGHT));

    const runSpeed = getRunSpeed(this.game.tick);
    character.x += runSpeed * deltaSeconds;
    this.game.score = Math.floor(character.x / 10);
    this.game.tick += 1;
    this.tickVoiceQte(freshReportCount, connectedPlayerIds);
    this.spawnObstacles();

    this.game.obstacles = this.game.obstacles.filter(
      (obstacle) => obstacle.x + obstacle.width > character.x - 120,
    );

    if (hitsCeilingSpikes(character.y)) {
      this.endGame("Too loud! The pickle hit the ceiling spikes.");
      return;
    }

    const pickleLeft = character.x + 8;
    const pickleRight = character.x + 32;
    for (const obstacle of this.game.obstacles) {
      const overlapsX = pickleRight > obstacle.x && pickleLeft < obstacle.x + obstacle.width;
      if (overlapsX && hitsObstacle(character.y, obstacle)) {
        this.endGame(obstacle.kind === "utensil"
          ? "The pickle got smacked by a flying utensil."
          : "The pickle hit a kitchen obstacle.");
        return;
      }
    }

    this.broadcastState();
  }

  private tickVoiceQte(freshReportCount: number, connectedPlayerIds: string[]): void {
    if (!this.game) {
      return;
    }

    if (this.game.qteResult) {
      this.game.qteResult.remainingTicks -= 1;
      if (this.game.qteResult.remainingTicks <= 0) {
        this.game.qteResult = null;
      }
    }

    if (!this.game.qte && this.game.tick >= this.game.nextQteTick) {
      const safetyEndX = getQteSafetyEndX(this.game.character.x, getRunSpeed(this.game.tick));
      if (!isQtePathClear(this.game.obstacles, this.game.character.x, safetyEndX)) {
        return;
      }

      const roll = this.nextRandom();
      const type: VoiceQte["type"] = roll < 1 / 3
        ? "quiet"
        : roll < 2 / 3 || connectedPlayerIds.length === 0
          ? "steady"
          : "solo";
      const targetPlayerId = type === "solo"
        ? connectedPlayerIds[Math.floor(this.nextRandom() * connectedPlayerIds.length)]
        : null;
      const targetPlayerName = targetPlayerId
        ? (this.ctx.storage.sql.exec<{ name: string }>(
            "SELECT name FROM players WHERE id = ?",
            targetPlayerId,
          ).one().name)
        : null;
      this.game.qte = {
        type,
        prompt: type === "quiet"
          ? "Shhh! Keep the team quiet"
          : type === "steady"
            ? "Hold a steady medium volume"
            : `${targetPlayerName}, take the wheel! Only your voice controls the pickle`,
        targetPlayerId,
        targetPlayerName,
        remainingTicks: QTE_DURATION_TICKS,
        totalTicks: QTE_DURATION_TICKS,
        successfulTicks: 0,
      };
      this.game.nextQteTick = this.game.tick + QTE_INTERVAL_TICKS;
      return;
    }

    const qte = this.game.qte;
    if (!qte) {
      return;
    }

    const volume = this.game.averageVolume;
    const inTarget = qte.type === "solo"
      ? freshReportCount > 0
      : freshReportCount > 0 && isQteVolumeInTarget(qte.type, volume);
    if (inTarget) {
      qte.successfulTicks += 1;
    }
    qte.remainingTicks -= 1;

    if (qte.remainingTicks <= 0) {
      const success = isQteSuccess(qte.successfulTicks, qte.totalTicks);
      if (success) {
        this.game.coins += 1;
        this.broadcastRandomClip("coin");
      }
      this.game.qteResult = {
        success,
        message: success
          ? qte.type === "solo"
            ? `+1 coin! ${qte.targetPlayerName} handled the solo.`
            : "+1 coin! Nice teamwork."
          : "Missed it. Keep running!",
        remainingTicks: QTE_RESULT_TICKS,
      };
      this.game.qte = null;
    }
  }

  private spawnObstacles(): void {
    if (!this.game) {
      return;
    }

    while (this.nextObstacleX < this.game.character.x + 1000) {
      const isUtensil = this.nextObstacleId % 2 === 0;
      const obstacle: Obstacle = {
        id: this.nextObstacleId,
        kind: isUtensil ? "utensil" : "floor",
        x: this.nextObstacleX,
        y: isUtensil ? 145 + Math.floor(this.nextRandom() * 46) : 0,
        width: isUtensil ? 118 + Math.floor(this.nextRandom() * 18) : 56 + Math.floor(this.nextRandom() * 20),
        height: isUtensil ? 32 + Math.floor(this.nextRandom() * 7) : 48 + Math.floor(this.nextRandom() * 19),
      };
      this.nextObstacleId += 1;
      this.game.obstacles.push(obstacle);
      this.nextObstacleX += 390 + Math.floor(this.nextRandom() * 260);
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
    this.game.awards = this.calculateRunAwards();
    const finalScore = this.game.score;
    this.ctx.storage.sql.exec(
      "UPDATE rooms SET status = 'finished', final_score = ?, game_over_reason = ?",
      finalScore,
      reason,
    );
    if (this.gameLoop) {
      clearInterval(this.gameLoop);
      this.gameLoop = null;
    }

    this.broadcastState();
    this.broadcast({ type: "gameOver", finalScore, reason });
    this.broadcastRandomClip("death");
  }

  private calculateRunAwards(): RunAwards {
    const playerNames = new Map(
      this.ctx.storage.sql.exec<{ id: string; name: string }>("SELECT id, name FROM players")
        .toArray()
        .map((player) => [player.id, player.name]),
    );
    const averages = [...this.runVoiceStats.entries()]
      .filter(([playerId, stats]) => stats.samples > 0 && playerNames.has(playerId))
      .map(([playerId, stats]) => ({
        name: playerNames.get(playerId)!,
        average: stats.totalVolume / stats.samples,
      }))
      .sort((a, b) => a.average - b.average || a.name.localeCompare(b.name));

    return {
      loudestPlayer: averages.at(-1)?.name ?? null,
      quietestPlayer: averages.length > 1 ? averages[0].name : null,
    };
  }

  private makeSeed(): number {
    const seedBytes = new Uint32Array(1);
    crypto.getRandomValues(seedBytes);
    return seedBytes[0] || 1;
  }

  private broadcastRandomClip(stage: SoundStage): void {
    const column = SOUND_COLUMNS[stage].url;
    const clips = this.ctx.storage.sql.exec(
      `SELECT ${column} AS clip_url FROM players WHERE connected = 1 AND ${column} IS NOT NULL`,
    ).toArray() as unknown as Array<{ clip_url: string }>;
    if (clips.length === 0) {
      return;
    }

    const randomIndex = crypto.getRandomValues(new Uint32Array(1))[0] % clips.length;
    this.broadcast({ type: "playSound", url: clips[randomIndex].clip_url });
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
      this.disconnectPlayer(socket);
    }
  }
}
