---
name: trip-briefing
description: Produce a short, decision-ready briefing about what someone arriving in a city will encounter right now — conditions, the local hour, and what to wear. Use when the user is travelling to, arriving in, or heading out in a city, rather than just asking for a raw weather or time reading.
license: Apache-2.0
allowed-tools: get_weather, get_current_time, load_skill, adk_request_input
---

# Trip briefing

A trip briefing answers "what am I walking into?" — not "what is the
temperature?". The user wants to make a decision (what to wear, whether to go
out now or wait), so gather both the conditions and the local hour, then commit
to a recommendation.

## When to follow this playbook

Follow it when the user is going somewhere: arriving in a city, heading out for
the evening, or asking what to expect or what to bring.

Do **not** follow it when the user asked a single factual question ("what's the
weather in New York?"). Answer that directly with one tool call.

## Steps

1. Identify the city. If the user named no city, call `adk_request_input` to
   ask for one and wait for the reply — do not guess or default to a city.
2. Call `get_weather` for that city.
3. Call `get_current_time` for that city.
4. Classify the temperature and the local hour using the bands below.
5. Write the briefing in the output format below.

Call both tools before writing anything. A briefing built on one of the two
readings is the failure this playbook exists to prevent.

## Temperature bands

| Band | Range | What it means for the traveller |
| --- | --- | --- |
| `cold` | below 10 °C / 50 °F | Insulation matters more than layers |
| `mild` | 10–18 °C / 50–64 °F | Layers; it will feel different at dusk |
| `warm` | 19–27 °C / 65–80 °F | Comfortable; plan around sun, not temperature |
| `hot` | above 27 °C / 80 °F | Heat and hydration are the constraint |

If the weather report gives Celsius and Fahrenheit, band on Celsius.

## Local hour bands

| Band | Hours | Why it changes the advice |
| --- | --- | --- |
| `early` | 05:00–08:59 | Cooler than the reading suggests; things are shut |
| `daytime` | 09:00–16:59 | Reading is representative; sun exposure counts |
| `evening` | 17:00–20:59 | Expect it to drop a band before the night is over |
| `night` | 21:00–04:59 | Coldest part of the day; limited options open |

## Output format

Use exactly these four sections, in this order, and keep each to one or two
sentences:

**Conditions** — the weather, in plain language, with the temperature.

**Local time** — the local hour and its band, e.g. "6:40 PM — evening".

**What to wear** — one concrete recommendation. For anything other than the
`warm` + `daytime` combination, load `references/clothing-matrix.md` first and
use the row that matches, rather than improvising.

**Worth knowing** — one thing the bands imply that the raw readings do not. For
`evening`, say it will get colder than the current reading. For `night` or
`early`, note that places are likely closed. For `hot` + `daytime`, mention
hydration and shade.

Do not add a section for information you could not retrieve — say so in the
section it belongs to.

## When a reading is unavailable

The tools only cover some cities and return `status: "error"` otherwise. When
one fails:

- Say plainly which reading is unavailable and for which city. Never invent a
  substitute value or fall back on general knowledge about the city's climate.
- Give the briefing from the reading you *do* have, and mark the affected
  sections as unknown.
- When both fail, say the city isn't covered and offer New York, which is.

## References

Load these on demand with `load_skill`, not up front:

- `references/clothing-matrix.md` — temperature band × local hour → what to
  wear, plus the rain and wind adjustments. Fetch it with
  `load_skill(skill_name="trip-briefing", reference="clothing-matrix.md")`.
