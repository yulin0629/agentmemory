import { execSync, execFileSync } from "node:child_process";
import { basename, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { hostname } from "node:os";
import { createHash } from "node:crypto";

/** Selective memory identity is separate from legacy human-readable project labels. */
export function resolveContextProjectId(cwd: string): string {
  const hash = (value: string) => `project:${createHash("sha256").update(value).digest("hex")}`;
  const explicit = process.env["AGENTMEMORY_CONTEXT_PROJECT"]?.trim();
  if (explicit) return hash(`explicit:${explicit}`);
  const git = (args: string[]) => execFileSync("git", args, {
    cwd, stdio: ["ignore", "pipe", "ignore"], timeout: 500, encoding: "utf8",
  }).trim();
  try {
    const remote = git(["remote", "get-url", "origin"]);
    // A Windows drive path or Git remote helper is not an SSH hostname.
    const scp = /^[A-Za-z]:[\\/]/.test(remote) || remote.includes("::")
      ? null : /^(?:[^@/:]+@)?([^/:]+):(.+)$/.exec(remote);
    const url = new URL(remote.includes("://") ? remote : scp ? `ssh://${scp[1]}/${scp[2]}` : "file:///unshared");
    if (["https:", "http:", "ssh:"].includes(url.protocol) && url.hostname) {
      const port = url.protocol === "ssh:" && url.port === "22" ? "" : url.port;
      const path = url.pathname.replace(/\/$/, "").replace(/\.git$/, "");
      return hash(`remote:${url.hostname.toLowerCase()}${port ? `:${port}` : ""}${path}`);
    }
  } catch { /* Local-only repositories use their common Git directory below. */ }
  let path = cwd;
  try { path = resolve(cwd, git(["rev-parse", "--git-common-dir"])); } catch {}
  try { path = realpathSync(path); } catch { path = resolve(path); }
  return hash(`local:${hostname()}:${path}`);
}

// Resolution order: AGENTMEMORY_PROJECT_NAME env → git toplevel basename → cwd basename.
export function resolveProject(cwd?: string): string {
  const explicit = process.env["AGENTMEMORY_PROJECT_NAME"];
  if (explicit && explicit.trim()) return explicit.trim();
  const dir = cwd && cwd.trim() ? cwd : process.cwd();
  try {
    const top = execSync("git rev-parse --show-toplevel", {
      cwd: dir,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 500,
    })
      .toString()
      .trim();
    if (top) return basename(top);
  } catch {}
  return basename(dir);
}

export function hookCwd(data: Record<string, unknown> | null | undefined): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  if (typeof data.cwd === "string" && data.cwd.trim()) return data.cwd;
  const roots = data.workspace_roots;
  if (Array.isArray(roots)) {
    for (const root of roots) {
      if (typeof root === "string" && root.trim()) return root;
    }
  }
  const projectDir =
    process.env["DEVIN_PROJECT_DIR"] || process.env["CLAUDE_PROJECT_DIR"];
  if (projectDir && projectDir.trim()) return projectDir;
  return undefined;
}
