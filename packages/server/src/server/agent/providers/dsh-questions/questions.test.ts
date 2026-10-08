import { describe, expect, test } from "vitest";

import type { DshQuestionMapping } from "./questions.js";
import { mapDshQuestionRequest, resolveDshQuestionAnswers } from "./questions.js";

describe("mapDshQuestionRequest", () => {
  test("renders one DSH question as a Paseo question card", () => {
    const mapped = mapDshQuestionRequest({
      provider: "dsh",
      requestId: "request-1",
      request: {
        requestId: "request-1",
        questions: [
          {
            id: "color",
            question: "Which color should I use?",
            header: "Color",
            options: [{ label: "Red", description: "Warm" }, { label: "Blue" }],
            multiSelect: true,
          },
        ],
      },
    });

    expect(mapped.request).toMatchObject({
      id: "request-1",
      provider: "dsh",
      name: "ask_user_question",
      kind: "question",
      title: "Which color should I use?",
      input: {
        questions: [
          {
            question: "Which color should I use?",
            header: "Color",
            options: [{ label: "Red", description: "Warm" }, { label: "Blue" }],
            multiSelect: true,
            // DSH always offers a typed answer beside its options, so the card
            // must not hide the field just because DSH sent no such flag.
            allowOther: true,
            allowEmpty: false,
          },
        ],
      },
    });
    expect(mapped.mapping).toEqual([
      { header: "Color", id: "color", labels: ["Red", "Blue"], multiSelect: true },
    ]);
  });

  test("names a plan review after the tool that asked for it", () => {
    const mapped = mapDshQuestionRequest({
      provider: "dsh",
      requestId: "request-2",
      request: {
        requestId: "request-2",
        questions: [
          {
            id: "plan-review",
            question: "Approve this plan and leave plan mode?",
            header: "Plan review",
            detail: "# The plan",
            options: [{ label: "Approve" }, { label: "Keep planning" }],
            intent: { kind: "plan-review", approve: "Approve" },
          },
        ],
      },
    });

    expect(mapped.request.name).toBe("exit_plan_mode");
    expect(mapped.request.metadata).toMatchObject({
      bridge: "dsh-questions",
      requestId: "request-2",
      questionIds: ["plan-review"],
      intent: { kind: "plan-review", approve: "Approve" },
      detail: "# The plan",
    });
  });

  test("gives every question a unique answer key even when DSH repeats a header", () => {
    const mapped = mapDshQuestionRequest({
      provider: "dsh",
      requestId: "request-3",
      request: {
        requestId: "request-3",
        questions: [
          { id: "first", question: "First?", header: "Confirm", options: [] },
          { id: "second", question: "Second?", header: "Confirm", options: [] },
          { id: "third", question: "Third?", options: [] },
        ],
      },
    });

    expect(mapped.mapping.map((question) => question.header)).toEqual([
      "Confirm",
      "Confirm (2)",
      "third",
    ]);
  });

  test("keeps questions without options answerable as free text", () => {
    const mapped = mapDshQuestionRequest({
      provider: "dsh",
      requestId: "request-4",
      request: {
        requestId: "request-4",
        questions: [
          {
            id: "branch",
            question: "Which branch?",
            options: [],
            placeholder: "main",
            allowEmpty: true,
          },
        ],
      },
    });

    expect(mapped.request.input).toMatchObject({
      questions: [
        {
          header: "branch",
          options: [],
          allowOther: true,
          allowEmpty: true,
          placeholder: "main",
        },
      ],
    });
  });
});

