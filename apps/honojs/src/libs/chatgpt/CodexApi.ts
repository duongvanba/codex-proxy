import { ChatGPTClient, CHATGPT_BASE } from "./client";
import type { Account } from "../../schemas";
import type { HostItem, ProjectItem, ChatItem, TurnItem, TaskResult } from "../../schemas/api";
export type { HostItem, ProjectItem, ChatItem, TurnItem, TaskResult };

const HOME = process.env.HOME ?? "";

// ─── Class ────────────────────────────────────────────────────────────────────

export class CodexApiService {
  // ─── Data fetching functions ───────────────────────────────────────────────────

  async fetchHosts(account: Account): Promise<HostItem[]> {
    const url = `${CHATGPT_BASE}/backend-api/codex/remote/control/environments?limit=100`;
    const res = await fetch(url, { headers: ChatGPTClient.buildCodexHttpHeaders(account, "application/json") });
    if (!res.ok) throw new Error(`Upstream ${res.status}`);
    const data = (await res.json()) as { items?: unknown[] };
    return (data.items ?? [])
      .filter((item) => (item as Record<string, unknown>).kind !== "cloud")
      .map((item) => {
      const i = item as Record<string, unknown>;
      return {
        id: String(i.env_id ?? ""),
        env_id: String(i.env_id ?? ""),
        kind: i.kind as string | undefined,
        display_name: String(i.display_name ?? i.host_name ?? ""),
        host_name: String(i.host_name ?? ""),
        online: Boolean(i.online),
        busy: i.busy != null ? Boolean(i.busy) : undefined,
        os: i.os as string | undefined,
        os_version: i.os_version as string | undefined,
        arch: i.arch as string | undefined,
        app_server_version: i.app_server_version as string | undefined,
        client_type: i.client_type as string | undefined,
        client_version: i.client_version as string | undefined,
        last_seen_at: i.last_seen_at as string | undefined,
      };
    });
  }

  async fetchProjects(): Promise<ProjectItem[]> {
    const results: ProjectItem[] = [];

    try {
      const stateFile = Bun.file(`${HOME}/.codex/.codex-global-state.json`);
      if (await stateFile.exists()) {
        const state = (await stateFile.json()) as Record<string, unknown>;
        const projects = Array.isArray(state["remote-projects"]) ? state["remote-projects"] : [];
        for (const p of projects as Record<string, unknown>[]) {
          results.push({
            id: String(p.id ?? crypto.randomUUID()),
            hostId: String(p.hostId ?? ""),
            remotePath: String(p.remotePath ?? ""),
            label: String(p.label ?? p.remotePath ?? ""),
            source: "global-state",
          });
        }
      }
    } catch {
      // state file missing or malformed
    }

    try {
      const configFile = Bun.file(`${HOME}/.codex/codex-app/config.json`);
      if (await configFile.exists()) {
        const config = (await configFile.json()) as Record<string, unknown>;
        const connections = Array.isArray(config.remoteConnections) ? config.remoteConnections : [];
        for (const conn of connections as Record<string, unknown>[]) {
          const alias = String(conn.sshAlias ?? "");
          for (const proj of Array.isArray(conn.projects) ? (conn.projects as Record<string, unknown>[]) : []) {
            const path = String(proj.remotePath ?? "");
            if (!results.some((r) => r.remotePath === path && r.source === "global-state")) {
              results.push({
                id: crypto.randomUUID(),
                hostId: `ssh:${alias}`,
                remotePath: path,
                label: String(proj.label ?? path),
                source: "ssh-config",
              });
            }
          }
        }
      }
    } catch {
      // config missing or malformed
    }

    return results;
  }

