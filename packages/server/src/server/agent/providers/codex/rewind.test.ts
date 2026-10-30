import { describe, expect, test } from "vitest";

import type {
  CodexThreadForkParams,
  CodexThreadForkResponse,
  CodexThreadRollbackParams,
  CodexThreadRollbackResponse,
} from "./app-server-transport.js";
import {
  type CodexUserMessageTurnIndex,
  type CodexRewindClient,
  forkCodexConversation,
  revertCodexConversation,
} from "./rewind.js";

class FakeCodex implements CodexRewindClient {
  readonly recordedForks: CodexThreadForkParams[] = [];
  readonly recordedRollbacks: CodexThreadRollbackParams[] = [];

  async forkThread(params: CodexThreadForkParams): Promise<CodexThreadForkResponse> {
    this.recordedForks.push(params);
    return {
      thread: {
        id: "forked-thread",
        sessionId: "forked-session",
        forkedFromId: params.threadId,
        turns: [],
      },
      model: "gpt-5.4-mini",
      modelProvider: "openai",
      serviceTier: null,
      cwd: "/workspace/project",
      runtimeWorkspaceRoots: [],
      instructionSources: [],
      approvalPolicy: "on-request",
      approvalsReviewer: null,
      sandbox: { type: "workspaceWrite", networkAccess: false },
      activePermissionProfile: null,
      reasoningEffort: null,
    };
  }

  async rollbackThread(params: CodexThreadRollbackParams): Promise<CodexThreadRollbackResponse> {
    this.recordedRollbacks.push(params);
    return {
      thread: {
        id: params.threadId,
        sessionId: "forked-session",
        forkedFromId: "source-thread",
        turns: [],
      },
    };
  }

  request(method: string): Promise<unknown> {
    if (method === "thread/read") {
      return Promise.resolve({ thread: { id: "source-thread", historyMode: "legacy" } });
    }
    throw new Error(`Unexpected request: ${method}`);
  }
}

class CodexMessageTurns implements CodexUserMessageTurnIndex {
  constructor(
    private readonly indexesByMessageId: Map<string, number>,
    private readonly turnIdsByMessageId: Map<string, string> = new Map(),
  ) {}

  resolve(messageId: string): { index: number; turnId: string | null } | null {
    const index = this.indexesByMessageId.get(messageId);
    return index === undefined
      ? null
      : { index, turnId: this.turnIdsByMessageId.get(messageId) ?? null };
  }

  count(): number {
    return this.indexesByMessageId.size;
  }
}

describe("Codex Rewind", () => {
  test("rewinds the conversation by forking the thread and rolling back past the native user message", async () => {
    const codex = new FakeCodex();
    const userMessageTurns = new CodexMessageTurns(
      new Map([
        ["codex-first", 0],
        ["codex-second", 1],
      ]),
    );
    let reboundThreadId: string | null = null;

    await revertCodexConversation({
      client: codex,
      threadId: "source-thread",
      messageId: "codex-first",
      cwd: "/workspace/project",
      model: "gpt-5.4-mini",
      serviceTier: null,
      userMessageTurns,
      setThreadId: (threadId) => {
        reboundThreadId = threadId;
      },
    });

    expect(codex.recordedForks).toEqual([
      {
        threadId: "source-thread",
        cwd: "/workspace/project",
        model: "gpt-5.4-mini",
        serviceTier: null,
        excludeTurns: false,
        persistExtendedHistory: true,
      },
    ]);
    expect(codex.recordedRollbacks).toEqual([{ threadId: "forked-thread", numTurns: 2 }]);
    expect(reboundThreadId).toBe("forked-thread");
  });

  test("rewinds the conversation using native user message ids hydrated from app-server history", async () => {
    const codex = new FakeCodex();
    const userMessageTurns = new CodexMessageTurns(
      new Map([
        ["codex-first", 0],
        ["codex-second", 1],
        ["codex-third", 2],
      ]),
    );
    let reboundThreadId: string | null = null;

    await revertCodexConversation({
      client: codex,
      threadId: "source-thread",
      messageId: "codex-second",
      userMessageTurns,
      setThreadId: (threadId) => {
        reboundThreadId = threadId;
      },
    });

    expect(codex.recordedRollbacks).toEqual([{ threadId: "forked-thread", numTurns: 2 }]);
    expect(reboundThreadId).toBe("forked-thread");
  });

  test("rewinds a paginated conversation with one bounded fork and no rollback", async () => {
    class PaginatedCodex extends FakeCodex {
      override request(method: string): Promise<unknown> {
        if (method === "thread/read") {
          return Promise.resolve({ thread: { id: "source-thread", historyMode: "paginated" } });
        }
        throw new Error(`Unexpected request: ${method}`);
      }

      override rollbackThread(): Promise<CodexThreadRollbackResponse> {
        throw new Error("paginated threads do not support thread/rollback");
      }
    }

    const codex = new PaginatedCodex();
    const userMessageTurns = new CodexMessageTurns(
      new Map([
        ["codex-first", 0],
        ["codex-second", 1],
      ]),
      new Map([
        ["codex-first", "turn-first"],
        ["codex-second", "turn-second"],
      ]),
    );
    let reboundThreadId: string | null = null;

    await revertCodexConversation({
      client: codex,
      threadId: "source-thread",
      messageId: "codex-first",
      cwd: "/workspace/project",
      model: "gpt-5.4-mini",
      serviceTier: null,
      userMessageTurns,
      setThreadId: (threadId) => {
        reboundThreadId = threadId;
      },
    });

    expect(codex.recordedForks).toEqual([
      {
        threadId: "source-thread",
        beforeTurnId: "turn-first",
        cwd: "/workspace/project",
        model: "gpt-5.4-mini",
        serviceTier: null,
        excludeTurns: false,
        persistExtendedHistory: true,
      },
    ]);
    expect(codex.recordedRollbacks).toEqual([]);
    expect(reboundThreadId).toBe("forked-thread");
  });

  test("does not fork a paginated thread when the target turn id is unavailable", async () => {
    class PaginatedCodex extends FakeCodex {
      override request(method: string): Promise<unknown> {
        if (method === "thread/read") {
          return Promise.resolve({ thread: { id: "source-thread", historyMode: "paginated" } });
        }
        throw new Error(`Unexpected request: ${method}`);
      }
    }

    const codex = new PaginatedCodex();
    const userMessageTurns = new CodexMessageTurns(new Map([["codex-first", 0]]));
    let reboundThreadId: string | null = null;

    await expect(
      revertCodexConversation({
        client: codex,
        threadId: "source-thread",
        messageId: "codex-first",
        cwd: "/workspace/project",
        model: "gpt-5.4-mini",
        serviceTier: null,
        userMessageTurns,
        setThreadId: (threadId) => {
          reboundThreadId = threadId;
        },
      }),
    ).rejects.toThrow("Codex could not find the turn containing user message codex-first");

    expect(codex.recordedForks).toEqual([]);
    expect(codex.recordedRollbacks).toEqual([]);
    expect(reboundThreadId).toBeNull();
  });

  test("declines to rewind when the user message is not in the Codex thread", async () => {
    const codex = new FakeCodex();
    const userMessageTurns = new CodexMessageTurns(new Map([["codex-first", 0]]));

    await expect(
      revertCodexConversation({
        client: codex,
        threadId: "source-thread",
        messageId: "missing-message",
        userMessageTurns,
        setThreadId: () => undefined,
      }),
    ).rejects.toThrow("Codex could not find user message missing-message");
    expect(codex.recordedForks).toEqual([]);
    expect(codex.recordedRollbacks).toEqual([]);
  });
});

