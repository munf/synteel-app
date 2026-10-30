# Evaluation

What we measured for each Meta model use in Synt Eel, how, and where it falls short. All live numbers below are from runs on 29-30 October 2026 (WIB) against the current code. The offline part can be re-run by anyone with `npm run eval` (no keys, no network); `npm test` runs the full test suite (124 tests).

The app gives decision support. A model never diagnoses, never doses medicine, and never saves anything by itself: every count, voice log and meter reading is a draft the farmer confirms, and alarms come from fixed rules.

## Summary

| Model use | Measured | Result |
|---|---|---|
| SAM 3.1 dead eel count | 14 photos, 3 to ~150 eels | Up to 16 spread-out eels (6 photos): every answer within 1 eel of the true count. 18 or more eels, or a pile (8 photos): no usable count. The low end never went above the true count (14 of 14). Median 1.8 s per photo |
| Muse Spark, voice log extraction | 3 typed Javanese/Indonesian rounds, 12 fields | 12 of 12 fields right, e.g. "selawe koma wolu" read as 25.8. 4.2-5.2 s per round |
| Muse Voice Transcribe (ASR) | Synthetic voice only | Robot voice gave cut-off text. Real farmer recordings not measured yet |
| Muse Spark vision, meter photos | Offline guard tests only | No accuracy number yet |
| Muse Spark vision, notebook pages | 2 synthetic handwritten pages (+1 degraded copy), 5 live reads, 216 cells | 200 right, 16 hard cells left empty and flagged as meant, 0 wrong. Synthetic pages only; real notebooks not measured yet |
| Evening briefing agent (Muse Spark Open on Baseten, Muse Spark 1.3 on Meta) | 6 live runs on the seeded demo farm | 6 of 6 finished with tool calls, 7-8 steps, 9.3-13.3 s. All 12 rule checks kept in every run. 0 to 4 extra checks proposed per run |
| Deterministic rules and alarms | `npm run eval`, `npm test` | No model in the path; agent failure or bad output falls back to the rules |

## SAM 3.1: counting dead glass eels and elvers

Farmers net dead glass eels and throw them away, so the count works on the photo of the scoop or basin as it is ([`server/src/sam.ts`](../server/src/sam.ts)). One photo goes to SAM 3.1 with four prompts in parallel: "transparent eel", "thin worm", "transparent worm" for bodies and "black eye" for heads (two eyes close together are one head). Elver ponds add "worm". Bodies found by several prompts are merged. The answer is one number when sure bodies and heads agree, a range when they do not, or "at least N" when only heads are visible.

**Method.** 14 photos of glass eels and young elvers found on the internet. They are kept out of the repo and are described here only. The 4 smallest counts (3, 4, 7, 10) were checked by the user; the others were counted by hand during development, and the dense ones (~) are approximate. Each photo was prepared the way the app prepares a count photo (`prepareImage(file, 1600, 0.92, 1.12)` in [`web/src/capture/media.ts`](../web/src/capture/media.ts): longest side at most 1600 px, brightness x1.12, JPEG quality 0.92) and sent once through the current `countDeadEels`.

| Photo | True count | App shows | Low-high | Bodies (sure) | Heads | Time |
|---|---|---|---|---|---|---|
| Palm, glass eels | 3 | 3 | 3-3 | 4 (3) | 3 | 4.3 s |
| Clear container, coloured elvers | 4 | 4 | 4-4 | 4 (4) | 0 | 2.8 s |
| White background, elvers | 7 | 6 | 6-6 | 6 (6) | 2 | 1.9 s |
| Dark background, glass eels | 10 | about 10-13 (12 filled in) | 10-13 | 11 (10) | 0 | 1.9 s |
| Grey basin | 12 | about 11-12 | 11-12 | 11 (11) | 0 | 1.2 s |
| White basin with foam | 16 | at least 15 | 15-15 | 12 (0) | 15 | 2.3 s |
| On a net | 18 | about 3-10 | 3-10 | 10 (3) | 0 | 1.7 s |
| Palm, tangled | ~20 | nothing found, new photo asked | 0 | 0 | 0 | 1.1 s |
| Pink basin, crowded | ~25 | nothing found | 0 | 0 | 0 | 1.4 s |
| Two hands in a tank | ~40 | nothing found | 0 | 0 | 0 | 1.4 s |
| Tank, side view | ~50 | about 1-4 | 1-4 | 4 (0) | 0 | 0.8 s |
| White basin, dense | ~60 | at least 3 | 3-3 | 0 | 3 | 2.1 s |
| Plastic bag, dense | ~60 | nothing found | 0 | 0 | 0 | 1.6 s |
| Pile | ~150 | at least 16 | 16-16 | 0 | 16 | 1.5 s |

