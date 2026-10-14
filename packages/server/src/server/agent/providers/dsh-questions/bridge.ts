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
 * Answering DeepSeek Harness user questions from Paseo.
 *
 * DSH asks a question through a Cordis waterfall (`user-questions/request`)
 * that only its own client UI claims: `ask_user_question` and `exit_plan_mode`
 * both go through it, and the ACP profile Paseo drives has no answerer at all —
 * an ask fails with `NO_PROVIDER`. So Paseo loads a plugin into that process and
 * answers over a local channel, the same way its fork bridge used to.
 *
 * This is the Paseo side: materialize the plugin and the `--patch` overlay that
 * loads it (the overlay also inserts the `ask_user_question` tool, which the ACP
 * composition does not carry), name a channel per process, and relay questions.
 * A provider opts in through its params, so a provider that does not name a
 * bridge is untouched.
 */

/** Which DSH installation to load the plugin into, through its provider params. */
export const DshQuestionBridgeSchema = z.object({
  kind: z.literal("dsh-plugin"),
  /** DSH home holding the profile tree. Defaults to `~/.dsh`. */
  home: z.string().optional(),
});

export type DshQuestionBridgeSource = z.infer<typeof DshQuestionBridgeSchema>;

/** One question, as the DSH bridge forwards it. */
export const DshQuestionSchema = z.object({
  id: z.string().min(1),
  question: z.string(),
  header: z.string().optional(),
  options: z.array(
    z.object({
      label: z.string(),
      description: z.string().optional(),
    }),
  ),
  multiSelect: z.boolean().optional(),
  placeholder: z.string().optional(),
  allowEmpty: z.boolean().optional(),
  detail: z.string().optional(),
  intent: z
    .object({
      kind: z.string().optional(),
      approve: z.string().optional(),
    })
    .optional(),
});

export type DshQuestion = z.infer<typeof DshQuestionSchema>;

/** A question request the plugin claimed, as it arrives on the channel. */
export const DshQuestionRequestSchema = z.object({
  requestId: z.string().min(1),
  questions: z.array(DshQuestionSchema).min(1),
  agent: z
    .object({
      id: z.string().optional(),
      sessionId: z.string().optional(),
    })
    .optional(),
});

export type DshQuestionRequest = z.infer<typeof DshQuestionRequestSchema>;

/** One answer in DSH's own shape: option labels, plus free text when typed. */
export interface DshQuestionAnswer {
  id: string;
  selected: string[];
  custom?: string;
}

/**
 * What Paseo decided about one relayed question.
 *
 * `unavailable` means Paseo could not put the question in front of anyone — it
 * did not ask, so DSH must keep looking for another answerer instead of waiting
 * on an answer that will never come.
 */
export type DshQuestionOutcome =
  | { kind: "answers"; answers: DshQuestionAnswer[] }
  | { kind: "dismiss" }
  | { kind: "unavailable" };

/**
 * One slash command the plugin's DSH process offers for an agent.
 *
 * The catalog is DSH's own registry, so the names and descriptions a slash menu
 * renders are the ones the process can actually run.
 */
export const DshCommandDescriptorSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  argumentHint: z.string(),
});

export type DshCommandDescriptor = z.infer<typeof DshCommandDescriptorSchema>;

/**
 * What running one command settled to, in DSH's own words.
 *
 * `success` may carry the text DSH shows its own user ("Compacted 12 history
 * items (~3,400 tokens).") and the session event DSH anchored the result at.
 * For `/compact` that event exists only when history was actually replaced, so
 * its absence is what separates a real compaction from a no-op. The plugin
 * reports DSH's expected failures — an unknown name, a busy agent, a cancelled
 * compaction — as `error` with the text DSH already composed for them.
 */
export type DshCommandOutcome =
  | { kind: "success"; text?: string; sourceEventSeq?: number }
  | { kind: "error"; text: string };

