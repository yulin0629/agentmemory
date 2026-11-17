# Judge eval

50 hand-labelled zh-TW prompts against a pool of 30 lessons, 10 candidates each.
`run.mts` calls both recall judges once per case and stores raw per-slot scores;
`analyze.py` sweeps the `useful` threshold offline (even cases tune, odd cases hold out).

```sh
npx tsx scripts/judge-eval/run.mts /path/to/outdir   # copy dataset.json there first
python3 scripts/judge-eval/analyze.py /path/to/outdir
```

Keys come from `~/.agentmemory/.env` (TYPESAFE_API_KEY, and OPENAI_DECISIONS_KEY_FILE or OPENAI_DECISIONS_API_KEY).
One run is 50 TypeSafe calls and 50 Decisions calls (about USD 0.02 for Decisions).
Labels: `[prompt, previous, must, ok]`; lesson 3 (reply language) is allowed everywhere
except the case that asks for English.

Results at useful >= 0.7 (compatible, adds), exact cases out of 50:

- TypeSafe, 2026-11-17, jev-1.14.0, two runs: 43 and 43 (37/42 wanted lessons, 3 extra picks, median 240 ms),
  2692 input tokens per call. The per-candidate guidance is sent once in `state.rubric`, because Jev bills
  state once and each question separately. With the guidance repeated in every question the same two runs
  gave 38 and 39 (32 and 33 of 42, 2 extra picks) at 5747 input tokens per call.
- Decisions, 2026-11-08: 35 (35/42, 16 extra picks, median 541 ms, max 1000 ms). It still gets the full
  questions. A separate Decisions threshold did not help: best on tune (0.8) gave 13/25 on holdout, same as 0.7.
