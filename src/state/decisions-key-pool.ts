import { readFileSync } from "node:fs";

/**
 * Rotates Decisions calls over the OpenAI org keys in an agent.env-style file
 * (OPENAI_API_KEY plus OPENAI_API_KEY_<LABEL>), the same file and parse rule as
 * the openai-api-access skill's run.py and agent-hooks. Labels that run.py
 * benched in its keys.json state are skipped; that file is read, never written.
 */
export interface DecisionsKeyPool {
  /** Keys to try for one request, best first. */
  order(): string[];
  /** Skip this key for an hour: no credit, or the org refused it. */
  cool(key: string): void;
}

const KEY_NAME = /^OPENAI_API_KEY(?:_([A-Z0-9_]+))?$/;
const NO_CREDIT = /credit_balance_exhausted|insufficient_quota/;
const COOL_MS = 3_600_000;

/** True when another org's key may still answer: auth refused, or credit spent. */
export function isKeyFailure(status: number, body: string): boolean {
  return status === 401 || status === 403 || (status === 429 && NO_CREDIT.test(body));
}

function readKeys(file: string): Array<{ label: string; key: string }> {
  const keys = new Map<string, string>();
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    const match = KEY_NAME.exec(line.slice(0, eq).trim());
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (eq < 0 || !match || !/^sk-[A-Za-z0-9_-]+$/.test(value)) continue;
    const label = (match[1] ?? "DEFAULT").toLowerCase();
    if (!keys.has(label)) keys.set(label, value);
  }
  if (!keys.size) throw new Error("Decisions key file has no valid OPENAI_API_KEY");
  return [...keys].map(([label, key]) => ({ label, key }));
}

function benchedLabels(stateFile: string, now: number): Set<string> {
  try {
    const accounts = JSON.parse(readFileSync(stateFile, "utf8"))?.accounts ?? {};
    return new Set(Object.entries(accounts as Record<string, { benched_until?: unknown }>)
      .filter(([, record]) => typeof record?.benched_until === "number" && record.benched_until * 1000 > now)
      .map(([label]) => label));
  } catch {
    return new Set();  // no state yet, or unreadable: nothing is benched
  }
}

export function createDecisionsKeyPool(file: string, stateFile: string, now: () => number = Date.now): DecisionsKeyPool {
  const cooled = new Map<string, number>();
  let next = 0;
  return {
    order() {
      const keys = readKeys(file);  // re-read so a rotated file needs no restart
      const t = now();
      const benched = benchedLabels(stateFile, t);
      const usable = keys.filter(({ label, key }) => !benched.has(label) && (cooled.get(key) ?? 0) <= t);
      const list = usable.length ? usable : keys;  // every key skipped: try them all rather than fail unasked
      const start = next++ % list.length;
      return [...list.slice(start), ...list.slice(0, start)].map(({ key }) => key);
    },
    cool(key) { cooled.set(key, now() + COOL_MS); },
  };
}

const shared = new Map<string, DecisionsKeyPool>();

/** One pool per file, so the recall and capture judges share cooldowns and rotation. */
export function sharedDecisionsKeyPool(file: string, stateFile: string): DecisionsKeyPool {
  const id = `${file}\0${stateFile}`;
  if (!shared.has(id)) shared.set(id, createDecisionsKeyPool(file, stateFile));
  return shared.get(id)!;
}
