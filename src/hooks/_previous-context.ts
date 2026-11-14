import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { stripPrivateData } from "../functions/privacy.js";

/** Only same-session dialogue is eligible; tool results and reasoning are excluded. */
export function previousContext(path: unknown, sessionId: string, prompt: string): string {
  if (typeof path !== "string" || !path.endsWith(".jsonl") || sessionId === "unknown") return "";
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile()) return "";
    const head = Buffer.alloc(Math.min(stat.size, 8192));
    readSync(fd, head, 0, head.length, 0);
    let codexSession = false;
    try {
      const meta = JSON.parse(head.toString("utf8").split("\n")[0]!);
      if (meta.type === "session_meta") {
        if (meta.payload?.id !== sessionId) return "";
        codexSession = true;
      }
    } catch { /* Unknown headers require a session identity on each message. */ }
    // debt: ceiling: a 64 KiB transcript tail; if dialogue is outside it, omit
    // context. Upgrade to a harness-provided recent-turn API before reading more.
    const tail = Buffer.alloc(Math.min(stat.size, 65536));
    const offset = stat.size - tail.length;
    readSync(fd, tail, 0, tail.length, offset);
    const lines = tail.toString("utf8").split("\n");
    if (offset > 0) lines.shift();
    const messages: Array<{ role: string; text: string }> = [];
    for (const line of lines) {
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      const message = codexSession
        ? (row.type === "response_item" && row.payload?.type === "message" ? row.payload : null)
        : (row.sessionId === sessionId && ["user", "assistant"].includes(row.type) ? row.message : null);
      if (!message || !["user", "assistant"].includes(message.role)) continue;
      const text = typeof message.content === "string" ? message.content
        : Array.isArray(message.content) ? message.content
          .filter((block: { type?: string; text?: unknown }) =>
            ["text", "input_text", "output_text"].includes(block.type ?? "") && typeof block.text === "string")
          .map((block: { text: string }) => block.text).join("\n") : "";
      if (text.trim()) messages.push({ role: message.role, text: stripPrivateData(text) });
    }
    const last = messages.at(-1);
    if (last?.role === "user" && last.text.trim() === stripPrivateData(prompt).trim()) messages.pop();
    const selected: typeof messages = [];
    for (const message of messages.slice(-4).reverse()) {
      if (JSON.stringify([message, ...selected]).length > 8000) break;
      selected.unshift(message);
    }
    return selected.length ? JSON.stringify(selected) : "";
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
