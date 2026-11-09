import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDecisionsCaptureJudge } from "../src/state/explicit-memory.js";
import { createDecisionsKeyPool } from "../src/state/decisions-key-pool.js";

vi.mock("../src/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const ok = () => new Response(JSON.stringify({ answers: [{ type: "choice", name: "disposition", choice: "task_only" }] }));
const noCredit = () => new Response(JSON.stringify({ error: { code: "insufficient_quota" } }), { status: 429 });

function setup(env: string, benched: Record<string, number> = {}, now = 1_000_000_000_000) {
  const dir = mkdtempSync(join(tmpdir(), "decisions-pool-"));
  writeFileSync(join(dir, "agent.env"), env);
  writeFileSync(join(dir, "keys.json"), JSON.stringify({ accounts: Object.fromEntries(
    Object.entries(benched).map(([label, until]) => [label, { benched_until: until }])), next: 0 }));
  let clock = now;
  const pool = createDecisionsKeyPool(join(dir, "agent.env"), join(dir, "keys.json"), () => clock);
  const used: string[] = [];
  const judge = (respond: (key: string) => Response) => createDecisionsCaptureJudge({
    keyPool: pool, model: "gpt-6-luna", baseUrl: "https://api.openai.com/v1",
    fetch: (async (_url: string, init: RequestInit) => {
      const key = String((init.headers as Record<string, string>).Authorization).replace("Bearer ", "");
      used.push(key);
      return respond(key);
    }) as unknown as typeof fetch,
  })("記住：x", [], new AbortController().signal);
  return { judge, used, advance: (ms: number) => { clock += ms; } };
}

const ENV = "OPENAI_API_KEY=sk-a\nOPENAI_BASE_URL=https://api.openai.com/v1\n# note\nOPENAI_API_KEY_ORG2=sk-b\nOPENAI_API_KEY_ORG3=\"sk-c\"\n";

describe("Decisions org key pool", () => {
  it("moves to the next org key when one is out of credit, and skips it on later calls", async () => {
    const { judge, used } = setup(ENV);
    await expect(judge(key => key === "sk-a" ? noCredit() : ok())).resolves.toBe("task_only");
    expect(used).toEqual(["sk-a", "sk-b"]);
    used.length = 0;
    await judge(() => ok()); await judge(() => ok());
    expect(used).not.toContain("sk-a");
  });

  it("does not switch keys on a plain rate limit or a server error", async () => {
    const { judge, used } = setup(ENV);
    await expect(judge(() => new Response(JSON.stringify({ error: { code: "rate_limit_exceeded" } }), { status: 429 })))
      .rejects.toThrow(/429/);
    await expect(judge(() => new Response("", { status: 503 }))).rejects.toThrow(/503/);
    expect(used).toHaveLength(2);
  });

  it("skips labels benched in run.py state until the bench ends", async () => {
    const now = 1_000_000_000_000;
    const { judge, used, advance } = setup(ENV, { default: now / 1000 + 60, org2: now / 1000 + 60 }, now);
    await judge(() => ok()); await judge(() => ok());
    expect(used).toEqual(["sk-c", "sk-c"]);
    advance(61_000); used.length = 0;
    await judge(() => ok()); await judge(() => ok()); await judge(() => ok());
    expect(new Set(used)).toEqual(new Set(["sk-a", "sk-b", "sk-c"]));
  });

  it("tries every key when all are benched, and fails only after the last one", async () => {
    const now = 1_000_000_000_000;
    const { judge, used } = setup(ENV, { default: now / 1000 + 60, org2: now / 1000 + 60, org3: now / 1000 + 60 }, now);
    await expect(judge(() => noCredit())).rejects.toThrow(/429/);
    expect(new Set(used)).toEqual(new Set(["sk-a", "sk-b", "sk-c"]));
  });
});
