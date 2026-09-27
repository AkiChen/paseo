import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Logger } from "pino";
import { z } from "zod";

import { writeFileAtomic } from "../../../atomic-file.js";

/**
 * Forking a DeepSeek Harness session from Paseo.
 *
 * DSH hands a forked session a copy of its source's event prefix, which is what
 * keeps the model's cache warm, and it does that work host-side — the ACP
 * profile has no `session/fork` to call. So Paseo loads a plugin into the
 * `dsh --profile acp` process it already owns, and that plugin forks in-process
 * and answers over a local channel. Paseo only learns the child id, and resumes
 * it over ACP like any other session.
 *
 * This is the Paseo side: materialize the plugin and the `--patch` overlay that
 * loads it, name a channel per process, and ask for a fork. A provider opts in
 * through its params, so a provider that does not name a bridge is untouched.
 */

/** Which DSH installation to load the plugin into, through its provider params. */
export const DshForkBridgeSchema = z.object({
  kind: z.literal("dsh-plugin"),
  /** DSH home holding the profile tree. Defaults to `~/.dsh`. */
  home: z.string().optional(),
});

export type DshForkBridgeSource = z.infer<typeof DshForkBridgeSchema>;

const CHANNEL_ENV = "PASEO_FORK_BRIDGE_SOCKET";
const PLUGIN_DIRECTORY = "paseo-fork-bridge";
const PATCH_FILENAME = "paseo-fork-bridge.yml";
const DEFAULT_FORK_TIMEOUT_MS = 30_000;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

const PLUGIN_PACKAGE = `${JSON.stringify(
  {
    name: PLUGIN_DIRECTORY,
    version: "0.0.0",
    private: true,
    type: "module",
    main: "index.js",
  },
  null,
  2,
)}\n`;

/**
 * The overlay that adds the bridge to the ACP profile. `insert` adds a plugin the
 * profile does not already carry, and the name resolves out of the profile's
 * `node_modules`, which is where the plugin directory is written.
 */
const PATCH_CONTENT = `- insert:
    - id: ${PLUGIN_DIRECTORY}
      name: ${PLUGIN_DIRECTORY}
`;

const ForkResponseSchema = z.union([
  z.object({ ok: z.literal(true), sessionId: z.string().min(1) }),
  z.object({ ok: z.literal(false), code: z.string(), error: z.string() }),
]);

/** A fork the bridge refused, carrying the bridge's own stable code. */
export class DshForkError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DshForkError";
  }
}

export interface DshForkBridgeLaunch {
  /** Channel the plugin inside the spawned process listens on. */
  channel: string;
  /** Arguments to append to the provider command. */
  args: string[];
  /** Environment the spawned process needs to find its channel. */
  env: Record<string, string>;
}

export interface DshForkBridgeOptions {
  source: DshForkBridgeSource;
  logger: Logger;
  /** Platform whose channel form to use. Injectable for tests. */
  platform?: NodeJS.Platform;
  forkTimeoutMs?: number;
}

/**
 * Materializes the plugin into a DSH profile and forks sessions through it.
 *
 * One instance serves every launch of its provider: the artifacts are written
 * once, while the channel is named per process because the plugin that answers
 * on it lives inside that process.
 */
export class DshForkBridge {
  private readonly home: string;
  private readonly logger: Logger;
  private readonly platform: NodeJS.Platform;
  private readonly forkTimeoutMs: number;
  private artifacts: Promise<{ patchPath: string }> | null = null;

  constructor(options: DshForkBridgeOptions) {
    this.home = expandHome(options.source.home ?? "~/.dsh");
    this.logger = options.logger.child({ module: "agent", component: "dsh-fork-bridge" });
    this.platform = options.platform ?? process.platform;
    this.forkTimeoutMs = options.forkTimeoutMs ?? DEFAULT_FORK_TIMEOUT_MS;
  }

  /** Write the plugin and its overlay, then name a channel for one process. */
  async prepareLaunch(): Promise<DshForkBridgeLaunch> {
    const { patchPath } = await this.materialize();
    const channel = this.createChannel();
    return {
      channel,
      args: ["--patch", patchPath],
      env: { [CHANNEL_ENV]: channel },
    };
  }

  /**
   * Fork `sessionId` inside the process listening on `channel` and return the
   * child id. The child is stored and flushed before this resolves, so resuming
   * it in a fresh process finds it.
   */
  async fork(input: { channel: string; sessionId: string; atSeq?: number }): Promise<string> {
    const response = await this.request(input.channel, {
      op: "fork",
      sessionId: input.sessionId,
      ...(input.atSeq === undefined ? {} : { atSeq: input.atSeq }),
    });
    const parsed = ForkResponseSchema.safeParse(response);
    if (!parsed.success) {
      throw new DshForkError("bridge-protocol", "the fork bridge returned an unrecognized reply");
    }
    if (!parsed.data.ok) {
      throw new DshForkError(parsed.data.code, parsed.data.error);
    }
    this.logger.info(
      { sessionId: input.sessionId, forkedSessionId: parsed.data.sessionId },
      "Forked a DSH session through its bridge",
    );
    return parsed.data.sessionId;
  }

  private async materialize(): Promise<{ patchPath: string }> {
    const pending = this.artifacts ?? this.writeArtifacts();
    this.artifacts = pending;
    try {
      return await pending;
    } catch (error) {
      // A failed write must not poison every later launch.
      this.artifacts = null;
      throw error;
    }
  }

