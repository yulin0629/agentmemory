import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectiveSettings } from "../src/hooks/_selective-settings.js";

let home = "";
afterEach(() => {
  vi.unstubAllEnvs();
  if (home) rmSync(home, { recursive: true, force: true });
  home = "";
});

function withEnvFileSecret(url: string): void {
  home = mkdtempSync(join(tmpdir(), "am-selective-secret-"));
  const envFile = join(home, "agentmemory.env");
  writeFileSync(envFile, "AGENTMEMORY_SECRET=env-file-secret\n");
  vi.stubEnv("HOME", home);
  vi.stubEnv("AGENTMEMORY_ENV_FILE", envFile);
  vi.stubEnv("AGENTMEMORY_SECRET", "");
  vi.stubEnv("AGENTMEMORY_URL", url);
}

describe("selective hook settings", () => {
  it("does not send the env-file secret to a non-loopback server", () => {
    withEnvFileSecret("http://192.0.2.10:3111");
    expect(selectiveSettings().secret).toBe("");
  });

  it("sends the env-file secret to a loopback server", () => {
    withEnvFileSecret("http://127.0.0.1:3111");
    expect(selectiveSettings().secret).toBe("env-file-secret");
  });
});
