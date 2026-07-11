import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";

const COMMIT = /^[a-f0-9]{40}$/u;

const EVIDENCE_ONLY_PATHS = new Set([
  "data/acceptance/acceptance.json",
  "data/acceptance/evidence/alert-drill.json",
  "data/acceptance/evidence/backup-drill.json",
  "data/acceptance/evidence/fresh-clone.json",
  "docs/acceptance-report.md",
]);

function git(root: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

export function isAcceptanceEvidencePath(path: string): boolean {
  return EVIDENCE_ONLY_PATHS.has(path)
    || /^data\/acceptance\/evidence\/classification-review-v[1-9]\d*\.json$/u.test(path);
}

function commitPaths(root: string, commit: string): string[] {
  return git(root, ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", commit])
    .split("\n")
    .filter(Boolean)
    .sort();
}

/**
 * Resolve the last implementation/data cut beneath a linear tail containing
 * only strictly allowlisted generated acceptance evidence.
 */
export function resolveAcceptanceEvaluatedCommit(rootInput: string): string {
  const root = realpathSync(rootInput);
  let candidate = git(root, ["rev-parse", "HEAD"]);
  if (!COMMIT.test(candidate)) throw new Error("Acceptance requires a Git implementation commit");
  while (true) {
    const ancestry = git(root, ["rev-list", "--parents", "-n", "1", candidate]).split(/\s+/u).filter(Boolean);
    const paths = commitPaths(root, candidate);
    if (ancestry.length !== 2 || paths.length === 0 || paths.some((path) => !isAcceptanceEvidencePath(path))) {
      return candidate;
    }
    const parent = ancestry[1];
    if (parent === undefined || !COMMIT.test(parent)) return candidate;
    candidate = parent;
  }
}
