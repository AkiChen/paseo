import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { selectRecentAgents } from "@/components/sidebar/sidebar-recent-agents-model";
import { deriveSidebarStateBucket } from "@/utils/sidebar-agent-state";

export interface AgentStatusSummaryCounts {
  /** Waiting for the user to answer or grant permission. */
  waiting: number;
  failed: number;
  /** Finished turns that are ready for the user to review. */
  attention: number;
  running: number;
}

/**
 * Counts the agents the sidebar lists in its Agents mode: root agents only,
 * archived agents excluded. The buckets mirror the sidebar's status groups
 * minus done: the header only surfaces work that is moving or needs the user,
 * and a green check means the same thing in both places (`attention`).
 */
export function summarizeAgentStatusCounts(
  agents: readonly AggregatedAgent[],
): AgentStatusSummaryCounts {
  const counts: AgentStatusSummaryCounts = {
    waiting: 0,
    failed: 0,
    attention: 0,
    running: 0,
  };

  for (const agent of selectRecentAgents(agents)) {
    // A starting agent is active work, but the canonical bucket files it under
    // done until its first turn opens. The header is a liveness readout, so
    // count it as running instead of flashing a false "done".
    if (agent.status === "initializing") {
      counts.running += 1;
      continue;
    }

    const bucket = deriveSidebarStateBucket({
      status: agent.status,
      requiresAttention: Boolean(agent.requiresAttention),
      attentionReason: agent.attentionReason ?? null,
      pendingPermissionCount: agent.pendingPermissionCount ?? 0,
    });

    if (bucket === "needs_input") {
      counts.waiting += 1;
    } else if (bucket === "failed") {
      counts.failed += 1;
    } else if (bucket === "attention") {
      counts.attention += 1;
    } else if (bucket === "running") {
      counts.running += 1;
    }
    // `done` is intentionally silent: it asks nothing of the user, and a
    // top-bar count for it would only add noise.
  }

  return counts;
}
