import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { mediaKindOf, mediaMimeTypeOf } from "@getpaseo/protocol/media-types";
import { resolveDaemonHttpTarget } from "@/utils/daemon-http-target";
import { useHosts } from "@/runtime/host-runtime";

interface WorkspaceMediaPreviewProps {
  serverId: string;
  cwd: string;
  path: string;
  client: DaemonClient | null;
}

type MediaPreviewState =
  | { status: "loading" }
  | { status: "ready"; url: string; kind: "video" | "audio" }
  | { status: "error"; message: string };

/**
 * Plays a workspace video/audio file by pointing a native media element at the
 * daemon's range-capable `/api/files/media` route.
 *
 * The element does the buffering and seeking itself: the daemon answers Range
 * requests sent with a media token, so a large clip starts playing without the
 * app ever holding its bytes. The token is requested once per file and reused
 * for every range request the element issues.
 */
export function FileMediaPreview({ serverId, cwd, path, client }: WorkspaceMediaPreviewProps) {
  const { t } = useTranslation();
  const daemons = useHosts();
  const daemonProfile = useMemo(
    () => daemons.find((daemon) => daemon.serverId === serverId),
    [daemons, serverId],
  );
  const [state, setState] = useState<MediaPreviewState>({ status: "loading" });
  const mountedRef = useRef(true);
  const mimeType = useMemo(() => mediaMimeTypeOf(path), [path]);
  const kind = useMemo(() => mediaKindOf(path), [path]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadToken = useCallback(async () => {
    const target = resolveDaemonHttpTarget(daemonProfile);
    if (!client || !target.baseUrl || !mimeType || !kind) {
      setState({ status: "error", message: t("panels.file.noPreview") });
      return;
    }
    setState({ status: "loading" });
    try {
      const payload = await client.requestMediaToken(cwd, path);
      if (!mountedRef.current) {
        return;
      }
      if (!payload.token) {
        setState({
          status: "error",
          message: payload.error ?? t("panels.file.failedToLoadPreview"),
        });
        return;
      }
      const url = new URL("/api/files/media", target.baseUrl);
      url.searchParams.set("token", payload.token);
      if (target.authCredentials) {
        url.username = target.authCredentials.username;
        url.password = target.authCredentials.password;
      }
      setState({ status: "ready", url: url.toString(), kind });
    } catch (error) {
      if (!mountedRef.current) {
        return;
      }
      setState({
        status: "error",
        message: error instanceof Error ? error.message : t("panels.file.failedToLoadPreview"),
      });
    }
  }, [client, cwd, daemonProfile, kind, mimeType, path, t]);

  useEffect(() => {
    void loadToken();
  }, [loadToken]);

  const onError = useCallback(() => {
    setState({ status: "error", message: t("panels.file.failedToLoadPreview") });
  }, [t]);

  if (state.status === "loading") {
    return (
      <View style={styles.centerState} testID="media-preview-loading">
        <Text style={styles.mutedText}>{t("panels.file.loading")}</Text>
      </View>
    );
  }

  if (state.status === "error") {
    return (
      <View style={styles.centerState} testID="media-preview-error">
        <Text style={styles.errorText}>{state.message}</Text>
      </View>
    );
  }

  return (
    <View style={styles.container} testID="media-file-preview">
      {state.kind === "video" ? (
        <video
          data-testid="media-video"
          src={state.url}
          controls
          playsInline
          preload="metadata"
          style={VIDEO_STYLE}
          onError={onError}
        />
      ) : (
        <audio
          data-testid="media-audio"
          src={state.url}
          controls
          preload="metadata"
          style={AUDIO_STYLE}
          onError={onError}
        />
      )}
    </View>
  );
}

const VIDEO_STYLE = {
  width: "100%",
  height: "100%",
  maxHeight: "100%",
  objectFit: "contain",
  backgroundColor: "black",
} as const;

const AUDIO_STYLE = {
  width: "100%",
  maxWidth: 560,
} as const;

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface0,
  },
  centerState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[4],
  },
  mutedText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  errorText: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
}));
