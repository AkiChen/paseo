import { join } from "node:path";
import type { Logger } from "pino";
import type { ProjectRegistry, WorkspaceRegistry } from "../workspace-registry.js";
import { WorkLedgerService } from "./service.js";
import type { ScopeResolver } from "./service.js";

export { WorkLedgerService } from "./service.js";
import { WorkLedgerStore } from "./store.js";

export {
  WorkLedgerError,
  isItemVisibleInScope,
  matchItemReference,
  scopeMatches,
} from "./service.js";
export type {
  CreateItemInput,
  MoveItemInput,
  RecordEntryInput,
  ScopeResolver,
  UpdateItemInput,
  WorkLedgerErrorCode,
} from "./service.js";
export { WorkLedgerSequence } from "./sequence.js";
export type { WorkLedgerCursor } from "./sequence.js";
export { WorkLedgerStore } from "./store.js";

export interface WorkLedgerScopeRegistries {
  projects: Pick<ProjectRegistry, "get">;
  workspaces: Pick<WorkspaceRegistry, "get">;
}

/**
 * Resolves ledger scopes against the daemon registries. An archived workspace no
 * longer names a project, so an archived workspace cannot become a new item's owner.
 */
export function createRegistryScopeResolver(registries: WorkLedgerScopeRegistries): ScopeResolver {
  return {
    async projectIdForWorkspace(workspaceId) {
      const workspace = await registries.workspaces.get(workspaceId);
      return workspace && !workspace.archivedAt ? workspace.projectId : null;
    },
    async projectExists(projectId) {
      return (await registries.projects.get(projectId)) !== null;
    },
  };
}

export function createWorkLedgerService(input: {
  paseoHome: string;
  logger: Logger;
  projectRegistry: Pick<ProjectRegistry, "get">;
  workspaceRegistry: Pick<WorkspaceRegistry, "get">;
}): WorkLedgerService {
  const store = new WorkLedgerStore(
    join(input.paseoHome, "work-ledger"),
    input.logger.child({ module: "work-ledger" }),
  );
  return new WorkLedgerService(
    store,
    createRegistryScopeResolver({
      projects: input.projectRegistry,
      workspaces: input.workspaceRegistry,
    }),
  );
}
