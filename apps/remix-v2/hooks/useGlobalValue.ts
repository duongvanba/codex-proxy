const WINDOW_GLOBAL_KEY = Symbol.for("CodexRemixGlobalValue");

export function useGlobalValue<T>(key: string, resolver: () => T): T {
  const global = globalThis as typeof globalThis & {
    [WINDOW_GLOBAL_KEY]?: Record<string, unknown>;
  };
  global[WINDOW_GLOBAL_KEY] ??= {};
  if (!(key in global[WINDOW_GLOBAL_KEY])) {
    global[WINDOW_GLOBAL_KEY][key] = resolver();
  }
  return global[WINDOW_GLOBAL_KEY][key] as T;
}
