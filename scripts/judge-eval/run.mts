// Runs both judges once per case and stores raw per-slot scores; thresholds are swept offline.
import { createDecisionsContextJudge, createJevContextJudge } from "../../src/state/selective-context.ts";
import { readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { createDecisionsKeyPool } from "../../src/state/decisions-key-pool.ts";
const dir = process.argv[2];
const env = Object.fromEntries(readFileSync(`${process.env.HOME}/.agentmemory/.env`,"utf8").split("\n").filter(l=>/^[A-Z_]+=/.test(l)).map(l=>[l.slice(0,l.indexOf("=")), l.slice(l.indexOf("=")+1)]));
const { lessons, cases } = JSON.parse(readFileSync(`${dir}/dataset.json`, "utf8"));
let seed = 42; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const judges: Record<string, any> = {
  typesafe: createJevContextJudge(env.TYPESAFE_API_KEY, env.TYPESAFE_MODEL || "jev-preview"),
  decisions: createDecisionsContextJudge({ model: "gpt-6-luna", baseUrl: "https://api.openai.com/v1", apiKey: env.OPENAI_DECISIONS_API_KEY,
    keyPool: env.OPENAI_DECISIONS_KEY_FILE ? createDecisionsKeyPool(env.OPENAI_DECISIONS_KEY_FILE, `${process.env.HOME}/.local/state/openai-api-access/keys.json`) : undefined }),
};
const out = `${dir}/raw.jsonl`; writeFileSync(out, "");
for (const [ci, [prompt, previous, must, ok]] of cases.entries()) {
  const ids = new Set<number>([...must, ...ok]);
  while (ids.size < 10) ids.add(Math.floor(rnd() * lessons.length));
  const order = [...ids].sort(() => rnd() - 0.5);
  const cands = order.map(i => ({ id:`k${i}`, revision:"r1", status:"active", scope:{namespace:"ns"},
    evidence:{eventId:`e${i}`, text:lessons[i], adoptedAt:"2026-11-01T00:00:00Z"}, spans:[{ id:`L${i}`, text:lessons[i] }] }));
  for (const [name, j] of Object.entries(judges)) {
    const t0 = Date.now(); let slots: any[] = [], error: string | undefined;
    try {
      const d = await j({ prompt, previous, namespace:"ns", asOf:"2026-11-08T00:00:00Z" }, cands, AbortSignal.timeout(15000));
      slots = d.map((x: any) => ({ lesson: Number(x.spanId.slice(1)), useful: x.useful, compatibility: x.compatibility, addition: x.addition }));
    } catch (e) { error = String(e).slice(0, 200); }
    appendFileSync(out, JSON.stringify({ case: ci, judge: name, ms: Date.now() - t0, error, slots }) + "\n");
  }
  process.stdout.write(".");
}
console.log(" done");
