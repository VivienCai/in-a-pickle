export { GameRoom } from "./gameRoom";

export interface Env {
  GAME_ROOMS: DurableObjectNamespace;
  ASSETS: Fetcher;
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return Response.json({ ok: true, game: "in-a-pickle" });
    }

    return env.ASSETS.fetch(request);
  },
};
