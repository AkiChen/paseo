/**
 * Paseo's in-process bridge to DeepSeek Harness user questions.
 *
 * DSH answers a question in the process that owns the session, through a
 * Cordis waterfall (`user-questions/request`) that its own client UI claims.
 * The ACP profile mounts neither that UI nor any other answerer, so
 * `ask_user_question` has nobody to ask and `exit_plan_mode` cannot review a
 * plan: both fail with `NO_PROVIDER`. The tool row itself is not even part of
 * the ACP composition, which is why the overlay that loads this plugin inserts
 * it too.
 *
 * Paseo loads this plugin into the `dsh --profile acp` process it already owns.
 * The plugin claims the waterfall and relays each request over a local channel
 * to the daemon that spawned the process, which renders it as a question card
 * and sends the human's answer back. Nothing about a process Paseo did not
 * launch changes: the plugin loads only through a `--patch` overlay the daemon
 * passes on the command line, and it stays inert without a channel.
 *
 * A channel also buys one line of system-prompt guidance: the shipped tool
 * description says what the tool does, not when a coding agent should prefer it
 * over deciding for the user, and the ACP profile mounts no agent preset that
 * would say so.
 *
 * The same process is where DeepSeek Harness's slash commands live — `/compact`,
 * `/goal`, `/plan`, `/permission`, `/feedback` are registered on `ctx.commands`
 * and only its own client UI ever runs them. The ACP profile composes the
 * registry, so the plugin lists it and runs a line on the daemon's behalf,
 * reporting DSH's own result text back. That is the only way Paseo can offer
 * those commands: `dsh-acp` has no command method and never sends
 * `available_commands_update`.
 *
 * It is also where the session's token totals live. ACP tells a client how full
 * the context window is (`usage_update`) but nothing about billing, and the
 * cumulative buckets only exist as the `tokenUsage` session projection the
 * harness renders in its own usage pill — so the plugin reads that projection on
 * request and answers with the same numbers.
 *
 * It speaks newline-delimited JSON over the channel named by
 * `PASEO_QUESTION_BRIDGE_SOCKET` (`unix:<path>`, `pipe:<name>`,
 * `tcp:<host>:<port>`) and never writes to stdout, which belongs to the ACP
 * handshake.
 */

import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, unlinkSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";

export const name = "paseo-question-bridge";

/**
 * The seams this plugin answers on. A profile without them never activates us.
 *
 * `systemPrompt` is here for the guidance below; `commands`, `agents`, and
 * `sessionProjections` are here because the daemon runs this session's slash
 * commands and reads its token totals through the same channel.
 */
export const inject = ["userQuestions", "systemPrompt", "commands", "agents", "sessionProjections"];

const SOCKET_ENV = "PASEO_QUESTION_BRIDGE_SOCKET";
const LOG_ENV = "PASEO_QUESTION_BRIDGE_LOG";
const PROTOCOL = 1;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const GUIDANCE_SECTION = "paseo:user-questions";
/** Where the plan policy sits, used when the section order table is unavailable. */
const GUIDANCE_ORDER_FALLBACK = 500;
/**
 * One complete slash-command line, exactly as DSH's own registry parses it: a
 * name, then either the end of the line or the input it takes. Anything else is
 * prose that happens to start with a slash, and belongs to the model.
 */
const COMMAND_LINE = /^\/[a-z][a-z0-9_-]*(?=$|[\t\n\r ])/u;

/**
 * When to ask instead of deciding.
 *
 * Deliberately short and bounded: the failure this addresses is an agent that
 * picks for the user, or asks in prose where no options can be rendered — not
 * an agent that asks about what it could look up itself.
 */
const GUIDANCE = [
  "Use ask_user_question for decisions that belong to the user: which of several",
  "plausible approaches to take, a preference only they can state, or a choice they",
  "asked you to make. Ask with the tool rather than in prose, offer concrete",
  "options, and keep one decision per question. Anything you can settle by reading",
  "the workspace, settle yourself.",
].join(" ");

