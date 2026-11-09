# Post-hackathon improvements (branch `post-hackathon` → `main`)

The eight items approved after the Meta hackathon, taken from what the ten winning projects did well: verify AI output before the farmer sees it, record every model call, measure, close the loop with field data, show real runs, keep the model choice open, deliver steps on WhatsApp, and tidy the repo.

31 commits, about 80 files, roughly 8,700 lines added. Nothing is deployed or pushed yet.

## Checks

Run on the VPS on 10 Nov 2026, one after another, on the last code commit:

| Check | Result |
|---|---|
| `npm test` | 275 tests, 275 pass (206 on `main`). 8 new test files: `verify`, `ledger`, `providers`, `bench`, `cycle`, `replay`, `whatsapp`, `webapp` |
| `npx tsc --noEmit -p web` | clean |
| `npm run build` | app and team dashboard built |
| `npm run eval` | offline evaluation passes |
| `npm run eval -- bench --mock` | benchmark pipeline passes against the pretend API |
| `.github/workflows/ci.yml` | valid YAML. Not run on GitHub yet: it runs on the first push |

## Real AI calls made while building this

30 calls to the Meta Model API, all on the existing key, none to Baseten, Fireworks or NVIDIA:

- **19 calls**: first benchmark run, typed Javanese rounds and SAM 3.1 on the 4 user-checked photos ([`docs/eval-results/2026-11-10-meta.json`](eval-results/2026-11-10-meta.json)).
- **11 calls**: replay capture run, 3 rounds and 2 SAM photos, for the public replay page ([`docs/eval-results/2026-11-10-meta-replay.json`](eval-results/2026-11-10-meta-replay.json)).

Every other run used mock mode or the pretend API.

## What changed, by item

### 1. Verify before show

Every AI result passes code checks before the farmer sees it. A value that fails is not filled in: the app shows "Cek manual" with the reason.

- `319228e` `server/src/verify.ts`: readings in plausible ranges and units, numbers in a drafted log that were really said (Indonesian, Javanese and English number words), the pond exists on the farm, SAM outlines sane, advice never calls a pond safe where the alarm rules see risk and never names a medicine, dose or diagnosis.
- `3117821` hears Javanese *sewidak* (60), so "satus sewidak" is 160 (found by the benchmark).
- `85b5f09` hears "selikur sanga koma lima" as 29.5.
- `bb6790a` farmer view: "Cek manual" on held-back values, voice rounds ask to confirm a number that was not heard, a failed dead-eel count leaves the stepper to the farmer.

### 2. AI call ledger

- `7e4d81b` `server/src/ledger.ts`: every model call goes through one `call()` and is stored with provider, model, step, latency, tokens, estimated cost (price table with sources, read 9 Nov) and outcome (ok, fallback, error, mock). No audio, images or farmer text are stored.
- `7d74fd0` wired into drafts, voice rounds, dead-eel counts, notebook pages, the evening briefing and case updates. The agents' summaries fall back to the rules when they contradict them.
- `bb6790a` "Cara AI memproses ini" under each AI result: steps, models, time and each check with a tick or a cross. Farmers never see costs.
- `f2889d7` team dashboard, Pemakaian AI: recent calls, totals per model over 14 days, estimated cost per pond per night.
- `ef480d8` English check and trace texts made singular where needed.
- `ab1c901` README section.

### 3. Measured evaluation

- `bbd08d1` `npm run eval -- bench`: labelled items (`eval/labelled/`) through any provider and model per task, through the app's own path and checks. Prints accuracy, verification pass rate, median time and estimated cost per item. Blind A/B pairs of advice export to CSV for a person to rate.
- `292e3b9` keeps the failed checks of every item.
- `9728dfc` `scripts/nowcast-check.ts`: each night's oxygen-risk forecast against what was logged. No model, no network.
- `26ea300` first benchmark run (19 Meta calls): typed rounds 12 of 12 fields, 11 of 12 still filled in after the checks; SAM 3 of 4 photos within 1 eel. Too few real night readings yet for the nowcast check to say anything.

### 4. Field data loop

- `135c984` cycle summary per batch: days, checks, nights, readings, alarms, deaths. Survival only from two counts the farmer entered (stocked and sorting/harvest), compared with the 20–40% the partner farmer reported, labelled farmer-reported.
- `20c2198` pond screen: "Siklus batch ini" card.
- `2f63302` team dashboard: Data lapangan, CSV or JSON download without names or places.
- `998ede3` `docs/field-data-plan.md`: what to record at the partner farm over one cycle.

### 5. Replayable real runs

- `19682b2` run bundles from benchmark files, an app database's ledger or the demo farm. The anonymiser uses the pseudonym, "Tambak mitra" for farm names, and removes phone numbers, e-mail, coordinates and anything finer than the village.
- `ed260a8` public page at `<app>/replay/`: input, model calls, code checks and what the farmer saw, step by step. No sign-in.
- `82e7710` README and evaluation updated.

### 6. Model freedom

