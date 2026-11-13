import {
  isTerminalWorkLedgerStatus,
  type WorkLedgerAgentLink,
  type WorkLedgerAttentionReason,
  type WorkLedgerItem,
  type WorkLedgerStatus,
} from "@getpaseo/protocol/work-ledger/types";
import type { WorkLedgerHostSnapshot } from "@/work-ledger";

/** One host's ledger as the index sees it. */
export interface WorkLedgerHostView {
  serverId: string;
  serverName: string;
  items: readonly WorkLedgerItem[];
  status: WorkLedgerHostSnapshot["status"];
  error: string | null;
  syncedAt: string | null;
}

export interface WorkLedgerRow {
  serverId: string;
  serverName: string;
  item: WorkLedgerItem;
  showServer: boolean;
  /** Agents rendered with role and link state, confirmed links before candidates. */
  agents: readonly WorkLedgerAgentLink[];
}

export type WorkLedgerStatusFilter = "all" | WorkLedgerStatus | "attention";
export type WorkLedgerScopeFilter =
  | { kind: "all" }
  | { kind: "project"; projectId: string }
  | { kind: "workspace"; workspaceId: string };

export interface WorkLedgerFilters {
  query: string;
  status: WorkLedgerStatusFilter;
  scope: WorkLedgerScopeFilter;
}

export type WorkLedgerBodyState =
  | { kind: "loading" }
  | { kind: "unsupported" }
  | { kind: "load-error" }
  | { kind: "empty" }
  | { kind: "content" };

function normalizeQuery(value: string): string {
  return value.trim().toLowerCase();
}

function itemMatchesQuery(item: WorkLedgerItem, query: string): boolean {
  if (!query) return true;
  const haystack = [
    item.number,
    item.title,
    item.latestSummary ?? "",
    item.goal ?? "",
    item.blockedReason ?? "",
    item.attentionNote ?? "",
    ...item.agents.map((link) => link.agentId),
    ...item.agents.flatMap((link) => (link.label ? [link.label] : [])),
  ]
    .join("\n")
    .toLowerCase();
  return haystack.includes(query);
}

function itemMatchesScope(item: WorkLedgerItem, scope: WorkLedgerScopeFilter): boolean {
  if (scope.kind === "all") return true;
  if (scope.kind === "project") return item.projectId === scope.projectId;
  return (
    item.workspaceId === scope.workspaceId ||
    (item.scope.kind === "workspace" && item.scope.workspaceId === scope.workspaceId)
  );
}

/**
 * Status buckets follow the index's chips, except finished work: completed and
 * cancelled items appear only when asked for, so an old ledger does not bury what
 * is live. "Attention" is cross-cutting and overlaps every bucket by design.
 */
export function itemMatchesStatusFilter(
  item: WorkLedgerItem,
  filter: WorkLedgerStatusFilter,
): boolean {
  if (filter === "all") return !isTerminalWorkLedgerStatus(item.status);
  if (filter === "attention") return item.attention.length > 0;
  return item.status === filter;
}

/** Confirmed links first; a candidate never outranks a fact. Role orders within that. */
export function orderAgentLinks(links: readonly WorkLedgerAgentLink[]): WorkLedgerAgentLink[] {
  const roleRank = { executor: 0, verifier: 1, monitor: 2 } as const;
  return [...links].sort((left, right) => {
    if (left.state !== right.state) return left.state === "confirmed" ? -1 : 1;
    if (left.role !== right.role) return roleRank[left.role] - roleRank[right.role];
    return left.agentId.localeCompare(right.agentId);
  });
}

/** Most recent real movement first; inspections alone do not outrank it. */
function recency(item: WorkLedgerItem): number {
  const progressed = item.lastProgressAt ? Date.parse(item.lastProgressAt) : 0;
  const inspected = item.lastInspectedAt ? Date.parse(item.lastInspectedAt) : 0;
  const updated = Date.parse(item.updatedAt);
  return Math.max(progressed, inspected, Number.isNaN(updated) ? 0 : updated);
}

export function buildWorkLedgerRows(input: {
  hosts: readonly WorkLedgerHostView[];
  filters: WorkLedgerFilters;
}): WorkLedgerRow[] {
  const query = normalizeQuery(input.filters.query);
  const showServer =
    input.hosts.filter((host) => host.status === "online" && host.items.length > 0).length > 1;
  return input.hosts
    .flatMap((host) =>
      host.status !== "online"
        ? []
        : host.items
            .filter(
              (item) =>
                itemMatchesStatusFilter(item, input.filters.status) &&
                itemMatchesScope(item, input.filters.scope) &&
                itemMatchesQuery(item, query),
            )
            .map((item) => ({
              serverId: host.serverId,
              serverName: host.serverName,
              item,
              showServer,
              agents: orderAgentLinks(item.agents),
            })),
    )
    .sort((left, right) => recency(right.item) - recency(left.item));
}

