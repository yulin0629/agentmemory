import { createHash } from "node:crypto";

export const MAX_EVENT_BYTES = 16 * 1024;

export function redact(value, limit = 2048) {
  return String(value)
    .replace(/data:[^,\s]+;base64,[A-Za-z0-9+/_=-]+/gi, "[attachment omitted]")
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, "[redacted]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_.=~-]+/gi, "[redacted]")
    .replace(/((?:password|passwd|secret|token|api[-_]?key|authorization|credential)["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi, "$1[redacted]")
    .replace(/\b(?:sk-|gh[pousr]_|github_pat_|AKIA|ASIA)[A-Za-z0-9_/-]+/g, "[redacted]")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "")
    .slice(0, limit);
}

export function sessionIdentity(value) {
  return redact(value, 128) === value ? value : `redacted-${createHash("sha256").update(value).digest("hex")}`;
}

export function commandSummary(command) {
  const known = /^(git|npm|pnpm|node|python3?|rg|ls|pwd|cat|head|tail|sed|awk|find|mkdir|cp|mv|rm|curl|wget|ssh|make|cargo|go|printf|echo|true|false)$/;
  return String(command).split(/\r?\n|&&|\|\||[;|]/).slice(0, 8).map((part) => {
    const words = part.trim().split(/\s+/);
    const executable = words[0]?.split("/").at(-1);
    if (!known.test(executable ?? "")) return "[command]";
    const subcommand = ["git", "npm", "pnpm", "cargo", "go"].includes(executable)
      && /^(status|diff|show|log|add|commit|test|run|build|install|check|fetch|pull|push)$/.test(words[1] ?? "")
      ? ` ${words[1]}` : "";
    return executable + subcommand;
  }).join("; ").slice(0, 256);
}

export function statusOutput(output) {
  return String(output).slice(0, 8192).split(/\r?\n/)
    .filter((line) => /^(?:\s*(?:PASS|FAIL|ok|not ok|Done|done|success|failed)\s*$|\s*(?:Tests|Test Files|# tests|# pass|# fail)\s*[: ]\s*[\d\s|()]+(?:passed|failed|skipped)?[\d\s|()]*)$/i.test(line))
    .join("\n").slice(0, 1024) || "[output omitted]";
}

const DETAIL_FIELDS = {
  open_workspace: ["path", "mode", "base_ref", "workspace_id"],
  read: ["path", "offset", "limit", "read_bytes"],
  show_changes: ["files", "additions", "removals"],
  write: ["path", "content_bytes", "lines"],
  edit: ["path", "edit_count", "old_bytes", "new_bytes"],
  bash: ["command_summary", "working_directory", "exit_code", "output"],
};

export function sanitizeEvent(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.schema_version !== 1
    || raw.event_type !== "tool.completed"
    || typeof raw.event_id !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw.event_id)
    || typeof raw.occurred_at !== "string" || raw.occurred_at.length > 40 || !Number.isFinite(Date.parse(raw.occurred_at))) {
    throw new Error("invalid_event_envelope");
  }
  const timestamp = raw.occurred_at;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(timestamp)
    || new Date(timestamp).toISOString() !== timestamp.replace(/(?:\.(\d{1,3}))?Z$/, (_, fraction) => `.${(fraction ?? "").padEnd(3, "0")}Z`)) {
    throw new Error("invalid_event_timestamp");
  }
  for (const key of ["machine_id", "workspace_id", "project", "cwd", "tool"]) {
    if (typeof raw[key] !== "string" || !raw[key].trim() || raw[key].length > 2048) throw new Error("invalid_event_fields");
  }
  for (const key of ["machine_id", "workspace_id"]) {
    if (raw[key].length > 128 || /[\x00-\x1f]/.test(raw[key])) throw new Error("invalid_session_identity");
  }
  const outcome = raw.outcome;
  if (!outcome || !["success", "failure"].includes(outcome.status)
    || typeof outcome.duration_ms !== "number" || !Number.isFinite(outcome.duration_ms) || outcome.duration_ms < 0) {
    throw new Error("invalid_event_outcome");
  }
  const event = {
    schema_version: 1,
    event_id: raw.event_id,
    event_type: "tool.completed",
    occurred_at: raw.occurred_at,
    machine_id: sessionIdentity(raw.machine_id),
    workspace_id: sessionIdentity(raw.workspace_id),
    project: redact(raw.project, 256),
    cwd: redact(raw.cwd),
    tool: redact(raw.tool, 128),
    outcome: { status: outcome.status, duration_ms: outcome.duration_ms },
  };
  const details = {};
  for (const field of DETAIL_FIELDS[raw.tool] ?? []) {
    const value = raw.details?.[field];
    if (typeof value === "string") details[field] = field === "command_summary" ? commandSummary(value)
      : field === "output" ? statusOutput(value) : redact(value);
    else if (typeof value === "number" && Number.isFinite(value)) details[field] = value;
  }
  if (Object.keys(details).length) event.details = details;
  return event;
}