describe("resolveDshQuestionAnswers", () => {
  const single: DshQuestionMapping = {
    header: "Color",
    id: "color",
    labels: ["Red", "Blue"],
    multiSelect: false,
  };
  const multi: DshQuestionMapping = {
    header: "Features",
    id: "features",
    labels: ["Search", "Export"],
    multiSelect: true,
  };

  test("returns a chosen label as that label, with no free text", () => {
    expect(
      resolveDshQuestionAnswers([single], {
        behavior: "allow",
        updatedInput: { answers: { Color: "Blue" } },
      }),
    ).toEqual({ kind: "answers", answers: [{ id: "color", selected: ["Blue"] }] });
  });

  test("returns every ticked label for a multi-select question", () => {
    expect(
      resolveDshQuestionAnswers([multi], {
        behavior: "allow",
        updatedInput: { answers: { Features: "Search, Export" } },
      }),
    ).toEqual({
      kind: "answers",
      answers: [{ id: "features", selected: ["Search", "Export"] }],
    });
  });

  test("keeps ticked labels and carries the typed remainder as free text", () => {
    expect(
      resolveDshQuestionAnswers([multi], {
        behavior: "allow",
        updatedInput: { answers: { Features: "Search, Only with a flag" } },
      }),
    ).toEqual({
      kind: "answers",
      answers: [{ id: "features", selected: ["Search"], custom: "Only with a flag" }],
    });
  });

  test("replaces the choice with typed text on a single-select question", () => {
    expect(
      resolveDshQuestionAnswers([single], {
        behavior: "allow",
        updatedInput: { answers: { Color: "Something else" } },
      }),
    ).toEqual({
      kind: "answers",
      answers: [{ id: "color", selected: [], custom: "Something else" }],
    });
  });

  test("reads back an option whose own label contains the separator", () => {
    const sentenceOptions: DshQuestionMapping = {
      header: "Features",
      id: "features",
      labels: ["Search, then export", "Export"],
      multiSelect: true,
    };

    expect(
      resolveDshQuestionAnswers([sentenceOptions], {
        behavior: "allow",
        updatedInput: { answers: { Features: "Search, then export, Export" } },
      }),
    ).toEqual({
      kind: "answers",
      answers: [{ id: "features", selected: ["Search, then export", "Export"] }],
    });
    expect(
      resolveDshQuestionAnswers([sentenceOptions], {
        behavior: "allow",
        updatedInput: { answers: { Features: "Export, only on Linux" } },
      }),
    ).toEqual({
      kind: "answers",
      answers: [{ id: "features", selected: ["Export"], custom: "only on Linux" }],
    });
  });

  test("treats text that matches no option as the whole answer", () => {
    expect(
      resolveDshQuestionAnswers([multi], {
        behavior: "allow",
        updatedInput: { answers: { Features: "Neither of those" } },
      }),
    ).toEqual({
      kind: "answers",
      answers: [{ id: "features", selected: [], custom: "Neither of those" }],
    });
  });

  test("answers an optional question the user skipped with nothing", () => {
    expect(
      resolveDshQuestionAnswers([single], {
        behavior: "allow",
        updatedInput: { answers: { Color: "" } },
      }),
    ).toEqual({ kind: "answers", answers: [{ id: "color", selected: [] }] });
  });

  test("treats a refusal as a dismissal rather than an answer", () => {
    expect(
      resolveDshQuestionAnswers([single], { behavior: "deny", message: "Dismissed by user" }),
    ).toEqual({ kind: "dismiss" });
  });

  test("treats a card that came back with no answers as a dismissal", () => {
    expect(resolveDshQuestionAnswers([single], { behavior: "allow" })).toEqual({ kind: "dismiss" });
    expect(
      resolveDshQuestionAnswers([single], { behavior: "allow", updatedInput: { answers: {} } }),
    ).toEqual({ kind: "dismiss" });
  });

  test("answers every question in a multi-question ask, in order", () => {
    expect(
      resolveDshQuestionAnswers([single, multi], {
        behavior: "allow",
        updatedInput: { answers: { Color: "Red", Features: "Export" } },
      }),
    ).toEqual({
      kind: "answers",
      answers: [
        { id: "color", selected: ["Red"] },
        { id: "features", selected: ["Export"] },
      ],
    });
  });
});
