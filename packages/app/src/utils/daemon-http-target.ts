import type { HostProfile } from "@/types/host-connection";
import { buildDaemonWebSocketUrl } from "@/utils/daemon-endpoints";

export interface DaemonHttpTarget {
  /** Origin the daemon's HTTP routes answer on, or null when the host has no direct TCP connection. */
  baseUrl: string | null;
  /** Basic-auth header for native downloads; web media uses the token alone. */
  authHeader: string | null;
  authCredentials: { username: string; password: string } | null;
}

/**
 * Resolve the daemon's HTTP origin from a host profile's direct TCP connection.
 *
 * The client connects to the daemon over a WebSocket URL; HTTP routes (`/api/...`)
 * answer on the same origin. `buildDaemonWebSocketUrl` already carries the
 * credentials the connection URI declared, so they are split out here instead of
 * being embedded in every request URL.
 */
export function resolveDaemonHttpTarget(daemon?: HostProfile): DaemonHttpTarget {
  const connection = daemon?.connections.find((conn) => conn.type === "directTcp") ?? null;
  if (!connection) {
    return { baseUrl: null, authHeader: null, authCredentials: null };
  }

  let parsed: URL;
  try {
    parsed = new URL(
      buildDaemonWebSocketUrl(connection.endpoint, { useTls: connection.useTls ?? false }),
    );
  } catch {
    return { baseUrl: null, authHeader: null, authCredentials: null };
  }

  if (parsed.protocol === "ws:") {
    parsed.protocol = "http:";
  } else if (parsed.protocol === "wss:") {
    parsed.protocol = "https:";
  }

  let authCredentials: { username: string; password: string } | null = null;
  if (parsed.username || parsed.password) {
    authCredentials = {
      username: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
    };
    parsed.username = "";
    parsed.password = "";
  }

  parsed.pathname = parsed.pathname.replace(/\/ws\/?$/, "/");

  return {
    baseUrl: parsed.origin,
    authHeader: authCredentials
      ? `Basic ${btoa(`${authCredentials.username}:${authCredentials.password}`)}`
      : null,
    authCredentials,
  };
}