/**
 * The session's cumulative billing buckets, as DeepSeek Harness counts them.
 *
 * The three prompt-side buckets are disjoint and cover every billed prompt
 * token; `outputTokens` covers everything the model produced. These are the
 * numbers DSH's own usage pill renders, read from the same session projection.
 */
export const DshSessionUsageSchema = z.object({
  uncachedInputTokens: z.number().min(0),
  cacheReadTokens: z.number().min(0),
  cacheWriteTokens: z.number().min(0),
  outputTokens: z.number().min(0),
});

export type DshSessionUsage = z.infer<typeof DshSessionUsageSchema>;

export interface DshQuestionBridgeLaunch {
  /** Channel the plugin inside the spawned process listens on. */
  channel: string;
  /** Arguments to append to the provider command. */
  args: string[];
  /** Environment the spawned process needs to find its channel. */
  env: Record<string, string>;
}

export interface DshQuestionBridgeOptions {
  source: DshQuestionBridgeSource;
  logger: Logger;
  /** Platform whose channel form to use. Injectable for tests. */
  platform?: NodeJS.Platform;
  connectTimeoutMs?: number;
  reconnectDelayMs?: number;
  /** How long the command catalog may take before Paseo falls back to ACP. */
  commandListTimeoutMs?: number;
  /** How long one command may run; compaction summarizes the whole history. */
  commandRunTimeoutMs?: number;
  /** How long the session's token totals may take before Paseo gives up. */
  usageTimeoutMs?: number;
}

const CHANNEL_ENV = "PASEO_QUESTION_BRIDGE_SOCKET";
const PLUGIN_DIRECTORY = "paseo-question-bridge";
const PATCH_FILENAME = "paseo-question-bridge.yml";
const DEFAULT_CONNECT_TIMEOUT_MS = 20_000;
const DEFAULT_RECONNECT_DELAY_MS = 250;
const DEFAULT_COMMAND_LIST_TIMEOUT_MS = 5_000;
const DEFAULT_COMMAND_RUN_TIMEOUT_MS = 300_000;
const DEFAULT_USAGE_TIMEOUT_MS = 5_000;
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
 * The overlay that adds the bridge to the ACP profile.
 *
 * `insert` adds a plugin the profile does not already carry, and each name
 * resolves out of the profile's `node_modules`, which is where the plugin
 * directory is written. `tool-ask-user` is one of those rows because the ACP
 * composition has no `ask_user_question` tool at all: the shipped agent presets
 * own it, and the ACP profile mounts none of them. `tool-present` is missing for
 * the same reason, and it is how an agent hands a file to the user: with it, a
 * picture reaches the transcript without being read into the agent's context.
 */
const PATCH_CONTENT = `# Paseo's question bridge, loaded into \`dsh --profile acp\` at launch.
- insert:
    - id: tool-ask-user
      name: '@deepseek-ai/dsh-tool-ask-user'

    - id: tool-present
      name: '@deepseek-ai/dsh-tool-present'

    - id: ${PLUGIN_DIRECTORY}
      name: ${PLUGIN_DIRECTORY}
`;

/** A live channel connection that speaks the plugin's newline-delimited JSON. */
export interface DshQuestionBridgeConnection {
  /** Resolves when the plugin first answers on the channel. */
  readonly ready: Promise<void>;
  /** Send one answered question back to DSH. */
  answer(requestId: string, answers: DshQuestionAnswer[]): void;
  /** Tell DSH the user refused to answer. */
  dismiss(requestId: string, message?: string): void;
  /** Tell DSH this question was never shown, so it looks for another answerer. */
  decline(requestId: string): void;
  /**
   * Whether the plugin announced it can run DSH's slash commands.
   *
   * A plugin materialized by an older daemon never says so, and then commands
   * are not offered at all — the same behavior as before this existed.
   */
  supportsCommands(): boolean;
  /** This agent's command catalog, or null when the plugin cannot answer. */
  listCommands(agentId: string): Promise<DshCommandDescriptor[] | null>;
  /** Run one complete slash line, or null when DSH was never asked. */
  runCommand(agentId: string, line: string): Promise<DshCommandOutcome | null>;
  /**
   * Whether the plugin announced it can report the session's token totals.
   *
   * A plugin materialized before this existed never says so, and then Paseo
   * shows the context window it gets from ACP and nothing more.
   */
  supportsUsage(): boolean;
  /** The session's cumulative buckets, or null when DSH could not answer. */
  readUsage(agentId: string): Promise<DshSessionUsage | null>;
  close(): void;
}

