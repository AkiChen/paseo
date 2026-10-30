/**
 * Paseo's in-process bridge to a DeepSeek Harness session store.
 *
 * DSH forks a session host-side: the store hands a child session a copy of the
 * source's event prefix, which is what keeps the model's cache warm. An ACP
 * client cannot ask for that, because DSH advertises no ACP fork capability, so
 * Paseo loads this plugin into the same `dsh --profile acp` process and asks it
 * over a local channel instead. The fork happens inside the process that owns the
 * store; Paseo only learns the child id, and resumes it over ACP like any other
 * session.
 *
 * The plugin is loaded from `$DSH_HOME/profiles/node_modules/paseo-fork-bridge`
 * through a `--patch` overlay, so it changes nothing unless Paseo launches the
 * process. It speaks newline-delimited JSON over the channel named by
 * `PASEO_FORK_BRIDGE_SOCKET` (`unix:<path>`, `pipe:<name>`, `tcp:<host>:<port>`)
 * and never writes to stdout, which belongs to the ACP handshake.
 *
 * The child is written straight to the session store rather than through
 * `sessions.fork` plus an agent: a store fork is owned by the calling fiber and
 * persists nothing on its own, and a live child would hold a second write handle
 * on a session the ACP resume is about to open. What lands on disk is the same
 * artifact a host-side fork writes — the source's completed-turn prefix, marked
 * `isSeeded` with its inherited event count — minus the `parentSession` lineage,
 * which `session/resume` refuses (`is not resumable`). Lineage is the one thing
 * this gives up: DSH's own UI will not draw this child as a fork.
 */

import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, unlinkSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";

export const name = "paseo-fork-bridge";

/** The services the fork path reads. A missing one fails a request, not the process. */
export const inject = ["sessions", "sessionPersistence"];

const SOCKET_ENV = "PASEO_FORK_BRIDGE_SOCKET";
const LOG_ENV = "PASEO_FORK_BRIDGE_LOG";
const SELFTEST_ENV = "PASEO_FORK_BRIDGE_SELFTEST";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

/** A fork request the bridge refuses, with a stable code for the caller to branch on. */
class BridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "BridgeError";
  }
}

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
 * The seq of the assistant message with `messageId`, or undefined when this log
 * does not carry it.
 */
function assistantMessageSeq(events, messageId) {
  const index = events.findLastIndex(
    (event) =>
      event.type === "assistant/message" &&
      event.data !== null &&
      typeof event.data === "object" &&
      event.data.message !== null &&
      typeof event.data.message === "object" &&
      event.data.message.id === messageId,
  );
  return index === -1 ? undefined : events[index].seq;
}

/**
 * The prefix length to fork through.
 *
 * The boundary is the first `turn/end` at or after the assistant message the
 * user branched from, and the cut stops right there. DSH's host fork instead
 * walks to the next `turn/start`, which pulls between-turn events into the child;
 * this path keeps exactly the turn the user clicked.
 *
 * A Paseo timeline seq is not a DSH seq, so the provider message id is the only
 * boundary both sides share. A request without one, or one this log does not
 * carry, fails: branching somewhere the user did not click is worse than failing.
 */
function resolveForkCut(events, atSeq, atMessageId) {
  let anchor = atSeq;
  if (typeof atMessageId === "string" && atMessageId.length > 0) {
    const found = assistantMessageSeq(events, atMessageId);
    if (found === undefined) {
      throw new BridgeError(
        "fork-unavailable",
        `session has no assistant message "${atMessageId}" to branch from`,
      );
    }
    anchor = found;
  }

  // No boundary is a request error, not a reason to branch from the end: the
  // fork must land where the user clicked or not at all.
  if (anchor === undefined) {
    throw new BridgeError(
      "fork-unavailable",
      "fork requires a boundary: no assistant message id was given",
    );
  }
  const boundary = events.find((event) => event.type === "turn/end" && event.seq >= anchor);
  if (boundary === undefined) {
    throw new BridgeError(
      "fork-unavailable",
      `session has not completed the turn containing event ${anchor}`,
    );
  }
  // Stop exactly at the turn's end. DSH's own host fork walks forward to the
  // next turn/start, which drags between-turn events — a queued inbox message,
  // a title update — into the child even though the user never saw them as part
  // of the turn they clicked. This fork keeps only what the turn itself wrote.
  return boundary.seq + 1;
}

