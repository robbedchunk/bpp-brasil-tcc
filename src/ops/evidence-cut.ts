import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";

const COMMIT = /^[a-f0-9]{40}$/u;

const EVIDENCE_ONLY_PATHS = new Set([
  "data/acceptance/acceptance.json",
  "data/acceptance/evidence/alert-drill.json",
  "data/acceptance/evidence/backup-drill.json",
  "data/acceptance/evidence/fresh-clone.json",
  "data/acceptance/evidence/healing-sabotage-drill.json",
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

/**
 * Paths backed by the frozen release's mutable state links. Commits that only
 * change these paths do not change the installed executable/configuration
 * tree, so a release remains current across committed collection evidence.
 */
export function isReleaseNeutralPath(path: string): boolean {
  return isAcceptanceEvidencePath(path)
    || path.startsWith("data/")
    || path.startsWith("analysis/output/");
}

function gitSucceeds(root: string, args: string[]): boolean {
  try {
    execFileSync("git", args, {
      cwd: root,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * A signed release can remain the current runtime across later (or earlier)
 * commits containing only state linked into that release. Requiring literal
 * commit equality would make it impossible to commit a scheduled SQLite run
 * without immediately invalidating the release that produced the run.
 */
export function releaseSourceMatchesEvaluatedCommit(
  rootInput: string,
  releaseSourceCommit: string,
  evaluatedCommit: string,
): boolean {
  if (!COMMIT.test(releaseSourceCommit) || !COMMIT.test(evaluatedCommit)) return false;
  let root: string;
  try {
    root = realpathSync(rootInput);
  } catch {
    return false;
  }
  if (!gitSucceeds(root, ["cat-file", "-e", `${releaseSourceCommit}^{commit}`])
    || !gitSucceeds(root, ["cat-file", "-e", `${evaluatedCommit}^{commit}`])) {
    return false;
  }
  if (releaseSourceCommit === evaluatedCommit) return true;
  const linearlyRelated = gitSucceeds(
    root,
    ["merge-base", "--is-ancestor", releaseSourceCommit, evaluatedCommit],
  ) || gitSucceeds(
    root,
    ["merge-base", "--is-ancestor", evaluatedCommit, releaseSourceCommit],
  );
  if (!linearlyRelated) return false;
  try {
    const paths = execFileSync(
      "git",
      ["diff", "--name-only", "--no-renames", releaseSourceCommit, evaluatedCommit],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim().split("\n").filter(Boolean);
    return paths.every(isReleaseNeutralPath);
  } catch {
    return false;
  }
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
