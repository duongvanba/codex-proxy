import { useCallback, useEffect, useState } from "react";

export type Theme = "dark" | "light";

function applyTheme(t: Theme) {
  document.documentElement.setAttribute("data-theme", t);
  document.documentElement.classList.remove(t === "dark" ? "light" : "dark");
  document.documentElement.classList.add(t);
  try { localStorage.setItem("codex-theme", t); } catch { /* ignore */ }
}

/** Đọc theme hiện tại reactive (theo dõi <html data-theme> qua MutationObserver) — cập nhật
 *  kể cả khi theme được toggle ở component khác. Dùng cho code block chọn prism style theo theme. */
export function useThemeValue(): Theme {
  const read = (): Theme =>
    (typeof document !== "undefined" ? (document.documentElement.getAttribute("data-theme") as Theme) : "dark") || "dark";
  const [theme, setTheme] = useState<Theme>(read);
  useEffect(() => {
    const el = document.documentElement;
    const obs = new MutationObserver(() => setTheme(read()));
    obs.observe(el, { attributes: true, attributeFilter: ["data-theme"] });
    setTheme(read());
    return () => obs.disconnect();
  }, []);
  return theme;
}

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
      applyTheme(t);
    }
  }, []);

  const toggle = useCallback(() => {
    setThemeState((prev) => {
      const next: Theme = prev === "dark" ? "light" : "dark";
      if (typeof document !== "undefined") {
        applyTheme(next);
      }
      return next;
    });
  }, []);

  return { theme, setTheme, toggle };
}