/**
 * Read the source's header and full event log.
 *
 * The session Paseo forks is live in this process by construction, so the live
 * store is the normal path. A session that is only on disk is read through
 * persistence rather than the query service: a query call re-enters this
 * plugin's fiber, where the store it injects is not reachable.
 */
async function readSource(bridge, sessionId) {
  const live = bridge.sessions.get(sessionId);
  if (live !== undefined) {
    log(`source ${sessionId} is live here`);
    return { events: live.snapshotEvents(), header: live.header, close: () => {} };
  }
  log(`source ${sessionId} is not live here; reading it from the store`);
  let handle;
  try {
    handle = await bridge.persistence.open(sessionId, "read");
    const read = await handle.read(0, undefined);
    return { events: read.events, header: handle.header, close: () => handle.close() };
  } catch (error) {
    await handle?.close().catch(() => {});
    throw new BridgeError("source-unavailable", describeError(error));
  }
}

/**
 * Point the seeded prefix's session-scoped delivery markers at the child.
 *
 * A v4 log records which session accepted each delivery. Seeding copies those
 * markers verbatim, so they still name the source; the decoder accepts a foreign
 * marker only on a session that keeps `parentSession` lineage, and the ACP
 * resume path refuses exactly those sessions. Renaming the markers to the child
 * keeps both invariants: the child owns its copy, and it stays resumable.
 */
function retargetSeed(events, childId) {
  return events.map((event) => {
    if (event.type !== "session-log-deepseek/delivery-accepted") return event;
    const data = event.data;
    if (data === null || data === undefined || data.sessionId === childId) return event;
    return { ...event, data: { ...data, sessionId: childId } };
  });
}

/**
 * Write one child session holding a copy of the source's prefix.
 *
 * `prepare` builds the same header a host-side fork builds — seeded, with the
 * inherited count that must equal the seed length — and the store then owns
 * durability: `flush` is what materializes the log another process resumes from.
 */
async function forkSession(bridge, request) {
  const { sessions, persistence } = bridge;
  if (sessions === undefined || persistence === undefined) {
    throw new BridgeError("bridge-unavailable", "this profile has no session store to fork");
  }

  const sessionId = request.sessionId;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new BridgeError("bad-request", "sessionId must be a non-empty string");
  }
  const atSeq = request.atSeq;
  if (atSeq !== undefined && (!Number.isSafeInteger(atSeq) || atSeq < 0)) {
    throw new BridgeError("bad-request", "atSeq must be a non-negative safe integer");
  }
  const atMessageId = request.atMessageId;
  if (atMessageId !== undefined && (typeof atMessageId !== "string" || atMessageId.length === 0)) {
    throw new BridgeError("bad-request", "atMessageId must be a non-empty string");
  }

  const source = await readSource(bridge, sessionId);
  try {
    const cwd = source.header.cwd;
    if (cwd === undefined) {
      throw new BridgeError("fork-unavailable", `session "${sessionId}" has no cwd to fork into`);
    }
    const cut = resolveForkCut(source.events, atSeq, atMessageId);
    if (cut === 0) {
      throw new BridgeError("fork-unavailable", `session "${sessionId}" has an empty prefix`);
    }

    const childId = `session-${randomUUID()}`;
    const seed = retargetSeed(source.events.slice(0, cut), childId);
    const prepared = sessions.prepare(childId, {
      seed,
      meta: { cwd, isSeeded: true },
      inheritedEventCount: cut,
    });
    // A seeded log carries its cut as the seq of a trailing `session/end-seed`
    // marker, which the constructor appends — so store the prepared log, not the
    // bare seed, or the format decoder refuses the child it just wrote.
    const stored = prepared.snapshotEvents();
    const handle = await persistence.create(prepared.header, { inheritedEventCount: cut });
    try {
      await handle.append(stored);
      await handle.flush();
    } finally {
      await handle.close();
    }

    // Read the child back through the same decoder the ACP resume will use, so a
    // log this build cannot interpret is reported as a failed fork rather than
    // handed to Paseo as a session that cannot be opened.
    const written = await readBack(persistence, childId, cut + 1);
    if (written !== cut + 1) {
      throw new BridgeError(
        "fork-verify-failed",
        `child "${childId}" stored ${written} events, expected ${cut + 1}`,
      );
    }
    return { sessionId: childId, boundary: cut - 1, inheritedEventCount: cut };
  } finally {
    await source.close();
  }
}

