import { DeepSeekIcon } from "@/components/icons/deepseek-icon";
import { getProviderIcon, type ProviderIconComponent } from "@/components/provider-icons";

const DEEPSEEK_ICON_ID = "deepseek";

interface ModelFamily {
  /** A registered provider icon that already draws this family's mark. */
  iconId: string;
  pattern: RegExp;
}

/**
 * First match wins, so a distilled `deepseek-r1-distill-qwen` keeps the base
 * model's mark instead of the student's. Patterns run against a normalized
 * string where punctuation has become spaces, which is what makes the leading
 * `(?:^|\s)` behave as a token boundary.
 */
const MODEL_FAMILIES: readonly ModelFamily[] = [
  { iconId: DEEPSEEK_ICON_ID, pattern: /(?:^|\s)deepseek/ },
  { iconId: "kimi", pattern: /(?:^|\s)kimi|moonshot/ },
  { iconId: "claude", pattern: /(?:^|\s)claude|anthropic|(?:^|\s)(?:sonnet|opus|haiku)/ },
  { iconId: "codex", pattern: /(?:^|\s)gpt|chatgpt|(?:^|\s)o[1-9](?:\s|$)|codex|davinci/ },
  { iconId: "gemini", pattern: /(?:^|\s)(?:gemini|gemma)/ },
  { iconId: "qwen-code", pattern: /(?:^|\s)(?:qwen|qwq|tongyi)/ },
  { iconId: "glm-acp-agent", pattern: /(?:^|\s)(?:glm|chatglm|zhipu)/ },
  { iconId: "grok", pattern: /(?:^|\s)grok/ },
  { iconId: "mistral-vibe", pattern: /(?:^|\s)(?:mistral|devstral|codestral|magistral)/ },
  { iconId: "minimax", pattern: /(?:^|\s)(?:minimax|abab)/ },
];

/**
 * Lowercase, collapse every punctuation run into one space, and pad both ends so
 * `morphic/gpt-6.1-sol` becomes ` morphic gpt 6 1 sol `.
 */
function normalizeModelName(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return normalized.length > 0 ? ` ${normalized} ` : null;
}

/** The icon id of the model's family, or `null` when the model names no known brand. */
export function resolveModelIconId(
  modelId: string | null | undefined,
  modelLabel?: string | null,
): string | null {
  for (const candidate of [modelId, modelLabel]) {
    const normalized = normalizeModelName(candidate);
    if (!normalized) continue;
    const family = MODEL_FAMILIES.find((entry) => entry.pattern.test(normalized));
    if (family) return family.iconId;
  }
  return null;
}

export interface ModelIconInput {
  provider: string;
  modelId?: string | null;
  modelLabel?: string | null;
  serverId?: string | null;
}

/**
 * Model-aware glyph: a provider that fronts several vendors (`morphic`,
 * `openrouter`, a custom ACP harness) still shows the mark of the model it has
 * selected, not the provider's own. Unknown models fall back to that provider's
 * icon, which is the pre-existing behavior.
 */
export function getModelIcon({
  provider,
  modelId,
  modelLabel,
  serverId,
}: ModelIconInput): ProviderIconComponent {
  const familyId = resolveModelIconId(modelId, modelLabel);
  if (!familyId) {
    return getProviderIcon(provider, serverId);
  }
  if (familyId === DEEPSEEK_ICON_ID) {
    return DeepSeekIcon;
  }
  return getProviderIcon(familyId);
}
