# Evaluation data

Labelled items for the measured benchmark (`npm run eval -- bench`, [`scripts/bench.ts`](../scripts/bench.ts)). Each item goes through the same code the app runs: the provider+model route of its task ([`server/src/providers.ts`](../server/src/providers.ts)), `call()`, the guards and the code checks ([`server/src/verify.ts`](../server/src/verify.ts)). Every call is written to an in-memory AI call ledger, so time, tokens, estimated cost and the provider/model that answered come from the same place as in production. Results: [`docs/evaluation.md`](../docs/evaluation.md) and `docs/eval-results/`.

Only add a label that a person checked. Never fill in a value because a model said it, and never guess one: an item with a doubtful label is worse than no item.

## Run

```sh
npm run eval                                    # offline checks, no keys
npm run eval -- routes                          # which provider+model each task uses here
npm run eval -- bench --mock                    # the whole pipeline against a pretend API (no keys, no cost)
npm run eval -- bench --provider meta --tasks extract --save
npm run eval -- bench --route extract=fireworks --tasks extract
npm run eval -- bench --tasks segment --images /path/to/photos --only g17,g18 --max-calls 8
```

`--max-calls` (default 20) stops a run before an item that could go past it. A live run costs credits: start small. `--save` writes `docs/eval-results/<date>-<provider>.json` with every item, its score, its verification, the calls and who answered.

What each task scores:

| Task | Data file | Score | Also |
|---|---|---|---|
| `speech` | `speech.json` | Word error rate against the typed transcript (lower is better) | |
| `extract` | `rounds.json`, `meter-photos.json` | Share of labelled fields right in the model's answer after the guards | Share still filled in after the code checks ("Cek manual" counts as not filled in); values nobody labelled ("extra") |
| `agent` | `briefings.json` | Share of the rule checks the briefing kept (must be 100%) | The advice text, for blind rating |
| `segment` | `counts.json` | Share of counts within 1 eel of the true count | Exact, low end at or under the truth, error per photo |

Every task also reports the share of results that passed verification, the median time per item and the estimated cost per item (prices in [`server/src/ledger.ts`](../server/src/ledger.ts); "n/a" when a model has no price).

`--mock` answers every request from the labels themselves. It shows the pipeline works and costs nothing; its accuracy is 100% by construction and says nothing about a model. The test suite runs it (`server/test/bench.test.ts`).

## Private files stay out of the repo

Photos and recordings are never committed. The data files name them; pass their folder with `--images` / `--audio` (or `SYNTEEL_EVAL_IMAGES` / `SYNTEEL_EVAL_AUDIO`). An item whose file is missing is listed as skipped, not scored. Partner-farm photos and recordings additionally need the farmer's consent for this use, no faces, and no business name or address in the file or its label.

## Adding labelled data

### Farmer voice clips (speech-to-text): `speech.json`

1. Only with the farmer's consent for this use. Record at the pond as the app does (WAV, 16 kHz mono is fine).
2. A person who heard the clip types exactly what was said, in the words said ("pitulikur", not "27"), no corrections.
3. Add an item:

```json
{ "id": "budi-2026-11-12-a", "audio": "budi-2026-11-12-a.wav", "transcript": "Kolam A suhune pitulikur koma lima, pH pitu koma papat" }
```

### Voice rounds (log extraction): `rounds.json`

A transcript (typed, or a checked transcript of a real recording) and, per pond, the values that were said. `ponds` lists the farm's ponds as the app knows them (`id`, `name`, `nicknames`). Fields: `temperature` (°C), `ph`, `tds` (ppm), `do` (mg/L), `mortality` (dead eels), `color` (`clear`, `green`, `brown`, `cloudy`), `smell` (`normal`, `foul`), `leftover` (`none`, `little`, `much`), `aeration` (`on`, `weak`, `off`). Label only what was said; a field left out is not scored.

```json
{ "id": "jv-4", "transcript": "Kolam B suhune wolulikur, pakane entek", "expect": [{ "pond": 2, "temperature": 28, "leftover": "none" }] }
```

### Meter photos (log extraction): `meter-photos.json`

A photo of a pH, TDS or temperature display and the value on the display, typed by a person looking at the meter (or at the photo when the display is sharp). `field` is the form field the farmer would have tapped (`temperature`, `ph`, `tds`), or left out for "everything".

```json
{ "id": "ph-001", "image": "ph-001.jpg", "field": "ph", "expect": { "ph": 7.2, "temperature": 27.5 } }
```

### Basin photos with hand counts (SAM): `counts.json`

A photo of the scoop, net or basin from above, prepared as the app prepares it (longest side at most 1600 px, brightness ×1.12, JPEG quality 0.92), and the number of eels counted by hand. `countedBy`: `user` (checked by the owner), `hand` (counted during development) or `farmer`; `approx: true` for a dense photo whose count is an estimate. `phase` picks the prompt set (`glass_eel` or `elver`).

```json
{ "id": "budi-scoop-01", "image": "budi-scoop-01.jpg", "truth": 9, "phase": "glass_eel", "label": "scoop at dusk, 9 dead glass eels", "countedBy": "farmer" }
```

### Briefing nights (agent): `briefings.json`

A farm night as the briefing agent sees it (`BriefingInput` in [`server/src/agent.ts`](../server/src/agent.ts)): ponds, nowcasts, weather, and `history` as a map from pond id to its daily rows. The one there now is synthetic. Real nights must be pseudonymised first (farm name "Tambak", pond names as the farmer uses them, no place).

### Nowcast vs measured readings

No file: the readings are the farm's own records. `node scripts/nowcast-check.ts --db <file.sqlite> [--farm <id>] [--days 30]` makes each night's forecast again as the app would have at 17.00 and holds it against what was logged from 17.00 to 09.00: water temperature readings against the estimate at that hour, and oxygen signs (eels surfacing or at the inlet, dissolved oxygen under 5 mg/L) against the night's peak risk. Dead eels are shown per night, apart. It works on a copy, never on the database itself. More night readings, above all a dissolved-oxygen meter reading now and then, make this check mean something.

## Blind rating of advice

Advice has no right answer to score, so a person compares it. Two saved runs of the agent task (two providers, or two models) become pairs:

```sh
npm run eval -- pairs docs/eval-results/<date>-meta.json docs/eval-results/<date>-nvidia.json --out eval/ratings/pairs-<date>.csv
```

Each row holds the advice two models wrote for the same night, in random order, with model names taken out. Which side is which goes to `<file>.key.json`: the rater must not open it. The rater fills in `better (A/B/same)` and, if useful, `notes`, judging what a farmer at the pond would act on: clear, true to the data, nothing about medicine. Then:

```sh
npm run eval -- tally eval/ratings/pairs-<date>.csv eval/ratings/pairs-<date>.key.json
```

Unrated rows are counted as unrated, never as a tie. Do not fill in ratings for someone else, and do not let a model rate.
