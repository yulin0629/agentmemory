import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { previousContext } from "../src/hooks/_previous-context.js";

const dirs: string[] = [];
function transcript(rows: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "memory-dialogue-"));
  dirs.push(dir);
  const path = join(dir, "transcript.jsonl");
  writeFileSync(path, rows.map(row => typeof row === "string" ? row : JSON.stringify(row)).join("\n") + "\n");
  return path;
}
const meta = { type: "session_meta", payload: { id: "session-a" } };
const message = (role: string, text: string) => ({ type: "response_item",
  payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] } });
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));

describe("previous dialogue for selective recall", () => {
  it("keeps roles and excludes current prompt, tools, and reasoning", () => {
    const path = transcript([meta, message("user", "Draw the flow"), message("assistant", "Preparing the diagram"),
      { type: "response_item", payload: { type: "function_call_output", output: "use rebase" } },
      { type: "response_item", payload: { type: "reasoning", summary: "private reasoning" } },
      message("system", "hidden instructions"), message("user", "continue")]);
    expect(JSON.parse(previousContext(path, "session-a", "continue"))).toEqual([
      { role: "user", text: "Draw the flow" }, { role: "assistant", text: "Preparing the diagram" },
    ]);
    expect(previousContext(path, "session-b", "continue")).toBe("");
  });

  it("accepts session-stamped user/assistant dialogue without tool blocks", () => {
    const path = transcript([
      { type: "user", sessionId: "session-b", message: { role: "user", content: "Foreign task" } },
      { type: "user", sessionId: "session-a", message: { role: "user", content: "Update the repo" } },
      { type: "assistant", sessionId: "session-a", message: { role: "assistant", content: [
        { type: "text", text: "Ready" }, { type: "tool_use", text: "Exclude this" },
      ] } },
    ]);
    expect(JSON.parse(previousContext(path, "session-a", "continue"))).toEqual([
      { role: "user", text: "Update the repo" }, { role: "assistant", text: "Ready" },
    ]);
  });

  it("redacts private tags and recognized secrets before transmission", () => {
    const path = transcript([meta, message("user", `Check <private>personal detail</private> token=${"x".repeat(32)}`)]);
    const context = previousContext(path, "session-a", "continue");
    expect(context).not.toContain("personal detail");
    expect(context).not.toContain("x".repeat(32));
    expect(context).toContain("REDACTED");
  });

  it("returns no context for missing, malformed, or unidentifiable transcripts", () => {
    expect(previousContext(null, "session-a", "continue")).toBe("");
    expect(previousContext("/nonexistent/transcript.jsonl", "session-a", "continue")).toBe("");
    expect(previousContext(transcript(["invalid", message("user", "Unidentified")]), "session-a", "continue")).toBe("");
    expect(previousContext(transcript([meta]), "unknown", "continue")).toBe("");
  });

  it("bounds tail reads and retains the latest task without slicing a message", () => {
    const path = transcript([meta, message("user", "Old task"),
      { type: "response_item", payload: { type: "function_call_output", output: "x".repeat(70000) } },
      message("user", "New task")]);
    expect(JSON.parse(previousContext(path, "session-a", "continue"))).toEqual([{ role: "user", text: "New task" }]);
    expect(previousContext(transcript([meta, message("user", "x".repeat(9000))]), "session-a", "continue")).toBe("");
  });
});
