import { ChatGptIcon } from "@/components/icons/chatgpt-icon";
import { DeepSeekIcon } from "@/components/icons/deepseek-icon";
import { resolveProviderIconName } from "@/components/provider-icon-name";
import { getProviderIcon, type ProviderIconComponent } from "@/components/provider-icons";

const CHATGPT_ICON_ID = "chatgpt";
const DEEPSEEK_ICON_ID = "deepseek";

/** Families whose mark lives in the app rather than in the provider registry. */
const LOCAL_FAMILY_ICONS: Record<string, ProviderIconComponent> = {
  [CHATGPT_ICON_ID]: ChatGptIcon,
  [DEEPSEEK_ICON_ID]: DeepSeekIcon,
};

interface ModelFamily {
  /** Key in `LOCAL_FAMILY_ICONS`, or a provider icon id registered in `provider-icons`. */
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
  {
    iconId: CHATGPT_ICON_ID,
    pattern: /(?:^|\s)gpt|chatgpt|(?:^|\s)o[1-9](?:\s|$)|codex|davinci/,
  },
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
 * Model-aware glyph. A provider that brands itself (Codex, Claude, anything with
 * a registered or daemon-supplied icon) keeps its own mark for every model it
 * lists. Only a generic harness — no icon, so the robot fallback — takes the
 * selected model's family, which is what a multi-vendor front end needs.
 */
export function getModelIcon({
  provider,
  modelId,
  modelLabel,
  serverId,
}: ModelIconInput): ProviderIconComponent {
  if (resolveProviderIconName(provider, serverId).kind !== "bot") {
    return getProviderIcon(provider, serverId);
  }
  const familyId = resolveModelIconId(modelId, modelLabel);
  if (!familyId) {
    return getProviderIcon(provider, serverId);
  }
  return LOCAL_FAMILY_ICONS[familyId] ?? getProviderIcon(familyId);
}
