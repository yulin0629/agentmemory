import { expect, test } from "vitest";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";

test("shared client keeps diagnostics separate from model content", async () => {
  let mode = "selected";
  const server = createServer((_request, response) => {
    if (mode === "timeout") return;
    if (mode === "http_error") { response.writeHead(401); response.end("private error"); return; }
    if (mode === "invalid_response") { response.end("not JSON private error"); return; }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ status: mode === "selected" ? "selected" : "empty",
      spans: mode === "selected" ? [{ text: "private knowledge" }] : [], catalogRevision: 1 }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  try {
    for (const scenario of ["selected", "empty", "http_error", "invalid_response", "timeout"]) {
      mode = scenario;
      const child = execFile(process.execPath, [resolve("plugin/scripts/selective-client.mjs"), "--stdin"], {
        env: { ...process.env, AGENTMEMORY_URL: `http://127.0.0.1:${address.port}`,
          AGENTMEMORY_SELECTIVE_CONTEXT_INJECT: "true", AGENTMEMORY_RECALL_DIAGNOSTICS: "1" },
        timeout: 8000,
      });
      const result = new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        let stdout = "", stderr = "";
        child.stdout!.on("data", data => stdout += data);
        child.stderr!.on("data", data => stderr += data);
        child.on("error", reject);
        child.on("close", code => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`exit ${code}`)));
      });
      child.stdin!.end(JSON.stringify({ prompt: "private prompt", session_id: "diagnostic-test", cwd: "/tmp" }));
      const { stdout, stderr } = await result;
      expect(stdout).toBe(scenario === "selected" ? "[Verified background relevant to this request]\n- private knowledge" : "");
      const diagnostic = JSON.parse(stderr.trim().slice("AGENTMEMORY_RECALL ".length));
      expect(diagnostic.reason).toBe(scenario === "empty" ? "api_empty" : scenario === "timeout" ? "api_timeout" : scenario);
      expect(stderr).not.toContain("private");
      expect(stderr).not.toContain("Bearer");
    }
  } finally {
    server.closeAllConnections();
    await promisify(server.close.bind(server))();
  }
}, 20000);