  async fetchChats(
    account: Account,
    params: { taskFilter?: string; limit?: number; projectPath?: string; envId?: string } = {}
  ): Promise<ChatItem[]> {
    const qs = new URLSearchParams({
      task_filter: params.taskFilter ?? "all",
      limit: String(Math.min(params.limit ?? 20, 20)),
    });
    const url = `${CHATGPT_BASE}/backend-api/wham/tasks/list?${qs}`;
    const res = await fetch(url, { headers: ChatGPTClient.buildCodexHttpHeaders(account, "application/json") });
    if (!res.ok) throw new Error(`Upstream ${res.status}`);
    const data = (await res.json()) as { items?: unknown[]; tasks?: unknown[] };
    let tasks = (data.items ?? data.tasks ?? []) as Record<string, unknown>[];
    if (params.projectPath) {
      tasks = tasks.filter((t) => {
        const label = (t.task_status_display as Record<string, unknown>)?.environment_label;
        return label === params.projectPath || t.workspace_root === params.projectPath;
      });
    }
    return tasks.map((t) => {
      const display = (t.task_status_display as Record<string, unknown>) ?? {};
      const workspacePath = String(display.environment_label ?? t.workspace_root ?? "");
      return {
        ...t,
        id: String(t.id ?? t.task_id ?? ""),
        title: t.title as string | undefined,
        status: String((display.latest_turn_status_display as Record<string, unknown>)?.turn_status ?? t.status ?? ""),
        workspace_root: workspacePath,
        created_at: t.created_at as string | undefined,
        updated_at: t.updated_at as string | undefined,
      };
    });
  }

  async fetchTurns(account: Account, chatId: string): Promise<{ turns: TurnItem[]; current_turn_id?: string }> {
    const headers = ChatGPTClient.buildCodexHttpHeaders(account, "application/json");
    const res = await fetch(`${CHATGPT_BASE}/backend-api/wham/tasks/${chatId}/turns`, { headers });
    if (!res.ok) throw new Error(`Upstream ${res.status}`);
    const payload = (await res.json()) as Record<string, unknown>;
    const turnMapping = (payload.turn_mapping ?? {}) as Record<string, { turn: Record<string, unknown> }>;
    const turns: TurnItem[] = Object.values(turnMapping).map((e) => ({
      id: String(e.turn.id ?? ""),
      type: String(e.turn.type ?? ""),
      role: String(e.turn.role ?? ""),
      input_items: (e.turn.input_items as unknown[]) ?? [],
      output_items: (e.turn.output_items as unknown[]) ?? [],
      ...e.turn,
    }));
    return { turns, current_turn_id: payload.current_turn_id as string | undefined };
  }

  // ─── Wham task mutations ───────────────────────────────────────────────────────

  private async whamPost(account: Account, path: string, body?: unknown): Promise<Record<string, unknown>> {
    const res = await fetch(`${CHATGPT_BASE}/backend-api${path}`, {
      method: "POST",
      headers: ChatGPTClient.buildCodexHttpHeaders(account, "application/json"),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Upstream ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
    }
    return (await res.json()) as Record<string, unknown>;
  }

  async createTask(
    account: Account,
    params: {
      input_items: unknown[];
      environment_id?: string;
      branch?: string;
      model_slug?: string;
    }
  ): Promise<TaskResult> {
    const newTask: Record<string, unknown> = {
      branch: params.branch ?? "main",
      metadata: { model_slug: params.model_slug ?? "gpt-5.5", best_of_n: 1 },
    };
    if (params.environment_id) newTask.environment_id = params.environment_id;
    const body: Record<string, unknown> = {
      new_task: newTask,
      input_items: params.input_items,
    };
    const data = await this.whamPost(account, "/wham/tasks", body);
    return { ...data, task_id: String(data.task_id ?? data.id ?? "") };
  }

  async sendFollowUp(
    account: Account,
    taskId: string,
    params: {
      input_items: unknown[];
      turn_id?: string;
      environment_mode?: "ask" | "code";
    }
  ): Promise<TaskResult> {
    const follow_up: Record<string, unknown> = {
      task_id: taskId,
      environment_mode: params.environment_mode ?? "ask",
    };
    if (params.turn_id) follow_up.turn_id = params.turn_id;
    const data = await this.whamPost(account, "/wham/tasks", { follow_up, input_items: params.input_items });
    return { ...data, task_id: String(data.task_id ?? data.id ?? taskId) };
  }

  async cancelTask(account: Account, taskId: string): Promise<void> {
    await this.whamPost(account, `/wham/tasks/${taskId}/cancel`);
  }

  async archiveTask(account: Account, taskId: string): Promise<void> {
    await this.whamPost(account, `/wham/tasks/${taskId}/archive`);
  }

  async recoverTask(account: Account, taskId: string): Promise<void> {
    await this.whamPost(account, `/wham/tasks/${taskId}/recover`);
  }

  async markTaskRead(account: Account, taskId: string): Promise<void> {
    await this.whamPost(account, `/wham/tasks/${taskId}/mark_read`);
  }
}
