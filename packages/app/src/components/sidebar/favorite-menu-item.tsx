import { useTranslation } from "react-i18next";
import { Star } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import type { ReactElement } from "react";
import type { Theme } from "@/styles/theme";

const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
// A starred row says so by filling the star. `fill` is what react-native-svg paints its glyph
// with, on web and native alike; passing a mapping is the same shape the `color` mapping uses.
const filledStarMapping = (theme: Theme) => ({
  color: theme.colors.foreground,
  fill: theme.colors.foreground,
});

const ThemedStar = withUnistyles(Star);

const starLeadingIcon = <ThemedStar size={14} uniProps={foregroundMutedColorMapping} />;
const filledStarLeadingIcon = <ThemedStar size={14} uniProps={filledStarMapping} />;

/**
 * The star's icon and label, shared by every menu that can star a row.
 *
 * Agents mode and workspace mode are separate lists with separate menus and separate sets of
 * stars. They must not grow separate ideas of what a starred row looks like, which is exactly
 * how the workspace menu once shipped without a star at all.
 */
export function FavoriteMenuItemContent({ isFavorite }: { isFavorite: boolean }): {
  leading: ReactElement;
  label: string;
} {
  const { t } = useTranslation();
  return {
    leading: isFavorite ? filledStarLeadingIcon : starLeadingIcon,
    label: isFavorite
      ? t("sidebar.workspace.actions.unfavorite")
      : t("sidebar.workspace.actions.favorite"),
  };
}
