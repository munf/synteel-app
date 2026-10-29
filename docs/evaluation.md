# Evaluation

What we measured for each Meta model use in Synt Eel, how, and where it falls short. All live numbers below are from runs on 29-30 October 2026 (WIB) against the current code. The offline part can be re-run by anyone with `npm run eval` (no keys, no network); `npm test` runs the full test suite (101 tests).

The app gives decision support. A model never diagnoses, never doses medicine, and never saves anything by itself: every count, voice log and meter reading is a draft the farmer confirms, and alarms come from fixed rules.

## Summary

| Model use | Measured | Result |
|---|---|---|
| SAM 3.1 dead eel count | 14 photos, 3 to ~150 eels | Up to 16 spread-out eels (6 photos): every answer within 1 eel of the true count. 18 or more eels, or a pile (8 photos): no usable count. The low end never went above the true count (14 of 14). Median 1.8 s per photo |
| Muse Spark, voice log extraction | 3 typed Javanese/Indonesian rounds, 12 fields | 12 of 12 fields right, e.g. "selawe koma wolu" read as 25.8. 4.2-5.2 s per round |
| Muse Voice Transcribe (ASR) | Synthetic voice only | Robot voice gave cut-off text. Real farmer recordings not measured yet |
| Muse Spark vision, meter photos | Offline guard tests only | No accuracy number yet |
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

## Limits

- Small samples: 14 photos, 3 typed voice rounds, 6 agent runs. Treat them as spot checks.
- The count photos are from the internet, mostly live eels in good light. Dead eels in a farmer's net at dusk will look different.
- Most true counts above 10 are hand counts by us, and the dense ones are approximate.
- No field validation yet: no partner-farm count photos, voice recordings or meter photos have been scored.
- The voice check skipped ASR. Real speech, wind and pumps at the pond will add errors before the extraction step.
- The agent was run at one time of day on one seeded farm.

## Reproduce

```sh
npm run eval   # offline: SAM fixture and count rules, voice and meter guards, agent guard and fallback, rules
npm test       # full test suite
```

The live runs need API keys and the private photo set, so they are not in the repo.
