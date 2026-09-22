import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { selectiveSettings } from "./_selective-settings.js";

export { selectiveSettings };

export async function recallForPrompt(prompt: string, sessionId: string, cwd: string, transcriptPath?: string): Promise<string> {
  if (!selectiveSettings().enabled || !prompt.trim()) return "";
  return new Promise(resolve => {
    const child = execFile(process.execPath, [fileURLToPath(new URL("./prompt-submit.mjs", import.meta.url))],
      { timeout: 6500, maxBuffer: 16384, env: { ...process.env, AGENTMEMORY_SHARED_CLIENT: "1" } }, (error, stdout) => {
        if (error) return resolve("");
        try {
          const text = JSON.parse(stdout).hookSpecificOutput?.additionalContext;
          resolve(typeof text === "string" ? text : "");
        } catch { resolve(""); }
      });
    child.stdin?.end(JSON.stringify({ prompt, session_id: sessionId, cwd, transcript_path: transcriptPath, hook_event_name: "UserPromptSubmit" }));
  });
}

// The shared agent-hooks core owns native routing; this entry owns the REST contract.
if (process.argv.includes("--stdin")) {
  (async () => {
    let input = "";
    for await (const chunk of process.stdin) {
      input += chunk;
      if (input.length > 65536) return;
    }
    const data = JSON.parse(input);
    if (typeof data.prompt !== "string" || typeof data.session_id !== "string"
      || typeof data.cwd !== "string") return;
    process.stdout.write(await recallForPrompt(data.prompt, data.session_id, data.cwd, data.transcript_path));
  })().catch(() => {});
}
