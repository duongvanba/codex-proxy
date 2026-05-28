import { Hono } from "hono";
import {
  handleLivequeryRequest,
  openLivequerySocket,
  messageLivequerySocket,
  closeLivequerySocket,
} from "../services/livequery";

export function createLivequeryController(options: { restartCodex: () => Promise<void> }) {
  const app = new Hono();

  app.all("/livequery/*", async (c) => {
    const url = new URL(c.req.url);
    return handleLivequeryRequest(c.req.raw, {
      openaiBaseUrl: `${url.origin}/v1`,
      publicBaseUrl: url.origin,
      restartCodex: options.restartCodex,
    });
  });

  return app;
}

export { openLivequerySocket, messageLivequerySocket, closeLivequerySocket };
