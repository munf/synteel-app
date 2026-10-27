# Roadmap (Oct 27 – Nov 4, 2026)

Submission target: Nov 4 evening WIB. Hard deadline: Nov 4, 9:00 PM ET (Nov 5, 09:00 WIB).

| Day | Date | Focus | Done when |
|---|---|---|---|
| 1 | Tue Oct 27 | Foundations | Repo scaffold; knowledge base from Blueprint v5; Meta API spikes (Voice Transcribe on Indonesian, SAM 3.1 on elver photos) |
| 2 | Wed Oct 28 | Data + rules | Farm / pond / batch setup (batch knows its nursery week); manual pH, TDS, temperature logs; deterministic threshold rules engine |
| 3 | Thu Oct 29 | AI logging | Voice note and photo into a structured log the farmer confirms; offline queue |
| 4 | Fri Oct 30 | Today + Watch | Home screen with pond status and phase-based daily tasks; agentic evening risk assessment (logs, weather, phase), including inferred low-DO risk |
| 5 | Sat Oct 31 | Problem flow | Photo or video, SAM 3.1 marks dead or surfacing eels, then first actions, likely causes with sources, when to call an expert, and follow-up |
| 6 | Sun Nov 1 | Alarms + Android | Android build; alarm-style night checks; escalation when unanswered |
| 7 | Mon Nov 2 | Vision screen + demo data | Synt Nursery vision screen (labelled as not built); realistic seed data and replayable scenarios; UI polish; feature freeze |
| 8 | Tue Nov 3 | Hardening + recording | Bug fixes, test on a low-end Android, deploy, screen recordings for the video |
| 9 | Wed Nov 4 | Submission | 3-minute video, README, submission form |

## Change on Oct 27: pond nowcast moved to Day 3

The Meta API credits were not active yet, and the partner farm said that losses happen whenever the pond is left unwatched, at any hour. Their ponds run 24-hour aeration. So the deterministic **pond nowcast** moved forward to Day 3, because it needs no Meta API. It covers weather, water temperature estimates, hourly oxygen risk, check schedules with night alarms, and a 30-minute server monitor. AI logging (voice and photo) moves to Day 4, alongside the agent that explains the nowcast.

| Day | New focus |
|---|---|
| 3 | Pond nowcast + check schedule (done) |
| 4 | Muse Spark agent on top of the nowcast (evening briefing, "measure now" when uncertain, plan for the night); voice and photo logging |
| 5 | Problem flow with SAM 3.1 video; photo guidance (glare, angle, polarizing clip), on-device blur/glare check, white-basin protocol for dead eels |

## Field input from the partner farm (Oct 27)

Done: elver water ranges, TDS limit, stocking density, heavy-rain guidance (see `knowledge/partner-practice.json`). Still to use:

- **Day 4 Today:** feeding progression task (1× → 2× → 3× a day while feed is finished, then more volume); monthly size sorting reminder; paste training fasting (3–7 days).
- **Day 4 Watch:** heavy rain in the forecast → keep rainwater out, use settled water from the quarantine/settling pond when the water source turns muddy.
- **Day 5 Problem:** fungus on eels → isolate in a quarantine pond and consult; no medicine dosing in the app.
- **Day 7:** batch species (bicolor) and seed origin; stocking checklist (oxygen-filled bags, acclimatization, shelter, paranet, shade).

## Fallbacks

- Voice Transcribe lacks Indonesian: send audio to Muse Spark 1.2 directly.
- SAM 3.1 struggles with transparent glass eels: demo on elvers, and treat glass eels as future work.
- Unreliable alarms on old Android: schedule night checks from the evening briefing; plain notifications on web.
- Meta API credits delayed: develop against Muse Spark Open on a partner provider.
