# Synt Eel — AI farm assistant for eel nurseries

> Built for the **Meta Global AI Developer Hackathon** (Oct 26 – Nov 4, 2026) · Track: **Indie** · Theme: **Build for Your World**

Eel farmers in Indonesia lose whole batches of glass eels and elvers overnight. The fish are fragile, the water can turn in a few hours, and most farmers keep track of their ponds from memory. By the time anyone notices, it is too late to act.

Synt Eel is a mobile app that closes that gap:

- **Record (Catat)**: the farmer sends a voice note, a photo or a pH / TDS / temperature reading. Meta models turn it into a structured pond log.
- **Today (Hari Ini)**: shows each pond's status and the day's tasks, based on the batch's week in the nursery program.
- **Watch (Waspada)**: an agent combines recent logs, the batch phase, the weather forecast and validated water-quality thresholds into an evening risk briefing. It also schedules night checks with alarm-style notifications. This includes inferring low dissolved-oxygen risk even when the farm has no DO meter.
- **Problem (Ada Masalah)**: the farmer takes a photo or video. SAM 3.1 marks dead or surfacing eels, and the app lists the first actions to take in the first 15 minutes, why, and when to call an expert. It follows up afterwards.

The AI **advises, it does not decide**. Emergency alerts come from deterministic threshold rules and never depend on a language model being available.

## Built during the hackathon vs. pre-existing

Judges need to see what is new, so here it is plainly.

| Built during the hackathon (Oct 26 – Nov 4, 2026) | Pre-existing (before Oct 26) |
|---|---|
| All code in this repository (app, server, agents, rules engine) | Synt Eel Nursery Blueprint v5: an internal design document. Its water-quality thresholds, the 0–12 week glass eel program and maintenance SOPs were transcribed into [`knowledge/`](knowledge/) as data |
| The knowledge base format and how the agents use it |
| Elver-phase practice from an interview with our partner eel farmer in Sleman ([`knowledge/partner-practice.json`](knowledge/partner-practice.json)) | 3D render of the Synt Nursery v5 system, shown only as a labelled "product vision" at the end of the demo video |
| 3D render of the sensor kit (made during the event) | Landing page eel.synt.fun (not part of this submission) |

Commit history in this repo starts on Oct 26, 2026.

## Meta models

| Model | Used for |
|---|---|
| Muse Spark (Meta Model API) | Structuring voice, photo and text logs; risk-reasoning agent with tool calls; problem triage |
| Muse Voice Transcribe | Farmers' voice notes into text (Indonesian, with code-switching) |
| SAM 3.1 | Segmenting and counting dead or surfacing eels in pond photos and video |
| Muse Spark Open / Muse Glimmer | Open-weight path for high-frequency log processing (planned, subject to partner credits) |

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
# API key: put MODEL_API_KEY=... in ~/.synteel.env (outside the repo), see .env.example
npm run check:meta     # verify which Meta models your key can reach
npm run seed:demo      # optional: demo farm with two weeks of logs (stop the server first)
npm run dev:server     # http://localhost:8787
npm run dev:web        # http://localhost:5173 (proxies /api to the server)
```

## Status

- Day 1: repository scaffold and knowledge base.
- Day 2: farm, pond and batch setup (each batch knows its nursery week and stage), manual logging (temperature, pH, TDS, deaths, behaviour, feed leftovers, water colour and smell), and the deterministic rules engine with tests (`npm test`).
- Field input: elver ponds now use the partner farm's water ranges, TDS has an upper limit, and pond area gives a stocking density check (ideal 40–60 per m², max 100).

See the roadmap in [`docs/roadmap.md`](docs/roadmap.md).
