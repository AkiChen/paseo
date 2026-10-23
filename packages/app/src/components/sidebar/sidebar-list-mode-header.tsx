import { router } from "expo-router";
import { History } from "lucide-react-native";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { SidebarDisplayPreferencesMenu } from "@/components/sidebar/display-preferences/menu";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useSidebarListModeStore, type SidebarListMode } from "@/stores/sidebar-list-mode-store";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { buildSessionsRoute } from "@/utils/host-routes";

const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedHistory = withUnistyles(History);

const MODE_OPTIONS: readonly { value: SidebarListMode; labelKey: string; testID: string }[] = [
  {
    value: "workspaces",
    labelKey: "sidebar.listMode.workspaces",
    testID: "sidebar-mode-workspaces",
  },
  { value: "agents", labelKey: "sidebar.listMode.agents", testID: "sidebar-mode-agents" },
];

/**
 * The switch between the workspace tree and the agent list, plus the one action that belongs to
 * the current mode: display preferences configure workspace rows, History is where the agents
 * that have been archived or aged out still live.
 */
export function SidebarListModeHeader({ onBeforeNavigate }: { onBeforeNavigate?: () => void }) {
  const { t } = useTranslation();
  const mode = useSidebarListModeStore((state) => state.mode);
  const setMode = useSidebarListModeStore((state) => state.setMode);
  const options: SegmentedControlOption<SidebarListMode>[] = MODE_OPTIONS.map((option) => ({
    value: option.value,
    label: t(option.labelKey),
    testID: option.testID,
  }));

  const handleOpenHistory = useCallback(() => {
    onBeforeNavigate?.();
    router.push(buildSessionsRoute());
  }, [onBeforeNavigate]);

  const historyButtonStyle = useCallback(
    ({ hovered }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.iconButton,
      Boolean(hovered) && styles.iconButtonHovered,
    ],
    [],
  );

  return (
    <View style={styles.container}>
      <SegmentedControl
        size="xs"
        options={options}
        value={mode}
        onValueChange={setMode}
        testID="sidebar-list-mode"
      />
      <View style={styles.actions}>
        {mode === "workspaces" ? (
          <Tooltip delayDuration={300}>
            <TooltipTrigger asChild>
              <View>
                <SidebarDisplayPreferencesMenu />
              </View>
            </TooltipTrigger>
            <TooltipContent side="bottom" align="center" offset={8}>
              <Text style={styles.tooltipText}>{t("sidebar.display.trigger")}</Text>
            </TooltipContent>
          </Tooltip>
        ) : (
          <Tooltip delayDuration={300}>
            <TooltipTrigger asChild>
              <Pressable
                accessible
                accessibilityLabel={t("sidebar.sections.sessions")}
                accessibilityRole="button"
                onPress={handleOpenHistory}
                style={historyButtonStyle}
                testID="sidebar-mode-history"
              >
                {({ hovered }) => (
                  <ThemedHistory
                    size={ICON_SIZE.sm}
                    uniProps={hovered ? foregroundColorMapping : foregroundMutedColorMapping}
                  />
                )}
              </Pressable>
            </TooltipTrigger>
            <TooltipContent side="bottom" align="center" offset={8}>
              <Text style={styles.tooltipText}>{t("sidebar.sections.sessions")}</Text>
            </TooltipContent>
          </Tooltip>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flexDirection: "row",
    alignItems: "center",
    // The narrowest sidebar leaves just enough room for the segments and pushes the action to a
    // second line instead of letting it clip.
    flexWrap: "wrap",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[1],
  },
  actions: {
    marginLeft: "auto",
    flexDirection: "row",
    alignItems: "center",
  },
  iconButton: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
  },
  iconButtonHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  tooltipText: {
    color: theme.colors.popoverForeground,
    fontSize: theme.fontSize.base,
  },
}));