describe("Codex session fork", () => {
  test("copies the whole thread when the fork keeps every turn", async () => {
    const codex = new FakeCodex();
    const userMessageTurns = new CodexMessageTurns(
      new Map([
        ["codex-first", 0],
        ["codex-second", 1],
      ]),
    );

    const forkedThreadId = await forkCodexConversation({
      client: codex,
      threadId: "source-thread",
      truncateFromUserMessageId: null,
      cwd: "/workspace/project",
      model: "gpt-5.4-mini",
      serviceTier: null,
      userMessageTurns,
    });

    expect(forkedThreadId).toBe("forked-thread");
    expect(codex.recordedForks).toEqual([
      {
        threadId: "source-thread",
        cwd: "/workspace/project",
        model: "gpt-5.4-mini",
        serviceTier: null,
        excludeTurns: false,
        persistExtendedHistory: true,
      },
    ]);
    expect(codex.recordedRollbacks).toEqual([]);
  });

  test("rolls the copy back to the turn the fork stopped at, leaving the source alone", async () => {
    const codex = new FakeCodex();
    const userMessageTurns = new CodexMessageTurns(
      new Map([
        ["codex-first", 0],
        ["codex-second", 1],
        ["codex-third", 2],
      ]),
    );

    const forkedThreadId = await forkCodexConversation({
      client: codex,
      threadId: "source-thread",
      truncateFromUserMessageId: "codex-third",
      userMessageTurns,
    });

    expect(forkedThreadId).toBe("forked-thread");
    expect(codex.recordedForks.map((params) => params.threadId)).toEqual(["source-thread"]);
    expect(codex.recordedRollbacks).toEqual([{ threadId: "forked-thread", numTurns: 1 }]);
  });

  test("forks a paginated thread before the first dropped turn, with no rollback", async () => {
    class PaginatedCodex extends FakeCodex {
      override request(method: string): Promise<unknown> {
        if (method === "thread/read") {
          return Promise.resolve({ thread: { id: "source-thread", historyMode: "paginated" } });
        }
        throw new Error(`Unexpected request: ${method}`);
      }

      override rollbackThread(): Promise<CodexThreadRollbackResponse> {
        throw new Error("paginated threads do not support thread/rollback");
      }
    }

    const codex = new PaginatedCodex();
    const userMessageTurns = new CodexMessageTurns(
      new Map([
        ["codex-first", 0],
        ["codex-second", 1],
      ]),
      new Map([
        ["codex-first", "turn-first"],
        ["codex-second", "turn-second"],
      ]),
    );

    const forkedThreadId = await forkCodexConversation({
      client: codex,
      threadId: "source-thread",
      truncateFromUserMessageId: "codex-second",
      userMessageTurns,
    });

    expect(forkedThreadId).toBe("forked-thread");
    expect(codex.recordedForks).toEqual([
      {
        threadId: "source-thread",
        beforeTurnId: "turn-second",
        cwd: null,
        model: null,
        serviceTier: null,
        excludeTurns: false,
        persistExtendedHistory: true,
      },
    ]);
    expect(codex.recordedRollbacks).toEqual([]);
  });

  test("refuses to fork when the truncation boundary is not in the thread", async () => {
    const codex = new FakeCodex();
    const userMessageTurns = new CodexMessageTurns(new Map([["codex-first", 0]]));

    await expect(
      forkCodexConversation({
        client: codex,
        threadId: "source-thread",
        truncateFromUserMessageId: "missing-message",
        userMessageTurns,
      }),
    ).rejects.toThrow("Codex could not find user message missing-message");
    expect(codex.recordedForks).toEqual([]);
  });
});