export interface DshQuestionBridgeConnectOptions {
  channel: string;
  /** Handle one relayed question; the reply is sent for whatever it returns. */
  onAsk: (request: DshQuestionRequest) => Promise<DshQuestionOutcome>;
  /** DSH settled a question by itself — an aborted turn, a disposed profile. */
  onSettled?: (requestId: string, outcome: string) => void;
  /** The channel dropped; questions relayed afterwards are left unanswered. */
  onDisconnect?: () => void;
}

/**
 * Materializes the plugin into a DSH profile and relays questions through it.
 *
 * One instance serves every launch of its provider: the artifacts are written
 * once, while the channel is named per process because the plugin that answers
 * on it lives inside that process.
 */
export class DshQuestionBridge {
  private readonly home: string;
  private readonly logger: Logger;
  private readonly platform: NodeJS.Platform;
  private readonly connectTimeoutMs: number;
  private readonly reconnectDelayMs: number;
  private readonly commandListTimeoutMs: number;
  private readonly commandRunTimeoutMs: number;
  private readonly usageTimeoutMs: number;
  private artifacts: Promise<{ patchPath: string }> | null = null;

  constructor(options: DshQuestionBridgeOptions) {
    this.home = expandHome(options.source.home ?? "~/.dsh");
    this.logger = options.logger.child({ module: "agent", component: "dsh-question-bridge" });
    this.platform = options.platform ?? process.platform;
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
    this.commandListTimeoutMs = options.commandListTimeoutMs ?? DEFAULT_COMMAND_LIST_TIMEOUT_MS;
    this.commandRunTimeoutMs = options.commandRunTimeoutMs ?? DEFAULT_COMMAND_RUN_TIMEOUT_MS;
    this.usageTimeoutMs = options.usageTimeoutMs ?? DEFAULT_USAGE_TIMEOUT_MS;
  }

  /** Write the plugin and its overlay, then name a channel for one process. */
  async prepareLaunch(): Promise<DshQuestionBridgeLaunch> {
    const { patchPath } = await this.materialize();
    const channel = this.createChannel();
    return {
      channel,
      args: ["--patch", patchPath],
      env: { [CHANNEL_ENV]: channel },
    };
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
    const artifact = await loadDshQuestionBridgePluginArtifact(import.meta.url);
    const pluginDirectory = path.join(this.home, "profiles", "node_modules", PLUGIN_DIRECTORY);
    const patchPath = path.join(this.home, "profiles", PATCH_FILENAME);
    await this.writeIfChanged(path.join(pluginDirectory, "package.json"), PLUGIN_PACKAGE);
    await this.writeIfChanged(path.join(pluginDirectory, "index.js"), artifact);
    await this.writeIfChanged(patchPath, PATCH_CONTENT);
    this.logger.debug({ pluginDirectory, patchPath }, "Materialized the DSH question bridge");
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
    const name = `paseo-question-bridge-${randomUUID()}`;
    if (this.platform === "win32") {
      return `pipe:\\\\.\\pipe\\${name}`;
    }
    return `unix:${path.join(tmpdir(), "paseo-question-bridge", `${name}.sock`)}`;
  }

