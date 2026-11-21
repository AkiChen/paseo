import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { Pressable, Text } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import type { Theme } from "@/styles/theme";

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

export function PinnedSectionHeader({
  collapsed,
  onToggle,
}: {
  collapsed: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  return (
    <SidebarSectionHeader
      title={t("sidebar.pinned.title")}
      collapsed={collapsed}
      onToggle={onToggle}
      testID="sidebar-pinned-section-header"
    />
  );
}

/**
 * The collapse toggle above a hoisted sidebar section — Pinned, Favorites. Both are one flat
 * list of rows under a muted title, so they share the header rather than growing a variant each.
 */
export function SidebarSectionHeader({
  title,
  collapsed,
  onToggle,
  testID,
}: {
  title: string;
  collapsed: boolean;
  onToggle: () => void;
  testID: string;
}) {
  const isCompact = useIsCompactFormFactor();
  const accessibilityState = useMemo(() => ({ expanded: !collapsed }), [collapsed]);
  const Chevron = collapsed ? ThemedChevronRight : ThemedChevronDown;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      onPress={onToggle}
      style={styles.header}
      testID={testID}
    >
      {({ hovered }) => (
        <>
          <Text style={styles.title}>{title}</Text>
          {hovered || isNative || isCompact ? (
            <Chevron size={12} uniProps={foregroundMutedColorMapping} />
          ) : null}
        </>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  header: {
    minHeight: 36,
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    userSelect: "none",
  },
  title: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
}));
