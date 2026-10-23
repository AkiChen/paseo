import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { STATUS_BUCKET_LABELS } from "@/hooks/sidebar-status-view-model";
import {
  deriveSidebarStateBucket,
  STATUS_BUCKET_ORDER,
  type SidebarStateBucket,
} from "@/utils/sidebar-agent-state";

export interface RecentAgentGroup {
  bucket: SidebarStateBucket;
  label: string;
  agents: AggregatedAgent[];
}

/**
 * The agents the sidebar lists in its Agents mode.
 *
 * Root agents only: a subagent is a tool call's child that the parent track owns, so surfacing it
 * next to the conversations the user switches between would present implementation detail as a
 * destination. Archived agents are closed, not recent.
 */
export function selectRecentAgents(agents: readonly AggregatedAgent[]): AggregatedAgent[] {
  return agents
    .filter((agent) => !agent.archivedAt && !agent.parentAgentId)
    .sort(compareRecentAgents);
}

/**
 * Groups the recent agents the way the workspace list already groups workspaces.
 *
 * Running agents sort by id, not by activity. Their activity updates constantly, and a list that
 * reorders under the pointer is worse than one whose order is arbitrary but fixed; the id is the
 * only stable key an agent has. Every other bucket keeps newest-activity-first, because there the
 * user is looking for what just happened rather than trying to click a moving target.
 */
export function buildRecentAgentGroups(agents: readonly AggregatedAgent[]): RecentAgentGroup[] {
  const buckets = new Map<SidebarStateBucket, AggregatedAgent[]>();
  for (const agent of selectRecentAgents(agents)) {
    const bucket = deriveSidebarStateBucket({
      status: agent.status,
      requiresAttention: Boolean(agent.requiresAttention),
      attentionReason: agent.attentionReason ?? null,
      pendingPermissionCount: agent.pendingPermissionCount ?? 0,
    });
    const rows = buckets.get(bucket) ?? [];
    rows.push(agent);
    buckets.set(bucket, rows);
  }

  const groups: RecentAgentGroup[] = [];
  for (const bucket of STATUS_BUCKET_ORDER) {
    const rows = buckets.get(bucket);
    if (!rows || rows.length === 0) {
      continue;
    }
    rows.sort(bucket === "running" ? compareByAgentId : compareRecentAgents);
    groups.push({ bucket, label: STATUS_BUCKET_LABELS[bucket], agents: rows });
  }
  return groups;
}

function compareRecentAgents(left: AggregatedAgent, right: AggregatedAgent): number {
  const byActivity = right.lastActivityAt.getTime() - left.lastActivityAt.getTime();
  if (byActivity !== 0) {
    return byActivity;
  }
  return compareByAgentId(left, right);
}

function compareByAgentId(left: AggregatedAgent, right: AggregatedAgent): number {
  if (left.serverId !== right.serverId) {
    return left.serverId.localeCompare(right.serverId);
  }
  return left.id.localeCompare(right.id);
}