  /**
   * Relay questions over `channel`, keeping one connection open.
   *
   * The plugin binds the channel while the profile boots, so a dial can arrive
   * before it is up; a connection is retried until it takes, and dialed again if
   * the plugin drops one. A question that arrives with no connection is left to
   * DSH's other answerers — the same `NO_PROVIDER` outcome Paseo had before.
   */
  connect(options: DshQuestionBridgeConnectOptions): DshQuestionBridgeConnection {
    const target = parseChannel(options.channel);
    const started = Date.now();
    let socket: ReturnType<typeof createConnection> | null = null;
    let closed = false;
    let buffered = "";
    let timer: NodeJS.Timeout | null = null;
    let readySettled = false;
    /** Whether the plugin announced it can list and run DSH's commands. */
    let commandsSupported = false;
    /** Whether the plugin announced it can report the session's token totals. */
    let usageSupported = false;
    /** Questions DSH settled on its own; a reply to one of those would be refused. */
    const settled = new Set<string>();
    /** Requests waiting on a reply, keyed by the id this side minted. */
    const requests = new Map<
      string,
      { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
    >();
    let requestSeq = 0;
    let resolveReady: () => void = () => {};
    let rejectReady: (error: Error) => void = () => {};
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });

    const settleReady = (error?: Error) => {
      if (readySettled) return;
      readySettled = true;
      if (error === undefined) resolveReady();
      else rejectReady(error);
    };

    const write = (message: Record<string, unknown>): boolean => {
      const open = socket;
      if (open === null || open.destroyed) {
        this.logger.warn(
          { channel: options.channel },
          "The DSH question bridge is disconnected; dropping a reply",
        );
        return false;
      }
      open.write(`${JSON.stringify(message)}\n`);
      return true;
    };

