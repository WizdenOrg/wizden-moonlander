# Moon lander benchmark 2026-09-24T16-06-50

Started 2026-09-24T16:06:50.248Z, finished 2026-09-24T16:37:13.859Z. 160 decision probes (up to 40 per control), 16 missions × 150/300 ms = 32 flights per case. Seed 7. Threshold 0.5.

## laya

Latency (100 sequential guided calls after warm-up): client p50 244 ms, p95 325.1 ms; server inference p50 50.5 ms, p95 54.7 ms. Models: {"english":100}, device cuda. Failed: 0.

| Case | Decisions | 95% CI | Landings | 95% CI | Crash / off-pad / timeout / error | Mean touchdown vy | Retries |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Raw telemetry, one 4-way choice | 40/160 (25.0%) | 18.9%–32.2% | 0/32 | 0.0%–10.7% | 32 / 0 / 0 / 0 | — | 0 |
| Guided sentences, one 4-way choice (reconstructed) | 110/160 (68.8%) | 61.2%–75.4% | 0/32 | 0.0%–10.7% | 32 / 0 / 0 / 0 | — | 0 |
| Guided sentences, brake yes/no + sideways choice (reconstructed) | 160/160 (100.0%) | 97.7%–100.0% | 32/32 | 89.3%–100.0% | 0 / 0 / 0 / 0 | 2.51 | 0 |
| Guided sentences, three yes/no | 160/160 (100.0%) | 97.7%–100.0% | 32/32 | 89.3%–100.0% | 0 / 0 / 0 / 0 | 2.51 | 0 |
| Computed numbers + rule, no verdict (new) | 33/160 (20.6%) | 15.1%–27.6% | 0/32 | 0.0%–10.7% | 32 / 0 / 0 / 0 | — | 0 |
| Facts only | 40/160 (25.0%) | 18.9%–32.2% | 0/32 | 0.0%–10.7% | 32 / 0 / 0 / 0 | — | 0 |
| Facts only + formula briefing | 40/160 (25.0%) | 18.9%–32.2% | 0/32 | 0.0%–10.7% | 32 / 0 / 0 / 0 | — | 0 |
| Facts only + intent briefing | 40/160 (25.0%) | 18.9%–32.2% | 0/32 | 0.0%–10.7% | 32 / 0 / 0 / 0 | — | 0 |
| Facts only + braking table briefing | 40/160 (25.0%) | 18.9%–32.2% | 0/32 | 0.0%–10.7% | 32 / 0 / 0 / 0 | — | 0 |
| Facts only + flight rules briefing | 40/160 (25.0%) | 18.9%–32.2% | 0/32 | 0.0%–10.7% | 32 / 0 / 0 / 0 | — | 0 |

## jev

Latency (100 sequential guided calls after warm-up): client p50 258.5 ms, p95 305.4 ms. Models: {"jev-1.13.0":100}. Failed: 0.

| Case | Decisions | 95% CI | Landings | 95% CI | Crash / off-pad / timeout / error | Mean touchdown vy | Retries |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Raw telemetry, one 4-way choice | 51/160 (31.9%) | 25.1%–39.5% | 0/32 | 0.0%–10.7% | 32 / 0 / 0 / 0 | — | 0 |
| Guided sentences, one 4-way choice (reconstructed) | 160/160 (100.0%) | 97.7%–100.0% | 32/32 | 89.3%–100.0% | 0 / 0 / 0 / 0 | 2.51 | 0 |
| Guided sentences, brake yes/no + sideways choice (reconstructed) | 160/160 (100.0%) | 97.7%–100.0% | 32/32 | 89.3%–100.0% | 0 / 0 / 0 / 0 | 2.51 | 0 |
| Guided sentences, three yes/no | 160/160 (100.0%) | 97.7%–100.0% | 32/32 | 89.3%–100.0% | 0 / 0 / 0 / 0 | 2.51 | 0 |
| Computed numbers + rule, no verdict (new) | 128/160 (80.0%) | 73.1%–85.5% | 32/32 | 89.3%–100.0% | 0 / 0 / 0 / 0 | 2.51 | 0 |
| Facts only | 40/160 (25.0%) | 18.9%–32.2% | 0/32 | 0.0%–10.7% | 32 / 0 / 0 / 0 | — | 0 |
| Facts only + formula briefing | 41/160 (25.6%) | 19.5%–32.9% | 0/32 | 0.0%–10.7% | 32 / 0 / 0 / 0 | — | 0 |
| Facts only + intent briefing | 42/160 (26.3%) | 20.1%–33.6% | 0/32 | 0.0%–10.7% | 32 / 0 / 0 / 0 | — | 0 |
| Facts only + braking table briefing | 70/160 (43.8%) | 36.3%–51.5% | 4/32 | 5.0%–28.1% | 28 / 0 / 0 / 0 | 2.9 | 0 |
| Facts only + flight rules briefing | 85/160 (53.1%) | 45.4%–60.7% | 22/32 | 51.4%–82.0% | 9 / 1 / 0 / 0 | 2.53 | 0 |
