import { readFileSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createJevContextJudge, selectContext, type ContextDecision, type ContextJudge,
  type ContextKnowledge,
} from "../src/state/selective-context.js";

// Explicit opt-in only: the normal test suite must never spend API credits.
describe.runIf(process.env["AGENTMEMORY_LIVE_JEV_EVAL"] === "true")("live selective recall", () => {
  const facts = [
    ["command", "本測試專案的回歸測試命令是 npm run test:ledger-canary。"],
    ["filename", "本測試專案的審查報告預設檔名是 ledger-review.txt。"],
    ["ascii", "在 TUI／CLI 中呈現流程圖或架構圖時，必須使用純文字／ASCII，不得使用 Mermaid；TUI 不會渲染 Mermaid。"],
    ["git", "git pull 一律 merge，永遠不要 --rebase。"],
  ];
  const records: ContextKnowledge[] = facts.map(([id, text]) => ({
    id: id!, revision: "synthetic-1", status: "active",
    scope: { namespace: "live-eval" },
    evidence: { eventId: `fixture-${id}`, text: text!, adoptedAt: "2026-09-18T00:00:00.000Z" },
    spans: [{ id: "fact", text: text! }],
  }));
  // Freeze expected outcomes before a live run. These are synthetic data, not user memories.
  const cases: Array<{ name: string; prompt: string; previous?: string; expected: string[];
    conflict?: string; category?: ContextDecision["compatibility"] }> = [
    { name: "regression-command", prompt: "本測試專案的回歸測試命令是什麼？只回答命令；若沒有專案資訊，只回答 UNKNOWN。", expected: ["command"] },
    { name: "regression-filename", prompt: "本測試專案的審查報告預設檔名是什麼？只回答檔名；若沒有專案資訊，只回答 UNKNOWN。", expected: ["filename"] },
    { name: "explicit-filename", prompt: "這次審查報告請改用 draft.txt，別採用預設檔名。只回答這次應用的檔名。", expected: [], conflict: "filename" },
    { name: "explicit-git-exception", prompt: "本次例外：請用 git pull --rebase，這次不使用 merge。", expected: [], conflict: "git" },
    { name: "explicit-mermaid", prompt: "這次圖要貼到支援 Mermaid 的網頁，請提供 Mermaid 原始碼，不要 ASCII 圖。", expected: [], conflict: "ascii" },
    { name: "unrelated", prompt: "只回答 17 加 25 的結果。", expected: [] },
    { name: "already-supplied", prompt: "已知本測試專案的回歸測試命令是 npm run test:ledger-canary。請只重述該命令。", expected: [] },
    { name: "diagram", prompt: "請畫出接收訂單、檢查庫存、出貨三步驟的流程圖。", expected: ["ascii"] },
    { name: "holdout-json-value", prompt: "回覆 JSON：testCommand 欄位填本測試專案的回歸測試命令，找不到資訊才填 null。", expected: ["command"] },
    { name: "holdout-no-explanation", prompt: "本測試專案的審查報告預設叫什麼？只給檔名，不要解釋原因。", expected: ["filename"] },
    { name: "holdout-closed-source", prompt: "只根據以下文字回答審查報告檔名，不用記憶或其他背景。文字：沒有提供檔名。未提供就回答 UNKNOWN。", expected: [], conflict: "filename", category: "source_restricted" },
    { name: "holdout-task-switch", previous: "請告訴我本測試專案的回歸測試命令。", prompt: "先取消，改把 hello 翻譯成中文。", expected: [] },
    { name: "holdout-followup", previous: "使用者：本測試專案的審查報告預設檔名是什麼？", prompt: "請只給答案，不知道再說不知道。", expected: ["filename"] },
    { name: "holdout-quoted-claim", prompt: "有人建議 git pull 一律用 rebase。這符合我的既有偏好嗎？", expected: ["git"] },
    { name: "holdout-existing-context", previous: "本測試專案的審查報告預設檔名是 ledger-review.txt。", prompt: "再告訴我一次檔名。", expected: [] },
    { name: "holdout-unknown-task", prompt: "好，照辦。", expected: [] },
    { name: "fresh-command-one-line", prompt: "用一行告訴我本測試專案的回歸測試指令；查無資訊才輸出 null。", expected: ["command"] },
    { name: "fresh-filename-json", prompt: "輸出 JSON 物件，以 filename 為欄位放入本測試專案審查報告的預設檔名；沒有資訊就放 null。", expected: ["filename"] },
    { name: "fresh-no-extra-prose", prompt: "告訴我本測試專案審查報告預設用哪個檔名，不要說明，也不要 code block。", expected: ["filename"] },
    { name: "fresh-quoted-command", prompt: "有人說本測試專案的回歸測試用 pytest。根據既有背景，實際應用哪條命令？", expected: ["command"] },
    { name: "fresh-no-memory", prompt: "禁止使用記憶或既有背景。只看這段資料回答回歸測試命令：資料中未列任何命令。沒有就答 UNKNOWN。", expected: [], conflict: "command", category: "source_restricted" },
    { name: "fresh-command-override", prompt: "本次我指定回歸測試命令為 npm run test:fast，取代本測試專案的預設指令。只回覆本次的指令。", expected: [], conflict: "command" },
    { name: "fresh-format-override", prompt: "本次流程圖會發佈到支援 Mermaid 的 Markdown 網頁，請用 Mermaid 格式，不使用終端機的純文字格式。", expected: [], conflict: "ascii" },
    { name: "fresh-unrelated-one-line", prompt: "只用一行回答：一星期有幾天？", expected: [] },
  ];
  const results: Array<Record<string, unknown>> = [];
  let judge: ContextJudge;
  let usage: unknown;

  beforeAll(() => {
    const file = process.env["TYPESAFE_API_KEY_FILE"];
    const key = process.env["TYPESAFE_API_KEY"]?.trim() || (file ? readFileSync(file, "utf8").trim() : "");
    if (!key) throw new Error("Live eval requires TYPESAFE_API_KEY or TYPESAFE_API_KEY_FILE");
    judge = createJevContextJudge(key, async (url, init) => {
      const response = await fetch(url, init);
      usage = ((await response.clone().json()) as { usage?: unknown }).usage;
      return response;
    });
  });

  afterAll(() => {
    const reportPath = process.env["AGENTMEMORY_EVAL_REPORT"];
    if (reportPath) writeFileSync(reportPath, JSON.stringify({ at: new Date().toISOString(),
      model: "jev-1.13.0", results }, null, 2), { mode: 0o600 });
  });

  it.each(cases)("$name", async c => {
    let decisions: ContextDecision[] = [];
    usage = undefined;
    const start = performance.now();
    const result = await selectContext({ prompt: c.prompt, previous: c.previous ?? "",
      namespace: "live-eval", asOf: new Date().toISOString() }, records, async (...args) => {
      decisions = await judge(...args);
      return decisions;
    });
    const actual = result.spans.map(span => span.knowledgeId).sort();
    const compatibility = c.conflict ? decisions.find(d => d.knowledgeId === c.conflict)?.compatibility : undefined;
    const requiredCategory = c.category ?? "overridden";
    const passed = result.status !== "unavailable"
      && JSON.stringify(actual) === JSON.stringify([...c.expected].sort())
      && (!c.conflict || compatibility === requiredCategory);
    results.push({ ...c, actual, status: result.status, decisions, usage,
      ms: Math.round(performance.now() - start), passed });
    expect(result.status).not.toBe("unavailable");
    expect(actual).toEqual([...c.expected].sort());
    if (c.conflict) expect(compatibility).toBe(requiredCategory);
  });
});