The two elver photos were also run with the elver prompt set (5 prompts): same answers (4 and 6), 2.0 s each. Median time over all 16 runs: 1.8 s; the slowest was the first call (4.3 s).

What this shows:

- Up to 16 eels lying apart, the answer is usable: 2 exact, 2 ranges that contain the true count, and 2 one under (6 for 7; "at least 15" for 16).
- The low end of the answer was at or below the true count on all 14 photos. When the app is wrong, it undercounts.
- Piles and dense groups are out of reach. Half of them return nothing, and the app then asks for a new photo or a typed number; the rest give a floor far below the truth. The app says "at least N" and asks the farmer to add more, but the numbers here show the farmer should count by hand in that case.

Earlier findings from the prompt and photo-preparation tests (same photo set, during development):

| Test | Finding |
|---|---|
| 15 prompts on the white-basin photo (16 eels) | "black eye" 25 eyes, "thin worm" 11, "eye" 11, "transparent worm" 10, "transparent eel" 1. "eel", "glass eel", "elver", "fish", "fish head", "larva", "noodle", "transparent fish", "thin transparent fish larva" and "worm" found nothing |
| "worm" on elvers in a white basin | 8 of 8 (recorded SAM output, kept as the test fixture `server/test/fixtures/sam-synth8.txt`) |
| JPEG quality 0.82 at 1280 px (the meter-photo setting) | Eye detections on one photo dropped from 15 to 9. Count photos now go out at 1600 px and quality 0.92 |
| Filters before sending: grey, sharpen, more saturation | Fewer detections, so none are used |
| Brightness +25% | Worse than +12%; the app uses x1.12 |
| A hand-made "thickness map" to estimate piles | Unreliable; left out. A density model learned from farmer-corrected photos is post-hackathon work |

## Voice logs: Meta ASR and Muse Spark extraction

A farmer walks the ponds and talks (Indonesian, Javanese, or English). Muse Voice Transcribe turns the audio into text; Muse Spark 1.3 splits it per pond into a strict JSON schema ([`server/src/round.ts`](../server/src/round.ts)). The prompt lists Javanese numbers and says "koma" is the decimal point. Local code then matches pond names and checks every number before the farmer sees the draft.

**Live check, extraction only.** Three typed transcripts went through the real Muse Spark extraction (Meta API, no ASR):

| Said (typed) | Expected | Got |
|---|---|---|
| "Kolam A suhune selawe koma wolu, pH pitu koma papat. Kolam be suhune wolulikur, ana sing mati loro." | A: 25.8 °C, pH 7.4. B: 28 °C, 2 dead | all 4 right |
| "Kolam ce siji suhune selikur sanga koma lima, tds satus sewidak. Kolam pojok banyune rada ijo, pakane isih akeh." | C1: 29.5 °C, TDS 160. Pojok: green water, much feed left | all 4 right |
| "Kolam B suhu dua puluh tujuh koma tiga, pH tujuh koma satu. Kolam A pH pitu papat, suhune nemlikur." | B: 27.3 °C, pH 7.1. A: pH 7.4 (said "74"), 26 °C | all 4 right |

12 of 12 fields, 4.2-5.2 s per round. "satus sewidak" (160) is not in the prompt's number list and was still read right.

**What the tests cover** ([`server/test/round.test.ts`](../server/test/round.test.ts), and the voice rows of `npm run eval`):

| Case | Handling |
|---|---|
| Pond names as spoken: "kolam be", "kolam ce siji", "Kolam C satu", "Kolam B maneh", nickname "pojok" | Matched locally to the right pond |
| The model guesses a pond id for an unknown name ("kolam mburi") | Not followed; the farmer picks, with the model's guess offered first |
| pH heard as 74 | Saved as 7.4 and shown as fixed |
| Temperature 9 (the "selikur" was lost) | Asked, with 29 suggested |
| TDS 5000, pH 2 | Asked as implausible |
| Same pond said twice with different readings | Merged, the farmer asked which one |
| Full path: audio → ASR → first provider down → second provider → guards | Mocked end to end |

