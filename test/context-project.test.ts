import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveContextProjectId, resolveProject } from "../src/hooks/_project.js";

const dirs: string[] = [];
function root() { const dir = mkdtempSync(join(tmpdir(), "memory-project-")); dirs.push(dir); return dir; }
const git = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
afterEach(() => { vi.unstubAllEnvs(); dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });

describe("selective memory project identity", () => {
  it("separates same-name folders without changing legacy labels", () => {
    vi.stubEnv("AGENTMEMORY_PROJECT_NAME", ""); vi.stubEnv("AGENTMEMORY_CONTEXT_PROJECT", "");
    const dir = root(), a = join(dir, "a", "same"), b = join(dir, "b", "same");
    mkdirSync(a, { recursive: true }); mkdirSync(b, { recursive: true });
    expect(resolveProject(a)).toBe(resolveProject(b));
    expect(resolveContextProjectId(a)).not.toBe(resolveContextProjectId(b));
  });
  it("shares equivalent SSH/HTTPS origins without including credentials", () => {
    vi.stubEnv("AGENTMEMORY_CONTEXT_PROJECT", "");
    const a = root(), b = root(); git(a, "init"); git(b, "init");
    git(a, "remote", "add", "origin", "https://user:fixture-secret@example.test/team/repo.git");
    git(b, "remote", "add", "origin", "git@example.test:team/repo.git");
    expect(resolveContextProjectId(a)).toBe(resolveContextProjectId(b));
    expect(resolveContextProjectId(a)).not.toContain("fixture-secret");
    git(b, "remote", "set-url", "origin", "git@example.test:other/repo.git");
    expect(resolveContextProjectId(a)).not.toBe(resolveContextProjectId(b));
  });
  it("uses the common repository identity for local-only subdirectories", () => {
    vi.stubEnv("AGENTMEMORY_CONTEXT_PROJECT", "");
    const dir = root(); git(dir, "init"); const nested = join(dir, "src"); mkdirSync(nested);
    expect(resolveContextProjectId(nested)).toBe(resolveContextProjectId(dir));
  });
  it("does not confuse Windows drive paths with a shared SSH remote", () => {
    vi.stubEnv("AGENTMEMORY_CONTEXT_PROJECT", "");
    const a = root(), b = root(); git(a, "init"); git(b, "init");
    git(a, "remote", "add", "origin", "C:\\repos\\same.git");
    git(b, "remote", "add", "origin", "C:\\repos\\same.git");
    expect(resolveContextProjectId(a)).not.toBe(resolveContextProjectId(b));
  });
  it("requires a separate explicit alias to share context across unrelated paths", () => {
    const a = root(), b = root();
    vi.stubEnv("AGENTMEMORY_PROJECT_NAME", "same-display-name"); vi.stubEnv("AGENTMEMORY_CONTEXT_PROJECT", "");
    expect(resolveContextProjectId(a)).not.toBe(resolveContextProjectId(b));
    vi.stubEnv("AGENTMEMORY_CONTEXT_PROJECT", "reviewed-shared-project");
    expect(resolveContextProjectId(a)).toBe(resolveContextProjectId(b));
  });
});
