import type { AgentPermissionRequest, AgentPermissionResponse } from "../../agent-sdk-types.js";
import type {
  DshQuestion,
  DshQuestionAnswer,
  DshQuestionOutcome,
  DshQuestionRequest,
} from "./bridge.js";

/**
 * Translating DSH's questions into Paseo's question card, and back.
 *
 * The two shapes disagree in three places, and each disagreement is a decision
 * rather than a rename:
 *
 * - Paseo keys an answer by the question's `header`, so headers must be unique
 *   and non-empty even when DSH sent neither a header nor two distinct ones.
 * - DSH always offers a typed answer next to its options, so `allowOther` is on
 *   for every question instead of mirroring a flag DSH does not have.
 * - Paseo returns one string per question — the labels it showed, joined with
 *   ", ", or the typed text. DSH wants the labels back as a list plus the free
 *   text separately, and plan mode only treats a selection as approval when the
 *   free text is absent.
 */

/** One question's round-trip: the key Paseo answers by, and the labels it showed. */
export interface DshQuestionMapping {
  header: string;
  id: string;
  labels: string[];
  multiSelect: boolean;
}

export interface MappedDshQuestionRequest {
  request: AgentPermissionRequest;
  mapping: DshQuestionMapping[];
}

/** The provider-facing question, ready for the app's question card. */
export function mapDshQuestionRequest(input: {
  provider: string;
  requestId: string;
  request: DshQuestionRequest;
}): MappedDshQuestionRequest {
  const headers = uniqueHeaders(input.request.questions);
  const mapping: DshQuestionMapping[] = [];
  const questions = input.request.questions.map((question, index) => {
    const header = headers[index] ?? question.id;
    const labels = question.options.map((option) => option.label);
    mapping.push({
      header,
      id: question.id,
      labels,
      multiSelect: question.multiSelect === true,
    });
    return {
      question: question.question,
      header,
      options: question.options.map((option) => ({ ...option })),
      multiSelect: question.multiSelect === true,
      allowOther: true,
      allowEmpty: question.allowEmpty === true,
      ...(question.placeholder === undefined ? {} : { placeholder: question.placeholder }),
    };
  });

  const first = input.request.questions[0];
  return {
    request: {
      id: input.requestId,
      provider: input.provider,
      name: first?.intent?.kind === "plan-review" ? "exit_plan_mode" : "ask_user_question",
      kind: "question",
      ...(first === undefined ? {} : { title: first.question }),
      input: { questions },
      metadata: {
        bridge: "dsh-questions",
        requestId: input.requestId,
        questionIds: input.request.questions.map((question) => question.id),
        ...(first?.intent === undefined ? {} : { intent: first.intent }),
        ...(first?.detail === undefined ? {} : { detail: first.detail }),
      },
    },
    mapping,
  };
}

/**
 * Turn the client's response into DSH's answer, or into a dismissal.
 *
 * A denied card is a refusal, and a card that came back with no answers at all
 * is one too: neither is an answer the model may read as the user's choice.
 */
export function resolveDshQuestionAnswers(
  mapping: readonly DshQuestionMapping[],
  response: AgentPermissionResponse,
): DshQuestionOutcome {
  if (response.behavior === "deny") return { kind: "dismiss" };
  const answers = readAnswerStrings(response.updatedInput);
  if (answers === null) return { kind: "dismiss" };
  return {
    kind: "answers",
    answers: mapping.map((question) => toDshAnswer(question, answers[question.header])),
  };
}

function toDshAnswer(question: DshQuestionMapping, raw: string | undefined): DshQuestionAnswer {
  if (raw === undefined || raw.length === 0) {
    return { id: question.id, selected: [] };
  }
  if (question.labels.includes(raw)) {
    return { id: question.id, selected: [raw] };
  }
  // A single-choice question replaces the option with typed text; a multi-choice
  // one keeps the boxes the user ticked and carries the rest as free text —
  // which is also how DSH's own client answers its question card.
  if (!question.multiSelect) {
    return { id: question.id, selected: [], custom: raw };
  }
  const { selected, rest } = takeLabels(raw, question.labels);
  if (selected.length === 0) {
    return { id: question.id, selected: [], custom: raw };
  }
  return {
    id: question.id,
    selected,
    ...(rest.length === 0 ? {} : { custom: rest }),
  };
}

/**
 * Peel Paseo's answer string back into the labels it showed.
 *
 * Paseo joins ticked labels with ", ", which a label may itself contain, so
 * splitting on the separator would break any option written as a sentence. The
 * longest matching label wins at each step and whatever is left over is the
 * text the user typed.
 */
function takeLabels(
  value: string,
  labels: readonly string[],
): { selected: string[]; rest: string } {
  const longestFirst = [...labels].sort((left, right) => right.length - left.length);
  const selected: string[] = [];
  let rest = value;
  let matched = true;
  while (matched) {
    matched = false;
    for (const label of longestFirst) {
      if (label.length === 0) continue;
      if (rest === label) {
        selected.push(label);
        rest = "";
        matched = true;
        break;
      }
      if (rest.startsWith(`${label}, `)) {
        selected.push(label);
        rest = rest.slice(label.length + 2);
        matched = true;
        break;
      }
    }
  }
  return { selected, rest };
}

/** Answer keys the client echoes back, keyed by the header this mapping chose. */
function readAnswerStrings(
  input: Record<string, unknown> | undefined,
): Record<string, string> | null {
  const answers = input?.answers;
  if (typeof answers !== "object" || answers === null || Array.isArray(answers)) {
    return null;
  }
  const strings: Record<string, string> = {};
  for (const [header, value] of Object.entries(answers)) {
    if (typeof value === "string") strings[header] = value;
  }
  return Object.keys(strings).length === 0 ? null : strings;
}

/**
 * One unique, non-empty header per question, in order.
 *
 * DSH's header is whatever the asker wrote — optional, and not required to be
 * unique — while Paseo answers by header. Questions that share one, or carry
 * none, fall back to the question id and then to a suffix.
 */
function uniqueHeaders(questions: readonly DshQuestion[]): string[] {
  const used = new Set<string>();
  return questions.map((question, index) => {
    const base = firstNonEmpty(question.header, question.id, `question ${index + 1}`);
    let header = base;
    let suffix = 2;
    while (used.has(header)) {
      header = `${base} (${suffix})`;
      suffix += 1;
    }
    used.add(header);
    return header;
  });
}

function firstNonEmpty(...values: (string | undefined)[]): string {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed !== undefined && trimmed.length > 0) return trimmed;
  }
  return "";
}