function log(line) {
  const target = process.env[LOG_ENV];
  if (!target) return;
  try {
    appendFileSync(target, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // A bridge log failure must never take the profile down.
  }
}

function describeError(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/**
 * An error shaped like DSH's own `UserQuestionError`.
 *
 * The question service reconstructs the taxonomy from `name` and `code` on any
 * thrown object, so a code the caller branches on — `ASK_CANCELLED`, which is
 * what plan mode turns into "the user dismissed the review" — survives without
 * this plugin importing DSH packages it cannot resolve from the profile.
 */
function questionError(message, code) {
  const error = new Error(message);
  error.name = "UserQuestionError";
  error.code = code;
  return error;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Where the guidance sits in the prompt: with the plan policy, ahead of every
 * tool section. The order table is the profile's, so a name it does not carry
 * falls back to the number that table gives that policy today.
 */
function guidanceOrder(systemPrompt) {
  try {
    const planPolicy = systemPrompt.getSectionOrder("PLAN_POLICY");
    return Number.isFinite(planPolicy) ? planPolicy + 1 : GUIDANCE_ORDER_FALLBACK;
  } catch {
    return GUIDANCE_ORDER_FALLBACK;
  }
}

function optionalString(record, key) {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Copy one question into the wire shape, keeping only what a UI renders and
 * answers by. Unknown fields are dropped rather than forwarded, so the daemon
 * validates a small, stable contract instead of whatever DSH adds next.
 */
function normalizeQuestion(question, index) {
  const options = Array.isArray(question.options)
    ? question.options
        .filter((option) => isRecord(option) && typeof option.label === "string")
        .map((option) =>
          typeof option.description === "string"
            ? { label: option.label, description: option.description }
            : { label: option.label },
        )
    : [];
  const intent = isRecord(question.intent)
    ? {
        ...(typeof question.intent.kind === "string" ? { kind: question.intent.kind } : {}),
        ...(typeof question.intent.approve === "string"
          ? { approve: question.intent.approve }
          : {}),
      }
    : {};
  const header = optionalString(question, "header");
  const placeholder = optionalString(question, "placeholder");
  const detail = optionalString(question, "detail");
  return {
    id: optionalString(question, "id") ?? `q${index + 1}`,
    question: typeof question.question === "string" ? question.question : "",
    ...(header === undefined ? {} : { header }),
    options,
    ...(question.multiSelect === true ? { multiSelect: true } : {}),
    ...(placeholder === undefined ? {} : { placeholder }),
    ...(question.allowEmpty === true ? { allowEmpty: true } : {}),
    ...(detail === undefined ? {} : { detail }),
    ...(Object.keys(intent).length === 0 ? {} : { intent }),
  };
}

/** What the daemon needs to attribute a question to a Paseo agent in its logs. */
function describeAgent(agent) {
  if (!isRecord(agent)) return undefined;
  try {
    const id = optionalString(agent, "id");
    const session = isRecord(agent.session) ? optionalString(agent.session, "id") : undefined;
    if (id === undefined && session === undefined) return undefined;
    return {
      ...(id === undefined ? {} : { id }),
      ...(session === undefined ? {} : { sessionId: session }),
    };
  } catch {
    return undefined;
  }
}

/** Accept only answers that name a question this request asked. */
function parseAnswers(value, questions) {
  if (!Array.isArray(value)) return null;
  const known = new Set(questions.map((question) => question.id));
  const answers = [];
  for (const answer of value) {
    if (!isRecord(answer)) return null;
    const id = optionalString(answer, "id");
    if (id === undefined || !known.has(id)) return null;
    if (!Array.isArray(answer.selected)) return null;
    const selected = answer.selected.filter((item) => typeof item === "string");
    if (selected.length !== answer.selected.length) return null;
    answers.push({
      id,
      selected,
      ...(typeof answer.custom === "string" ? { custom: answer.custom } : {}),
    });
  }
  return answers;
}

/**
 * Finish one pending question once, telling the daemon which way it ended.
 *
 * The `settled` line matters even when the daemon sent the answer: DSH also
 * settles a question on its own — an aborted turn, a disposed bridge — and a
 * card left behind would be a lie about what the model is still waiting for.
 */
function settleQuestion(bridge, requestId, outcome, finish) {
  const entry = bridge.pending.get(requestId);
  if (entry === undefined) return false;
  bridge.pending.delete(requestId);
  if (entry.signal !== undefined && entry.onAbort !== null) {
    entry.signal.removeEventListener("abort", entry.onAbort);
  }
  bridge.write({ op: "settled", requestId, outcome });
  finish(entry);
  return true;
}

function answerQuestion(bridge, requestId, answers) {
  const entry = bridge.pending.get(requestId);
  if (entry === undefined) return false;
  const parsed = parseAnswers(answers, entry.questions);
  if (parsed === null) return false;
  return settleQuestion(bridge, requestId, "answered", (pending) =>
    pending.resolve({ answers: parsed }),
  );
}

function dismissQuestion(bridge, requestId, message) {
  return settleQuestion(bridge, requestId, "dismissed", (entry) =>
    entry.reject(
      questionError(
        typeof message === "string" && message.length > 0
          ? message
          : "the user cancelled ask_user_question",
        "ASK_CANCELLED",
      ),
    ),
  );
}

/**
 * Hand the question back to DSH's other answerers.
 *
 * The daemon declines when it cannot render the question for anyone, which is
 * not the same as the user refusing it: DSH must keep looking rather than
 * report an answer that no human gave.
 */
function declineQuestion(bridge, requestId) {
  return settleQuestion(bridge, requestId, "declined", (entry) =>
    entry.resolve({ declined: true }),
  );
}

/**
 * Claim one DSH question request, or return null to let the next answerer try.
 *
 * Null is the honest answer when no daemon is connected: DSH then reports the
 * request as unanswered, exactly as it does today, instead of blocking a turn
 * on a card nobody can see.
 */
function claimQuestion(bridge, request) {
  if (bridge.client === null) return null;
  const questions = Array.isArray(request?.questions)
    ? request.questions.filter(isRecord).map(normalizeQuestion)
    : [];
  if (questions.length === 0) return null;

  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    const entry = { resolve, reject, questions, signal: request?.signal, onAbort: null };
    bridge.pending.set(requestId, entry);

    entry.onAbort = () => {
      if (!bridge.pending.has(requestId)) return;
      settleQuestion(bridge, requestId, "aborted", (pending) =>
        pending.reject(
          questionError("ask_user_question was aborted before the user answered", "ASK_ABORTED"),
        ),
      );
    };
    if (entry.signal?.aborted === true) {
      entry.onAbort();
      return;
    }
    entry.signal?.addEventListener("abort", entry.onAbort, { once: true });

    const agent = describeAgent(request?.agent);
    bridge.write({
      op: "ask",
      protocol: PROTOCOL,
      requestId,
      questions,
      ...(agent === undefined ? {} : { agent }),
    });
  });
}

/**
 * One live agent, or null when the id names none.
 *
 * The ACP session id and the agent id are the same string, which is what lets
 * the daemon address an agent it already owns without a second lookup table.
 * A missing agent is normal: the process outlives a closed session, and a
 * resumed one is looked up by the id it was resumed with.
 */
function resolveAgent(agents, agentId) {
  if (typeof agentId !== "string" || agentId.length === 0) return null;
  try {
    return agents.get(agentId) ?? null;
  } catch {
    return null;
  }
}

/** Copy one registry descriptor into the wire shape a slash menu renders. */
function normalizeCommand(descriptor) {
  const commandName = optionalString(descriptor, "name");
  if (commandName === undefined) return null;
  const input = isRecord(descriptor.input) ? descriptor.input : undefined;
  return {
    name: commandName,
    description: typeof descriptor.description === "string" ? descriptor.description : "",
    argumentHint: input !== undefined && typeof input.hint === "string" ? input.hint : "",
  };
}

/**
 * Answer one `commands` request with this agent's effective command catalog.
 *
 * The registry is DSH's own: the names, descriptions, and argument hints are
 * exactly what its client UI would offer, so the menu Paseo renders cannot
 * drift from the commands the process can actually run.
 */
function listCommands(bridge, message) {
  const id = message.id ?? null;
  const agent = resolveAgent(bridge.agents, message.agentId);
  if (agent === null) {
    return {
      op: "commands",
      id,
      ok: false,
      error: `no live agent "${String(message.agentId)}" in this process`,
    };
  }
  try {
    const list = [];
    for (const descriptor of bridge.commands.list(agent)) {
      const command = normalizeCommand(descriptor);
      if (command !== null) list.push(command);
    }
    return { op: "commands", id, ok: true, list };
  } catch (error) {
    log(`listing commands failed: ${describeError(error)}`);
    return { op: "commands", id, ok: false, error: describeError(error) };
  }
}

/** One finite non-negative token count, or zero when DSH did not report it. */
function tokenCount(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Answer one `usage` request with this session's cumulative billing buckets.
 *
 * These are the numbers DeepSeek Harness puts in its own usage pill: three
 * disjoint prompt-side buckets (uncached input, cache read, cache write) over
 * the whole durable log, plus output. They come from the session's `tokenUsage`
 * projection — the same value its client UI reads — so Paseo cannot drift from
 * what the harness itself reports. ACP carries none of it: `session/prompt`
 * answers with a stop reason alone.
 */
function readUsage(bridge, message) {
  const id = message.id ?? null;
  const agent = resolveAgent(bridge.agents, message.agentId);
  if (agent === null) {
    return {
      op: "usage",
      id,
      ok: false,
      error: `no live agent "${String(message.agentId)}" in this process`,
    };
  }
  try {
    const snapshot = bridge.sessionProjections.snapshot(agent.session, ["tokenUsage"]);
    const usage = isRecord(snapshot?.values) ? snapshot.values.tokenUsage : undefined;
    log(
      `usage for ${String(message.agentId)}: ${isRecord(usage) ? JSON.stringify(usage) : "none"}`,
    );
    if (!isRecord(usage)) {
      // No billed request yet: a real answer, not a failure.
      return { op: "usage", id, ok: true, usage: null };
    }
    return {
      op: "usage",
      id,
      ok: true,
      usage: {
        uncachedInputTokens: tokenCount(usage.uncachedInputTokens),
        cacheReadTokens: tokenCount(usage.cacheReadTokens),
        cacheWriteTokens: tokenCount(usage.cacheWriteTokens),
        outputTokens: tokenCount(usage.outputTokens),
      },
    };
  } catch (error) {
    log(`reading usage failed: ${describeError(error)}`);
    return { op: "usage", id, ok: false, error: describeError(error) };
  }
}

/**
 * Parse and run one complete slash-command line through the registry.
 *
 * `execute` is DSH's own entry point: it logs the `command/run` and
 * `command/done` pair into the session, resolves agent-scoped commands, and
 * yields the same result text its client UI shows. An unknown or malformed name
 * comes back as `undefined`, which is reported as a failure rather than
 * silently swallowed.
 */
async function runCommand(bridge, socket, message) {
  const id = message.id ?? null;
  const respond = (payload) => {
    try {
      socket.write(`${JSON.stringify(payload)}\n`);
    } catch (error) {
      log(`reply failed: ${describeError(error)}`);
    }
  };
  const line = typeof message.line === "string" ? message.line.trim() : "";
  if (!COMMAND_LINE.test(line)) {
    respond({ op: "command", id, ok: false, error: `"${line}" is not a slash command` });
    return;
  }
  const agent = resolveAgent(bridge.agents, message.agentId);
  if (agent === null) {
    respond({
      op: "command",
      id,
      ok: false,
      error: `no live agent "${String(message.agentId)}" in this process`,
    });
    return;
  }

  const controller = new AbortController();
  bridge.running.add(controller);
  try {
    const executed = await bridge.commands.execute(agent, line, [], controller.signal);
    if (executed === undefined) {
      respond({ op: "command", id, ok: false, error: `unknown command "${line}"` });
      return;
    }
    const result = executed.result;
    respond({
      op: "command",
      id,
      ok: true,
      result:
        result.kind === "success"
          ? {
              kind: "success",
              ...(result.text === undefined ? {} : { text: result.text }),
              // DSH anchors a command result at the session event it produced.
              // For `/compact` that event exists only when history was actually
              // replaced, which is how the daemon can tell a real compaction
              // from "No compactable history yet."
              ...(result.sourceEventSeq === undefined
                ? {}
                : { sourceEventSeq: result.sourceEventSeq }),
            }
          : { kind: "error", text: result.text },
    });
  } catch (error) {
    log(`running ${line} failed: ${describeError(error)}`);
    respond({ op: "command", id, ok: false, error: describeError(error) });
  } finally {
    bridge.running.delete(controller);
  }
}

/**
 * Split one channel description into what `net` listens on.
 *
 * Paseo picks the form, because it knows what the target platform can bind: a
 * unix socket path, a Windows named pipe, or a loopback TCP port. A socket that
 * answers question requests is reachable by anything on the machine that can
 * open it, so TCP is refused outside loopback.
 */
function parseChannel(channel) {
  const separator = channel.indexOf(":");
  const kind = separator === -1 ? "" : channel.slice(0, separator);
  const value = channel.slice(separator + 1);
  switch (kind) {
    case "unix":
    case "pipe": {
      if (value.length === 0) throw new Error(`bridge channel "${channel}" has no path`);
      return { kind, listen: value, display: value };
    }
    case "tcp": {
      const parts = value.split(":");
      const host = parts.length === 2 ? "127.0.0.1" : parts.slice(0, -1).join(":");
      const port = Number(parts.at(-1));
      if (!LOOPBACK_HOSTS.has(host)) {
        throw new Error(`bridge channel "${channel}" must use a loopback host`);
      }
      if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
        throw new Error(`bridge channel "${channel}" does not name a valid TCP port`);
      }
      return { kind, listen: { host, port }, display: value };
    }
    default:
      throw new Error(`bridge channel "${channel}" must start with unix:, pipe:, or tcp:`);
  }
}

function listen(server, target) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(target);
  });
}

