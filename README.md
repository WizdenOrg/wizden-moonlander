# Wizden Moon Lander

A lunar lander flown by typed-decision models. Every half second of flight, the craft's state goes to a model — [Laya](https://github.com/NandhaKishorM/laya) or JEV — as three yes/no questions, and the answers become the next maneuver. Run batches of missions with random landing zones, fly both models side by side on identical missions, and see exactly what each model was asked and how it answered.

It is also a small, honest experiment in *who does the reasoning*: a **guided** prompt where the app states what the physics requires, versus a **facts-only** prompt where the model has to work it out.

![Campaign board: six missions, each with its flight path, touchdown numbers and action mix](docs/campaign.png)

| Soft landing | Guided vs facts only, same flight state |
| --- | --- |
| ![A soft landing on the pad with confetti](docs/landing.png) | ![The tech specification comparing guided and facts-only inputs](docs/guided-vs-facts.png) |

## Quick start

Requires Node.js 18 or later. No dependencies.

```sh
git clone https://github.com/<owner>/wizden-moonlander.git
cd wizden-moonlander
npm start
```

Open <http://localhost:3030>, enter a model's credentials in the top bar, and press **START**.

You need access to at least one model:

- **Laya**: any endpoint that serves Laya's typed-decision API (`POST /v1/decisions`, `X-API-Key` header). The quickest way is [`laya-service/colab_laya_service.py`](laya-service/colab_laya_service.py): run it in a Google Colab T4 runtime, and it prints a temporary public URL and an API token to paste into the top bar.
- **JEV**: a Typesafe API key (`https://api.typesafe.ai/v1/systemone`, model `jev-latest`).

Keys are stored in your browser only and sent only to the local server, which forwards them to the model and strips them from every response.

## What you can do

- **Campaigns**: fly 1–100 missions back to back. Each mission has a random pad and a launch point 150–600 m from it. The board shows a success ring, averages, the action mix, and one card per mission with the flight path over that mission's terrain. Results persist in the browser, and finished campaigns are archived.
- **Side by side**: Laya and JEV fly the identical mission in two panes, and the board compares them.
- **Speed**: 1× to MAX. Above 1× the simulation waits for each answer, then fast-forwards, so results do not depend on speed. Playback is decoupled and interpolated, so it stays smooth. The real speed is capped by model latency.
- **Prompt mode**: guided or facts only (see below), fixed per campaign and recorded with its results.
- **Mission briefing** (facts only): optional rules sent with every decision, with clickable examples and their measured results.
- **Tech specification**: a collapsible section at the bottom with the real inputs for six example situations in both modes. It includes the exact request bodies, a button that asks the models live, the flight rules, and measured results.
- **Outcomes**: a soft landing on the pad counts as success (confetti). A soft landing elsewhere is an intact off-pad landing, which does not count. Anything harder is a crash (explosion).
- **Manual mode**: switch off the autopilot and fly it yourself (W/Space thrust, A/D yaw).

## How a decision is made

1. The browser simulates the flight (`public/lander-physics.js`) and takes a snapshot every 480 ms of flight time.
2. The local relay (`server.js`) validates the snapshot and builds the request (`src/lander-adapter.js`).
3. The snapshot becomes two short texts, vertical and sideways, and three yes/no questions: *brake now? push right? push left?*
4. The model scores each question from 0 to 1. Braking wins at ≥ 0.5; otherwise the stronger sideways answer at ≥ 0.5; otherwise coast.
5. The craft flies that maneuver until the next answer. Maneuvers use attitude hold, as in a real lander. Translation burns tilt to ±0.5 rad. The brake throttles down near 2.5 m/s, so it cannot climb, and it leans slightly against sideways drift.

Both models receive byte-identical state and questions; only the endpoint, auth header and model name differ.

## Guided vs facts only

| | Guided | Facts only |
| --- | --- | --- |
| Who does the physics | The app's flight director (`src/lander-guidance.js`): stopping distance, target sideways speed, when to brake | The model, from measurements and the briefing's rules |
| Example text | "DANGER: descending too fast. Falling at 14 m/s needs about 100 m to stop, but only 63 m of altitude remain. The engine must brake now." | "Altitude above the ground: 63 m. Vertical speed: falling at 14.0 m/s. Gravity adds 1.62 m/s … A braking burn removes about 3.2 m/s … Safe touchdown requires a downward speed below 4.5 m/s." |
| The model's job | Confirm the stated conclusion | Work out the decision |

Measured results (decisions: agreement with the flight plan on 120–160 labelled states; landings: missions flown in the headless simulator):

| Prompt | Laya decisions | Laya landings | JEV decisions | JEV landings |
| --- | --- | --- | --- | --- |
| Raw telemetry numbers, one 4-way choice | 28% | 0/12 | 33% | — |
| Guided | 100% | 31/32 | 100% | 32/32 |
| Facts only, no briefing | — | — | 25% | 0/6 |
| Facts only + "Flight rules" briefing | — | — | — | 14/20 |

With raw numbers, both models pick one direction for almost every state. With facts only and no briefing, JEV brakes in every state and hovers until the fuel runs out. Its brake scores rise with danger but stay above the threshold. Briefings written as lookup tables ("falling 20 m/s: brake below 220 m") work where formulas and plain intent do not. The "Flight rules" example also says "brake if altitude is below 50 m", which gives soft touchdowns. A dash means not measured.

## Tests and evaluation

```sh
npm test                                                   # offline: physics, guidance, request contract, relay, closed-loop flights vs a fake model
LAYA_URL=... LAYA_TOKEN=... JEV_KEY=... npm run test:live   # live acceptance per configured model (others are skipped)
JEV_KEY=... npm run eval:lander -- --provider jev --variants binary,facts --random 10
```

`scripts/lander-eval.js` flies the headless simulator (`src/lander-sim.js`) against a live model. It reports per-decision accuracy (confusion matrix, per-reason hit rate) and closed-loop landings, and saves JSON reports to `eval-results/`. Options include `--provider laya|jev`, `--variants`, `--briefing "..."`, `--random N --seed S`, `--latency 150,300`, and `--probes-only` / `--flights-only`.

## Project layout

```
public/            browser app: game, campaign board, shared flight model (lander-physics.js)
src/               relay-side logic: request building and providers, flight director, headless simulator
server.js          static files, tech-spec data, decision relay
scripts/           live evaluation
test/              offline suite and live acceptance suite
laya-service/      Colab script that serves Laya with a temporary public URL
```

## Security notes

- The server listens on `127.0.0.1` by default. The relay forwards requests to whatever Laya endpoint the page supplies, so only set `HOST=0.0.0.0` on a trusted network.
- API keys live in the browser's local storage. Use a private profile on shared machines, and **FORGET** in the top bar clears them.
- The Colab service generates a fresh API token each run; its tunnel URL is public while the cell runs.

## Configuration

See [`.env.example`](.env.example): `PORT` (default 3030) and `HOST` (default 127.0.0.1). Model credentials are entered in the page, not in environment variables. The environment variables are used only by the command-line tests and evaluation.

## License

[MIT](LICENSE) © 2026 Wizden. Laya and JEV are separate projects with their own terms.
