import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Star } from "lucide-react-native";
import { View } from "react-native";
import type { Theme } from "@/styles/theme";

const ThemedStar = withUnistyles(Star);

const starredColorMapping = (theme: Theme) => ({
  color: theme.colors.foreground,
  fill: theme.colors.foreground,
});

/**
 * The star that marks a starred sidebar row.
 *
 * Two placements, because the two sidebar lists spend their leading corner differently:
 *
 * - `corner` overhangs the leading icon's bottom-right, for Agents rows whose icon carries
 *   nothing else. The parent slot owns `position: relative`; this only draws.
 * - `inline` sits at the head of the title, for workspace rows whose leading icon already
 *   carries the aggregate status badge, so a second mark on that corner would overlap.
 *
 * Neither placement takes a permanent slot, so unstarred rows keep the rail they had.
 */
export function SidebarStarBadge({ placement = "corner" }: { placement?: "corner" | "inline" }) {
  return (
    <View
      style={placement === "corner" ? styles.corner : styles.inline}
      pointerEvents="none"
      testID="sidebar-row-star-badge"
    >
      <ThemedStar size={placement === "corner" ? 10 : 11} uniProps={starredColorMapping} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  corner: {
    position: "absolute",
    right: -3,
    bottom: -2,
    width: 13,
    height: 13,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.full,
    // A halo rather than a filled chip: the row underneath may be hovered
    // (`surfaceSidebarHover`) or selected (`surfaceSidebarSelected`), and a hard background
    // would match at most one of them. The ring separates the glyph from both.
    backgroundColor: theme.colors.surfaceSidebar,
    borderWidth: 1,
    borderColor: theme.colors.surface2,
  },
  inline: {
    height: 20,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
}));
