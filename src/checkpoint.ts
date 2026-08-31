import { spawnSync } from "node:child_process";

export function getHeadHash(cwd: string): string | null {
  try {
    const res = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
      windowsHide: true,
    });
    if (res.status === 0 && !res.error) {
      return res.stdout.trim();
    }
    return null;
  } catch {
    return null;
  }
}

export function isWorkingTreeClean(cwd: string): boolean {
  try {
    const res = spawnSync("git", ["status", "--porcelain"], {
      cwd,
      encoding: "utf8",
      windowsHide: true,
    });
    if (res.status !== 0 || res.error) {
      return false;
    }
    return res.stdout.trim() === "";
  } catch {
    return false;
  }
}

export function ensureGitRepo(cwd: string): boolean {
  try {
    const res = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd,
      encoding: "utf8",
      windowsHide: true,
    });
    if (res.status === 0 && !res.error) {
      return true;
    }
    const initRes = spawnSync("git", ["init"], {
      cwd,
      encoding: "utf8",
      windowsHide: true,
    });
    return initRes.status === 0 && !initRes.error;
  } catch {
    return false;
  }
}

export function prepareCheckpoint(cwd: string): { eligible: boolean; beforeHash: string | null; reason: string | null } {
  try {
    const repoOk = ensureGitRepo(cwd);
    if (!repoOk) {
      return { eligible: false, beforeHash: null, reason: "git not available or init failed" };
    }
    if (!isWorkingTreeClean(cwd)) {
      return {
        eligible: false,
        beforeHash: null,
        reason: "working tree had uncommitted changes before this task — checkpoint skipped to avoid mixing unrelated work",
      };
    }
    return { eligible: true, beforeHash: getHeadHash(cwd), reason: null };
  } catch {
    return { eligible: false, beforeHash: null, reason: "internal error" };
  }
}

/**
 * Stage and commit a checkpoint. When `scopeFiles` is given (the files a task's
 * own tool calls actually touched), ONLY those paths are staged — this keeps
 * the auto-commit from silently bundling in unrelated changes that appeared in
 * the working tree from another concurrent process (a human editing the same
 * repo, another acp session, or a scope-creeping sub-agent). Falls back to
 * staging everything only when no scope is provided (legacy/full-tree mode).
 */
export function commitCheckpoint(
  cwd: string,
  message: string,
  scopeFiles?: string[],
): { committed: boolean; afterHash: string | null } {
  try {
    const addArgs = scopeFiles && scopeFiles.length > 0 ? ["add", "--", ...scopeFiles] : ["add", "-A"];
    const addRes = spawnSync("git", addArgs, {
      cwd,
      encoding: "utf8",
      windowsHide: true,
    });
    if (addRes.status !== 0 || addRes.error) {
      return { committed: false, afterHash: null };
    }

    const commitRes = spawnSync("git", ["commit", "-m", message], {
      cwd,
      encoding: "utf8",
      windowsHide: true,
    });
    if (commitRes.status !== 0 || commitRes.error) {
      return { committed: false, afterHash: getHeadHash(cwd) };
    }

    return { committed: true, afterHash: getHeadHash(cwd) };
  } catch {
    return { committed: false, afterHash: null };
  }
}
