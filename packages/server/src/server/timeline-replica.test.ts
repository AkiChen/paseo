import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, expect, test } from "vitest";

import { ensureAgentLoaded } from "./agent/agent-loading.js";
import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";

const roots: string[] = [];
const logger = pino({ level: "silent" });

function timelinePath(paseoHome: string, agentId: string): string {
  const encoded = Buffer.from(agentId, "utf8").toString("base64url");
  return path.join(paseoHome, "timelines", `agent-${encoded}.jsonl`);
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

// The daemon used to keep every agent timeline in memory alone, so a restart left every
// agent whose provider cannot replay a transcript (DSH over ACP) with an empty chat while
// its provider session was intact. Reopening one reads the rows the previous process wrote.
test("a restarted daemon serves the rows an agent wrote before the restart", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "paseo-timeline-replica-"));
  roots.push(root);
  const cwd = path.join(root, "workspace");
  mkdirSync(cwd);
  let agentId = "";

  const first = await createTestPaseoDaemon({ paseoHomeRoot: root, cleanup: false });
  try {
    const agent = await first.daemon.agentManager.createAgent(
      { provider: "opencode", cwd },
      undefined,
      { workspaceId: undefined, historyPrimed: true },
    );
    agentId = agent.id;
    await first.daemon.agentManager.appendTimelineItem(agent.id, {
      type: "user_message",
      text: "before the restart",
      messageId: "before-the-restart",
    });
    await first.daemon.agentManager.appendTimelineItem(agent.id, {
      type: "assistant_message",
      text: "also before the restart",
      messageId: "also-before-the-restart",
    });
    await first.daemon.agentManager.flush();
    expect(existsSync(timelinePath(first.paseoHome, agentId))).toBe(true);
  } finally {
    await first.close();
  }

  // A real restart starts the next process from the same home; `cleanup: false` keeps it.
  const second = await createTestPaseoDaemon({ paseoHomeRoot: root, cleanup: false });
  try {
    // What `fetch_agent_timeline_request` does for a closed agent: reopen it, then read it.
    const reopened = await ensureAgentLoaded(agentId, {
      agentManager: second.daemon.agentManager,
      agentStorage: second.daemon.agentStorage,
      logger,
    });
    await second.daemon.agentManager.hydrateTimelineFromProvider(reopened.id);

    const page = second.daemon.agentManager.fetchTimeline(reopened.id, {
      direction: "tail",
      limit: 100,
    });
    expect(page.rows.map((row) => row.item)).toEqual([
      { type: "user_message", text: "before the restart", messageId: "before-the-restart" },
      {
        type: "assistant_message",
        text: "also before the restart",
        messageId: "also-before-the-restart",
      },
    ]);
  } finally {
    await second.close();
  }
}, 30_000);
