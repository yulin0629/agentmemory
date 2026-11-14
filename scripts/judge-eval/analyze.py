import json, sys, statistics
d = sys.argv[1]
cases = json.load(open(f"{d}/dataset.json"))["cases"]
rows = [json.loads(l) for l in open(f"{d}/raw.jsonl")]
EN = next(i for i, c in enumerate(cases) if c[0].startswith("用英文回答"))
def score(judge, t, idx):
    exact = hit = must = fp = 0
    for r in rows:
        if r["judge"] != judge or r["case"] not in idx: continue
        _, _, m, ok = cases[r["case"]]
        allowed = set(m) | set(ok) | (set() if r["case"] == EN else {3})
        picked = {s["lesson"] for s in r["slots"] if s["useful"] >= t and s["compatibility"] == "compatible" and s["addition"] == "adds"}
        h = len(set(m) & picked); f = len(picked - allowed)
        hit += h; must += len(m); fp += f; exact += (h == len(m) and f == 0)
    return exact, hit, must, fp
tune = set(range(0, 50, 2)); hold = set(range(1, 50, 2)); full = tune | hold
ts = [round(0.30 + 0.05 * i, 2) for i in range(14)]
for judge in ("typesafe", "decisions"):
    ms = sorted(r["ms"] for r in rows if r["judge"] == judge)
    print(f"\n== {judge}  latency median {ms[len(ms)//2]} ms, p90 {ms[int(len(ms)*.9)]} ms, max {ms[-1]} ms")
    print("  t    tune(exact/25 hit fp)   holdout(exact/25 hit fp)   all(exact/50)")
    for t in ts:
        a = score(judge, t, tune); b = score(judge, t, hold); c = score(judge, t, full)
        mark = " <- current" if t == 0.7 else ""
        print(f"  {t:.2f}  {a[0]:2d}  {a[1]}/{a[2]} {a[3]:2d}          {b[0]:2d}  {b[1]}/{b[2]} {b[3]:2d}           {c[0]:2d}{mark}")
    best = max(ts, key=lambda t: (score(judge, t, tune)[0], -abs(t - 0.7)))
    print(f"  best on tune: t={best}  holdout exact {score(judge, best, hold)[0]}/25 vs t=0.7 {score(judge, 0.7, hold)[0]}/25")
