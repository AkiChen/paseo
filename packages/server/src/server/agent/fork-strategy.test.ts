import { describe, expect, it } from "vitest";
import { resolveForkStrategy } from "./fork-strategy.js";

describe("resolveForkStrategy", () => {
  it("forks the provider session when the provider stays and supports it", () => {
    expect(
      resolveForkStrategy({
        sourceProvider: "dsh",
        targetProvider: "dsh",
        providerSupportsFork: true,
      }),
    ).toBe("provider-fork");
  });

  it("carries the timeline when the provider cannot fork", () => {
    expect(
      resolveForkStrategy({
        sourceProvider: "dsh",
        targetProvider: "dsh",
        providerSupportsFork: false,
      }),
    ).toBe("timeline-attachment");
  });

  it("carries the timeline across providers, which no prefix can cross", () => {
    expect(
      resolveForkStrategy({
        sourceProvider: "dsh",
        targetProvider: "codex",
        providerSupportsFork: true,
      }),
    ).toBe("timeline-attachment");
    expect(
      resolveForkStrategy({
        sourceProvider: "claude",
        targetProvider: "dsh",
        providerSupportsFork: true,
      }),
    ).toBe("timeline-attachment");
  });

  it("carries the timeline when a provider is unknown", () => {
    expect(
      resolveForkStrategy({
        sourceProvider: undefined,
        targetProvider: "dsh",
        providerSupportsFork: true,
      }),
    ).toBe("timeline-attachment");
    expect(
      resolveForkStrategy({
        sourceProvider: "dsh",
        targetProvider: undefined,
        providerSupportsFork: true,
      }),
    ).toBe("timeline-attachment");
  });
});
