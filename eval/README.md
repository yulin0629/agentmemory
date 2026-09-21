# agentmemory-evals

Public benchmarks for agentmemory's hybrid memory stack (BM25 + embeddings + consolidation + graph).

Two retrieval benchmark families, both reproducible:

- **LongMemEval** — public 500-question retrieval benchmark over multi-session chat
- **coding-agent-life-v1** — in-house corpus of 15 fictional Claude Code sessions for a Rust CLI project (`shipctl`), with 15 hand-graded queries covering bug fixes, refactors, preferences, and multi-session causal reasoning

An opt-in selective-recall check separately tests whether Jev chooses useful, permitted background without repeating information or overriding the current request.

## Adapters

| Adapter | Backend | API key needed |
|---|---|---|
| `grep` | Tokenized substring match | none |
| `vector` | OpenAI `text-embedding-3-small` + cosine | `OPENAI_API_KEY` |
| `agentmemory` | Running agentmemory server, smart-search endpoint | none (auth optional via `AGENTMEMORY_SECRET`) |

## Sandbox first

Running the `agentmemory` adapter against your real `~/.agentmemory` directory pollutes the eval with pre-existing memories AND pollutes your real store with eval test data. Always sandbox.

`eval/scripts/sandbox.sh` spins up a clean agentmemory + iii-engine on ports 3411/3412 with state in `/tmp/agentmemory-eval-sandbox/`, exports `AGENTMEMORY_BASE_URL`, and tears down on exit.

```sh
source eval/scripts/sandbox.sh
npm run eval:coding-life -- --adapters grep,agentmemory
```

Requires iii v0.11.2 on PATH (agentmemory pin). If you already have a different version installed, install the pinned build into `~/.local/bin` and make sure that directory comes first on `PATH`:

```sh
mkdir -p ~/.local/bin
curl -fsSL https://github.com/iii-hq/iii/releases/download/iii/v0.11.2/iii-aarch64-apple-darwin.tar.gz | tar -xz -C ~/.local/bin
export PATH="$HOME/.local/bin:$PATH"  # add to ~/.zshrc or ~/.bashrc for persistence
```

## Quickstart

### Selective recall (synthetic fixtures, paid Jev calls)

The 24 cases in `test/selective-context-live.test.ts` require explicit opt-in and use no running agentmemory server or persistent memory store. Normal `npm test` skips these calls. They cover answer-only formatting, missing-information fallbacks, explicit overrides, restricted sources, continuations, and irrelevant or repeated background. Compatibility is a categorical decision: only `compatible` passes; `overridden`, `source_restricted`, and `unclear` remain silent. Relevance still requires 0.7.

```sh
AGENTMEMORY_LIVE_JEV_EVAL=true \
TYPESAFE_API_KEY_FILE=/path/to/key \
AGENTMEMORY_EVAL_REPORT=/tmp/selective-recall-results.json \
npm test -- --run test/selective-context-live.test.ts
```

An existing `TYPESAFE_API_KEY` can replace the key-file setting. The optional report includes decisions, latency, API token usage, and expected versus actual selections. Passing this small corpus does not establish production reliability or prove that a harness delivers the selected context to its model.

### coding-agent-life-v1 (in-house, no download)

```sh
# grep baseline, no sandbox needed
npm run eval:coding-life -- --adapters grep

# add agentmemory + vector (sandbox + OpenAI key)
source eval/scripts/sandbox.sh
OPENAI_API_KEY=sk-... npm run eval:coding-life -- --adapters grep,vector,agentmemory
```

### LongMemEval `_s` (public, 278MB download)

```sh
mkdir -p ~/datasets/longmemeval
curl -Lo ~/datasets/longmemeval/longmemeval_s.json \
  https://huggingface.co/datasets/xiaowu0162/longmemeval/resolve/main/longmemeval_s

source eval/scripts/sandbox.sh

# Stratified sample of 10 per type (fast iteration, ~$0.20 OpenAI cost)
OPENAI_API_KEY=sk-... LONGMEMEVAL_PATH=~/datasets/longmemeval/longmemeval_s.json \
  npm run eval:longmemeval -- --stratify 10

# Full 500 questions × 3 adapters (~$2 OpenAI cost)
OPENAI_API_KEY=sk-... LONGMEMEVAL_PATH=~/datasets/longmemeval/longmemeval_s.json \
  npm run eval:longmemeval
```

## Repo layout

```text
eval/
├── README.md
├── runner/
│   ├── types.ts                   Adapter, Question, RankedDoc, ScoreRow
│   ├── score.ts                   P@K, R@K, aggregation
│   ├── load.ts                    LongMemEval JSON → Question[]
│   ├── adapters/
│   │   ├── grep.ts                tokenized substring baseline
│   │   ├── vector.ts              OpenAI embeddings + cosine
│   │   └── agentmemory.ts         POST /agentmemory/{remember,smart-search}
│   ├── longmemeval.ts             public benchmark runner
│   └── coding-life.ts             in-house benchmark runner
└── data/
    └── coding-agent-life-v1/
        ├── sessions.json          15 fictional sessions (~6KB)
        └── queries.json           15 queries with gold session IDs
```

Reports land in `eval/reports/<bench>/` (gitignored): `scores.ndjson` + `summary.json`.

Published scorecards land in `docs/benchmarks/YYYY-MM-DD-<bench>.md`.

## Writing a new adapter

1. Implement `Adapter<State>` from `eval/runner/types.ts`:
   ```ts
   import type { Adapter } from "../types.js";
   export const myAdapter: Adapter<MyState> = {
     name: "my-adapter",
     async init(sessions, config) { /* index */ return state; },
     async query(q, state, k) { /* search */ return ranked; },
   };
   ```
2. Register in `eval/runner/{longmemeval,coding-life}.ts` `ADAPTERS` map.
3. Run against `coding-agent-life-v1` to sanity-check before committing OpenAI spend on LongMemEval.

## Why a benchmark for agentmemory

agentmemory ships BM25 + embeddings + consolidation + graph retrieval. Numbers from those layers should be measured against grep/vector baselines so the value of each layer is provable.

The in-house corpus is small on purpose (15 sessions) — covers single-session, multi-session, preference, and temporal question types without taking 15 minutes to run. LongMemEval gives the public-comparison axis.
