import { MoonIcon, SunIcon } from "lucide-react";
import type { ComponentProps } from "react";

import { useTheme } from "../../hooks/useTheme";
import { getThemeColorsForMode, getThemeDefinition } from "../../themePalette";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const defaultTrigger = (
  <Button variant="ghost" size="icon-sm" className="[-webkit-app-region:no-drag]" />
);

export function AppearanceToggleButton({
  render = defaultTrigger,
  tooltipSide = "bottom",
}: {
  readonly render?: ComponentProps<typeof TooltipTrigger>["render"];
  readonly tooltipSide?: "top" | "bottom";
} = {}) {
  const { resolvedTheme, theme, themeHalves, setAppearanceMode } = useTheme();
  const nextMode = resolvedTheme === "dark" ? "light" : "dark";
  const label = `Switch to ${nextMode} mode`;
  const palette = getThemeDefinition(theme);
  const canSwitch =
    palette === null ||
    Boolean(themeHalves?.[nextMode]) ||
    getThemeColorsForMode(palette, nextMode) !== null;
  const Icon = nextMode === "dark" ? MoonIcon : SunIcon;

  return (
    <Tooltip>
      <TooltipTrigger
        render={render}
        aria-label={label}
        aria-disabled={!canSwitch || undefined}
        onClick={() => {
          if (canSwitch && !setAppearanceMode(nextMode)) {
            toastManager.add(
              stackedThreadToast({ type: "error", title: "Couldn't switch appearance" }),
            );
          }
        }}
      >
        <Icon aria-hidden />
      </TooltipTrigger>
      <TooltipPopup side={tooltipSide}>
        {canSwitch ? label : `This theme only supports ${resolvedTheme} mode`}
      </TooltipPopup>
    </Tooltip>
  );
}
