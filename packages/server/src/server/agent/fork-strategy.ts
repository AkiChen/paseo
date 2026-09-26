/**
 * How a fork of an existing conversation is carried into a new one.
 *
 * A provider session is bound to its provider: `session/fork` hands the new
 * session the original's inherited prefix, which is what keeps the model's
 * cache warm, and no provider can import another's prefix. So the provider's own
 * fork is used only when the fork keeps the provider and the provider advertises
 * the capability; every other case carries the canonical rows instead, which is
 * what Paseo has always done.
 */
export type ForkStrategy = "provider-fork" | "timeline-attachment";

export function resolveForkStrategy(input: {
  sourceProvider: string | undefined;
  targetProvider: string | undefined;
  providerSupportsFork: boolean;
}): ForkStrategy {
  if (input.sourceProvider === undefined || input.targetProvider === undefined) {
    return "timeline-attachment";
  }
  if (input.sourceProvider !== input.targetProvider) {
    return "timeline-attachment";
  }
  return input.providerSupportsFork ? "provider-fork" : "timeline-attachment";
}
