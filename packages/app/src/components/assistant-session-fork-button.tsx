import { memo, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text } from "react-native";
import { GitFork } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ICON_SIZE } from "@/styles/theme";

interface AssistantSessionForkButtonProps {
  /** Branch the provider session. Errors are surfaced by the caller's toast. */
  onFork: () => Promise<void> | void;
  testID?: string;
}

/**
 * The native counterpart to the chat-history fork menu: same turn boundary, but
 * the provider branches its own session instead of the history being pasted into
 * a fresh one. Only rendered when the agent advertises `supportsSessionFork`.
 */
export const AssistantSessionForkButton = memo(function AssistantSessionForkButton({
  onFork,
  testID = "assistant-session-fork",
}: AssistantSessionForkButtonProps) {
  const { t } = useTranslation();
  const [pending, setPending] = useState(false);

  const handlePress = useCallback(async () => {
    if (pending) {
      return;
    }
    setPending(true);
    try {
      await onFork();
    } finally {
      setPending(false);
    }
  }, [onFork, pending]);

  const pressableStyle = useMemo(
    () => [stylesheet.trigger, pending ? stylesheet.triggerDisabled : null],
    [pending],
  );

  return (
    <Tooltip delayDuration={250} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger asChild>
        <Pressable
          accessibilityLabel={t("message.actions.forkSession")}
          accessibilityRole="button"
          disabled={pending}
          onPress={handlePress}
          style={pressableStyle}
          testID={`${testID}-trigger`}
        >
          {({ hovered }) => (
            <GitFork
              size={ICON_SIZE.sm}
              color={
                hovered || pending ? stylesheet.iconHoveredColor.color : stylesheet.iconColor.color
              }
            />
          )}
        </Pressable>
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={8}>
        <Text style={stylesheet.tooltipText}>{t("message.actions.forkSession")}</Text>
      </TooltipContent>
    </Tooltip>
  );
});

const stylesheet = StyleSheet.create((theme) => ({
  trigger: {
    padding: theme.spacing[1],
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "transparent",
  },
  triggerDisabled: {
    opacity: theme.opacity[50],
  },
  iconColor: {
    color: theme.colors.foregroundMuted,
  },
  iconHoveredColor: {
    color: theme.colors.foreground,
  },
  tooltipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
}));
