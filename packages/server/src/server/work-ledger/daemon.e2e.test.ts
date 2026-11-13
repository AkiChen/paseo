import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { FileBackedProjectRegistry, FileBackedWorkspaceRegistry } from "../workspace-registry.js";
import { createPaseoDaemon } from "../bootstrap.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createWorkLedgerService, type WorkLedgerService } from "./index.js";

/**
 * End-to-end proof of the ledger contract over the real daemon: the feature flag a
 * client gates on, the read-only subscription, a catch-up by id, and item history.
 * It never touches the developer daemon: the harness listens on an OS-chosen port
 * and owns its own PASEO_HOME. Writes go through the service the daemon bootstraps
 * (the same one the agent tools receive), seeded with a real project record so the
 * scope resolution under test is the production one.
 */
const PROJECT_ID = "prj_ledger_e2e";
const WORKSPACE_ID = "ws_ledger_e2e";

describe("work ledger over the daemon WebSocket", () => {
  const logger = pino({ level: "silent" });
  let daemon: Awaited<ReturnType<typeof createPaseoDaemon>>;
  let client: DaemonClient;
  let workLedger: WorkLedgerService;
  let rootDir: string;

  beforeAll(async () => {
    rootDir = await mkdtemp(path.join(os.tmpdir(), "paseo-ledger-e2e-"));
    const paseoHome = path.join(rootDir, ".paseo");
    const repoDir = path.join(rootDir, "repo");
    await mkdir(paseoHome, { recursive: true });
    await mkdir(repoDir, { recursive: true });

    // Seed the registries before boot so the daemon serves this project/workspace.
    const projects = new FileBackedProjectRegistry(
      path.join(paseoHome, "projects", "projects.json"),
      logger,
    );
    const workspaces = new FileBackedWorkspaceRegistry(
      path.join(paseoHome, "projects", "workspaces.json"),
      logger,
    );
    const timestamp = new Date().toISOString();
    await projects.upsert({
      projectId: PROJECT_ID,
      rootPath: repoDir,
      kind: "non_git",
      displayName: "ledger-e2e",
      createdAt: timestamp,
      updatedAt: timestamp,
      archivedAt: null,
    });
    await workspaces.upsert({
      workspaceId: WORKSPACE_ID,
      projectId: PROJECT_ID,
      cwd: repoDir,
      kind: "directory",
      displayName: "ledger-e2e",
      createdAt: timestamp,
      updatedAt: timestamp,
      archivedAt: null,
    });

    daemon = await createPaseoDaemon(
      {
        listen: "127.0.0.1:0",
        paseoHome,
        corsAllowedOrigins: [],
        hostnames: true,
        mcpEnabled: false,
        staticDir: path.join(rootDir, "static"),
        mcpDebug: false,
        agentClients: {},
        agentStoragePath: path.join(paseoHome, "agents"),
        relayEnabled: false,
        relayEndpoint: "relay.paseo.sh:443",
        appBaseUrl: "https://app.paseo.sh",
      },
      logger,
    );
    await daemon.start();

    // A second instance over the same home proves the file store, not the socket path.
    workLedger = createWorkLedgerService({
      paseoHome,
      logger,
      projectRegistry: projects,
      workspaceRegistry: workspaces,
    });

    client = new DaemonClient({ url: daemonUrl(daemon), appVersion: "0.11.0" });
    await client.connect();
    await client.fetchAgents({ subscribe: {} }).catch(() => undefined);
  }, 180_000);

  afterAll(async () => {
    await client?.close().catch(() => undefined);
    await daemon?.stop().catch(() => undefined);
    await rm(rootDir, { recursive: true, force: true });
  });

  test("server_info advertises the workLedger feature", () => {
    const info = client.getLastServerInfoMessage();
    if (!info) throw new Error("no server_info observed");
    expect(info.features?.workLedger).toBe(true);
    expect(info.serverId).toBe(daemon.getServerId());
  });

  test("a client snapshot sees an item written by another service instance", async () => {
    // Production has exactly one ledger instance (the daemon's); publishing is
    // instance-scoped. This proves the other half of the contract: a second
    // instance over the same PASEO_HOME sees the first one's durable writes.
    const created = await workLedger.createItem({
      title: "Ship the ledger",
      goal: "A client can read it",
      acceptanceCriteria: "Snapshot and live update both arrive",
      scope: { kind: "project", projectId: PROJECT_ID },
    });

    const snapshot = await client.listWorkLedger({
      scope: { kind: "project", projectId: PROJECT_ID },
    });
    expect(snapshot.items.map((item) => item.number)).toContain(created.number);
    expect(snapshot.counts.total).toBeGreaterThanOrEqual(1);
    expect(snapshot.counts.pending).toBeGreaterThanOrEqual(1);
    expect(snapshot.sync.mode).toBe("snapshot");
    expect(snapshot.sync.generation.length).toBeGreaterThan(0);
  }, 60_000);

  test("a second instance's write is not broadcast, but a fresh snapshot carries it", async () => {
    // Publication is scoped to the writing instance; production has exactly one
    // (the daemon's, shared by the WebSocket layer and the agent tools), so a
    // second instance standing in for an agent write must NOT reach a subscriber —
    // but its durable write must be visible to the next snapshot read.
    const created = await workLedger.createItem({
      title: "Cross-instance write",
      scope: { kind: "project", projectId: PROJECT_ID },
    });

    const received: string[] = [];
    const subscription = client.observeWorkLedger({
      scope: { kind: "project", projectId: PROJECT_ID },
    });
    subscription.subscribe({
      snapshot: () => undefined,
      update: (message) => {
        if (message.type === "work_ledger.update" && message.payload.kind === "upsert") {
          received.push(message.payload.item.number);
        }
      },
      error: () => undefined,
    });
    try {
      await subscription.ready;
      const moved = await workLedger.moveItem({
        itemId: created.id,
        status: "in_progress",
        note: { summary: "picked up" },
      });
      expect(moved.status).toBe("in_progress");
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(received).not.toContain(created.number);
    } finally {
      await subscription.release();
    }

    const refetched = await client.listWorkLedgerItems({ itemIds: [created.id] });
    expect(refetched.items[0]?.status).toBe("in_progress");
    expect(refetched.items[0]?.entryCount).toBe(1);
  }, 60_000);

  test("item.get returns full history and pages back", async () => {
    const created = await workLedger.createItem({
      title: "History over the wire",
      scope: { kind: "project", projectId: PROJECT_ID },
    });
    for (let index = 1; index <= 4; index += 1) {
      await workLedger.recordEntry({
        itemId: created.id,
        kind: "progress",
        source: "agent",
        summary: `step ${index}`,
        movesProgress: true,
      });
    }
    // The list projection carries only the newest few; get carries the window.
    const list = await client.listWorkLedger({ scope: { kind: "project", projectId: PROJECT_ID } });
    const listed = list.items.find((item) => item.id === created.id);
    expect(listed?.entries[0]?.summary).toBe("step 4");
    expect(listed?.entryCount).toBe(4);

    const page = await client.getWorkLedgerItem({ itemId: created.id, limit: 2 });
    expect(page.entries.map((entry) => entry.summary)).toEqual(["step 4", "step 3"]);
    expect(page.hasMore).toBe(true);

    const older = await client.getWorkLedgerItem({
      itemId: created.id,
      limit: 2,
      beforeEntryId: page.entries[1]!.id,
    });
    expect(older.entries.map((entry) => entry.summary)).toEqual(["step 2", "step 1"]);
  }, 60_000);

  test("item.list returns the ids a catch-up names, and reports missing ones", async () => {
    const created = await workLedger.createItem({
      title: "Catch-up target",
      scope: { kind: "project", projectId: PROJECT_ID },
    });
    const payload = await client.listWorkLedgerItems({
      itemIds: [created.id, "wli_does_not_exist"],
    });
    expect(payload.items.map((item) => item.id)).toEqual([created.id]);
    expect(payload.missingItemIds).toEqual(["wli_does_not_exist"]);
  }, 60_000);

  test("an item survives a daemon restart and a second service instance", async () => {
    const created = await workLedger.createItem({
      title: "Durable item",
      scope: { kind: "workspace", workspaceId: WORKSPACE_ID },
      workspaceId: WORKSPACE_ID,
    });

    await client.close();
    await daemon.stop();
    await daemon.start();

    client = new DaemonClient({ url: daemonUrl(daemon), appVersion: "0.11.0" });
    await client.connect();

    const after = await client.listWorkLedger({});
    const restored = after.items.find((item) => item.id === created.id);
    expect(restored?.title).toBe("Durable item");
    expect(restored?.scope).toEqual({ kind: "workspace", workspaceId: WORKSPACE_ID });
  }, 90_000);
});

function daemonUrl(target: { getListenTarget(): { type: string; port?: number } | null }): string {
  const listenTarget = target.getListenTarget();
  const port = listenTarget?.type === "tcp" ? listenTarget.port : null;
  if (!port) throw new Error("daemon did not bind a TCP port");
  return `ws://127.0.0.1:${port}/ws`;
}
