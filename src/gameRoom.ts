import { DurableObject } from "cloudflare:workers";

interface Env {
  GAME_ROOMS: DurableObjectNamespace;
  ASSETS: Fetcher;
}

export class GameRoom extends DurableObject {
  override async fetch(request: Request): Promise<Response> {
    return Response.json({ status: "lobby", msg: "the jar awaits" });
  }
}