/**
 * Count the events a freshly stored child reads back as, using the real decoder.
 * Throws when the stored log does not decode, which is the failure a resume
 * would hit later and further away from its cause.
 */
async function readBack(persistence, sessionId, expected) {
  const handle = await persistence.open(sessionId, "read");
  try {
    if (handle.inheritedEventCount !== expected - 1) {
      throw new BridgeError(
        "fork-verify-failed",
        `child "${sessionId}" stored inherited count ${handle.inheritedEventCount}, expected ${expected - 1}`,
      );
    }
    const read = await handle.read(0, undefined);
    return read.events.length;
  } finally {
    await handle.close().catch(() => {});
  }
}

async function handleRequest(bridge, request) {
  switch (request.op) {
    case "ping":
      return { ok: true, pid: process.pid, capabilities: { fork: true } };
    case "fork":
      return { ok: true, ...(await forkSession(bridge, request)) };
    default:
      throw new BridgeError("bad-request", `unknown op "${String(request.op)}"`);
  }
}

/**
 * Split one channel description into what `net` listens on.
 *
 * Paseo picks the form, because it knows what the target platform can bind: a
 * unix socket path, a Windows named pipe, or a loopback TCP port. A socket that
 * answers fork requests is reachable by anything on the machine that can open
 * it, so TCP is refused outside loopback.
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
      // Owner-only: any local process that can open this socket can ask for a fork.
      chmodSync(parsed.display, 0o600);
    } catch {
      // Defence in depth; the fork path still works without it.
    }
  }
  return server;
}

function serve(bridge, server) {
  server.on("connection", (socket) => {
    socket.setEncoding("utf8");
    let pending = "";
    socket.on("data", (chunk) => {
      pending += chunk;
      let index = pending.indexOf("\n");
      while (index !== -1) {
        const line = pending.slice(0, index);
        pending = pending.slice(index + 1);
        index = pending.indexOf("\n");
        if (line.trim().length > 0) void respond(bridge, socket, line);
      }
    });
    socket.on("error", (error) => {
      log(`connection error: ${describeError(error)}`);
    });
  });
}

async function respond(bridge, socket, line) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    socket.write(
      `${JSON.stringify({ id: null, ok: false, code: "bad-request", error: "invalid JSON" })}\n`,
    );
    return;
  }
  const id = typeof request?.id === "string" ? request.id : null;
  try {
    const result = await handleRequest(bridge, request ?? {});
    socket.write(`${JSON.stringify({ id, ...result })}\n`);
  } catch (error) {
    const code = error instanceof BridgeError ? error.code : "internal";
    log(`request ${String(request?.op)} failed: ${describeError(error)}`);
    socket.write(`${JSON.stringify({ id, ok: false, code, error: describeError(error) })}\n`);
  }
}

export function apply(ctx) {
  const channel = process.env[SOCKET_ENV];
  const selftest = process.env[SELFTEST_ENV];
  if (channel === undefined && selftest === undefined) {
    log("no channel configured; bridge idle");
    return;
  }

  // Resolve the services once, here: requests arrive on detached socket
  // callbacks, and cordis refuses a late `ctx.get` outside an active context.
  const bridge = {
    sessions: ctx.get("sessions"),
    persistence: ctx.get("sessionPersistence"),
  };

  ctx.effect(() => {
    let server = null;
    let stopped = false;

    void (async () => {
      try {
        if (channel !== undefined) {
          server = await startChannel(channel);
          serve(bridge, server);
          server.unref();
          log(`listening on ${channel}`);
        }
        if (selftest !== undefined) {
          try {
            // `<sessionId>[:<assistantMessageId>]`, so a real store can exercise
            // the exact boundary without a Paseo client.
            const [sessionId, messageId] = selftest.split(":");
            const result = await forkSession(bridge, {
              sessionId,
              op: "fork",
              ...(messageId ? { atMessageId: messageId } : {}),
            });
            log(`selftest ok: ${JSON.stringify(result)}`);
          } catch (error) {
            log(`selftest failed: ${describeError(error)}`);
          }
        }
      } catch (error) {
        log(`bridge unavailable: ${describeError(error)}`);
      }
    })();

    return () => {
      if (stopped) return;
      stopped = true;
      const closing = server;
      server = null;
      if (closing === null) return;
      closing.close();
      log("channel closed");
    };
  }, "paseo-fork-bridge");
}