/** Bind the channel, replacing a socket file a crashed process left behind. */
async function startChannel(channel) {
  const parsed = parseChannel(channel);
  if (parsed.kind === "unix") mkdirSync(path.dirname(parsed.display), { recursive: true });
  const server = createServer();
  try {
    await listen(server, parsed.listen);
  } catch (error) {
    if (parsed.kind !== "unix" || error?.code !== "EADDRINUSE") throw error;
    try {
      unlinkSync(parsed.display);
    } catch {
      // Another process owns the path; the retry reports that.
    }
    await listen(server, parsed.listen);
  }
  if (parsed.kind === "unix") {
    try {
      // Owner-only: any local process that can open this socket answers as the user.
      chmodSync(parsed.display, 0o600);
    } catch {
      // Defence in depth; the bridge still works without it.
    }
  }
  return server;
}

function receive(bridge, socket, line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    socket.write(
      `${JSON.stringify({ op: "error", code: "bad-request", error: "invalid JSON" })}\n`,
    );
    return;
  }
  if (!isRecord(message)) return;
  log(`received ${String(message.op)}`);
  switch (message.op) {
    case "ping":
      socket.write(
        `${JSON.stringify({ op: "pong", id: message.id ?? null, protocol: PROTOCOL, pid: process.pid })}\n`,
      );
      return;
    case "answer": {
      const handled =
        typeof message.requestId === "string" &&
        answerQuestion(bridge, message.requestId, message.answers);
      if (!handled) {
        socket.write(
          `${JSON.stringify({
            op: "error",
            code: "unknown-request",
            requestId: message.requestId ?? null,
            error: "no pending question accepts this answer",
          })}\n`,
        );
      }
      return;
    }
    case "dismiss": {
      const handled =
        typeof message.requestId === "string" &&
        dismissQuestion(bridge, message.requestId, message.message);
      if (!handled) {
        socket.write(
          `${JSON.stringify({
            op: "error",
            code: "unknown-request",
            requestId: message.requestId ?? null,
            error: "no pending question matches this dismissal",
          })}\n`,
        );
      }
      return;
    }
    case "commands":
      socket.write(`${JSON.stringify(listCommands(bridge, message))}\n`);
      return;
    case "usage":
      socket.write(`${JSON.stringify(readUsage(bridge, message))}\n`);
      return;
    case "command":
      void runCommand(bridge, socket, message);
      return;
    case "unavailable": {
      const handled =
        typeof message.requestId === "string" && declineQuestion(bridge, message.requestId);
      if (!handled) {
        socket.write(
          `${JSON.stringify({
            op: "error",
            code: "unknown-request",
            requestId: message.requestId ?? null,
            error: "no pending question matches this decline",
          })}\n`,
        );
      }
      return;
    }
    default:
      socket.write(
        `${JSON.stringify({
          op: "error",
          code: "bad-request",
          error: `unknown op "${String(message.op)}"`,
        })}\n`,
      );
  }
}

