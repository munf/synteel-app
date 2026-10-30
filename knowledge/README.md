# Knowledge base

Domain knowledge that the rules engine and the agents work from. The agents are instructed to ground advice in these files and cite them. They do not use web search.

## Source and status

| File | Content | Source |
|---|---|---|
| `thresholds.json` | Target / warning / critical values per water parameter, with operator actions | Synt Eel Nursery Blueprint v5 Rev. A, ch. 9–10 |
| `nursery-program.json` | Glass eel program, weeks 0–12: feed, mesh, water targets | Blueprint v5, ch. 2.4 and 5.2 |
| `sop.json` | Daily, weekly, monthly and per-batch maintenance tasks | Blueprint v5, ch. 11 |
| `alarm-levels.json` | Alarm levels and escalation | Blueprint v5, ch. 9.1 |
| `emergencies.json` | Trigger → operator actions | Blueprint v5, ch. 10; heavy rain from the partner farm; `aerator_off` (power cut at a pond without the Synt system) drafted during the hackathon, to be validated |
| `partner-practice.json` | Elver-phase practice: water ranges, stocking density, feeding progression, sorting, rainy season, fungus quarantine | Interview with the partner eel farmer in Sleman, **collected during the hackathon** |

Elver ponds use the partner farm's ranges (`by_phase.elver` in `thresholds.json`: temperature 28–31 °C, pH 6.8–7.6), because the Blueprint values were designed for glass eels in an indoor recirculating system. TDS above 200 ppm comes from the partner farm and applies to all ponds.

The blueprint is an internal Synt document written **before** the hackathon. Its values were transcribed here as data with the author's permission. The blueprint itself states they are **design starting points**: not yet field-validated, and to be re-tuned after the first trial batch.

Fields marked `"scope": "synt-nursery"` apply only to the Synt Nursery v5 recirculating system (sump, ozone, biofilter, etc.). Fields marked `"scope": "general"` apply to any glass eel or elver pond.

Threshold values come from the blueprint as-is. The blueprint's chapter 10 gives operator actions only for some triggers. The farmer-facing action texts for the remaining parameters were **drafted during the hackathon** and still need validation: pH, NO₃, turbidity, CO₂, salinity, and the power-outage and low-DO steps for ponds without the Synt system.

## Known gaps (TODO)

- **TDS:** only an upper limit (200 ppm) from the partner farm; no critical level. Sudden changes against the pond's own baseline are still flagged.
- **Elver critical temperature:** the upper critical limit (33 °C) is a Synt Eel heuristic and needs validation.
- **Elver phase program:** partner practice covers husbandry, but there is no week-by-week elver program yet.
- **Open questions** for the partner farm are listed in `partner-practice.json`.
