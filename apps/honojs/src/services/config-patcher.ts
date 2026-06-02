import { readFileSync, writeFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const STATE_FILE = join(homedir(), ".codex", "proxy-state.json");
const CODEX_CONFIG = join(homedir(), ".codex", "config.toml");

// ─── ConfigPatcherService ─────────────────────────────────────────────────────

export class ConfigPatcherService {
  private upsertTomlKey(content: string, key: string, value: string): { content: string; changed: boolean } {
    const pattern = new RegExp(`^${key}\\s*=\\s*"(.+?)"`, "m");
    const match = content.match(pattern);
    if (match) {
      if (match[1] === value) return { content, changed: false };
      return { content: content.replace(pattern, `${key} = "${value}"`), changed: true };
    }
    return { content: `${key} = "${value}"\n` + content, changed: true };
  }

  saveProxyState(enabled: boolean): void {
    writeFileSync(STATE_FILE, JSON.stringify({ enabled }));
  }

  loadProxyState(): boolean {
    try {
      if (!existsSync(STATE_FILE)) return false;
      return Boolean(JSON.parse(readFileSync(STATE_FILE, "utf8")).enabled);
    } catch { return false; }
  }

  patchCodexConfig(openaiUrl: string): void {
    if (!existsSync(CODEX_CONFIG)) {
      console.log("[config] config.toml not found, skipping patch");
      return;
    }
    let content = readFileSync(CODEX_CONFIG, "utf8");
    content = content.replace(/^chatgpt_base_url\s*=\s*"http:\/\/localhost:[0-9]+"\n?/m, "");
    const r1 = this.upsertTomlKey(content, "openai_base_url", openaiUrl);
    if (r1.changed) {
      console.log(`[config] Set openai_base_url = "${openaiUrl}"`);
      content = r1.content;
    }
    writeFileSync(CODEX_CONFIG, content);
  }

  restoreCodexConfig(): boolean {
    if (!existsSync(CODEX_CONFIG)) return false;
    const before = readFileSync(CODEX_CONFIG, "utf8");
    const after = before.replace(/^openai_base_url\s*=\s*"(?:https?:\/\/localhost:[0-9]+\/v1|https:\/\/opaip\.amazingproxy\.xyz\/v1)"\n?/m, "");
    if (after !== before) {
      writeFileSync(CODEX_CONFIG, after);
      console.log("[config] Restored: removed openai_base_url from config.toml");
      return true;
    }
    return false;
  }

  isCodexConfigPatched(openaiUrl: string): boolean {
    if (!existsSync(CODEX_CONFIG)) return false;
    const content = readFileSync(CODEX_CONFIG, "utf8");
    return new RegExp(`^openai_base_url\\s*=\\s*"${openaiUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`, "m").test(content);
  }
}
