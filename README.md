# Synt Eel — AI farm assistant for eel nurseries

> Built for the **Meta Global AI Developer Hackathon** (Oct 26 – Nov 4, 2026) · Track: **Indie** · Theme: **Build for Your World**

🌐 Synt Eel website: **[eel.synt.fun](https://eel.synt.fun)**

📱 Try the app: **[eel.synt.fun/preview](https://eel.synt.fun/preview/)** (demo farm, reset every night; photo, voice and video capture read by Meta Muse models, with a daily demo quota)

Eel farmers in Indonesia lose whole batches of glass eels and elvers overnight. The fish are fragile, the water can turn in a few hours, and most farmers keep track of their ponds from memory. By the time anyone notices, it is too late to act.

Synt Eel is a mobile app that closes that gap:

- **Record (Catat)**: the farmer sends a voice note, a photo or a pH / TDS / temperature reading. Meta models turn it into a structured pond log.
- **Today (Hari Ini)**: shows each pond's status and the day's tasks, based on the batch's week in the nursery program.
- **Watch (Waspada)**: the farmer measures once or twice a day, but eels die in the hours nobody is looking. Every 30 minutes the server re-estimates each pond's water temperature from the hourly weather, anchored on the last reading and calibrated per pond. It turns that, together with what the farmer logged, into an oxygen risk score with its reasons. This works even on farms with no DO meter. It also builds a check schedule, with a night alarm when risk peaks while people sleep. An agent turns this into an evening briefing (in progress).
- **Problem (Ada Masalah)**: the farmer takes a photo or video. SAM 3.1 marks dead or surfacing eels, and the app lists the first actions to take in the first 15 minutes, why, and when to call an expert. It follows up afterwards.

The AI **advises, it does not decide**. Emergency alerts come from deterministic threshold rules and never depend on a language model being available.

## Built during the hackathon vs. pre-existing

Judges need to see what is new, so here it is plainly.

| Built during the hackathon (Oct 26 – Nov 4, 2026) | Pre-existing (before Oct 26) |
|---|---|
| All code in this repository (app, server, agents, rules engine) | Synt Eel Nursery Blueprint v5: an internal design document. Its water-quality thresholds, the 0–12 week glass eel program and maintenance SOPs were transcribed into [`knowledge/`](knowledge/) as data |
| The knowledge base format and how the agents use it |
| Elver-phase practice from an interview with our partner eel farmer in Sleman ([`knowledge/partner-practice.json`](knowledge/partner-practice.json)) | 3D render of the Synt Nursery v5 system, shown only as a labelled "product vision" at the end of the demo video |
| 3D render of the sensor kit (made during the event) | Landing page [eel.synt.fun](https://eel.synt.fun) (not part of this submission) |

Commit history in this repo starts on Oct 26, 2026.

## Meta models

| Model | Used for |
|---|---|
| Muse Spark 1.3 (Meta Model API) | Reading meter displays and pond video frames; structuring voice notes into a pond log (strict JSON schema); risk-reasoning agent with tool calls; problem triage |
| Muse Voice Transcribe | Farmers' voice notes and video narration into text (Indonesian, with code-switching), WAV converted on the phone |
| SAM 3.1 | Segmenting and counting dead or surfacing eels in pond photos and video |
| Muse Spark Open (Fireworks) | Open-weight fallback: takes over capture reading automatically when the Meta API is down or out of credits |

## Evaluation

Measured numbers, method and limits for each model use are in [`docs/evaluation.md`](docs/evaluation.md). Headlines:

| What | Result |
|---|---|
| SAM 3.1 dead eel count, 14 test photos | Up to 16 eels lying apart (6 photos): every answer within 1 eel of the true count, median 1.8 s. Groups of 18 or more and piles (8 photos): no usable count; the app undercounts, says "at least N", or asks for a new photo |
| Muse Spark reading spoken Javanese numbers | 12 of 12 fields from 3 typed rounds, e.g. "selawe koma wolu" = 25.8. Real farmer recordings not measured yet |
| Evening briefing agent, 6 live runs (Muse Spark Open on Baseten, Muse Spark 1.3 on Meta) | 6 of 6 finished with tool calls, 7-8 steps, 9-13 s; all 12 rule checks kept in every run |
| Offline checks | `npm run eval`: 33 of 33 cases; `npm test`: 101 tests |

## Repository layout

```
knowledge/   Eel nursery knowledge base (thresholds, weekly program, SOPs, emergencies)
server/      API server: Node 24 + Hono + built-in SQLite; holds the Meta API key
web/         Mobile web app: Vite + Preact (wrapped as an Android app later)
scripts/     Developer utilities (e.g. check Meta Model API access)
```

## Running locally

Requirements: Node.js 24+.

```sh
npm install
# API keys: put META_API_KEY=... (and optionally FIREWORKS_API_KEY=...) in ~/.synteel.env
# (outside the repo), see .env.example
npm run check:meta     # verify which Muse models your keys can reach
npm run seed:demo      # optional: demo farm with two weeks of logs (stop the server first)
npm run dev:server     # http://localhost:8787  (SYNTEEL_AI_MOCK=1 for example AI drafts)
npm run dev:web        # http://localhost:5173 (proxies /api to the server)
```

## Status

- Day 1: repository scaffold and knowledge base.
- Day 2: farm, pond and batch setup (each batch knows its nursery week and stage), manual logging (temperature, pH, TDS, deaths, behaviour, feed leftovers, water colour and smell), and the deterministic rules engine with tests (`npm test`).
- Field input: elver ponds now use the partner farm's water ranges, TDS has an upper limit, and pond area gives a stocking density check (ideal 40–60 per m², max 100).
- Day 3: pond nowcast ([`server/src/nowcast.ts`](server/src/nowcast.ts)).
  - A water temperature model driven by Open-Meteo hourly weather. It re-anchors on each reading and learns a per-pond offset from past errors, and its uncertainty grows with time since the last reading.
  - Hourly oxygen risk with explained factors: warm water, eel behaviour, aerator status, green water at night, density, uneaten feed, heavy rain, and hours unwatched.
  - Suggested checks, including night alarms.
  - A server-side monitor that re-runs every 30 minutes and records when a pond's risk rises.
  - A 36-hour chart on the Watch screen, and a one-tap "quick check". The farm location comes from GPS or a place name.
- Hands-free capture (wet hands at the pond):
  - **Voice note**: one big button.
  - **Meter photos**: a camera button next to every reading.
  - **Daily video**: the phone extracts 12 frames and a 16 kHz soundtrack instead of uploading the whole video, to save data and API cost.
  - On-phone blur and glare check before a photo is sent.
  - The AI fills a draft that the farmer checks; each field shows "from photo / from voice", or "unsure, check again".
  - Captures wait in an offline queue on the phone until there is signal.
  - Without API keys, `SYNTEEL_AI_MOCK=1` runs the flow with clearly labelled example drafts.
  - `SYNTEEL_AI_DAILY_CAP` limits real AI reads per day (used on the public preview).

See the roadmap in [`docs/roadmap.md`](docs/roadmap.md).
