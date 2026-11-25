import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

interface WorkspaceMediaPreviewProps {
  serverId: string;
  cwd: string;
  path: string;
  client: DaemonClient | null;
}

/**
 * Native fallback for a workspace media file.
 *
 * The daemon's media route streams over plain HTTP Range, which the native media
 * components could consume too, but their HTTP stacks differ per platform and
 * the explicit download/share path already exists. Until that is wired, mobile
 * says so instead of decoding bytes as text.
 */
export function FileMediaPreview(_props: WorkspaceMediaPreviewProps) {
  const { t } = useTranslation();
  return (
    <View style={styles.centerState} testID="media-preview-unavailable">
      <Text style={styles.emptyText}>{t("panels.file.noPreview")}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  centerState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[4],
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
}));
