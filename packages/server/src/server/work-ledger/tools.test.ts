import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type {
  PaseoToolConfig,
  PaseoToolExecutionContext,
  PaseoToolResult,
} from "../agent/tools/types.js";
import { WorkLedgerService, WorkLedgerStore } from "./index.js";
import { registerWorkLedgerTools } from "./tools.js";

const logger = pino({ level: "silent" });
const PROJECT_ID = "prj_alpha";
const WORKSPACE_ID = "ws_main";

interface RegisteredTool {
  config: PaseoToolConfig;
  handler: (input: unknown, context: PaseoToolExecutionContext) => Promise<PaseoToolResult>;
}

function harness(options: { agentId?: string } = {}) {
  const tools = new Map<string, RegisteredTool>();
  return {
    tools,
    registerTool: (
      name: string,
      config: PaseoToolConfig,
      handler: RegisteredTool["handler"],
    ): void => {
      tools.set(name, { config, handler });
    },
    agentId: options.agentId ?? "agent-executor",
  };
}

async function call(
  registered: Map<string, RegisteredTool>,
  name: string,
  input: unknown,
): Promise<Record<string, unknown>> {
  const tool = registered.get(name);
  if (!tool) throw new Error(`tool not registered: ${name}`);
  const result = await tool.handler(input, {});
  return result.structuredContent as Record<string, unknown>;
}

describe("work ledger agent tools", () => {
  let dir: string;
  let service: WorkLedgerService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "paseo-work-ledger-tools-"));
    service = new WorkLedgerService(new WorkLedgerStore(dir, logger), {
      projectIdForWorkspace: async (workspaceId) =>
        workspaceId === WORKSPACE_ID ? PROJECT_ID : null,
      projectExists: async (projectId) => projectId === PROJECT_ID,
    });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function setup(agentId = "agent-executor") {
    const h = harness({ agentId });
    registerWorkLedgerTools({
      service,
      registerTool: h.registerTool,
      callerAgentId: agentId,
      resolveCallerAgent: () => ({ id: agentId, workspaceId: WORKSPACE_ID, cwd: "/repo" }),
      resolveScopeReference: async (reference) => {
        if (reference === `project:${PROJECT_ID}`) return { kind: "project", id: PROJECT_ID };
        if (reference === `workspace:${WORKSPACE_ID}`)
          return { kind: "workspace", id: WORKSPACE_ID };
        return null;
      },
    });
    return h.tools;
  }

  test("registers the full tool set", () => {
    const tools = setup();
    expect([...tools.keys()].sort()).toEqual([
      "work_ledger_entry_add",
      "work_ledger_item_create",
      "work_ledger_item_get",
      "work_ledger_item_set_status",
      "work_ledger_link_agent",
      "work_ledger_search",
    ]);
  });

  test("create links the caller, records goal and acceptance criteria, and defaults to the project", async () => {
    const tools = setup();
    const created = (await call(tools, "work_ledger_item_create", {
      title: "Evaluate loader speed",
      goal: "Report steady-state step time for four arms",
      acceptanceCriteria: "Numbers for all four arms with warmup excluded",
    })) as { item: { number: string; agents: Array<{ agentId: string }>; scope: unknown } };

    expect(created.item.number).toMatch(/^TODO-\d{8}-001$/);
    expect(created.item.scope).toEqual({ kind: "project", projectId: PROJECT_ID });
    expect(created.item.agents.map((link) => link.agentId)).toEqual(["agent-executor"]);

    const stored = await service.listItems();
    expect(stored[0]?.goal).toContain("steady-state");
    expect(stored[0]?.acceptanceCriteria).toContain("warmup");
  });

  test("moving an item to review links the agent without a second call", async () => {
    const tools = setup();
    const created = (await call(tools, "work_ledger_item_create", {
      title: "Ship the report",
    })) as { item: { number: string } };

    const moved = (await call(tools, "work_ledger_item_set_status", {
      item: created.item.number,
      status: "review",
      note: "Report written, waiting on numbers",
    })) as { item: { status: string; revision: number; entries: unknown[] } };

    expect(moved.item.status).toBe("review");
    expect(moved.item.entries).toHaveLength(1);
    const stored = await service.listItems();
    expect(stored[0]?.agents).toHaveLength(1);
    expect(stored[0]?.agents[0]?.source).toBe("tool");
  });

  test("entry_add records evidence and an incomplete sweep says which sources were unread", async () => {
    const tools = setup();
    const created = (await call(tools, "work_ledger_item_create", {
      title: "Copy dataset",
    })) as { item: { number: string } };

    const entry = (await call(tools, "work_ledger_entry_add", {
      item: created.item.number,
      kind: "inspection",
      summary: "Upstream finished; downstream bucket not reachable",
      outcome: "incomplete",
      unreadSources: ["wulan-oss"],
      evidence: [{ label: "object count", reference: "logs/count.txt", note: "5,172,982" }],
      attention: ["missing_evidence"],
      attentionNote: "Downstream unverified",
    })) as { entryId: string };

    expect(entry.entryId).toMatch(/^wle_/);
    const stored = await service.listItems();
    expect(stored[0]?.lastInspectedAt).not.toBeNull();
    expect(stored[0]?.lastProgressAt).toBeNull();
    expect(stored[0]?.attention).toEqual(["missing_evidence"]);
    const full = await service.getItem(stored[0]!.id);
    expect(full?.entries[0]?.unreadSources).toEqual(["wulan-oss"]);
    expect(full?.entries[0]?.evidence?.[0]?.reference).toBe("logs/count.txt");
  });

  test("a stale expectedRevision comes back as a typed error, not a silent overwrite", async () => {
    const tools = setup();
    const created = (await call(tools, "work_ledger_item_create", {
      title: "Race",
    })) as { item: { number: string } };
    await call(tools, "work_ledger_item_set_status", {
      item: created.item.number,
      status: "in_progress",
    });

    const tool = tools.get("work_ledger_entry_add")!;
    const result = await tool.handler(
      { item: created.item.number, summary: "late", expectedRevision: 1 },
      {},
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: "revision_conflict" });
  });

  test("search finds an item by number and reports counts", async () => {
    const tools = setup();
    const created = (await call(tools, "work_ledger_item_create", {
      title: "Findable work",
    })) as { item: { number: string } };

    const found = (await call(tools, "work_ledger_search", {
      query: created.item.number,
    })) as { items: Array<{ number: string }>; counts: { total: number } };
    expect(found.items.map((item) => item.number)).toEqual([created.item.number]);
    expect(found.counts.total).toBe(1);
  });

  test("an unknown item reference fails with a pointer to search", async () => {
    const tools = setup();
    const tool = tools.get("work_ledger_item_get")!;
    const result = await tool.handler({ item: "TODO-19990101-001" }, {});
    expect(result.isError).toBe(true);
    expect(
      String(result.structuredContent && (result.structuredContent as { error: string }).error),
    ).toContain("work_ledger_search");
  });
});
