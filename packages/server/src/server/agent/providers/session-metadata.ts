import { z } from "zod";
import { createDshProjCacheReader } from "./dsh-projcache-session-metadata.js";

/**
 * Session metadata a provider keeps on its own disk but never sends over ACP.
 *
 * ACP can describe a session with a title, an update time, and — through
 * `loadSession` — prompt previews. Providers that implement neither leave the
 * import list showing "untitled session" and 1970, which is what a DSH session
 * looked like before this existed. The data was already on the same machine, so
 * a provider can opt in to having it read instead of waiting for the provider to
 * grow the ACP side.
 *
 * Readers are best effort by contract: a missing, stale, or reformatted store
 * yields no metadata, never an error, and the ACP values stay authoritative for
 * every field the provider does send.
 */

export const SessionMetadataSchema = z.object({
  /** Which private store to read. Only the DSH project cache exists today. */
  kind: z.literal("dsh-projcache"),
  /** Provider home holding the store. Defaults to `~/.dsh`. */
  home: z.string().optional(),
});

export type SessionMetadataSource = z.infer<typeof SessionMetadataSchema>;

export interface SessionMetadata {
  title?: string;
  firstPromptPreview?: string;
  lastPromptPreview?: string;
  lastActivityAt?: Date;
  /**
   * False when the store says the session never recorded a message. Providers
   * create throwaway sessions for their own probes, and Paseo hides an empty
   * session from the import list — this is how a store-only provider says so.
   * Left undefined when the store cannot tell.
   */
  hasConversation?: boolean;
}

export interface ImportableSessionFields {
  title: string | null;
  firstPromptPreview: string | null;
  lastPromptPreview: string | null;
  lastActivityAt: Date;
}

/** Reads one session's metadata. Returns null when the store has nothing. */
export type SessionMetadataReader = (sessionId: string) => Promise<SessionMetadata | null>;

/**
 * A source the provider config asked for, or null when it asked for nothing or
 * for something this build does not know.
 */
export function resolveSessionMetadataSource(
  providerParams: unknown,
): SessionMetadataSource | null {
  if (!providerParams || typeof providerParams !== "object" || Array.isArray(providerParams)) {
    return null;
  }
  const candidate = (providerParams as Record<string, unknown>).sessionMetadata;
  const parsed = SessionMetadataSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export function createSessionMetadataReader(
  source: SessionMetadataSource | null,
): SessionMetadataReader | null {
  if (!source) {
    return null;
  }
  switch (source.kind) {
    case "dsh-projcache":
      return createDshProjCacheReader(source);
    default:
      return null;
  }
}

/**
 * Fills the fields ACP left empty. Anything the provider did send wins, so an
 * ACP implementation that catches up later needs no change here. An epoch
 * `lastActivityAt` is the ACP client's way of saying "no time was sent", and is
 * the only value the store is allowed to overwrite.
 */
export function mergeSessionMetadata(
  fields: ImportableSessionFields,
  metadata: SessionMetadata | null,
): ImportableSessionFields {
  if (!metadata) {
    return fields;
  }
  return {
    title: fields.title ?? metadata.title ?? null,
    firstPromptPreview: fields.firstPromptPreview ?? metadata.firstPromptPreview ?? null,
    lastPromptPreview: fields.lastPromptPreview ?? metadata.lastPromptPreview ?? null,
    lastActivityAt:
      fields.lastActivityAt.getTime() > 0
        ? fields.lastActivityAt
        : (metadata.lastActivityAt ?? fields.lastActivityAt),
  };
}