export function apply(ctx) {
  const channel = process.env[SOCKET_ENV];
  if (channel === undefined || channel.length === 0) {
    log("no channel configured; bridge idle");
    return;
  }

  /** The daemon connection questions are relayed over; the newest one wins. */
  const client = { socket: null };
  const pending = new Map();
  /** Slash commands still running, so teardown can abort each one. */
  const running = new Set();
  const bridge = {
    get client() {
      return client.socket;
    },
    pending,
    running,
    commands: ctx.commands,
    agents: ctx.agents,
    sessionProjections: ctx.sessionProjections,
    write(message) {
      const socket = client.socket;
      if (socket === null || socket.destroyed === true) return false;
      try {
        socket.write(`${JSON.stringify(message)}\n`);
        return true;
      } catch (error) {
        log(`write failed: ${describeError(error)}`);
        return false;
      }
    },
  };

  const serveConnection = (socket) => {
    socket.setEncoding("utf8");
    const previous = client.socket;
    client.socket = socket;
    if (previous !== null && previous !== socket) previous.destroy();
    log(`client connected on ${channel}`);
    bridge.write({
      op: "ready",
      protocol: PROTOCOL,
      pid: process.pid,
      commands: true,
      usage: true,
    });

    let buffered = "";
    socket.on("data", (chunk) => {
      buffered += chunk;
      let index = buffered.indexOf("\n");
      while (index !== -1) {
        const line = buffered.slice(0, index);
        buffered = buffered.slice(index + 1);
        index = buffered.indexOf("\n");
        if (line.trim().length > 0) receive(bridge, socket, line);
      }
    });
    socket.on("close", () => {
      if (client.socket !== socket) return;
      client.socket = null;
      log("client disconnected");
    });
    socket.on("error", (error) => {
      log(`connection error: ${describeError(error)}`);
    });
  };

  ctx.on("user-questions/request", async (request, next) => {
    let claimed;
    try {
      claimed = claimQuestion(bridge, request);
    } catch (error) {
      log(`claim failed: ${describeError(error)}`);
      return next();
    }
    if (claimed === null) return next();
    const answer = await claimed;
    // A decline means the daemon could not show this question to anyone, so the
    // request keeps travelling down the waterfall instead of being answered.
    return answer?.declined === true ? next() : answer;
  });

  // Only while a daemon is wired up: guidance to ask is a promise that someone
  // will answer, and without a channel there is nobody to ask.
  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: GUIDANCE_SECTION,
        order: guidanceOrder(ctx.systemPrompt),
        text: GUIDANCE,
      }),
    "paseo-question-bridge: question guidance",
  );

  ctx.effect(() => {
    let server = null;
    void (async () => {
      try {
        const started = await startChannel(channel);
        server = started;
        started.on("connection", serveConnection);
        started.unref();
        log(`listening on ${channel}`);
      } catch (error) {
        log(`bridge unavailable: ${describeError(error)}`);
      }
    })();

    return () => {
      const closing = server;
      server = null;
      if (closing !== null) closing.close();
      for (const requestId of Array.from(pending.keys())) {
        settleQuestion(bridge, requestId, "aborted", (entry) =>
          entry.reject(questionError("the question bridge was disposed", "ASK_ABORTED")),
        );
      }
      // A command handler keeps running after its client is gone; its DSH-side
      // cancellation signal is the only way to stop the work it started.
      for (const controller of Array.from(running)) controller.abort();
      log("channel closed");
    };
  }, "paseo-question-bridge");
}
