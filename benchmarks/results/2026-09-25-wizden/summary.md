# Wizden decision fixtures: Laya vs JEV

Laya run 2026-09-25T13:13Z (Laya 0.3.5, `english` checkpoint forced, Colab T4 GPU). JEV run 2026-09-25T13:03Z (`jev-latest` → `jev-1.13.0`).
Same fixtures, same contracts and state preparation for both models; zero-shot; each fixture set run 3 times, the pilot 30 times.
Aggregates only: the fixtures are internal (synthetic plus four redacted staging-derived cases) and are not published.

| Set (5 decision types: triage, message quality, prompt injection, model routing, tool routing) | Laya | JEV | Laya stable | JEV stable |
| --- | --- | --- | --- | --- |
| 29 dev cases, generic category wording | 19/29 (65.5%) | 29/29 (100.0%) | 29/29 | 29/29 |
| 29 dev cases, Wizden-specific category wording | 26/29 (89.7%) | 29/29 (100.0%) | 29/29 | 29/29 |
| 29 dev cases, + features computed in code | 29/29 (100.0%) | 29/29 (100.0%) | 29/29 | 29/29 |
| Holdout v1, 16 cases | 16/16 (100.0%) | 16/16 (100.0%) | 16/16 | 16/16 |
| Holdout v2, 16 cases | 16/16 (100.0%) | 16/16 (100.0%) | 16/16 | 16/16 |
| Triage pilot, 20 cases × 30 repeats | 570/600 (95.0%) | 600/600 (100.0%) | 20/20 | 20/20 |

Per decision type (first run):

| Set | Laya | JEV |
| --- | --- | --- |
| 29 dev cases, generic category wording | triage route 6/8, message quality 1/5, prompt injection 4/5, model routing 2/5, tool routing 6/6 | triage route 8/8, message quality 5/5, prompt injection 5/5, model routing 5/5, tool routing 6/6 |
| 29 dev cases, Wizden-specific category wording | triage route 8/8, message quality 4/5, prompt injection 4/5, model routing 4/5, tool routing 6/6 | triage route 8/8, message quality 5/5, prompt injection 5/5, model routing 5/5, tool routing 6/6 |
| 29 dev cases, + features computed in code | triage route 8/8, message quality 5/5, prompt injection 5/5, model routing 5/5, tool routing 6/6 | triage route 8/8, message quality 5/5, prompt injection 5/5, model routing 5/5, tool routing 6/6 |
| Holdout v1, 16 cases | triage route 4/4, message quality 3/3, prompt injection 3/3, model routing 3/3, tool routing 3/3 | triage route 4/4, message quality 3/3, prompt injection 3/3, model routing 3/3, tool routing 3/3 |
| Holdout v2, 16 cases | triage route 4/4, message quality 3/3, prompt injection 3/3, model routing 3/3, tool routing 3/3 | triage route 4/4, message quality 3/3, prompt injection 3/3, model routing 3/3, tool routing 3/3 |

Round trip per call from the same client script (new HTTPS connection per call): Laya p50 268.7 ms / p95 350.4 ms (via Cloudflare tunnel); JEV p50 654.0 ms / p95 759.6 ms. With connection reuse, the lander benchmark measured 244 ms (Laya) and 258 ms (JEV) p50.

Note on the Arabic message-quality case: an earlier run with Laya's automatic routing sent it to the `multilingual` checkpoint, which classified it as unusable (confidence 0.846). Forced to `english`, as here, Laya answers meaningful with confidence 0.118.
