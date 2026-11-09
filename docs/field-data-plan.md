# Field data plan: one glass eel → elver cycle at the partner farm

Goal: one full cycle (stocking glass eels to sorting or harvest of elvers, about 12 weeks) recorded in the app on the partner farm, so the cycle summary can be set against the survival the farmer reported. Today that comparison has one real side only.

## What we know now, and how sure we are

| Figure | Source | Status |
|---|---|---|
| Glass eel → elver survival of about 20–40% | The partner farmer ("Pak Budi", pseudonym), from memory, at the 2 November 2026 visit | **Farmer-reported.** No records were ever kept on the farm; not measured |
| 6 ponds, worked alone, deaths often around two weeks after stocking | Same visit | Farmer-reported |
| One set of readings, 2 November 2026 (pH 7.44, TDS 235 ppm, 26.6 °C) | Measured on the visit | One reading, not a cycle |

The app and every export call the 20–40% "farmer-reported" (Indonesian: "menurut petani"). It is a baseline to compare against, not a fact about survival on this or any farm.

## What the app summarises per batch

The **Siklus batch ini** card on the pond screen and the team dashboard's **Data lapangan** page ([`server/src/cycle.ts`](../server/src/cycle.ts)) build this from records the app already keeps:

| Field | From | Notes |
|---|---|---|
| Stocking date and count | Batch setup (setup.tsx), or **Isi** on the card | The count is what was stocked, as the farmer counted or bought it |
| Days in the cycle | Stocking day = day 1, to today or the harvest count | |
| Records per day, days with a record | Every log by a person | Sensor readings are left out |
| Nights checked | A log by a person between 18.00 and 06.00 farm time | Only nights that have passed |
| Readings in range / out of range / danger | Every reading against the phase limits in `knowledge/thresholds.json` | "In range" = inside the warning limits |
| Danger signs checked again | A record the rules rate as danger (reading past the danger limit, eels at the surface, aerator off), answered when a person records a check on the pond within 2 hours; plus dead-eel re-checks from the Problem flow | Danger records within 2 hours of each other count once |
| Deaths | Every dead-eel number in the batch's records (Problem flow, voice, manual) and the number of reports | |
| Survival | Last sorting or harvest count ÷ stocked count | **Only when both counts were entered.** Recorded deaths are never turned into a survival figure |

Known gap: the night-check alarm on the phone (Waspada) is answered on the phone; the server sees the answer ("Cek malam … normal") but not an alarm nobody answered. The card therefore counts danger records and dead-eel re-checks, which the server sees whether or not they were answered.

## What to record during the cycle

Before stocking

1. Consent: the farmer agrees, in the app's terms and by word, that this cycle's records are used by the team as field evidence. Pseudonym only; no faces, no business name, no address; any map stays at village level.
2. Pick **one pond** for the cycle (two if the farmer wants a comparison pond). Fill in the pond profile: container, place, aeration, area.
3. On stocking day: start the batch with the **stocking date and the number stocked**. How the number was found (counted, estimated by weight, the seller's figure) goes in a note on the first record. If it is an estimate, write how it was estimated.

Every day

4. Morning and afternoon: temperature, pH and TDS (voice, meter photo or typed). Dead eels removed, with their number, every time, even 0 ("tidak ada yang mati").
5. At least one night check (18.00–06.00) when the app asks for it: a look at the eels and the aerator. "Ya, normal" on the alarm screen is enough.
6. Leftover feed, water colour or smell when they change.

Events

7. Deaths: report through **Masalah → Sidat mati** (photo for the count when possible) and answer the 1-hour re-check.
8. Power cuts: **Listrik padam** and **Listrik sudah menyala**.
9. Sorting: on every sorting day, **Catat hasil hitung → Sortir** with the number counted in this pond. Eels moved to another pond are noted in a record ("200 ekor dipindah ke Kolam C"), so they are not read as deaths.
10. Harvest or end of the glass eel stage: **Catat hasil hitung → Panen** with the final count.

Team side

11. Once a week: open **Data lapangan** on the team dashboard and check that records, nights and deaths are coming in. Call the farmer if a day is missing rather than fill it in.
12. At the end: download the batch as CSV and JSON. Store it with the date and the consent note, outside the public repo.

## Reading the result

- One cycle on one farm is a case, not a rate. Report it as "survival X% in one recorded cycle on the partner farm, against the farmer-reported 20–40%", with the number stocked and counted.
- If eels were moved between ponds, survival for the pond means little; add up the ponds of the batch by hand and say so.
- Counting thousands of glass eels has an error of its own. Write down how each count was made (by hand, by weight, by sample). A survival figure is only as good as the two counts.
- A cycle with many missing nights or days says more about the records than about survival: report the records per day and nights checked next to it.
- Never present a cycle summary as caused by the app. More checks and higher survival in one cycle show they happened together, nothing more.