    const schedule = (delayMs: number) => {
      if (closed || timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        dial();
      }, delayMs);
      timer.unref();
    };

    /**
     * Send one request that expects a reply, keyed by an id this side minted.
     *
     * Commands are the only request/reply pair on this channel — questions and
     * their answers flow the other way — so the id namespace stays this side's.
     * A reply that never comes is a rejection the caller turns into "Paseo could
     * not ask DSH", never a hang.
     */
    const request = (message: Record<string, unknown>, timeoutMs: number): Promise<unknown> => {
      const id = `paseo-${++requestSeq}`;
      return new Promise<unknown>((resolve, reject) => {
        const forget = () => {
          requests.delete(id);
        };
        const expiry = setTimeout(() => {
          forget();
          reject(new Error(`${String(message.op)} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        expiry.unref();
        requests.set(id, {
          resolve: (value) => {
            forget();
            resolve(value);
          },
          reject: (error) => {
            forget();
            reject(error);
          },
          timer: expiry,
        });
        if (!write({ ...message, id })) {
          const entry = requests.get(id);
          if (entry !== undefined) entry.reject(new Error("the DSH bridge is disconnected"));
        }
      });
    };

    const settleRequest = (message: Record<string, unknown>): boolean => {
      if (typeof message.id !== "string") return false;
      const entry = requests.get(message.id);
      if (entry === undefined) return false;
      clearTimeout(entry.timer);
      entry.resolve(message);
      return true;
    };

    const handle = (line: string) => {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        this.logger.warn("The DSH question bridge sent invalid JSON");
        return;
      }
      if (!isRecord(message)) return;
      if (settleRequest(message)) return;
      switch (message.op) {
        case "ready": {
          commandsSupported = message.commands === true;
          usageSupported = message.usage === true;
          this.logger.debug(
            {
              channel: options.channel,
              commands: commandsSupported,
              usage: usageSupported,
            },
            "The DSH bridge is ready",
          );
          return;
        }
        case "ask": {
          const parsed = DshQuestionRequestSchema.safeParse(message);
          if (!parsed.success) {
            this.logger.warn({ err: parsed.error }, "The DSH question bridge sent a malformed ask");
            write({ op: "unavailable", requestId: message.requestId ?? null });
            return;
          }
          void this.relayQuestion({ options, request: parsed.data, write, settled });
          return;
        }
        case "settled": {
          if (typeof message.requestId === "string" && typeof message.outcome === "string") {
            // DSH finished this question without Paseo — an aborted turn, a
            // disposed profile — so the reply Paseo is about to compute would
            // arrive for a question that no longer exists.
            settled.add(message.requestId);
            options.onSettled?.(message.requestId, message.outcome);
          }
          return;
        }
        case "error": {
          this.logger.debug({ message }, "The DSH question bridge reported an error");
          return;
        }
        default:
      }
    };

    const dial = () => {
      if (closed) return;
      const attempt = createConnection(target);
      let failed = false;
      attempt.setEncoding("utf8");
      attempt.once("connect", () => {
        socket = attempt;
        settleReady();
        this.logger.debug({ channel: options.channel }, "Connected to the DSH question bridge");
      });
      attempt.on("data", (chunk: string) => {
        buffered += chunk;
        let index = buffered.indexOf("\n");
        while (index !== -1) {
          const line = buffered.slice(0, index);
          buffered = buffered.slice(index + 1);
          index = buffered.indexOf("\n");
          if (line.trim().length > 0) handle(line);
        }
      });
      const abandon = (error: Error) => {
        if (failed) return;
        failed = true;
        const wasConnected = socket === attempt;
        if (wasConnected) socket = null;
        attempt.destroy();
        if (closed) return;
        if (wasConnected) options.onDisconnect?.();
        if (Date.now() - started >= this.connectTimeoutMs) {
          settleReady(error);
          return;
        }
        schedule(this.reconnectDelayMs);
      };
      attempt.once("error", abandon);
      attempt.once("close", () => abandon(new Error("the DSH question bridge closed the channel")));
    };

    dial();

    return {
      ready,
      answer: (requestId, answers) => {
        write({ op: "answer", requestId, answers });
      },
      dismiss: (requestId, message) => {
        write({ op: "dismiss", requestId, ...(message === undefined ? {} : { message }) });
      },
      decline: (requestId) => {
        write({ op: "unavailable", requestId });
      },
      supportsCommands: () => commandsSupported,
      supportsUsage: () => usageSupported,
      readUsage: async (agentId) => {
        if (!usageSupported) return null;
        try {
          const reply = await request({ op: "usage", agentId }, this.usageTimeoutMs);
          if (!isRecord(reply) || reply.ok !== true) {
            this.logger.warn(
              { channel: options.channel, reply },
              "The DSH bridge could not report this session's usage",
            );
            return null;
          }
          // A session with no billed request yet is an answer, not a failure:
          // the plugin reports `usage: null` and Paseo keeps what it has.
          if (reply.usage === null) return null;
          const parsed = DshSessionUsageSchema.safeParse(reply.usage);
          if (!parsed.success) {
            this.logger.warn({ err: parsed.error }, "The DSH bridge sent malformed usage");
            return null;
          }
          this.logger.debug({ usage: parsed.data }, "The DSH bridge reported session usage");
          return parsed.data;
        } catch (error) {
          this.logger.warn({ err: error }, "Asking the DSH bridge for usage failed");
          return null;
        }
      },
      listCommands: async (agentId) => {
        if (!commandsSupported) return null;
        try {
          const reply = await request({ op: "commands", agentId }, this.commandListTimeoutMs);
          if (!isRecord(reply) || reply.ok !== true) {
            this.logger.warn(
              { channel: options.channel, reply },
              "The DSH bridge could not list this agent's commands",
            );
            return null;
          }
          const parsed = z.array(DshCommandDescriptorSchema).safeParse(reply.list);
          if (!parsed.success) {
            this.logger.warn(
              { err: parsed.error },
              "The DSH bridge sent a malformed command catalog",
            );
            return null;
          }
          return parsed.data;
        } catch (error) {
          this.logger.warn({ err: error }, "Asking the DSH bridge for commands failed");
          return null;
        }
      },
      runCommand: async (agentId, line) => {
        if (!commandsSupported) return null;
        try {
          const reply = await request({ op: "command", agentId, line }, this.commandRunTimeoutMs);
          if (!isRecord(reply)) return null;
          if (reply.ok !== true) {
            return {
              kind: "error",
              text: typeof reply.error === "string" ? reply.error : `${line} failed`,
            };
          }
          const result = isRecord(reply.result) ? reply.result : null;
          if (result === null) return { kind: "error", text: `${line} returned no result` };
          if (result.kind === "success") {
            const sourceEventSeq =
              typeof result.sourceEventSeq === "number" ? result.sourceEventSeq : undefined;
            return {
              kind: "success",
              ...(typeof result.text === "string" ? { text: result.text } : {}),
              ...(sourceEventSeq === undefined ? {} : { sourceEventSeq }),
            };
          }
          return {
            kind: "error",
            text: typeof result.text === "string" ? result.text : `${line} failed`,
          };
        } catch (error) {
          this.logger.warn({ err: error }, "Running a DSH command through the bridge failed");
          return null;
        }
      },
      close: () => {
        closed = true;
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        const open = socket;
        socket = null;
        open?.destroy();
        for (const entry of requests.values()) {
          clearTimeout(entry.timer);
          entry.reject(new Error("the DSH bridge closed"));
        }
        requests.clear();
      },
    };
  }

  /** Put one relayed question in front of Paseo and send back its decision. */
  private async relayQuestion(input: {
    options: DshQuestionBridgeConnectOptions;
    request: DshQuestionRequest;
    write: (message: Record<string, unknown>) => boolean;
    settled: Set<string>;
  }): Promise<void> {
    const { options, request, write, settled } = input;
    let outcome: DshQuestionOutcome;
    try {
      outcome = await options.onAsk(request);
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to relay a DSH question to Paseo");
      outcome = { kind: "unavailable" };
    }
    if (settled.delete(request.requestId)) {
      // DSH settled it while Paseo was deciding; there is nothing to reply to.
      return;
    }
    switch (outcome.kind) {
      case "unavailable":
        write({ op: "unavailable", requestId: request.requestId });
        return;
      case "dismiss":
        write({ op: "dismiss", requestId: request.requestId });
        return;
      case "answers":
        write({ op: "answer", requestId: request.requestId, answers: outcome.answers });
    }
  }
}

/** Build the bridge a provider asked for, or nothing when it asked for none. */
export function createDshQuestionBridge(
  source: DshQuestionBridgeSource | null,
  logger: Logger,
): DshQuestionBridge | null {
  return source === null ? null : new DshQuestionBridge({ source, logger });
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
      throw new Error(`invalid DSH question bridge channel "${channel}"`);
    }
    return { host, port };
  }
  throw new Error(`unknown DSH question bridge channel "${channel}"`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expandHome(value: string): string {
  if (value === "~") return homedir();
  return value.startsWith("~/") ? path.join(homedir(), value.slice(2)) : value;
}

type CompileDshQuestionBridgePlugin = (sourcePath: string) => Promise<Uint8Array>;

/**
 * The packaged plugin bundle, or — when running from source — the plugin
 * compiled on the spot. A packaged runtime that lost its bundle fails loudly
 * instead of writing a plugin this build cannot produce.
 */
export async function loadDshQuestionBridgePluginArtifact(
  moduleUrl: string,
  compileSource: CompileDshQuestionBridgePlugin = compileDshQuestionBridgePlugin,
): Promise<Uint8Array> {
  const bundleUrl = new URL("./bridge-plugin.bundle.mjs", moduleUrl);
  try {
    return await readFile(bundleUrl);
  } catch (error) {
    if (!fileURLToPath(moduleUrl).endsWith(`${path.sep}bridge.ts`)) {
      throw new Error("Bundled DSH question bridge plugin artifact is missing", { cause: error });
    }
  }
  return compileSource(fileURLToPath(new URL("./bridge-plugin.mjs", moduleUrl)));
}

async function compileDshQuestionBridgePlugin(sourcePath: string): Promise<Uint8Array> {
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
  if (!artifact) throw new Error("Failed to bundle the DSH question bridge plugin");
  return artifact;
}
