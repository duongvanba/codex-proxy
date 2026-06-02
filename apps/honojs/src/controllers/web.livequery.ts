import { Hono } from "hono";
import { LivequeryStore } from "../services/livequery";
import type { EnrollmentService } from "../libs/openai";

// ─── WebController ────────────────────────────────────────────────────────────

export class WebController extends Hono {
  constructor(
    private readonly store: LivequeryStore,
    private readonly enrollment: EnrollmentService
  ) {
    super();

    this.get("/favicon.ico", (_c) => new Response(null, { status: 204 }));

    this.get("/enroll/callback", async (c) => {
      const url = new URL(c.req.url);
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const oauthError = url.searchParams.get("error");

      if (oauthError) {
        const desc = url.searchParams.get("error_description") ?? "";
        return c.html(`<html><body><h2>Enrollment failed: ${oauthError}</h2><p>${desc}</p><script>window.close();</script></body></html>`);
      }
      if (!code || !state) {
        return c.html(`<html><body><h2>Missing code or state</h2></body></html>`, 400);
      }
      try {
        await this.enrollment.completeEnrollmentWithCode(state, code);
        return c.html(`<html><body>
          <h2>Remote Control enrollment successful!</h2>
          <p>You can close this tab.</p>
          <script>
            window.opener?.postMessage({ type: "enroll-success", pendingId: "${state}" }, "*");
            setTimeout(() => window.close(), 1500);
          </script>
        </body></html>`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return c.html(`<html><body><h2>Enrollment failed</h2><pre>${msg}</pre></body></html>`, 500);
      }
    });

    this.get("/health", (c) => {
      const origin = new URL(c.req.url).origin;
      return c.json(this.store.getHealth(`${origin}/v1`));
    });

    this.get("/v1/models", (c) => {
      const models = ["gpt-5.5", "gpt-5.5-turbo", "gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "o1", "o3", "o4-mini"]
        .map((id) => ({ id, object: "model", created: 1700000000, owned_by: "openai" }));
      return c.json({ object: "list", data: models });
    });

    this.all("/api/*", (c) =>
      c.json({ error: { message: `Legacy API route removed after LiveQuery migration: ${c.req.path}`, type: "livequery_migration" } }, 410)
    );
  }
}
