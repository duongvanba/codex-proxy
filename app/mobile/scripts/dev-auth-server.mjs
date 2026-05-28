import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const port = Number(process.env.CODEX_DEV_AUTH_PORT || 8787);
const authPath = join(homedir(), ".codex", "auth.json");

function sendJson(res, status, body) {
  res.writeHead(status, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function pickAuth(auth) {
  const tokens = auth.tokens ?? auth;
  return {
    accessToken: tokens.access_token,
    accountId: tokens.account_id ?? auth.account_id ?? "",
    apiBase: "https://chatgpt.com",
  };
}

const server = createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }

  if (req.method !== "GET" || req.url !== "/auth") {
    sendJson(res, 404, { error: "not_found" });
    return;
  }

  try {
    const auth = JSON.parse(await readFile(authPath, "utf8"));
    const payload = pickAuth(auth);
    if (!payload.accessToken) {
      sendJson(res, 500, { error: "missing_access_token" });
      return;
    }
    sendJson(res, 200, payload);
  } catch (error) {
    sendJson(res, 500, {
      error: "auth_read_failed",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Codex dev auth server listening on http://127.0.0.1:${port}`);
});
