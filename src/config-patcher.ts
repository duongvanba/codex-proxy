import { readFileSync, writeFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const STATE_FILE = join(homedir(), ".codex", "proxy-state.json");

export function saveProxyState(enabled: boolean): void {
  writeFileSync(STATE_FILE, JSON.stringify({ enabled }));
}

export function loadProxyState(): boolean {
  try {
    if (!existsSync(STATE_FILE)) return false;
    const data = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    return Boolean(data.enabled);
  } catch {
    return false;
  }
}

const CODEX_CONFIG = join(homedir(), ".codex", "config.toml");

function upsertTomlKey(content: string, key: string, value: string): { content: string; changed: boolean } {
  const pattern = new RegExp(`^${key}\\s*=\\s*"(.+?)"`, "m");
  const match = content.match(pattern);
  if (match) {
    if (match[1] === value) return { content, changed: false };
    return { content: content.replace(pattern, `${key} = "${value}"`), changed: true };
  }
  return { content: `${key} = "${value}"\n` + content, changed: true };
}

export function patchCodexConfig(openaiUrl: string) {
  if (!existsSync(CODEX_CONFIG)) {
    console.log("[config] config.toml not found, skipping patch");
    return;
  }

  let content = readFileSync(CODEX_CONFIG, "utf8");

  // Remove any stale chatgpt_base_url we may have set previously
  content = content.replace(/^chatgpt_base_url\s*=\s*"http:\/\/localhost:[0-9]+"\n?/m, "");

  const r1 = upsertTomlKey(content, "openai_base_url", openaiUrl);
  if (r1.changed) {
    content = r1.content;
    console.log(`[config] Set openai_base_url = "${openaiUrl}"`);
    writeFileSync(CODEX_CONFIG, content);
  } else {
    // Still write if we cleaned up chatgpt_base_url
    writeFileSync(CODEX_CONFIG, content);
  }
}

export function restoreCodexConfig(): boolean {
  if (!existsSync(CODEX_CONFIG)) return false;
  let content = readFileSync(CODEX_CONFIG, "utf8");
  const before = content;
  content = content.replace(/^openai_base_url\s*=\s*"(?:https?:\/\/localhost:[0-9]+\/v1|https:\/\/opaip\.amazingproxy\.xyz\/v1)"\n?/m, "");
  if (content !== before) {
    writeFileSync(CODEX_CONFIG, content);
    console.log("[config] Restored: removed openai_base_url from config.toml");
    return true;
  }
  return false;
}

export function isCodexConfigPatched(openaiUrl: string): boolean {
  if (!existsSync(CODEX_CONFIG)) return false;
  const content = readFileSync(CODEX_CONFIG, "utf8");
  return new RegExp(`^openai_base_url\\s*=\\s*"${openaiUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`, "m").test(content);
}
