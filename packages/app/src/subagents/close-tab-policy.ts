import type { Agent } from "@/stores/session-store";

/**
 * Closing a tab only changes what the layout shows. The session keeps running
 * and stays unarchived, so the shape stays for callers while the outcome is
 * always the same one.
 */
export interface CloseAgentTabPolicy {
  kind: "layout-only";
}

export function resolveCloseAgentTabPolicy(
  _agent: Pick<Agent, "parentAgentId"> | null | undefined,
): CloseAgentTabPolicy {
  return { kind: "layout-only" };
}
