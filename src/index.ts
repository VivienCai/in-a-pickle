export { GameRoom } from "./gameRoom";

export interface Env {
  GAME_ROOMS: DurableObjectNamespace;
  ASSETS: Fetcher;
  CLOUDFLARE_ACCOUNT_ID: string;
  REALTIMEKIT_APP_ID: string;
  REALTIMEKIT_PRESET_NAME: string;
  CLOUDFLARE_API_TOKEN: string;
}

const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function makeRoomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return Array.from(bytes, (byte) => ROOM_CODE_ALPHABET[byte % ROOM_CODE_ALPHABET.length]).join("");
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await request.json();
    if (typeof value === "object" && value !== null) {
      return value as Record<string, unknown>;
    }
  } catch {
    // The caller receives a normal bad-request response below.
  }

  return {};
}

function errorResponse(message: string, status = 400): Response {
  return Response.json({ error: message }, { status });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return Response.json({ ok: true, game: "in-a-pickle" });
    }

    // Creating a room
    if (url.pathname === "/api/rooms" && request.method === "POST") {
      const body = await readJson(request);
      const name = typeof body.name === "string" ? body.name.trim() : "";

      if (!name || name.length > 24) {
        return errorResponse("Name must be between 1 and 24 characters.");
      }

      for (let attempt = 0; attempt < 5; attempt += 1) {
        const roomCode = makeRoomCode();
        const id = env.GAME_ROOMS.idFromName(roomCode);
        const room = env.GAME_ROOMS.get(id);
        // Worker speaking to DO
        const response = await room.fetch(
          new Request("https://room.internal/internal/create", {
            method: "POST",
            body: JSON.stringify({ roomCode, name }),
            headers: { "Content-Type": "application/json" },
          }),
        );

        if (response.status !== 409) {
          return response;
        }
      }

      return errorResponse("Could not create a unique room. Try again.", 500);
    }

    const roomMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)(?:\/(join|state|rejoin|voice|sfx))?$/);
    if (roomMatch) {
      const roomCode = roomMatch[1].toUpperCase();
      const action = roomMatch[2];
      const id = env.GAME_ROOMS.idFromName(roomCode);
      const room = env.GAME_ROOMS.get(id);

      // Joining a room
      if (action === "join" && request.method === "POST") {
        const body = await readJson(request);
        const name = typeof body.name === "string" ? body.name.trim() : "";

        if (!name || name.length > 24) {
          return errorResponse("Name must be between 1 and 24 characters.");
        }

        return room.fetch(
          new Request("https://room.internal/internal/join", {
            method: "POST",
            body: JSON.stringify({ roomCode, name }),
            headers: { "Content-Type": "application/json" },
          }),
        );
      }

      if (action === "state" && request.method === "GET") {
        return room.fetch(new Request("https://room.internal/internal/state"));
      }

      if (action === "rejoin" && request.method === "GET") {
        const playerId = url.searchParams.get("playerId");
        if (!playerId) {
          return errorResponse("playerId is required.");
        }

        const internalUrl = new URL("https://room.internal/internal/rejoin");
        internalUrl.searchParams.set("roomCode", roomCode);
        internalUrl.searchParams.set("playerId", playerId);
        return room.fetch(new Request(internalUrl));
      }

      if (action === "voice" && request.method === "GET") {
        const playerId = url.searchParams.get("playerId");
        if (!playerId) {
          return errorResponse("playerId is required.");
        }

        const internalUrl = new URL("https://room.internal/internal/voice");
        internalUrl.searchParams.set("roomCode", roomCode);
        internalUrl.searchParams.set("playerId", playerId);
        return room.fetch(new Request(internalUrl));
      }

      if (action === "sfx" && request.method === "POST") {
        const playerId = url.searchParams.get("playerId");
        if (!playerId) {
          return errorResponse("playerId is required.");
        }

        const internalUrl = new URL("https://room.internal/internal/sfx");
        internalUrl.searchParams.set("roomCode", roomCode);
        internalUrl.searchParams.set("playerId", playerId);
        const contentType = request.headers.get("Content-Type") ?? "multipart/form-data";
        return room.fetch(new Request(internalUrl, {
          method: "POST",
          headers: { "Content-Type": contentType },
          body: await request.arrayBuffer(),
        }));
      }
    }

    if (url.pathname === "/ws") {
      const roomCode = url.searchParams.get("roomCode")?.toUpperCase();
      const playerId = url.searchParams.get("playerId");

      if (!roomCode || !playerId) {
        return errorResponse("roomCode and playerId are required.");
      }

      const id = env.GAME_ROOMS.idFromName(roomCode);
      const room = env.GAME_ROOMS.get(id);
      return room.fetch(request);
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
