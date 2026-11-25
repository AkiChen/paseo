import { randomUUID } from "node:crypto";

export type DownloadTokenKind = "download" | "media";

export interface DownloadTokenEntry {
  token: string;
  kind: DownloadTokenKind;
  path: string;
  absolutePath: string;
  fileName: string;
  mimeType: string;
  size: number;
  expiresAt: number;
}

interface DownloadTokenStoreOptions {
  ttlMs: number;
  /**
   * Lifetime of a media token. Range requests keep arriving while the player
   * seeks, so this is far longer than the single-use download token's TTL.
   * Defaults to 12 hours.
   */
  mediaTtlMs?: number;
  now?: () => number;
}

const DEFAULT_MEDIA_TTL_MS = 12 * 60 * 60 * 1000;

export class DownloadTokenStore {
  private readonly ttlMs: number;
  private readonly mediaTtlMs: number;
  private readonly now: () => number;
  private readonly tokens = new Map<string, DownloadTokenEntry>();

  constructor(options: DownloadTokenStoreOptions) {
    this.ttlMs = options.ttlMs;
    this.mediaTtlMs = options.mediaTtlMs ?? DEFAULT_MEDIA_TTL_MS;
    this.now = options.now ?? (() => Date.now());
  }

  issueToken(input: Omit<DownloadTokenEntry, "token" | "kind" | "expiresAt">): DownloadTokenEntry {
    return this.issue(input, "download", this.ttlMs);
  }

  /**
   * Issue a token the media route accepts for HTTP Range reads. Unlike a
   * download token it is not consumed by its first request: one `<video>`
   * element issues many range requests over the life of the preview.
   */
  issueMediaToken(
    input: Omit<DownloadTokenEntry, "token" | "kind" | "expiresAt">,
  ): DownloadTokenEntry {
    return this.issue(input, "media", this.mediaTtlMs);
  }

  consumeToken(token: string): DownloadTokenEntry | null {
    const entry = this.tokens.get(token);
    if (!entry || entry.kind !== "download") {
      return null;
    }
    return this.take(token);
  }

  /** Read a media token without consuming it. */
  peekMediaToken(token: string): DownloadTokenEntry | null {
    const entry = this.tokens.get(token);
    if (!entry || entry.kind !== "media") {
      return null;
    }
    if (entry.expiresAt <= this.now()) {
      this.tokens.delete(token);
      return null;
    }
    return entry;
  }

  private issue(
    input: Omit<DownloadTokenEntry, "token" | "kind" | "expiresAt">,
    kind: DownloadTokenKind,
    ttlMs: number,
  ): DownloadTokenEntry {
    this.pruneExpired();
    const token = randomUUID();
    const entry: DownloadTokenEntry = {
      ...input,
      token,
      kind,
      expiresAt: this.now() + ttlMs,
    };
    this.tokens.set(token, entry);
    return entry;
  }

  private take(token: string): DownloadTokenEntry | null {
    const entry = this.tokens.get(token);
    if (!entry) {
      return null;
    }

    this.tokens.delete(token);
    if (entry.expiresAt <= this.now()) {
      return null;
    }
    return entry;
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [token, entry] of this.tokens) {
      if (entry.expiresAt <= now) {
        this.tokens.delete(token);
      }
    }
  }
}
