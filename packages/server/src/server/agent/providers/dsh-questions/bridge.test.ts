import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import {
  DshQuestionBridge,
  loadDshQuestionBridgePluginArtifact,
  type DshQuestionOutcome,
} from "./bridge.js";

const temporaryDirectories: string[] = [];
const openServers: Server[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-dsh-questions-"));
  temporaryDirectories.push(directory);
  return directory;
}

function createBridge(home: string): DshQuestionBridge {
  return new DshQuestionBridge({
    source: { kind: "dsh-plugin", home },
    logger: createTestLogger(),
    platform: "linux",
    connectTimeoutMs: 2_000,
    reconnectDelayMs: 10,
    commandListTimeoutMs: 1_000,
    commandRunTimeoutMs: 1_000,
    usageTimeoutMs: 1_000,
  });
}

interface FakePlugin {
  channel: string;
  /** Lines the bridge sent to the fake plugin, in order. */
  received: Record<string, unknown>[];
  /** Push one line as if the plugin inside the DSH process had sent it. */
  send(message: Record<string, unknown>): void;
  /** Drop every live connection, the way the plugin process dying would. */
  dropConnections(): void;
}

/** A channel that behaves like the plugin: it holds one connection and talks NDJSON. */
async function serveFakePlugin(
  onConnect?: (socket: Socket) => void,
  onLine?: (message: Record<string, unknown>, socket: Socket) => void,
): Promise<FakePlugin> {
  const received: Record<string, unknown>[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffered = "";
    socket.on("data", (chunk: string) => {
      buffered += chunk;
      let index = buffered.indexOf("\n");
      while (index !== -1) {
        const line = buffered.slice(0, index);
        buffered = buffered.slice(index + 1);
        index = buffered.indexOf("\n");
        if (line.trim().length > 0) {
          const message = JSON.parse(line) as Record<string, unknown>;
          received.push(message);
          onLine?.(message, socket);
        }
      }
    });
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => sockets.delete(socket));
    onConnect?.(socket);
  });
  openServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the fake plugin did not expose a TCP address");
  }
  return {
    channel: `tcp:127.0.0.1:${address.port}`,
    received,
    send: (message) => {
      for (const socket of sockets) socket.write(`${JSON.stringify(message)}\n`);
    },
    dropConnections: () => {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
    },
  };
}

