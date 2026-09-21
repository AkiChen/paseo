import { describe, expect, it } from "vitest";
import { resolveCommitMessage, resolveCommitSubject } from "./commit-details";

const base = {
  sha: "0123456789abcdef0123456789abcdef01234567",
  shortSha: "0123456",
  subject: "Cache the timeline loader",
  authorName: "Alex Doe",
  authorDate: "2026-09-20T15:38:29+08:00",
  isOnRemote: true,
  files: [],
};

describe("resolveCommitSubject", () => {
  it("keeps only the subject line of a multi-line message", () => {
    const commit = {
      ...base,
      message: [
        "[Perf] cache the timeline loader",
        "",
        "Loading a long transcript re-read every row on each revision.",
        "",
        "- warm the cache per agent",
        "Co-Authored-By: Someone <someone@example.com>",
      ].join("\n"),
    };

    expect(resolveCommitSubject(commit)).toBe("[Perf] cache the timeline loader");
  });

  it("falls back to the subject when the message is absent", () => {
    expect(resolveCommitSubject(base)).toBe("Cache the timeline loader");
  });

  // A message that starts with blank lines still has a first visible line worth
  // showing: trimming happens before the header picks its line.
  it("uses the first visible line when the message starts blank", () => {
    expect(resolveCommitSubject({ ...base, subject: "   ", message: "\n\nBody only" })).toBe(
      "Body only",
    );
  });

  it("falls back to the short sha when there is nothing to show", () => {
    expect(resolveCommitSubject({ ...base, subject: "", message: "   " })).toBe("0123456");
  });

  it("still returns the whole message for the expanded panel", () => {
    const commit = { ...base, message: "Subject\n\nBody" };

    expect(resolveCommitMessage(commit)).toBe("Subject\n\nBody");
  });
});
