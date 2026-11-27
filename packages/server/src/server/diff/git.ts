import { parseGitRevParsePath } from "../../utils/git-rev-parse-path.js";
import { readGitInputs } from "./inputs.js";
import { Patches } from "./patches.js";
import { HighlightSources } from "./sources.js";
import {
  prepareAllChangesIndex,
  PER_FILE_DIFF_MAX_BYTES,
  GIT_PATCH_FORMAT_ARGS,
  inspectUntrackedFile,
  snapshotComparisonIndex,
  resolveCheckoutDiffBase,
  type CheckoutDiffCompare,
} from "../../utils/checkout-git.js";
import { lstat, readFile, readlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { DiffEndpoint, DiffSubscribeRequest } from "@getpaseo/protocol/messages";
import type { DiffEntry, DiffBody } from "@getpaseo/protocol/binary-frames/index";
import { runGitCommand, type GitCommandOptions } from "../../utils/run-git-command.js";
import { parseDiff, highlightDiffWithFileContent } from "../utils/diff-highlighter.js";

export type Compare = Omit<DiffSubscribeRequest, "type" | "requestId"> & {
  checkoutBase?: { compare: CheckoutDiffCompare; paseoHome: string };
};
export interface ComparisonRevisions {
  refs: Map<string, string | null>;
  checkoutBase?: string | null;
}

export function isMovingRevision(rev: string): boolean {
  return !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(rev);
}

export interface ListedFile {
  entry: DiffEntry;
  identity: string;
  source: { kind: "tracked" } | { kind: "untracked"; size: number };
}
interface WorktreeInput {
  /** Comparison-side mode, or null when the file is added/untracked on this side. */
  oldMode: string | null;
  /** Comparison-side blob, or null when the file is added/untracked on this side. */
  oldBlob: string | null;
  /** A regular file whose bytes readGitInputs blob-hashes. */
  hashed: boolean;
  /** Content Git cannot read as a regular file: a symlink target or a submodule state. */
  literal: string | null;
  /** Git listed the path, but the worktree holds no copy of it. */
  missing: boolean;
}
interface ResolvedComparison {
  baseSha: string;
  headSha: string;
  mergeBaseSha: string;
  comparisonBaseSha: string;
}
export type DiffFileRead = { kind: "ready"; body: DiffBody; bytes: number } | { kind: "too_large" };
export interface Comparison extends Pick<
  ResolvedComparison,
  "baseSha" | "headSha" | "mergeBaseSha"
> {
  files: ListedFile[];
  metrics: { highlightCalls: number };
  close(): Promise<void>;
  selectBodies(paths: ReadonlySet<string>): void;
  hasInterpretationChanged(): Promise<boolean>;
  read(
    file: ListedFile,
    budget?: { remainingBytes?: number; maxPatchBytes?: number },
  ): Promise<DiffFileRead>;
}
export class DiffReadError extends Error {
  constructor(
    readonly code: "INVALID_COMPARE" | "NOT_GIT_REPO" | "REF_NOT_FOUND",
    message: string,
  ) {
    super(message);
  }
}
const EMPTY = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
// Keeps one re-listing's argument list short enough for the Windows command
// line, so a large sparse changes view does not become one process per path.
const VANISHED_PATH_BATCH_SIZE = 200;
export function validateCompare(compare: Compare): void {
  if (compare.head.kind === "empty")
    throw new DiffReadError("INVALID_COMPARE", "The head cannot be empty");
  if (compare.base.kind === "worktree")
    throw new DiffReadError("INVALID_COMPARE", "The working tree cannot be the base");
  if (compare.base.kind === "index" && compare.head.kind !== "worktree")
    throw new DiffReadError("INVALID_COMPARE", "An index base requires a working tree head");
  if (compare.mergeBase && compare.base.kind !== "rev")
    throw new DiffReadError("INVALID_COMPARE", "Merge base requires a revision base");
}
export async function worktreeRoot(cwd: string): Promise<string> {
  const result = await runGitCommand(["rev-parse", "--show-toplevel"], {
    cwd,
    acceptExitCodes: [0, 128],
  });
  if (result.exitCode !== 0) throw new DiffReadError("NOT_GIT_REPO", "Not a git repository");
  const root = parseGitRevParsePath(result.stdout);
  if (root === null) throw new DiffReadError("NOT_GIT_REPO", "Git returned no working tree root");
  return resolve(root);
}
async function resolveEndpoint(
  cwd: string,
  endpoint: DiffEndpoint,
  indexFile: string | null,
  revisions?: ComparisonRevisions,
): Promise<string> {
  if (endpoint.kind === "empty") return EMPTY;
  if (endpoint.kind === "index") {
    if (indexFile === null) throw new Error("Index comparisons require an index snapshot");
    const result = await runGitCommand(["write-tree"], {
      cwd,
      envOverlay: { GIT_INDEX_FILE: indexFile },
    });
    return result.stdout.trim();
  }
  const ref = endpoint.kind === "rev" ? endpoint.rev : "HEAD";
  const result = await runGitCommand(
    ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
    {
      cwd,
      acceptExitCodes: [0, 128],
    },
  );
  const sha = result.exitCode === 0 ? result.stdout.trim() : null;
  if (isMovingRevision(ref)) revisions?.refs.set(ref, sha);
  if (sha !== null) return sha;
  if (ref === "HEAD") {
    const unborn = await runGitCommand(["rev-parse", "--verify", "HEAD"], {
      cwd,
      acceptExitCodes: [0, 128],
    });
    if (unborn.exitCode !== 0) return EMPTY;
  }
  throw new DiffReadError("REF_NOT_FOUND", `Revision not found: ${ref}`);
}
function parseStats(
  text: string,
): Map<string, { additions: number; deletions: number; binary: boolean }> {
  const fields = text.split("\0");
  const stats = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  for (let index = 0; index < fields.length - 1; index++) {
    const line = fields[index];
    const tab = line.indexOf("\t");
    const second = line.indexOf("\t", tab + 1);
    const add = line.slice(0, tab);
    const del = line.slice(tab + 1, second);
    let path = line.slice(second + 1);
    if (!path) {
      index++;
      path = fields[++index];
    }
    stats.set(path, {
      additions: Number(add) || 0,
      deletions: Number(del) || 0,
      binary: add === "-",
    });
  }
  return stats;
}
export async function listComparison(
  compare: Compare,
  revisions?: ComparisonRevisions,
): Promise<Comparison> {
  if (compare.checkoutBase) {
    if (revisions) revisions.checkoutBase = null;
    const selected = await resolveCheckoutDiffBase(compare.cwd, compare.checkoutBase.compare, {
      paseoHome: compare.checkoutBase.paseoHome,
    });
    if (revisions) revisions.checkoutBase = selected;
    if (!selected) throw new DiffReadError("REF_NOT_FOUND", "Comparison base is unavailable");
    compare = { ...compare, base: { kind: "rev", rev: selected } };
  }
  validateCompare(compare);
  const cwd = compare.cwd;
  let privateIndex: Awaited<ReturnType<typeof prepareAllChangesIndex>> = null;
  try {
    if (compare.base.kind === "index" || compare.head.kind === "index")
      privateIndex = await snapshotComparisonIndex(cwd);
    const indexFile = privateIndex ? privateIndex.indexFile : null;
    const baseSha = await resolveEndpoint(cwd, compare.base, indexFile, revisions);
    const headSha = await resolveEndpoint(cwd, compare.head, indexFile, revisions);
    let mergeBaseSha = "";
    let comparisonBaseSha = baseSha;
    if (compare.mergeBase) {
      const headCommit =
        compare.head.kind === "index"
          ? await resolveEndpoint(cwd, { kind: "rev", rev: "HEAD" }, indexFile, revisions)
          : headSha;
      if (headCommit === EMPTY) comparisonBaseSha = EMPTY;
      else if (baseSha !== EMPTY) {
        const result = await runGitCommand(["merge-base", baseSha, headCommit], {
          cwd,
          acceptExitCodes: [0, 1],
        });
        mergeBaseSha = result.stdout.trim();
        if (mergeBaseSha) comparisonBaseSha = mergeBaseSha;
      }
    }
    if (compare.head.kind === "worktree" && compare.base.kind !== "index")
      privateIndex = await prepareAllChangesIndex(cwd, comparisonBaseSha);
    return await readComparisonList(
      compare,
      { baseSha, headSha, mergeBaseSha, comparisonBaseSha },
      privateIndex,
    );
  } catch (error) {
    await privateIndex?.cleanup();
    throw error;
  }
}

async function readComparisonList(
  compare: Compare,
  resolved: ResolvedComparison,
  privateIndex: Awaited<ReturnType<typeof prepareAllChangesIndex>>,
): Promise<Comparison> {
  const { baseSha, headSha, mergeBaseSha, comparisonBaseSha } = resolved;
  const cwd = compare.cwd;
  const args = diffArguments(compare, comparisonBaseSha, headSha);
  const options: GitCommandOptions = {
    cwd,
    envOverlay: {
      GIT_OPTIONAL_LOCKS: "0",
      ...(privateIndex ? { GIT_INDEX_FILE: privateIndex.indexFile } : {}),
    },
  };
  const tracked = await readTrackedFiles(compare, args, options);
  const files = tracked.files;
  const worktreeInputs = tracked.worktreeInputs;
  if (compare.head.kind === "worktree") {
    const untracked = await listUntrackedFiles(options);
    files.push(...untracked.files);
    for (const [path, input] of untracked.worktreeInputs) worktreeInputs.set(path, input);
    await dropVanishedEntries(files, worktreeInputs, args, options);
  }
  files.sort((a, b) => a.entry.path.localeCompare(b.entry.path));
  for (const file of files) tracked.interpretationPaths.add(file.entry.path);
  const hashedPaths = new Set(
    [...worktreeInputs].filter(([, input]) => input.hashed).map(([path]) => path),
  );
  const literalContent = new Map(
    [...worktreeInputs].flatMap(([path, input]) =>
      input.literal === null ? [] : [[path, input.literal] as const],
    ),
  );
  const gitInputs = await readGitInputs({
    paths: [...tracked.interpretationPaths].sort(),
    hashedPaths,
    options,
    literalContent,
  });
  for (const file of files) {
    if (compare.head.kind === "worktree") {
      const input = worktreeInputs.get(file.entry.path);
      if (!input) throw new Error(`Missing worktree identity for ${file.entry.path}`);
      file.identity = JSON.stringify([
        input.oldMode,
        input.oldBlob,
        gitInputs.identities.get(file.entry.path) ?? null,
        gitInputs.identities.get(file.entry.oldPath ?? file.entry.path) ?? null,
      ]);
      continue;
    }
    file.identity += JSON.stringify([
      gitInputs.identities.get(file.entry.path),
      gitInputs.identities.get(file.entry.oldPath ?? file.entry.path),
    ]);
  }
  const metrics = { highlightCalls: 0 };
  const patches = new Patches(args, options, files);
  const sources = new HighlightSources({
    cwd,
    baseSha: comparisonBaseSha,
    headSha: compare.head.kind === "worktree" ? null : headSha,
    files,
  });
  return {
    baseSha,
    headSha,
    mergeBaseSha,
    files,
    metrics,
    selectBodies: (paths) => patches.select(paths),
    hasInterpretationChanged: gitInputs.hasInterpretationChanged,
    close: async () => {
      await privateIndex?.cleanup();
    },
    async read(file, budget = {}) {
      const maxPatchBytes = budget.maxPatchBytes ?? PER_FILE_DIFF_MAX_BYTES;
      const remainingBytes = budget.remainingBytes ?? maxPatchBytes;
      if (file.source.kind === "untracked" && file.source.size > maxPatchBytes) {
        return { kind: "too_large" };
      }
      const result =
        file.source.kind === "untracked"
          ? await runGitCommand(
              [
                "diff",
                "--no-index",
                "--no-textconv",
                ...GIT_PATCH_FORMAT_ARGS,
                "--",
                "/dev/null",
                file.entry.path,
              ],
              {
                ...options,
                acceptExitCodes: [0, 1],
                maxOutputBytes: maxPatchBytes + 1,
              },
            )
          : await patches.read(file, maxPatchBytes);
      const bytes = Buffer.byteLength(result.stdout);
      if (result.truncated || bytes > remainingBytes || bytes > maxPatchBytes)
        return { kind: "too_large" };
      // File-type changes have a deletion and addition section for the same path.
      const sections = parseDiff(result.stdout).filter(
        (candidate) => candidate.path === file.entry.path,
      );
      if (!sections.length)
        return { kind: "ready", body: { path: file.entry.path, hunks: [] }, bytes };
      const parsed = {
        path: file.entry.path,
        isNew: file.entry.change === "added",
        isDeleted: file.entry.change === "deleted",
        additions: file.entry.additions,
        deletions: file.entry.deletions,
        hunks: sections.flatMap((section) => section.hunks),
      };
      let highlighted = parsed;
      if (compare.highlight !== false) {
        metrics.highlightCalls++;
        const context = await sources.read(file);
        highlighted = await highlightDiffWithFileContent(parsed, cwd, context);
      }
      const hunks = highlighted.hunks.map((hunk) => ({
        oldStart: hunk.oldStart,
        oldCount: hunk.oldCount,
        newStart: hunk.newStart,
        newCount: hunk.newCount,
        lines: hunk.lines.map((line) => {
          if (!line.tokens) return { type: line.type, content: line.content };
          return {
            type: line.type,
            content: line.content,
            runs: line.tokens
              .filter((token) => token.text.length > 0)
              .map((token) => ({ style: token.style, length: token.text.length })),
          };
        }),
      }));
      return { kind: "ready", body: { path: file.entry.path, hunks }, bytes };
    },
  };
}

async function readTrackedFiles(
  compare: Compare,
  args: string[],
  options: GitCommandOptions,
): Promise<{
  files: ListedFile[];
  worktreeInputs: Map<string, WorktreeInput>;
  interpretationPaths: Set<string>;
}> {
  const [raw, stat] = await Promise.all([
    runGitCommand([...args.filter((arg) => arg !== "-w"), "--raw", "--no-abbrev", "-z"], options),
    runGitCommand([...args, "--numstat", "-z"], options),
  ]);
  if (raw.truncated || stat.truncated)
    throw new Error("Diff entry list exceeded the git output budget");
  const stats = parseStats(stat.stdout);
  const fields = raw.stdout.split("\0");
  const files: ListedFile[] = [];
  const worktreeInputs = new Map<string, WorktreeInput>();
  const interpretationPaths = new Set<string>();
  for (let index = 0; index < fields.length - 1; index++) {
    const header = fields[index].split(" ");
    const code = header[4]?.[0];
    let path = fields[++index];
    let oldPath: string | null = null;
    if (code === "R" || code === "C") {
      oldPath = path;
      path = fields[++index];
    }
    interpretationPaths.add(path);
    if (oldPath !== null) interpretationPaths.add(oldPath);
    const counts = stats.get(path);
    // With -w, a raw metadata entry need not have a numstat record.
    if (!counts && compare.ignoreWhitespace) continue;
    if (!counts) throw new Error(`Missing diff statistics for ${path}`);
    let change: DiffEntry["change"] = "modified";
    if (code === "A") change = "added";
    else if (code === "D") change = "deleted";
    else if (oldPath !== null) change = "renamed";
    let identity = header.join(" ");
    if (compare.head.kind === "worktree") {
      // A sparse checkout keeps an entry in the index without materializing it,
      // and Git still diffs it, so an absent file is not a vanished path.
      const content =
        code === "D"
          ? null
          : await readWorktreeContent({ path, header, text: !counts.binary, options });
      const input: WorktreeInput = {
        oldMode: code === "A" ? null : header[0],
        oldBlob: code === "A" ? null : absentBlob(header[2]),
        hashed: content?.hashed ?? false,
        literal: content?.literal ?? null,
        missing: content === null && code !== "D",
      };
      const listedBlob = absentBlob(header[3]);
      if (input.missing && listedBlob !== null) {
        // Git diffs a path it cannot read from the worktree against the blob the
        // index holds, so that blob is the content identity of the change.
        input.literal = `index-blob:${listedBlob}`;
      }
      worktreeInputs.set(path, input);
      identity = "";
    }

    files.push({
      entry: {
        path,
        oldPath,
        change,
        content: counts.binary ? "binary" : "text",
        additions: counts.additions,
        deletions: counts.deletions,
        body: !counts.binary,
      },
      identity,
      source: { kind: "tracked" },
    });
  }
  return { files, worktreeInputs, interpretationPaths };
}

// Git's listing is a snapshot; deletes, checkouts, and test artifacts remove
// paths before the content read. A vanished path is not part of this revision's
// worktree state, so the caller drops the entry and the next revision reports
// the deletion, instead of failing the comparison with a raw ENOENT.
//
// Git decides which absent paths vanished: a sparse checkout's unmaterialized
// entry stays listed while the working-tree diff names it, even with the index
// flag spelled out as something sparse checkout did not set.
function isVanishedPath(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

// Drop the listed entries that the worktree lost before this revision read them.
// The private index must reach this check: its GIT_INDEX_FILE decides whether the
// worktree diff can see the entries at all.
async function dropVanishedEntries(
  files: ListedFile[],
  worktreeInputs: Map<string, WorktreeInput>,
  diffArgs: string[],
  options: GitCommandOptions,
): Promise<void> {
  const absent = files
    .filter((file) => worktreeInputs.get(file.entry.path)?.missing === true)
    .map((file) => file.entry.path);
  if (absent.length === 0) return;
  const listed = new Set<string>();
  for (let start = 0; start < absent.length; start += VANISHED_PATH_BATCH_SIZE) {
    const paths = absent
      .slice(start, start + VANISHED_PATH_BATCH_SIZE)
      .map((path) => `:(literal)${path}`);
    const result = await runGitCommand(
      [...diffArgs.filter((arg) => arg !== "-w"), "--raw", "-z", "--", ...paths],
      { ...options, envOverlay: { ...options.envOverlay, GIT_LITERAL_PATHSPECS: "1" } },
    );
    for (const record of result.stdout.split("\0")) {
      const separator = record.indexOf("\t");
      if (separator >= 0) listed.add(record.slice(separator + 1));
    }
  }
  // Nothing vanished: every listed path is still the worktree's state.
  if (listed.size === 0) return;
  const kept = files.filter((file) => {
    const path = file.entry.path;
    if (!listed.has(path)) return true;
    worktreeInputs.delete(path);
    return false;
  });
  files.splice(0, files.length, ...kept);
}

export async function readWorktreeContent({
  path,
  header,
  text,
  options,
}: {
  path: string;
  header: string[];
  text: boolean;
  options: GitCommandOptions;
}): Promise<{ hashed: boolean; literal: string | null } | null> {
  const absolutePath = resolve(options.cwd, path);
  const value = await lstat(absolutePath, { bigint: true }).catch((error: unknown) => {
    if (isVanishedPath(error)) return null;
    throw error;
  });
  if (value === null) return null;
  if (value.isSymbolicLink()) {
    const target = await readlink(absolutePath).catch((error: unknown) => {
      if (isVanishedPath(error)) return null;
      throw error;
    });
    return target === null ? null : { hashed: false, literal: `symlink:${target}` };
  }
  if (value.isDirectory() && (header[0] === ":160000" || header[1] === "160000")) {
    return { hashed: false, literal: await readSubmoduleIdentity(path, absolutePath, options) };
  }
  return { hashed: value.isFile() && text, literal: null };
}

// An uninitialized submodule has no `.git`; running git there would discover
// whichever repository sits above it. Its content is the commit the index
// records. Pinning GIT_DIR keeps an initialized submodule's status on its own `.git`.
async function readSubmoduleIdentity(
  path: string,
  submodulePath: string,
  options: GitCommandOptions,
): Promise<string> {
  try {
    await lstat(join(submodulePath, ".git"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const recorded = await runGitCommand(["rev-parse", "--verify", "--quiet", `:0:${path}`], {
      ...options,
      acceptExitCodes: [0, 1],
    });
    return `submodule-uninitialized:${recorded.stdout.trim()}`;
  }
  const status = await runGitCommand(
    ["status", "--porcelain=v2", "--branch", "--untracked-files=normal"],
    { cwd: submodulePath, envOverlay: { GIT_DIR: ".git", GIT_OPTIONAL_LOCKS: "0" } },
  );
  return `submodule:${status.stdout}`;
}

function diffArguments(compare: Compare, baseSha: string, headSha: string): string[] {
  const revisions: string[] = [];
  if (compare.base.kind !== "index") revisions.push(baseSha);
  if (compare.head.kind === "rev") revisions.push(headSha);
  if (compare.head.kind === "index") revisions.unshift("--cached");
  const args = ["diff", ...GIT_PATCH_FORMAT_ARGS, "--no-textconv", "-M", ...revisions];
  if (compare.ignoreWhitespace) args.push("-w");
  return args;
}

async function readUntrackedText(
  path: string,
  symlink: boolean,
  omitted: boolean,
): Promise<Buffer> {
  if (symlink) return Buffer.from(await readlink(path));
  if (omitted) return Buffer.alloc(0);
  return readFile(path);
}

async function listUntrackedFiles(
  options: GitCommandOptions,
): Promise<{ files: ListedFile[]; worktreeInputs: Map<string, WorktreeInput> }> {
  const cwd = options.cwd;
  const files: ListedFile[] = [];
  const worktreeInputs = new Map<string, WorktreeInput>();
  const untracked = await runGitCommand(
    ["ls-files", "--others", "--exclude-standard", "-z"],
    options,
  );
  for (const path of untracked.stdout.split("\0").filter(Boolean)) {
    try {
      const value = await lstat(resolve(cwd, path), { bigint: true });
      if (!value.isFile() && !value.isSymbolicLink()) continue;
      const symlink = value.isSymbolicLink();
      let binary = false;
      let omitted = false;
      if (!symlink) {
        const inspected = await inspectUntrackedFile(cwd, path);
        binary = inspected.stat?.isBinary === true;
        omitted = inspected.truncated;
      }
      const content = await readUntrackedText(resolve(cwd, path), symlink, binary || omitted);
      const additions =
        binary || content.length === 0
          ? 0
          : content.toString("utf8").split("\n").length - Number(content.at(-1) === 10);
      worktreeInputs.set(path, {
        oldMode: null,
        oldBlob: null,
        hashed: !symlink && !binary && !omitted,
        literal: symlink ? `symlink:${content.toString("utf8")}` : null,
        missing: false,
      });
      files.push({
        entry: {
          path,
          oldPath: null,
          change: "added",
          content: binary ? "binary" : "text",
          additions,
          deletions: 0,
          body: !binary,
        },
        identity: "",
        source: { kind: "untracked", size: Number(value.size) },
      });
    } catch (error) {
      if (isVanishedPath(error)) continue;
      throw error;
    }
  }
  return { files, worktreeInputs };
}

function absentBlob(value: string): string | null {
  return /^0+$/.test(value) ? null : value;
}
