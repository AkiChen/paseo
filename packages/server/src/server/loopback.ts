const LOOPBACK_REMOTE_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * Whether a request arrived over this host's own loopback interface.
 *
 * Clients reach a daemon on another machine through their own SSH tunnel, so
 * the daemon sees a loopback peer even though the client is remote. An intranet
 * host that connects to the daemon port directly does not — that distinction is
 * what keeps loopback-only routes loopback-only.
 */
export function isLoopbackRemoteAddress(remoteAddress: string | undefined): boolean {
  return remoteAddress !== undefined && LOOPBACK_REMOTE_ADDRESSES.has(remoteAddress);
}
