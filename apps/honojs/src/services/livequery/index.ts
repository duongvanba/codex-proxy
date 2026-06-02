import type { AccountsService } from "../accounts";
import type { ConfigPatcherService } from "../config-patcher";
import type { CodexApiService } from "../../libs/chatgpt";
import type { EnrollmentService } from "../../libs/openai";
import type { RemoteControlRegistry } from "../../libs/codex-remote-control";
import type { AccountService } from "../account-service";
import { LivequeryStore } from "./store";

export * from "./types";
export { LivequeryStore } from "./store";

export type LivequeryStoreDependencies = {
  accounts: AccountsService;
  codexApi: CodexApiService;
  registry: RemoteControlRegistry;
  enrollment: EnrollmentService;
  configPatcher: ConfigPatcherService;
  accountService: AccountService;
};

/** Kernel chia sẻ cho mọi LiveQuery controller (state + realtime + refresh). */
export function createLivequeryStore(deps: LivequeryStoreDependencies): LivequeryStore {
  return new LivequeryStore(deps.accounts, deps.codexApi, deps.registry, deps.enrollment, deps.configPatcher, deps.accountService);
}
