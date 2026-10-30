import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { DshForkBridge, DshForkError, loadDshForkBridgePluginArtifact } from "./bridge.js";

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
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-dsh-fork-"));
  temporaryDirectories.push(directory);
  return directory;
}

/** Close a test server and wait for its port to be released. */
async function closeServer(port: number): Promise<void> {
  const index = openServers.findIndex((server) => {
    const address = server.address();
    return typeof address === "object" && address !== null && address.port === port;
  });
  const server = openServers.splice(index, 1)[0];
  if (!server) throw new Error(`no test server on port ${port}`);
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

function createBridge(home: string, options: { platform?: NodeJS.Platform } = {}): DshForkBridge {
  return new DshForkBridge({
    source: { kind: "dsh-plugin", home },
    logger: createTestLogger(),
    platform: options.platform ?? "linux",
  });
}

/** One NDJSON request from a Paseo-shaped client, answered with `reply`. */
async function listenForOneRequest(reply: (request: Record<string, unknown>) => unknown) {
  const requests: Record<string, unknown>[] = [];
  const server = createServer((socket) => {
    let pending = "";
    socket.on("data", (chunk: Buffer) => {
      pending += chunk.toString("utf8");
      const end = pending.indexOf("\n");
      if (end === -1) return;
      const request = JSON.parse(pending.slice(0, end)) as Record<string, unknown>;
      requests.push(request);
      const answer = reply(request);
      if (answer !== undefined) socket.write(`${JSON.stringify(answer)}\n`);
    });
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
    throw new Error("test bridge did not expose a TCP address");
  }
  return { port: address.port, requests };
}

describe("loadDshForkBridgePluginArtifact", () => {
  test("loads packaged bundle bytes without invoking source compilation", async () => {
    const root = await createTemporaryDirectory();
    const moduleUrl = pathToFileURL(path.join(root, "bridge.js")).href;
    const bundle = Buffer.from("export default async () => ({})");
    await writeFile(path.join(root, "bridge-plugin.bundle.mjs"), bundle);
    const compileSource = vi.fn(async () => {
      throw new Error("packaged runtime must not compile");
    });

    await expect(loadDshForkBridgePluginArtifact(moduleUrl, compileSource)).resolves.toEqual(
      bundle,
    );
    expect(compileSource).not.toHaveBeenCalled();

    await rm(path.join(root, "bridge-plugin.bundle.mjs"));
    await expect(loadDshForkBridgePluginArtifact(moduleUrl, compileSource)).rejects.toThrow(
      "artifact is missing",
    );
    expect(compileSource).not.toHaveBeenCalled();
  });

  test("compiles the plugin source when running from a source checkout", async () => {
    const artifact = new Uint8Array([1, 2, 3]);
    const compileSource = vi.fn(async () => artifact);
    const moduleUrl = new URL("./bridge.ts", import.meta.url).href;

    await expect(loadDshForkBridgePluginArtifact(moduleUrl, compileSource)).resolves.toBe(artifact);
    expect(compileSource).toHaveBeenCalledWith(
      fileURLToPath(new URL("./bridge-plugin.mjs", moduleUrl)),
    );
  });
});

describe("DshForkBridge", () => {
  test("writes the plugin and its overlay, and names one channel per launch", async () => {
    const home = await createTemporaryDirectory();
    const bridge = createBridge(home);

    const first = await bridge.prepareLaunch();
    const second = await bridge.prepareLaunch();

    const patchPath = path.join(home, "profiles", "paseo-fork-bridge.yml");
    expect(first.args).toEqual(["--patch", patchPath]);
    expect(first.env.PASEO_FORK_BRIDGE_SOCKET).toMatch(
      new RegExp(`^unix:${escapeForRegExp(path.join(tmpdir(), "paseo-fork-bridge"))}`),
    );
    expect(second.env.PASEO_FORK_BRIDGE_SOCKET).not.toBe(first.env.PASEO_FORK_BRIDGE_SOCKET);

    const pluginDirectory = path.join(home, "profiles", "node_modules", "paseo-fork-bridge");
    expect(JSON.parse(await readFile(path.join(pluginDirectory, "package.json"), "utf8"))).toEqual({
      name: "paseo-fork-bridge",
      version: "0.0.0",
      private: true,
      type: "module",
      main: "index.js",
    });
    expect(await readFile(path.join(pluginDirectory, "index.js"), "utf8")).toContain(
      "paseo-fork-bridge",
    );
    expect(await readFile(patchPath, "utf8")).toContain("name: paseo-fork-bridge");
  });

  test("keeps the written artifacts when a later launch finds them current", async () => {
    const home = await createTemporaryDirectory();
    const bridge = createBridge(home);
    await bridge.prepareLaunch();
    const patchPath = path.join(home, "profiles", "paseo-fork-bridge.yml");
    const written = await stat(patchPath);

    await bridge.prepareLaunch();

    expect((await stat(patchPath)).mtimeMs).toBe(written.mtimeMs);
  });

  test("names a named pipe on Windows", async () => {
    const home = await createTemporaryDirectory();
    const bridge = createBridge(home, { platform: "win32" });

    const launch = await bridge.prepareLaunch();

    expect(launch.env.PASEO_FORK_BRIDGE_SOCKET).toMatch(/^pipe:\\\\\.\\pipe\\paseo-fork-bridge-/);
  });

  test("forks through the channel and returns the child id", async () => {
    const home = await createTemporaryDirectory();
    const bridge = createBridge(home);
    const { port, requests } = await listenForOneRequest(() => ({
      id: "request-1",
      ok: true,
      sessionId: "session-child",
      boundary: 167,
      inheritedEventCount: 168,
    }));

    const childId = await bridge.fork({
      channel: `tcp:127.0.0.1:${port}`,
      sessionId: "session-source",
      atSeq: 12,
    });

    expect(childId).toBe("session-child");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      op: "fork",
      sessionId: "session-source",
      atSeq: 12,
    });
  });

  test("surfaces a refusal with the bridge's own code", async () => {
    const home = await createTemporaryDirectory();
    const bridge = createBridge(home);
    const { port } = await listenForOneRequest(() => ({
      id: "request-1",
      ok: false,
      code: "fork-unavailable",
      error: "session has no completed turn to fork from",
    }));

    const failure = await bridge
      .fork({ channel: `tcp:127.0.0.1:${port}`, sessionId: "session-source" })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DshForkError);
    expect((failure as DshForkError).code).toBe("fork-unavailable");
    expect((failure as DshForkError).message).toContain("no completed turn");
  });

  test("reports a bridge that cannot be reached", async () => {
    const home = await createTemporaryDirectory();
    const bridge = createBridge(home);
    const { port, requests } = await listenForOneRequest(() => undefined);
    // Free the port again, so nothing is listening on the channel Paseo names.
    await closeServer(port);

    const failure = await bridge
      .fork({ channel: `tcp:127.0.0.1:${port}`, sessionId: "session-source" })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DshForkError);
    expect((failure as DshForkError).code).toBe("bridge-unreachable");
    expect(requests).toHaveLength(0);
  });

  test("times out when the bridge accepts but never answers", async () => {
    const home = await createTemporaryDirectory();
    const bridge = new DshForkBridge({
      source: { kind: "dsh-plugin", home },
      logger: createTestLogger(),
      platform: "linux",
      forkTimeoutMs: 50,
    });
    const { port } = await listenForOneRequest(() => undefined);

    const failure = await bridge
      .fork({ channel: `tcp:127.0.0.1:${port}`, sessionId: "session-source" })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DshForkError);
    expect((failure as DshForkError).code).toBe("bridge-timeout");
  });
});

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