**Known ASR limit.** Tests with a synthetic (robot) voice gave cut-off transcripts. Recordings of real farmers at the pond have not been measured yet. The guards above catch some ASR errors (a lost tens word, a missing decimal) but cannot recover words that were never transcribed.

## Meter photo reading: Muse Spark vision

The farmer photographs a pH, TDS or thermometer display; Muse Spark 1.3 reads it into a draft. No accuracy number on real meter photos yet. What the tests cover ([`server/test/ai.test.ts`](../server/test/ai.test.ts), meter rows of `npm run eval`):

- plausible readings are kept and impossible ones dropped (pH 72 is dropped and listed as a problem);
- unknown behaviour or feed words from the model are dropped;
- fields the model marks unsure are shown as "unsure, check again";
- when the Meta API answers 503, Muse Spark Open on Fireworks reads the photo instead;
- without keys or in mock mode, drafts are labelled as examples, and the daily cap stops real reads.

## Notebook pages: Muse Spark vision

Farmers keep handwritten notebooks (date, pond, temperature, pH, TDS, dead eels, feed). "Foto buku catatan" reads a photo of one page into rows the farmer checks and then saves as history ([`server/src/notebook.ts`](../server/src/notebook.ts)). Muse Spark 1.3 only copies each cell as written and says which cells it is unsure of. Code then decides: the number is parsed from the written text, never taken from the model's own reading; a number for a blank cell is dropped; ditto marks are not filled in from the row above; dates without a year get the most recent date that has passed; pond names are matched locally; pH 74 or temperature 9 are left empty with 7.4 or 29 offered, not filled in. Every row is checked by the farmer before anything is saved, and a pond that already has a record that day is skipped unless the farmer asks.

**Live check on synthetic pages.** No real notebook photos yet (they come from a field visit). Two pages were drawn with handwriting fonts on lined paper (wobble, slight rotation, blur, grain, uneven light) and kept out of the repo. Page 1: 8 rows over ponds A and B written as letters, October without a year, with pH written "74", a crossed-out pH, a ditto mark for a temperature and an unknown pond "pojok". Page 2: one pond in the title, "Sept 2026", pagi/sore, a temperature written "9" and a crossed-out TDS. A third read used page 1 shrunk to 1000 px, rotated, blurred and darkened. Cells scored: date, pond, temperature, pH, TDS, dead (6 per row).

| Page | Reads | Cells per read | Right | Flagged as meant (the hard cells) | Wrong | Time |
|---|---|---|---|---|---|---|
| Page 1, 8 rows | 2 | 48 | 44 | 4 of 4 | 0 | 8.4, 9.2 s |
| Page 1, degraded copy | 1 | 48 | 44 | 4 of 4 | 0 | 5.8 s |
| Page 2, 6 rows | 2 | 36 | 34 | 2 of 2 | 0 | 6.9, 9.3 s |

Every flag carried the right offer: pH "74" → 7.4, temperature "9" → 29, "pojok" → pick the pond. The crossed-out cells came back flagged with the model's best guess shown, not filled in. Times on page 2 (pagi → 07.00, sore → 17.00) and the year from the title were right in both reads. These pages are clean compared with a real notebook (one hand, ruled lines, no stains), so treat this as a smoke test of the pipeline, not an accuracy figure.

**What the tests cover** ([`server/test/notebook.test.ts`](../server/test/notebook.test.ts), notebook rows of `npm run eval`): invented values for blank cells, the model "correcting" what is written, unsure and ditto cells, plausibility offers, year inference and future dates, pond matching and the pond the import started from, reading saves nothing, the shared AI quota, duplicate and repeated rows on save, and a bad row stopping the whole save.

## Evening briefing agent

