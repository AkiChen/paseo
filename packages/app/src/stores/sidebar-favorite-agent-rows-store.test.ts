import { describe, expect, it } from "vitest";
import { favoriteAgentKey, toggleFavoriteKey } from "./sidebar-favorite-agent-rows-store";

describe("favoriteAgentKey", () => {
  it("addresses an agent by host and id, the way a workspace row uses workspaceKey", () => {
    expect(favoriteAgentKey({ serverId: "srv", id: "agent-1" })).toBe("srv:agent-1");
  });

  it("keeps two agents in one workspace apart", () => {
    expect(favoriteAgentKey({ serverId: "srv", id: "a" })).not.toBe(
      favoriteAgentKey({ serverId: "srv", id: "b" }),
    );
  });
});

describe("toggleFavoriteKey", () => {
  it("stars to the front so the most recent star leads the section", () => {
    expect(toggleFavoriteKey([], "srv:a")).toEqual(["srv:a"]);
    expect(toggleFavoriteKey(["srv:a"], "srv:b")).toEqual(["srv:b", "srv:a"]);
  });

  it("unstars without disturbing the rest of the order", () => {
    expect(toggleFavoriteKey(["srv:c", "srv:b", "srv:a"], "srv:b")).toEqual(["srv:c", "srv:a"]);
  });

  it("ignores a blank key rather than starring an empty row", () => {
    const keys = ["srv:a"];
    expect(toggleFavoriteKey(keys, "  ")).toBe(keys);
  });
});
