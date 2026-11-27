import type { AcpToolCallSnapshot } from "@getpaseo/plugin/server/acp";
import { describe, expect, it } from "vitest";
import { askQuestionFromToolCall } from "./tool-calls.js";

function askCall(input: unknown): AcpToolCallSnapshot {
  return {
    id: "ask-1",
    name: "ask_question",
    title: "Run ask_question",
    kind: "other",
    status: "in_progress",
    input: input as AcpToolCallSnapshot["input"],
    output: null,
    locations: [],
  };
}

describe("askQuestionFromToolCall", () => {
  it("reads agy's snake_case questions and drops the recommended prefix", () => {
    const question = askQuestionFromToolCall(
      askCall({
        questions: [
          {
            question: "要把 ignore 规则写在哪里？",
            is_multi_select: false,
            options: ["(Recommended) 写入 .git/info/exclude", "检出并修改仓库的 .gitignore"],
          },
        ],
      }),
      { sessionId: "s" },
    );

    expect(question).toMatchObject({
      questions: [
        {
          question: "要把 ignore 规则写在哪里？",
          multiSelect: false,
          options: [{ label: "写入 .git/info/exclude" }, { label: "检出并修改仓库的 .gitignore" }],
        },
      ],
    });
    expect(question?.promptText?.(["写入 .git/info/exclude"])).toBe("写入 .git/info/exclude");
  });

  it("numbers the answers of a multi-question ask", () => {
    const question = askQuestionFromToolCall(
      askCall({
        questions: [
          { question: "Where?", is_multi_select: false, options: ["A", "B"] },
          { question: "How many?", is_multi_select: true, options: ["1", "2"] },
        ],
      }),
      { sessionId: "s" },
    );

    expect(question?.questions.map((item) => item.multiSelect)).toEqual([false, true]);
    expect(question?.promptText?.(["A", "1, 2"])).toBe("1. A\n2. 1, 2");
  });

  it("accepts the object option shape and ignores calls that are not ask_question", () => {
    const question = askQuestionFromToolCall(
      askCall({
        questions: [{ question: "Which?", options: [{ label: "(Recommended) main" }, "dev"] }],
      }),
      { sessionId: "s" },
    );
    expect(question?.questions[0]?.options).toEqual([{ label: "main" }, { label: "dev" }]);

    expect(
      askQuestionFromToolCall(
        { ...askCall({ questions: [] }), name: "run_command" },
        {
          sessionId: "s",
        },
      ),
    ).toBeNull();
    expect(
      askQuestionFromToolCall(askCall({ questions: [{ options: [] }] }), { sessionId: "s" }),
    ).toBeNull();
  });
});
