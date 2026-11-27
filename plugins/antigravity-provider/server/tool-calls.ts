import type {
  AcpQuestion,
  AcpQuestionOption,
  AcpToolCallQuestion,
  AcpToolCallSnapshot,
  AcpTransformer,
} from "@getpaseo/plugin/server/acp";
import type { ProviderToolCallDetail } from "@getpaseo/plugin/server/provider";
import { z } from "zod";

const shellInput = z.object({ CommandLine: z.string() });
const shellOutput = z.object({
  output: z.string().optional(),
  exit_code: z.number().nullable().optional(),
});
const fileRead = z.object({
  Path: z.string().optional(),
  StartLine: z.int().positive().optional(),
  EndLine: z.int().positive().optional(),
});
const fileWrite = z.object({ Path: z.string(), Content: z.string().optional() });
const webSearch = z.object({ query: z.string() });

// ask_question's own argument names are snake_case (`is_multi_select`), and an option is a bare
// string. Accept the camelCase and object shapes too, as agy is free to change them.
const askOption = z.union([z.string(), z.object({ label: z.string() }).passthrough()]);
const askQuestion = z.object({
  question: z.string(),
  options: z.array(askOption).optional(),
  is_multi_select: z.boolean().optional(),
  isMultiSelect: z.boolean().optional(),
  multiSelect: z.boolean().optional(),
});
const askInput = z.object({ questions: z.array(askQuestion) });

/**
 * agy asks the user through the `ask_question` tool rather than an ACP permission request: the
 * call stays pending, the agent writes the question as a message and ends the turn, and the next
 * prompt is the answer. Without this, the question is ordinary text and its tool row never settles.
 */
export const askQuestionFromToolCall: NonNullable<AcpTransformer["toolCallQuestion"]> = (call) => {
  if (call.name !== "ask_question") return null;
  const parsed = askInput.safeParse(call.input);
  if (!parsed.success) return null;
  const questions: AcpQuestion[] = parsed.data.questions.map((question) => ({
    question: question.question,
    options: question.options?.map(readOption) ?? [],
    multiSelect:
      question.is_multi_select === true ||
      question.isMultiSelect === true ||
      question.multiSelect === true,
  }));
  const only = questions.length === 1 ? questions[0] : undefined;
  return {
    questions,
    // One question's answer is the whole prompt; several are numbered against their questions.
    promptText: (answers) => (only ? (answers[0] ?? "") : formatAnswers(questions, answers)),
  } satisfies AcpToolCallQuestion;
};

function readOption(option: z.infer<typeof askOption>): AcpQuestionOption {
  if (typeof option === "string") return stripRecommended(option);
  return stripRecommended(option.label);
}

/** agy ranks an option by prefixing it; the cards mark the first choice themselves. */
function stripRecommended(label: string): AcpQuestionOption {
  const trimmed = label.trim();
  const marked = /^\(recommended\)\s*/i.exec(trimmed);
  return { label: marked ? trimmed.slice(marked[0].length).trim() : trimmed };
}

function formatAnswers(questions: readonly AcpQuestion[], answers: readonly string[]): string {
  return questions
    .map((question, index) => {
      const answer = (answers[index] ?? "").trim();
      return answer.length > 0 ? `${index + 1}. ${answer}` : "";
    })
    .filter((line) => line.length > 0)
    .join("\n");
}

export const mapToolCall: NonNullable<AcpTransformer["toolCall"]> = (call, context) => {
  if (call.name?.startsWith("mcp_")) {
    return mapMcpCall(call, call.name, context.mcpServerNames ?? []);
  }
  const detail = mapNativeDetail(call);
  return detail ? { ...call, detail } : call;
};

function mapNativeDetail(call: AcpToolCallSnapshot): ProviderToolCallDetail | undefined {
  switch (call.name) {
    case "run_command": {
      const input = shellInput.safeParse(call.input).data;
      if (!input) break;
      const output = shellOutput.safeParse(call.output).data;
      return {
        type: "shell",
        command: input.CommandLine,
        output: output?.output,
        exitCode: output?.exit_code,
      };
    }
    case "write_file": {
      const input = fileWrite.safeParse(call.input).data;
      if (input) return { type: "write", filePath: input.Path, content: input.Content };
      break;
    }
    case "search_web": {
      const input = webSearch.safeParse(call.input).data;
      if (input) return { type: "search", toolName: "web_search", query: input.query };
      break;
    }
  }
  if (call.kind !== "read") return undefined;
  const input = fileRead.safeParse(call.input).data;
  const filePath = call.locations[0] ?? input?.Path;
  if (!filePath) return undefined;
  const { StartLine: offset, EndLine: end } = input ?? {};
  return {
    type: "read",
    filePath,
    offset,
    limit:
      offset !== undefined && end !== undefined && end >= offset ? end - offset + 1 : undefined,
  };
}

function mapMcpCall(
  call: AcpToolCallSnapshot,
  wireName: string,
  serverNames: readonly string[],
): AcpToolCallSnapshot {
  const qualifiedName = wireName.slice("mcp_".length);
  // The wire uses the same separator inside names and between the server and tool.
  // Paseo's own server can also appear when replaying with MCP disabled.
  const matchingServers = [...new Set([...serverNames, "paseo"])].filter((name) =>
    qualifiedName.startsWith(`${name}_`),
  );
  const server = matchingServers.length === 1 ? matchingServers[0] : undefined;
  let input = call.input;
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    const { toolSummary: _summary, ...args } = input;
    input = args;
  }
  return {
    ...call,
    name: server ? `${server}.${qualifiedName.slice(server.length + 1)}` : wireName,
    detail: { type: "unknown", input, output: call.output },
  };
}
