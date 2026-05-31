import { useCallback, useState } from "react";

export type Theme = "dark" | "light";

/** Quản lý theme (dark/light) — đồng bộ với <html data-theme> + localStorage. */
export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(() => {
    if (typeof document !== "undefined") {
      return (document.documentElement.getAttribute("data-theme") as Theme) || "dark";
    }
    return "dark";
  });

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    if (typeof document !== "undefined") {
      document.documentElement.setAttribute("data-theme", t);
      try { localStorage.setItem("codex-theme", t); } catch { /* ignore */ }
    }
  }, []);

  const toggle = useCallback(() => {
    setThemeState((prev) => {
      const next: Theme = prev === "dark" ? "light" : "dark";
      if (typeof document !== "undefined") {
        document.documentElement.setAttribute("data-theme", next);
        try { localStorage.setItem("codex-theme", next); } catch { /* ignore */ }
      }
      return next;
    });
  }, []);

  return { theme, setTheme, toggle };
}
