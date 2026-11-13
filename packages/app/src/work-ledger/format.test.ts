import { describe, expect, test } from "vitest";
import type { WorkLedgerItem } from "@getpaseo/protocol/work-ledger/types";
import {
  compareItemNumbers,
  formatRelativeAge,
  formatTimestamp,
  itemProgressLine,
  shortAgentId,
} from "./format";

const base = {
  scope: { kind: "project" as const, projectId: "p" },
  projectId: "p",
  title: "t",
  status: "pending" as const,
  attention: [],
  labels: [],
  agents: [],
  entries: [],
  entryCount: 0,
  createdAt: "2026-11-11T00:00:00.000Z",
  updatedAt: "2026-11-11T00:00:00.000Z",
  lastProgressAt: null,
  lastInspectedAt: null,
  completedAt: null,
  cancelledAt: null,
  revision: 1,
} satisfies Partial<WorkLedgerItem>;

const labels = {
  locale: "en",
  justNow: "just now",
  minute: "{{count}}m ago",
  hour: "{{count}}h ago",
  day: "{{count}}d ago",
};

describe("work ledger formatting", () => {
  test("relative age has four coarse buckets and handles missing timestamps", () => {
    const now = Date.parse("2026-11-12T12:00:00.000Z");
    expect(formatRelativeAge({ ...labels, now, iso: null })).toBeNull();
    expect(formatRelativeAge({ ...labels, now, iso: "2026-11-12T11:59:40.000Z" })).toBe("just now");
    expect(formatRelativeAge({ ...labels, now, iso: "2026-11-12T11:45:00.000Z" })).toBe("15m ago");
    expect(formatRelativeAge({ ...labels, now, iso: "2026-11-12T09:00:00.000Z" })).toBe("3h ago");
    expect(formatRelativeAge({ ...labels, now, iso: "2026-11-09T12:00:00.000Z" })).toBe("3d ago");
  });

  test("a clock skew in the future never reads as a negative age", () => {
    const now = Date.parse("2026-11-12T12:00:00.000Z");
    expect(formatRelativeAge({ ...labels, now, iso: "2026-11-12T12:00:30.000Z" })).toBe("just now");
  });

  test("absolute timestamps are locale-formatted and refuse garbage", () => {
    expect(formatTimestamp("not-a-date", "en")).toBeNull();
    expect(formatTimestamp("2026-11-12T12:00:00.000Z", "en")).toContain("2026");
  });

  test("item numbers sort naturally", () => {
    const numbers = ["TODO-20261111-010", "TODO-20261111-002", "TODO-20261112-001"];
    expect([...numbers].sort(compareItemNumbers)).toEqual([
      "TODO-20261111-002",
      "TODO-20261111-010",
      "TODO-20261112-001",
    ]);
  });

  test("the progress line prefers the current state and falls back to the block reason", () => {
    expect(itemProgressLine({ ...base, id: "a", number: "n", latestSummary: "41% copied" })).toBe(
      "41% copied",
    );
    expect(
      itemProgressLine({ ...base, id: "b", number: "n", blockedReason: "Awaiting creds" }),
    ).toBe("Awaiting creds");
    expect(itemProgressLine({ ...base, id: "c", number: "n" })).toBeNull();
  });

  test("short agent ids keep a recognizable head", () => {
    expect(shortAgentId("9f90efe0")).toBe("9f90efe0");
    expect(shortAgentId("9f90efe0123456789")).toBe("9f90efe0");
  });
});
