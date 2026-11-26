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
 * Ceiling for in-memory playback on SSH/relay hosts. The WebSocket file
 * transfer has no streaming consumer on this side yet, so a larger file would
 * sit in the renderer's heap; failing loudly is better than stalling the app.
 */
const MAX_INLINE_MEDIA_BYTES = 128 * 1024 * 1024;

/**
 * Plays a workspace video/audio file in a native media element.
 *
 * Two transports feed the element:
 * - a direct-TCP host has an HTTP origin, so the element streams from the
 *   daemon's `/api/files/media` route with a media token and range requests;
 * - an SSH or relay host has no HTTP origin on this machine, so the bytes come
 *   over the authenticated WebSocket file transfer and play from a Blob URL.
 *
 * The Blob path holds the file in memory, which is fine for the short clips the
 * agents produce but is why the direct route exists as the preferred path.
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
  const objectUrlRef = useRef<string | null>(null);
  const mimeType = useMemo(() => mediaMimeTypeOf(path), [path]);
  const kind = useMemo(() => mediaKindOf(path), [path]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (objectUrlRef.current !== null) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
    };
  }, []);

  const loadMedia = useCallback(async () => {
    if (!client || !mimeType || !kind) {
      setState({ status: "error", message: t("panels.file.noPreview") });
      return;
    }
    setState({ status: "loading" });
    const target = resolveDaemonHttpTarget(daemonProfile);
    try {
      if (target.baseUrl) {
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
        return;
      }

      // SSH and relay hosts: the WebSocket transport is the only channel to the
      // daemon, so the file arrives as binary frames and plays from memory.
      const file = await client.readFile(cwd, path, undefined, MAX_INLINE_MEDIA_BYTES);
      if (!mountedRef.current) {
        return;
      }
      if (file.kind !== "binary") {
        setState({ status: "error", message: t("panels.file.noPreview") });
        return;
      }
      const blob = new Blob([file.bytes.slice().buffer], { type: file.mime || mimeType });
      if (objectUrlRef.current !== null) {
        URL.revokeObjectURL(objectUrlRef.current);
      }
      objectUrlRef.current = URL.createObjectURL(blob);
      setState({ status: "ready", url: objectUrlRef.current, kind });
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
    void loadMedia();
  }, [loadMedia]);

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