The agent ([`server/src/agent.ts`](../server/src/agent.ts)) looks at the farm through read-only tools (ponds, recent history, the night's oxygen-risk forecast, weather, the knowledge base) and submits a short summary with extra checks. Providers are tried in order: Muse Spark Open on Baseten, Muse Spark 1.3 on the Meta API, Muse Spark Open on Fireworks, then a rules-only briefing. Code then guards the proposal: every rule check is kept, agent checks must name a real pond and fall within 18 hours, a check close to a rule check is dropped as a duplicate, and anything about medicine or doses is removed.

**Method.** 6 runs on the seeded demo farm (3 ponds, two weeks of logs), real models, at 05:20 WIB. Runs 5 and 6 had the Baseten key removed so the Meta API answered.

| Run | Provider | Language | Tool steps | Model calls | Time | Agent checks proposed / kept | Summary changed by guard |
|---|---|---|---|---|---|---|---|
| 1 | Baseten, Muse Spark Open | id | 7 | 4 | 9.3 s | 3 / 3 | no |
| 2 | Baseten, Muse Spark Open | id | 7 | 4 | 9.9 s | 1 / 1 | no |
| 3 | Baseten, Muse Spark Open | id | 8 | 5 | 10.7 s | 0 / 0 | no |
| 4 | Baseten, Muse Spark Open | en | 8 | 5 | 11.4 s | 2 / 2 | no |
| 5 | Meta, Muse Spark 1.3 | id | 7 | 4 | 13.3 s | 3 / 3 | no |
| 6 | Meta, Muse Spark 1.3 | en | 7 | 4 | 11.4 s | 4 / 4 | no |

Every run read the ponds, two ponds' night forecasts, the weather and two pond histories before submitting; runs 3 and 4 also searched the knowledge base. All 12 rule checks were kept in every run. Extra checks proposed were practical: remove leftover feed, lift out dead eels, check the aerator and drain after rain.

The guard did not need to change anything in these 6 runs. Its drop rules are shown offline instead (`npm run eval`, [`server/test/agent.test.ts`](../server/test/agent.test.ts)): of 5 proposed checks (one good, plus an unknown pond, an antibiotic, a duplicate of a rule check and one beyond 18 hours), only the good one is kept; a summary about medicine doses is replaced by the rules summary.

Wording the guard does not catch, seen in these runs:

- "Heavy rain" for a forecast of 3.1 mm in an hour.
- "Oxygen in the water is very low" stated as fact. The farm has no oxygen meter; this is the app's estimated risk.
- "Tonight" in a run made at 05:20. In use the briefing is made from 17:00.

**Fallback.** A local test server answers 402 (out of credits) for Baseten; the Meta provider then writes the briefing (`meta/muse-spark-1.3`). With every provider failing, or no keys, the briefing comes from the rules with the rule checks intact.

## Deterministic rules and alarms

Thresholds, the oxygen-risk score, the check schedule and the night alarms are plain code ([`server/src/rules.ts`](../server/src/rules.ts), [`server/src/nowcast.ts`](../server/src/nowcast.ts)) and take no model input. The tests show this three ways:

- the rules tests call `assessPond` on logs alone: 31 °C is critical, 29.5 °C a warning, surfacing eels critical, readings older than 24 h ignored;
- the briefing tests run with no model and with every provider failing, and the rule checks come out the same;
- the guard keeps every rule check whatever the agent submits, so the agent can add checks but cannot remove or move one.

## Water temperature model per pond (synthetic backtest)

The water temperature estimate is plain arithmetic, no model call ([`server/src/thermal.ts`](../server/src/thermal.ts)). Each pond starts from its profile (container, indoors / under a roof / open, depth, light, water color) and then learns three numbers from the farmer's own readings: an offset, how fast it follows the weather, and how much the sun warms it, by a ridge regression pulled towards the profile's starting values. Evaporation uses Open-Meteo humidity and reference evaporation. Old notebook readings are matched with past weather from the Open-Meteo archive, so a pond can learn on its first day. The "usually off by ±X °C" each pond shows is the 80th percentile of its own rolling backtest: every reading predicted from the one before it, using only what was learned before it. With fewer than 6 scored readings the pond shows "still learning" and its profile's starting error.

**Synthetic only.** Five pond types are simulated hour by hour with physics that is deliberately not the app's model (sun reaching one tank only between 11:00 and 14:00, a rougher evaporation rule, readings at 07:00 and 17:00 ± 40 minutes, 0.3 °C noise, rounded to 0.1, 10% of readings missed). Days 1-28 teach the model; each reading on days 29-35 is predicted from the reading before it. The old model is the one before 30 October 2026: fixed starting values and a median offset. `npm run eval` prints this table.

| Pond type (synthetic) | Held-out readings | Old model, mean / 80% error | New model, prior only | New model, learned, mean / 80% | 13:00 spot check, old → new |
|---|---|---|---|---|---|
| Indoor fiber tank | 14 | 0.27 / 0.31 °C | 0.31 °C | 0.10 / 0.16 °C | 0.13 → 0.09 °C |
| Aquarium indoors | 12 | 0.54 / 0.81 °C | 0.38 °C | 0.13 / 0.20 °C | 0.15 → 0.15 °C |
| Concrete pond under shade net | 13 | 0.41 / 0.58 °C | 0.16 °C | 0.14 / 0.20 °C | 0.23 → 0.18 °C |
| Open tarp tank in the sun | 12 | 1.21 / 1.40 °C | 1.35 °C | 0.09 / 0.11 °C | 1.24 → 0.97 °C |
| Roofed tank, midday sun through a gap | 12 | 0.10 / 0.14 °C | 0.26 °C | 0.09 / 0.12 °C | 0.43 → 0.42 °C |
| All | 63 | 0.50 / 0.83 °C | | 0.11 / 0.17 °C | |

The biggest gain is the open tarp tank, whose sun response the old fixed values underestimated. The 13:00 column shows the limit: with readings only at 07:00 and 17:00, midday heat is still learned poorly, which is why each pond also gets a suggested extra measuring time (the awake hour where the estimate is least certain and least measured). These are synthetic ponds; no partner-farm readings have been scored yet.

**Pond photo → profile (Muse Spark vision).** A photo of the pond gives a draft profile the farmer checks; fields the model is unsure of stay empty, and notes about light and water color come from fixed text in code ([`server/src/pondphoto.ts`](../server/src/pondphoto.ts)). Live check on 30 October 2026 with two public-domain/CC0 photos from Wikimedia Commons (not in the repo), Muse Spark 1.3 on the Meta API: an outdoor tarp tank with green water and sky reflection came back terpal, open, green, bright (4.2 s); a row of open concrete eel tanks with the water hidden under plants came back beton, open, bright, with water color left empty and "water surface covered by plants" reported (5.4 s). Two photos only: a smoke test, not an accuracy figure.

**Weekly pattern agent (Muse Spark Open on Baseten).** Once a week per farm, and on request from a pond's page, the agent reads each pond's backtest misses by time of day through tools and writes one or two sentences plus a suggested measuring time ([`server/src/patterns.ts`](../server/src/patterns.ts)). Every number it may use comes from the tools; a guard refuses any number not in the pond's data, a time that is not one of the computed hours, more than two sentences, oxygen, medicine or diagnosis, and that pond then gets the rules sentence. Two live runs on the seeded demo farm on 30 October 2026: an Indonesian run over 3 ponds (6.2 s, 5 tool calls) gave 3 notes that passed the guard; an English run over one pond (4.5 s) passed but used the Indonesian names for parts of the day and drew a conclusion from a time of day with a single reading. Both were fixed in code afterwards (the tools now give the part names in the viewer's language and no number for a time of day with fewer than 3 readings), not re-measured.

## Limits

- Small samples: 14 photos, 3 typed voice rounds, 6 agent runs. Treat them as spot checks.
- The count photos are from the internet, mostly live eels in good light. Dead eels in a farmer's net at dusk will look different.
- Most true counts above 10 are hand counts by us, and the dense ones are approximate.
- No field validation yet: no partner-farm count photos, voice recordings, meter photos or notebook pages have been scored. The notebook pages above are synthetic.
- The voice check skipped ASR. Real speech, wind and pumps at the pond will add errors before the extraction step.
- The agent was run at one time of day on one seeded farm.

## Reproduce

```sh
npm run eval   # offline: SAM fixture and count rules, voice, meter and notebook guards, agent guard and fallback, rules
npm test       # full test suite
```

The live runs need API keys and the private photo set, so they are not in the repo.
