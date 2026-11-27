import { readFileSync } from "node:fs";

/**
 * Orders Gemini embedding calls over the keys in an agent.env-style file
 * (GEMINI_API_KEY plus GEMINI_API_KEY_<LABEL>), the same file and parse rule
 * as the gemini-api-access skill's run.py. The preferred label answers while
 * it works; a key that is refused or over its quota is skipped for a while
 * and the next one answers.
 */
export interface GeminiKey {
  label: string;
  key: string;
}

export interface GeminiKeyPool {
  /** Keys to try for one request, best first. */
  order(): GeminiKey[];
  /** Skip this key for ten minutes. */
  cool(key: string): void;
}

const KEY_NAME = /^GEMINI_API_KEY(?:_([A-Z0-9_]+))?$/;
// debt: one cooldown for a per-minute rate limit and a spent budget alike.
// ceiling: a key over its budget is asked again every ten minutes;
// upgrade: tell the two 429s apart once those extra calls matter.
const COOL_MS = 600_000;

/** True when another key may still answer: this one is invalid, refused, unpaid, or over its quota or rate limit. */
export function isGeminiKeyFailure(status: number, body: string): boolean {
  return status === 401 || status === 402 || status === 403 || status === 429
    || (status === 400 && body.includes("API_KEY_INVALID"));
}

function readKeys(file: string): GeminiKey[] {
  const keys = new Map<string, string>();
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];  // unreadable: the caller's single key still answers
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    const match = KEY_NAME.exec(line.slice(0, eq).trim());
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (eq < 0 || !match || !/^[A-Za-z0-9_.-]{30,}$/.test(value)) continue;
    const label = (match[1] ?? "DEFAULT").toLowerCase();
    if (!keys.has(label)) keys.set(label, value);
  }
  return [...keys].map(([label, key]) => ({ label, key }));
}

/**
 * `prefer` is the label asked first. `single` is the key from GEMINI_API_KEY:
 * it goes last unless the file already holds it.
 */
export function createGeminiKeyPool(file: string, prefer: string, single: string, now: () => number = Date.now): GeminiKeyPool {
  const cooled = new Map<string, number>();
  const first = prefer.trim().toLowerCase();
  return {
    order() {
      const keys = readKeys(file);  // re-read so a rotated file needs no restart
      keys.sort((a, b) => Number(b.label === first) - Number(a.label === first));
      if (single && !keys.some(({ key }) => key === single)) keys.push({ label: "GEMINI_API_KEY", key: single });
      if (!keys.length) throw new Error("GEMINI_API_KEY_FILE holds no valid GEMINI_API_KEY and GEMINI_API_KEY is not set");
      const t = now();
      const usable = keys.filter(({ key }) => (cooled.get(key) ?? 0) <= t);
      return usable.length ? usable : keys;  // every key skipped: ask them all rather than fail unasked
    },
    cool(key) { cooled.set(key, now() + COOL_MS); },
  };
}