export function resolveWorkLedgerBodyState(input: {
  hosts: readonly WorkLedgerHostView[];
  rows: readonly WorkLedgerRow[];
  filtersActive: boolean;
}): WorkLedgerBodyState {
  const online = input.hosts.filter((host) => host.status === "online");
  const loading = online.some((host) => host.syncedAt === null && host.error === null);
  if (input.hosts.length === 0) return { kind: "loading" };
  if (input.hosts.every((host) => host.status === "unsupported")) return { kind: "unsupported" };
  if (online.length === 0) {
    return input.hosts.some((host) => host.error !== null)
      ? { kind: "load-error" }
      : { kind: "loading" };
  }
  if (loading && input.rows.length === 0) return { kind: "loading" };
  if (online.every((host) => host.error !== null && host.syncedAt === null)) {
    return { kind: "load-error" };
  }
  const totalItems = online.reduce((total, host) => total + host.items.length, 0);
  if (totalItems === 0) return { kind: "empty" };
  if (input.rows.length === 0 && input.filtersActive) return { kind: "empty" };
  return { kind: "content" };
}

export interface WorkLedgerScopeOption {
  id: string;
  label: string;
  scope: WorkLedgerScopeFilter;
}

/**
 * Scope choices for a workspace screen: everything, the item's project(s), and this
 * workspace. Projects come from the registry when it knows them, so an archived or
 * not-yet-loaded project still gets a stable label instead of disappearing.
 */
export function buildScopeOptions(input: {
  projects: readonly { projectId: string; name: string }[];
  items: readonly WorkLedgerItem[];
  workspace?: { workspaceId: string; name: string };
  allLabel?: string;
}): WorkLedgerScopeOption[] {
  const names = new Map(input.projects.map((project) => [project.projectId, project.name]));
  const projectIds = new Set<string>();
  for (const item of input.items) projectIds.add(item.projectId);
  for (const project of input.projects) projectIds.add(project.projectId);
  const options: WorkLedgerScopeOption[] = [
    { id: "all", label: input.allLabel ?? "All projects", scope: { kind: "all" } },
  ];
  // Sorted by label: registry order is insertion order, which is not a reading order.
  const projectOptions = [...projectIds]
    .map((projectId) => ({
      id: `project:${projectId}`,
      label: names.get(projectId) ?? projectId,
      scope: { kind: "project" as const, projectId },
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
  options.push(...projectOptions);
  if (input.workspace) {
    options.push({
      id: `workspace:${input.workspace.workspaceId}`,
      label: input.workspace.name,
      scope: { kind: "workspace", workspaceId: input.workspace.workspaceId },
    });
  }
  return options;
}

export function collectAttentionCounts(hosts: readonly WorkLedgerHostView[]): {
  attention: number;
  review: number;
  inProgress: number;
  total: number;
} {
  let attention = 0;
  let review = 0;
  let inProgress = 0;
  let total = 0;
  for (const host of hosts) {
    // Cached items count: a host whose status has not settled still has work worth
    // naming in the summary.
    for (const item of host.items) {
      total += 1;
      if (item.attention.length > 0) attention += 1;
      if (item.status === "review") review += 1;
      if (item.status === "in_progress") inProgress += 1;
    }
  }
  return { attention, review, inProgress, total };
}

/**
 * Which hosts the popup reads. It is a summary, not a host-scoped view: by default it
 * covers every host that has data, because an item written by an agent on another
 * daemon is exactly the thing a user is looking for here.
 *
 * Hosts with no items and hosts that do not serve the ledger are dropped; a host
 * whose status has not settled (offline, still connecting) still contributes its
 * cached items. Hiding real work behind a status flag is worse than showing items a
 * moment stale.
 */
export function selectPopupHosts(input: {
  hosts: readonly WorkLedgerHostView[];
  serverId?: string;
}): WorkLedgerHostView[] {
  return input.hosts.filter((host) => {
    if (host.status === "unsupported") return false;
    if (host.items.length > 0) return true;
    // An empty host only earns a slot while it is the one being looked at, so the
    // popup can still say "nothing here yet" for the workspace the user is in.
    return host.serverId === input.serverId;
  });
}

export function sortAttentionReasons(
  reasons: readonly WorkLedgerAttentionReason[],
): WorkLedgerAttentionReason[] {
  const rank: Record<WorkLedgerAttentionReason, number> = {
    blocked: 0,
    needs_input: 1,
    awaiting_confirmation: 2,
    missing_evidence: 3,
    stalled: 4,
  };
  return [...reasons].sort((left, right) => rank[left] - rank[right]);
}