async function waitFor(
  predicate: () => boolean,
  description: string,
  timeoutMs = 2_000,
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const ASK = {
  op: "ask",
  protocol: 1,
  requestId: "question-1",
  questions: [
    {
      id: "color",
      question: "Which color should I use?",
      header: "Color",
      options: [{ label: "Red" }, { label: "Blue" }],
    },
  ],
};

describe("DshQuestionBridge.prepareLaunch", () => {
  test("writes the plugin and the overlay that loads it into the ACP profile", async () => {
    const home = await createTemporaryDirectory();
    const bridge = createBridge(home);

    const launch = await bridge.prepareLaunch();

    const pluginDirectory = path.join(home, "profiles", "node_modules", "paseo-question-bridge");
    const patchPath = path.join(home, "profiles", "paseo-question-bridge.yml");
    expect(launch.args).toEqual(["--patch", patchPath]);
    expect(launch.channel.startsWith("unix:")).toBe(true);
    expect(launch.env).toEqual({ PASEO_QUESTION_BRIDGE_SOCKET: launch.channel });

    const manifest = JSON.parse(await readFile(path.join(pluginDirectory, "package.json"), "utf8"));
    expect(manifest).toMatchObject({ name: "paseo-question-bridge", type: "module" });
    const plugin = await readFile(path.join(pluginDirectory, "index.js"), "utf8");
    expect(plugin).toContain("paseo-question-bridge");
    // The plugin also carries the guidance that tells an agent when to ask: a
    // bridge that answers questions nobody is told to ask is half a feature.
    expect(plugin).toContain("paseo:user-questions");
    expect(plugin).toContain("Use ask_user_question for decisions that belong to the user");
    // The session's token totals come from the same projection the harness's own
    // usage pill reads, so the plugin has to name it.
    expect(plugin).toContain("tokenUsage");

    // The tool row matters as much as the plugin: the ACP composition has no
    // `ask_user_question`, so a bridge alone would answer only plan review.
    const patch = await readFile(patchPath, "utf8");
    expect(patch).toContain("'@deepseek-ai/dsh-tool-ask-user'");
    // `present` is missing from the same composition, and it is how an agent hands
    // a file to the user instead of reading it into its own context.
    expect(patch).toContain("'@deepseek-ai/dsh-tool-present'");
    expect(patch).toContain("name: paseo-question-bridge");
    // The title swap is the operator's install, so a profile without the package
    // keeps the composition it had.
    expect(patch).not.toContain("session-title-all-prompts");
  });

  test("swaps in the per-prompt title provider when the profile has it", async () => {
    const home = await createTemporaryDirectory();
    const titleProvider = path.join(
      home,
      "profiles",
      "acp",
      "node_modules",
      "@deepseek-ai",
      "dsh-session-title-all-prompts-llm",
    );
    await mkdir(titleProvider, { recursive: true });
    const bridge = createBridge(home);

    await bridge.prepareLaunch();

    const patch = await readFile(path.join(home, "profiles", "paseo-question-bridge.yml"), "utf8");
    // The first-prompt provider titles a session once, so it has to step aside for
    // the one that retitles after every prompt; the generation limits belong to the
    // entry, which is why they travel with it.
    expect(patch).toContain("- id: session-title-llm\n  disabled: true");
    expect(patch).toContain("name: '@deepseek-ai/dsh-session-title-all-prompts-llm'");
    expect(patch).toContain("targetWords: 5");
    // All-prompts frames the whole conversation and fails instead of truncating, so
    // the shipped 4096 (sized for a single message) would never generate a title.
    expect(patch).toContain("maxInputBytes: 262144");
  });

  test("names a fresh channel per launch so two processes never share one", async () => {
    const home = await createTemporaryDirectory();
    const bridge = createBridge(home);

    const first = await bridge.prepareLaunch();
    const second = await bridge.prepareLaunch();

    expect(first.channel).not.toBe(second.channel);
    expect(first.env.PASEO_QUESTION_BRIDGE_SOCKET).toBe(first.channel);
    expect(second.env.PASEO_QUESTION_BRIDGE_SOCKET).toBe(second.channel);
  });
});

describe("DshQuestionBridge.connect", () => {
  test("answers a relayed question with the decision Paseo made", async () => {
    const home = await createTemporaryDirectory();
    const bridge = createBridge(home);
    const plugin = await serveFakePlugin((socket) => {
      socket.write(`${JSON.stringify(ASK)}\n`);
    });
    const asked: unknown[] = [];

    const connection = bridge.connect({
      channel: plugin.channel,
      onAsk: async (request) => {
        asked.push(request);
        return { kind: "answers", answers: [{ id: "color", selected: ["Blue"] }] };
      },
    });
    await connection.ready;
    await waitFor(() => plugin.received.length > 0, "the bridge's answer");

    expect(asked).toEqual([
      {
        requestId: "question-1",
        questions: [
          {
            id: "color",
            question: "Which color should I use?",
            header: "Color",
            options: [{ label: "Red" }, { label: "Blue" }],
          },
        ],
      },
    ]);
    expect(plugin.received[0]).toEqual({
      op: "answer",
      requestId: "question-1",
      answers: [{ id: "color", selected: ["Blue"] }],
    });
    connection.close();
  });

  test("declines a question it cannot ask anyone", async () => {
    const home = await createTemporaryDirectory();
    const bridge = createBridge(home);
    const plugin = await serveFakePlugin((socket) => {
      socket.write(`${JSON.stringify(ASK)}\n`);
    });

    const connection = bridge.connect({
      channel: plugin.channel,
      onAsk: async (): Promise<DshQuestionOutcome> => ({ kind: "unavailable" }),
    });
    await connection.ready;
    await waitFor(() => plugin.received.length > 0, "the decline");

    expect(plugin.received[0]).toEqual({ op: "unavailable", requestId: "question-1" });
    connection.close();
  });

  test("tells DSH when the user refused to answer", async () => {
    const home = await createTemporaryDirectory();
    const bridge = createBridge(home);
    const plugin = await serveFakePlugin((socket) => {
      socket.write(`${JSON.stringify(ASK)}\n`);
    });

    const connection = bridge.connect({
      channel: plugin.channel,
      onAsk: async (): Promise<DshQuestionOutcome> => ({ kind: "dismiss" }),
    });
    await connection.ready;
    await waitFor(() => plugin.received.length > 0, "the dismissal");

    expect(plugin.received[0]).toEqual({ op: "dismiss", requestId: "question-1" });
    connection.close();
  });

  test("reports a channel the plugin dropped, and stops writing once closed", async () => {
    const home = await createTemporaryDirectory();
    const bridge = createBridge(home);
    const plugin = await serveFakePlugin();
    const disconnects: number[] = [];
    const connection = bridge.connect({
      channel: plugin.channel,
      onAsk: async (): Promise<DshQuestionOutcome> => ({ kind: "dismiss" }),
      onDisconnect: () => {
        disconnects.push(Date.now());
      },
    });
    await connection.ready;

    plugin.dropConnections();
    await waitFor(() => disconnects.length > 0, "the disconnect");

    connection.close();
    connection.answer("question-1", [{ id: "color", selected: ["Blue"] }]);
    expect(plugin.received).toEqual([]);
  });

  test("forwards DSH's own settlement so the card can be taken down", async () => {
    const home = await createTemporaryDirectory();
    const bridge = createBridge(home);
    const plugin = await serveFakePlugin();
    const settled: [string, string][] = [];

    const connection = bridge.connect({
      channel: plugin.channel,
      onAsk: async (): Promise<DshQuestionOutcome> => ({ kind: "dismiss" }),
      onSettled: (requestId, outcome) => {
        settled.push([requestId, outcome]);
      },
    });
    await connection.ready;
    plugin.send({ op: "settled", requestId: "question-1", outcome: "aborted" });
    await waitFor(() => settled.length > 0, "the settlement");

    expect(settled).toEqual([["question-1", "aborted"]]);
    connection.close();
  });

  test("stays silent about a question DSH settled while Paseo was deciding", async () => {
    const home = await createTemporaryDirectory();
    const bridge = createBridge(home);
    const plugin = await serveFakePlugin((socket) => {
      socket.write(`${JSON.stringify(ASK)}\n`);
    });
    let releaseAsk: () => void = () => {};
    const inFlight = new Promise<void>((resolve) => {
      releaseAsk = resolve;
    });
    let sawSettlement = false;

    const connection = bridge.connect({
      channel: plugin.channel,
      onAsk: async () => {
        await inFlight;
        return { kind: "answers", answers: [{ id: "color", selected: ["Blue"] }] };
      },
      onSettled: () => {
        sawSettlement = true;
      },
    });
    await connection.ready;
    plugin.send({ op: "settled", requestId: "question-1", outcome: "aborted" });
    await waitFor(() => sawSettlement, "the settlement");

    releaseAsk();
    await new Promise((resolve) => setImmediate(resolve));

    expect(plugin.received).toEqual([]);
    connection.close();
  });
});

describe("DshQuestionBridge commands", () => {
  const READY = { op: "ready", protocol: 1, pid: 4242, commands: true };
  const CATALOG = [
    { name: "compact", description: "Compact older conversation history", argumentHint: "" },
    { name: "goal", description: "set or view the goal", argumentHint: "[<objective>|clear]" },
  ];

  test("lists this agent's commands and runs one, reporting DSH's own result", async () => {
    const home = await createTemporaryDirectory();
    const bridge = createBridge(home);
    const plugin = await serveFakePlugin(
      (socket) => {
        socket.write(`${JSON.stringify(READY)}\n`);
      },
      (message, socket) => {
        if (message.op === "commands") {
          socket.write(
            `${JSON.stringify({ op: "commands", id: message.id, ok: true, list: CATALOG })}\n`,
          );
        }
        if (message.op === "command") {
          socket.write(
            `${JSON.stringify({
              op: "command",
              id: message.id,
              ok: true,
              result: {
                kind: "success",
                text: "Compacted 3 history items (~120 tokens).",
                sourceEventSeq: 42,
              },
            })}\n`,
          );
        }
      },
    );

    const connection = bridge.connect({
      channel: plugin.channel,
      onAsk: async (): Promise<DshQuestionOutcome> => ({ kind: "dismiss" }),
    });
    await connection.ready;
    await waitFor(() => connection.supportsCommands(), "the command capability");

    await expect(connection.listCommands("session-1")).resolves.toEqual(CATALOG);
    await expect(connection.runCommand("session-1", "/compact")).resolves.toEqual({
      kind: "success",
      text: "Compacted 3 history items (~120 tokens).",
      sourceEventSeq: 42,
    });
    expect(plugin.received).toEqual([
      { op: "commands", id: expect.any(String), agentId: "session-1" },
      { op: "command", id: expect.any(String), agentId: "session-1", line: "/compact" },
    ]);
    connection.close();
  });

  test("reports a command DSH refused with the text DSH composed", async () => {
    const home = await createTemporaryDirectory();
    const bridge = createBridge(home);
    const plugin = await serveFakePlugin(
      (socket) => {
        socket.write(`${JSON.stringify(READY)}\n`);
      },
      (message, socket) => {
        if (message.op === "command") {
          socket.write(
            `${JSON.stringify({
              op: "command",
              id: message.id,
              ok: false,
              error: "Compaction is unavailable because the agent is not idle.",
            })}\n`,
          );
        }
      },
    );

    const connection = bridge.connect({
      channel: plugin.channel,
      onAsk: async (): Promise<DshQuestionOutcome> => ({ kind: "dismiss" }),
    });
    await connection.ready;
    await waitFor(() => connection.supportsCommands(), "the command capability");

    await expect(connection.runCommand("session-1", "/compact")).resolves.toEqual({
      kind: "error",
      text: "Compaction is unavailable because the agent is not idle.",
    });
    connection.close();
  });

  test("offers no commands to a plugin that never announced them", async () => {
    const home = await createTemporaryDirectory();
    const bridge = createBridge(home);
    const plugin = await serveFakePlugin((socket) => {
      socket.write(`${JSON.stringify({ op: "ready", protocol: 1, pid: 4242 })}\n`);
    });

    const connection = bridge.connect({
      channel: plugin.channel,
      onAsk: async (): Promise<DshQuestionOutcome> => ({ kind: "dismiss" }),
    });
    await connection.ready;
    await waitFor(() => plugin.received.length === 0, "the channel to stay quiet");

    expect(connection.supportsCommands()).toBe(false);
    await expect(connection.listCommands("session-1")).resolves.toBeNull();
    await expect(connection.runCommand("session-1", "/compact")).resolves.toBeNull();
    // An older plugin holds the channel open for questions; commands must not
    // put a request on it that nothing will ever answer.
    expect(plugin.received).toEqual([]);
    connection.close();
  });

  test("gives up on a request the plugin never answers", async () => {
    const home = await createTemporaryDirectory();
    const bridge = createBridge(home);
    const plugin = await serveFakePlugin((socket) => {
      socket.write(`${JSON.stringify(READY)}\n`);
    });

    const connection = bridge.connect({
      channel: plugin.channel,
      onAsk: async (): Promise<DshQuestionOutcome> => ({ kind: "dismiss" }),
    });
    await connection.ready;
    await waitFor(() => connection.supportsCommands(), "the command capability");

    await expect(connection.listCommands("session-1")).resolves.toBeNull();
    await expect(connection.runCommand("session-1", "/compact")).resolves.toBeNull();
    expect(plugin.received.map((message) => message.op)).toEqual(["commands", "command"]);
    connection.close();
  });

  test("rejects a malformed catalog instead of offering it", async () => {
    const home = await createTemporaryDirectory();
    const bridge = createBridge(home);
    const plugin = await serveFakePlugin(
      (socket) => {
        socket.write(`${JSON.stringify(READY)}\n`);
      },
      (message, socket) => {
        if (message.op === "commands") {
          socket.write(
            `${JSON.stringify({ op: "commands", id: message.id, ok: true, list: [{ description: "no name" }] })}\n`,
          );
        }
      },
    );

    const connection = bridge.connect({
      channel: plugin.channel,
      onAsk: async (): Promise<DshQuestionOutcome> => ({ kind: "dismiss" }),
    });
    await connection.ready;
    await waitFor(() => connection.supportsCommands(), "the command capability");

    await expect(connection.listCommands("session-1")).resolves.toBeNull();
    connection.close();
  });

  test("fails pending command requests when the connection closes", async () => {
    const home = await createTemporaryDirectory();
    const bridge = createBridge(home);
    const plugin = await serveFakePlugin((socket) => {
      socket.write(`${JSON.stringify(READY)}\n`);
    });

    const connection = bridge.connect({
      channel: plugin.channel,
      onAsk: async (): Promise<DshQuestionOutcome> => ({ kind: "dismiss" }),
    });
    await connection.ready;
    await waitFor(() => connection.supportsCommands(), "the command capability");

    const running = connection.runCommand("session-1", "/compact");
    connection.close();
    await expect(running).resolves.toBeNull();
  });
});

describe("DshQuestionBridge usage", () => {
  const READY = { op: "ready", protocol: 1, pid: 4242, usage: true };
  const USAGE = {
    uncachedInputTokens: 120,
    cacheReadTokens: 4_400,
    cacheWriteTokens: 0,
    outputTokens: 900,
  };

  test("reports the session totals the plugin knows", async () => {
    const home = await createTemporaryDirectory();
    const bridge = createBridge(home);
    const plugin = await serveFakePlugin(
      (socket) => {
        socket.write(`${JSON.stringify(READY)}\n`);
      },
      (message, socket) => {
        if (message.op === "usage") {
          socket.write(
            `${JSON.stringify({ op: "usage", id: message.id, ok: true, usage: USAGE })}\n`,
          );
        }
      },
    );

    const connection = bridge.connect({
      channel: plugin.channel,
      onAsk: async (): Promise<DshQuestionOutcome> => ({ kind: "dismiss" }),
    });
    await connection.ready;
    await waitFor(() => connection.supportsUsage(), "the usage capability");

    await expect(connection.readUsage("session-1")).resolves.toEqual(USAGE);
    expect(plugin.received).toEqual([
      { op: "usage", id: expect.any(String), agentId: "session-1" },
    ]);
    connection.close();
  });

  test("treats a session with nothing billed yet as no answer", async () => {
    const home = await createTemporaryDirectory();
    const bridge = createBridge(home);
    const plugin = await serveFakePlugin(
      (socket) => {
        socket.write(`${JSON.stringify(READY)}\n`);
      },
      (message, socket) => {
        if (message.op === "usage") {
          socket.write(
            `${JSON.stringify({ op: "usage", id: message.id, ok: true, usage: null })}\n`,
          );
        }
      },
    );

    const connection = bridge.connect({
      channel: plugin.channel,
      onAsk: async (): Promise<DshQuestionOutcome> => ({ kind: "dismiss" }),
    });
    await connection.ready;
    await waitFor(() => connection.supportsUsage(), "the usage capability");

    await expect(connection.readUsage("session-1")).resolves.toBeNull();
    connection.close();
  });

  test("offers no usage to a plugin that never announced it", async () => {
    const home = await createTemporaryDirectory();
    const bridge = createBridge(home);
    const plugin = await serveFakePlugin((socket) => {
      socket.write(`${JSON.stringify({ op: "ready", protocol: 1, pid: 4242, commands: true })}\n`);
    });

    const connection = bridge.connect({
      channel: plugin.channel,
      onAsk: async (): Promise<DshQuestionOutcome> => ({ kind: "dismiss" }),
    });
    await connection.ready;
    await waitFor(() => connection.supportsCommands(), "the command capability");

    expect(connection.supportsUsage()).toBe(false);
    await expect(connection.readUsage("session-1")).resolves.toBeNull();
    expect(plugin.received).toEqual([]);
    connection.close();
  });

  test("gives up on a usage request the plugin never answers", async () => {
    const home = await createTemporaryDirectory();
    const bridge = createBridge(home);
    const plugin = await serveFakePlugin((socket) => {
      socket.write(`${JSON.stringify(READY)}\n`);
    });

    const connection = bridge.connect({
      channel: plugin.channel,
      onAsk: async (): Promise<DshQuestionOutcome> => ({ kind: "dismiss" }),
    });
    await connection.ready;
    await waitFor(() => connection.supportsUsage(), "the usage capability");

    await expect(connection.readUsage("session-1")).resolves.toBeNull();
    expect(plugin.received.map((message) => message.op)).toEqual(["usage"]);
    connection.close();
  });

  test("rejects malformed usage instead of reporting it", async () => {
    const home = await createTemporaryDirectory();
    const bridge = createBridge(home);
    const plugin = await serveFakePlugin(
      (socket) => {
        socket.write(`${JSON.stringify(READY)}\n`);
      },
      (message, socket) => {
        if (message.op === "usage") {
          socket.write(
            `${JSON.stringify({
              op: "usage",
              id: message.id,
              ok: true,
              usage: { ...USAGE, cacheReadTokens: -1 },
            })}\n`,
          );
        }
      },
    );

    const connection = bridge.connect({
      channel: plugin.channel,
      onAsk: async (): Promise<DshQuestionOutcome> => ({ kind: "dismiss" }),
    });
    await connection.ready;
    await waitFor(() => connection.supportsUsage(), "the usage capability");

    await expect(connection.readUsage("session-1")).resolves.toBeNull();
    connection.close();
  });
});

describe("DshQuestionBridge title", () => {
  const READY = { op: "ready", protocol: 1, pid: 4242, title: true };

  test("asks the plugin to regenerate and reports the title it returns", async () => {
    const home = await createTemporaryDirectory();
    const bridge = createBridge(home);
    const plugin = await serveFakePlugin(
      (socket) => {
        socket.write(`${JSON.stringify(READY)}\n`);
      },
      (message, socket) => {
        if (message.op === "refreshTitle") {
          socket.write(
            `${JSON.stringify({
              op: "refreshTitle",
              id: message.id,
              ok: true,
              title: "Cohort retention by month",
            })}\n`,
          );
        }
      },
    );

    const connection = bridge.connect({
      channel: plugin.channel,
      onAsk: async (): Promise<DshQuestionOutcome> => ({ kind: "dismiss" }),
    });
    await connection.ready;
    await waitFor(() => connection.supportsTitle(), "the title capability");

    await expect(connection.refreshTitle("session-1")).resolves.toBe("Cohort retention by month");
    expect(plugin.received).toEqual([
      { op: "refreshTitle", id: expect.any(String), agentId: "session-1" },
    ]);
    connection.close();
  });

  test("stays quiet for a plugin that never claimed the capability", async () => {
    const home = await createTemporaryDirectory();
    const bridge = createBridge(home);
    const plugin = await serveFakePlugin(
      (socket) => {
        socket.write(`${JSON.stringify({ op: "ready", protocol: 1, pid: 4242, usage: true })}\n`);
      },
      () => undefined,
    );

    const connection = bridge.connect({
      channel: plugin.channel,
      onAsk: async (): Promise<DshQuestionOutcome> => ({ kind: "dismiss" }),
    });
    await connection.ready;
    await waitFor(() => connection.supportsUsage(), "the usage capability");

    expect(connection.supportsTitle()).toBe(false);
    await expect(connection.refreshTitle("session-1")).resolves.toBeNull();
    expect(plugin.received).toEqual([]);
    connection.close();
  });

  test("reports no title when regeneration failed or answered with nothing", async () => {
    const home = await createTemporaryDirectory();
    const bridge = createBridge(home);
    const plugin = await serveFakePlugin(
      (socket) => {
        socket.write(`${JSON.stringify(READY)}\n`);
      },
      (message, socket) => {
        if (message.op !== "refreshTitle") return;
        socket.write(
          `${JSON.stringify({ op: "refreshTitle", id: message.id, ok: false, error: "boom" })}\n`,
        );
      },
    );

    const connection = bridge.connect({
      channel: plugin.channel,
      onAsk: async (): Promise<DshQuestionOutcome> => ({ kind: "dismiss" }),
    });
    await connection.ready;
    await waitFor(() => connection.supportsTitle(), "the title capability");

    await expect(connection.refreshTitle("session-1")).resolves.toBeNull();
    connection.close();
  });
});

describe("loadDshQuestionBridgePluginArtifact", () => {
  test("loads packaged bundle bytes without invoking source compilation", async () => {
    const root = await createTemporaryDirectory();
    const moduleUrl = pathToFileURL(path.join(root, "bridge.js")).href;
    const bundle = Buffer.from("export default async () => ({})");
    await writeFile(path.join(root, "bridge-plugin.bundle.mjs"), bundle);
    const compileSource = vi.fn(async () => {
      throw new Error("packaged runtime must not compile");
    });

    await expect(loadDshQuestionBridgePluginArtifact(moduleUrl, compileSource)).resolves.toEqual(
      bundle,
    );
    expect(compileSource).not.toHaveBeenCalled();

    await rm(path.join(root, "bridge-plugin.bundle.mjs"));
    await expect(loadDshQuestionBridgePluginArtifact(moduleUrl, compileSource)).rejects.toThrow(
      "artifact is missing",
    );
    expect(compileSource).not.toHaveBeenCalled();
  });
});