  private async writeArtifacts(): Promise<{ patchPath: string }> {
    const artifact = await loadDshForkBridgePluginArtifact(import.meta.url);
    const pluginDirectory = path.join(this.home, "profiles", "node_modules", PLUGIN_DIRECTORY);
    const patchPath = path.join(this.home, "profiles", PATCH_FILENAME);
    await this.writeIfChanged(path.join(pluginDirectory, "package.json"), PLUGIN_PACKAGE);
    await this.writeIfChanged(path.join(pluginDirectory, "index.js"), artifact);
    await this.writeIfChanged(patchPath, PATCH_CONTENT);
    this.logger.debug({ pluginDirectory, patchPath }, "Materialized the DSH fork bridge");
    return { patchPath };
  }

  private async writeIfChanged(filePath: string, data: string | Uint8Array): Promise<void> {
    const next = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
    const current = await readFile(filePath).catch(() => null);
    if (current !== null && current.equals(next)) {
      return;
    }
    await writeFileAtomic(filePath, next);
  }

  /**
   * A channel only this machine can reach: a unix socket, or a named pipe on
   * Windows, where `net` binds the same path form but not a unix socket.
   */
  private createChannel(): string {
    const name = `paseo-fork-bridge-${randomUUID()}`;
    if (this.platform === "win32") {
      return `pipe:\\\\.\\pipe\\${name}`;
    }
    return `unix:${path.join(tmpdir(), "paseo-fork-bridge", `${name}.sock`)}`;
  }

  private request(channel: string, body: Record<string, unknown>): Promise<unknown> {
    const target = parseChannel(channel);
    return new Promise((resolve, reject) => {
      const socket = createConnection(target);
      let received = "";
      let settled = false;
      const settle = (callback: () => void) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        callback();
      };
      socket.setEncoding("utf8");
      socket.setTimeout(this.forkTimeoutMs);
      socket.on("connect", () => {
        socket.write(`${JSON.stringify({ id: randomUUID(), ...body })}\n`);
      });
      socket.on("data", (chunk: string) => {
        received += chunk;
        const end = received.indexOf("\n");
        if (end === -1) return;
        const line = received.slice(0, end);
        settle(() => {
          try {
            resolve(JSON.parse(line));
          } catch {
            reject(new DshForkError("bridge-protocol", "the fork bridge returned invalid JSON"));
          }
        });
      });
      socket.on("timeout", () => {
        settle(() => reject(new DshForkError("bridge-timeout", "the fork bridge did not answer")));
      });
      socket.on("error", (error: Error) => {
        settle(() => reject(new DshForkError("bridge-unreachable", error.message)));
      });
    });
  }
}

/** Build the bridge a provider asked for, or nothing when it asked for none. */
export function createDshForkBridge(
  source: DshForkBridgeSource | null,
  logger: Logger,
): DshForkBridge | null {
  return source === null ? null : new DshForkBridge({ source, logger });
}

function parseChannel(channel: string): { host: string; port: number } | { path: string } {
  if (channel.startsWith("unix:") || channel.startsWith("pipe:")) {
    return { path: channel.slice(channel.indexOf(":") + 1) };
  }
  if (channel.startsWith("tcp:")) {
    const parts = channel.slice("tcp:".length).split(":");
    const host = parts.length === 2 ? "127.0.0.1" : parts.slice(0, -1).join(":");
    const port = Number(parts.at(-1));
    if (!LOOPBACK_HOSTS.has(host) || !Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
      throw new DshForkError("bridge-channel", `invalid bridge TCP channel "${channel}"`);
    }
    return { host, port };
  }
  throw new DshForkError("bridge-channel", `unknown bridge channel "${channel}"`);
}

function expandHome(value: string): string {
  if (value === "~") return homedir();
  return value.startsWith("~/") ? path.join(homedir(), value.slice(2)) : value;
}

type CompileDshForkBridgePlugin = (sourcePath: string) => Promise<Uint8Array>;

/**
 * The packaged plugin bundle, or — when running from source — the plugin
 * compiled on the spot. A packaged runtime that lost its bundle fails loudly
 * instead of writing a plugin this build cannot produce.
 */
export async function loadDshForkBridgePluginArtifact(
  moduleUrl: string,
  compileSource: CompileDshForkBridgePlugin = compileDshForkBridgePlugin,
): Promise<Uint8Array> {
  const bundleUrl = new URL("./bridge-plugin.bundle.mjs", moduleUrl);
  try {
    return await readFile(bundleUrl);
  } catch (error) {
    if (!fileURLToPath(moduleUrl).endsWith(`${path.sep}bridge.ts`)) {
      throw new Error("Bundled DSH fork bridge plugin artifact is missing", { cause: error });
    }
  }
  return compileSource(fileURLToPath(new URL("./bridge-plugin.mjs", moduleUrl)));
}

async function compileDshForkBridgePlugin(sourcePath: string): Promise<Uint8Array> {
  const source = await readFile(sourcePath, "utf8");
  const { build } = await import("esbuild");
  const bundled = await build({
    stdin: {
      contents: source,
      resolveDir: path.dirname(sourcePath),
      sourcefile: path.basename(sourcePath),
    },
    bundle: true,
    format: "esm",
    platform: "node",
    target: "es2022",
    write: false,
  });
  const artifact = bundled.outputFiles[0]?.contents;
  if (!artifact) throw new Error("Failed to bundle the DSH fork bridge plugin");
  return artifact;
}
