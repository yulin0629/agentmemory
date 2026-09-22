import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function selectiveSettings(): { enabled: boolean; url: string; secret: string; owner?: string } {
  let local: { enabled?: boolean; url?: string; secret?: string; owner?: string } = {};
  try {
    local = JSON.parse(readFileSync(join(homedir(), ".config", "agentmemory", "selective-context.json"), "utf8"));
  } catch { /* No local opt-in. */ }
  return {
    enabled: process.env.AGENTMEMORY_SELECTIVE_CONTEXT_INJECT !== undefined
      ? process.env.AGENTMEMORY_SELECTIVE_CONTEXT_INJECT === "true" : local?.enabled === true,
    url: process.env.AGENTMEMORY_URL || local?.url || "http://localhost:3111",
    secret: process.env.AGENTMEMORY_SECRET || local?.secret || "",
    owner: local?.owner,
  };
}
