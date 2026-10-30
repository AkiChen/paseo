import { Bot } from "lucide-react-native";
import { describe, expect, it } from "vitest";
import { ClaudeIcon } from "./icons/claude-icon";
import { CodexIcon } from "./icons/codex-icon";
import { DeepSeekIcon } from "./icons/deepseek-icon";
import { MiniMaxIcon } from "./icons/minimax-icon";
import { getModelIcon, resolveModelIconId } from "./model-icons";

function iconFor(modelId: string, modelLabel?: string) {
  return getModelIcon({ provider: "dsh", modelId, modelLabel, serverId: null });
}

describe("resolveModelIconId", () => {
  it.each([
    ["gpt-6.1-sol", "codex"],
    ["morphic/gpt-6.1-sol", "codex"],
    ["chatgpt-4o-latest", "codex"],
    ["o3-mini", "codex"],
    ["claude-sonnet-4-5", "claude"],
    ["anthropic/claude-opus-4", "claude"],
    ["deepseek-chat", "deepseek"],
    ["deepseek-r1-distill-qwen-32b", "deepseek"],
    ["morphic/kimi-k3", "kimi"],
    ["moonshot-v1-128k", "kimi"],
    ["gemini-3-pro", "gemini"],
    ["qwen3-coder-plus", "qwen-code"],
    ["glm-4.6", "glm-acp-agent"],
    ["grok-4-fast", "grok"],
    ["mistral-large-latest", "mistral-vibe"],
    ["MiniMax-M2", "minimax"],
  ])("maps %s to the %s family", (modelId, expected) => {
    expect(resolveModelIconId(modelId)).toBe(expected);
  });

  it("falls back to the label when the id names no brand", () => {
    expect(resolveModelIconId("morphic-sol-261024", "GPT-6.1 Sol")).toBe("codex");
  });

  it("returns null for opaque or empty models", () => {
    expect(resolveModelIconId("")).toBeNull();
    expect(resolveModelIconId(null)).toBeNull();
    expect(resolveModelIconId("router-model-261024")).toBeNull();
  });
});

describe("getModelIcon", () => {
  it("uses the model family's registered mark", () => {
    expect(iconFor("gpt-6.1-sol")).toBe(CodexIcon);
    expect(iconFor("claude-sonnet-4-5")).toBe(ClaudeIcon);
    expect(iconFor("MiniMax-M2")).toBe(MiniMaxIcon);
    expect(iconFor("deepseek-chat")).toBe(DeepSeekIcon);
  });

  it("uses the vendored brand SVG for catalog-only families", () => {
    expect(iconFor("morphic/kimi-k3").displayName).toBe("SvgProviderIcon(kimi)");
    expect(iconFor("gemini-3-pro").displayName).toBe("SvgProviderIcon(gemini)");
  });

  it("falls back to the provider icon for models it does not recognize", () => {
    expect(iconFor("router-model-261024")).toBe(Bot);
    expect(iconFor("")).toBe(Bot);
  });

  it("keeps the provider icon when the provider already brands the model", () => {
    const icon = getModelIcon({
      provider: "codex",
      modelId: "router-model-261024",
      serverId: null,
    });
    expect(icon).toBe(CodexIcon);
  });
});
