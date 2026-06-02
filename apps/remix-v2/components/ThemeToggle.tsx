import { IconButton } from "@chakra-ui/react";
import { LuMoon, LuSun } from "react-icons/lu";
import { useColorMode } from "@components/ui/color-mode";

/** Đổi giao diện sáng/tối qua color-mode của Chakra (next-themes). ColorModeSync mirror
 *  sang data-theme để các màn legacy chưa convert cũng đổi theo. */
export function ThemeToggle() {
  const { colorMode, toggleColorMode } = useColorMode();
  return (
    <IconButton
      aria-label="Đổi giao diện sáng/tối"
      title="Đổi giao diện sáng/tối"
      variant="ghost"
      size="sm"
      onClick={toggleColorMode}
    >
      {colorMode === "dark" ? <LuMoon /> : <LuSun />}
    </IconButton>
  );
}