- `2f2d28c` `server/src/providers.ts`: one ordered provider+model route per task (speech, extract, agent, segment), hackathon order kept as the default, fallback along the route, `SYNTEEL_ROUTE_<TASK>` overrides. NVIDIA NIM is an opt-in entry (`NVIDIA_API_KEY`), in no default route and never called yet. A test keeps every model module off the alarm path.
- `bbd08d1` the benchmark compares models through the same path.

### 7. WhatsApp delivery

- `6ffed4b` night plan, danger summary and Problem-flow steps behind one provider: Cloud API, a `wa.me` link (the default: the app opens WhatsApp with the text filled in) or mock. Opt-in and verified number only. Every send is recorded without its text or number. The phone alarm stays first and never waits for WhatsApp.
- `fd5e3cc` Profil: WhatsApp number, code check, opt-in, message choices and consent. Problem flow: "Kirim langkah lewat WhatsApp".
- `878613e` steps text: "(6 ekor)", not "(6 ekor mati)".
- `2cba186` `docs/whatsapp-plan.md`: what is built, the privacy draft, the setup steps and Meta's per-message pricing.

### 8. Repo hygiene

- `c67db87` `server/src/webapp.ts`: with `SYNTEEL_WEB_DIR` the server also serves the built app next to `/api`, as Caddy does. Unset on eel.synt.fun, so the live services do not change. Test: `server/test/webapp.test.ts`.
- `7de5578` `Dockerfile`, `compose.yaml`, `.dockerignore`, `docker/start.sh`: multi-stage build, Node 24, unprivileged user, health check on `/api/health`, database and photos in a volume, settings from `.env` (never in the image), mock AI when no model key is set, the demo farm on first start when `SYNTEEL_DEMO_PHONE` is set. **Docker is not installed on the VPS, so the image has not been built.** The start script and the combined server were run without Docker on a spare port: health, app page, replay page, team dashboard page and demo login all answered.
- `b203983` `.github/workflows/ci.yml`: `npm ci`, tests, type check, build, offline evaluation and the mock benchmark. Node 24 with the npm cache. No secrets. To save minutes on a private repo: one job, superseded runs cancelled, docs-only changes skipped, pushes checked on `main` only (a branch with a pull request is checked by the pull request run).
- `10a5e2d` README: CI badge, "Run with Docker", where the tests (`server/test/`) and evaluation items (`eval/`) are.
- `e2ae4b3` `.github/pull_request_template.md` (what changed for the farmer, checks, screenshots, AI calls made, safety) and a short `CONTRIBUTING.md`.
- This file.

## What you need to do

1. **Remove the freeze hook before pushing.** `.git/hooks/pre-push` still refuses every push (hackathon freeze). Delete it once judging is over: `rm /root/synteel-app/.git/hooks/pre-push`.
2. **Decide on `.env.example`.** The working tree has an uncommitted edit that adds `NVIDIA_API_KEY`, the `SYNTEEL_ROUTE_*` examples and the `WHATSAPP_*` settings. The pre-commit hook blocks it because `.env.example` matches its `.env.*` rule. It holds only empty names, no values. Either commit it yourself (add an exception for `.env.example` to the hook, or commit it once with the hook's check in mind), or drop it. The README's Docker steps and `docs/whatsapp-plan.md` refer to these names.
3. **NVIDIA key (optional).** To try NVIDIA NIM: get a key at build.nvidia.com, put `NVIDIA_API_KEY=` in `/root/.synteel.env`, then run a small benchmark, e.g. `npm run eval -- bench --route extract=nvidia --max-calls 10`. Nothing routes to NVIDIA until you set `SYNTEEL_ROUTE_*`.
4. **WhatsApp Cloud API (optional, when wanted).** Without it the app uses `wa.me` links and needs nothing. For sending from Synteel: Meta Business account and business verification for the PT, a dedicated WhatsApp Business number, a permanent token and phone number ID, four templates approved, then the values in `/root/.synteel.env`. Full steps and template texts: [`docs/whatsapp-plan.md`](whatsapp-plan.md). Indonesian per-message prices are not verified yet.
5. **Privacy policy update, before the Cloud API is turned on.** Draft changes to sections 2, 3, 5 and 8 are in [`docs/whatsapp-plan.md`](whatsapp-plan.md#does-the-privacy-text-need-a-change-yes-before-the-cloud-api-is-turned-on). Not applied. The terms need no change for WhatsApp to work.
6. **After the first push:** check that the CI run passes (the action versions and the npm cache are only proven there). If the repo is private, the README badge shows only to people signed in with access.
7. **Docker (optional):** on a machine with Docker, `cp .env.example .env && docker compose up --build`, then open http://localhost:8787. Not tested yet.
8. **Screenshots:** none are in the repo. The screens that changed are Cek manual, Cara AI memproses ini, Siklus batch ini, the WhatsApp part of Profil, the Problem-flow WhatsApp button, the replay page and two team dashboard tabs (Pemakaian AI, Data lapangan). Add phone-width screenshots to the pull request if wanted.
