import { useEffect } from "react";
import { useColorMode } from "./color-mode";

/** Mirror color-mode của Chakra (next-themes, attribute "class") sang [data-theme] để CSS legacy
 *  (`:root[data-theme]`) ở các màn chưa convert vẫn đổi theme đồng bộ. Gỡ khi đã convert hết. */
export function ColorModeSync() {
  const { colorMode } = useColorMode();
  useEffect(() => {
    if (!colorMode) return;
    document.documentElement.setAttribute("data-theme", colorMode);
    document.documentElement.classList.remove(colorMode === "dark" ? "light" : "dark");
    document.documentElement.classList.add(colorMode);
  }, [colorMode]);
  return null;
}
