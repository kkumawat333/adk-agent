---
name: spec-runner
description: Turn a free-form request into a structured, persisted task spec, then use your own judgment — reading each available tool's own description — to decide which of them actually accomplish the spec's goal, and call them. A demo of the "agent as orchestrator, LLM does the job" idea, where the code and this skill only guarantee a spec is recorded before anything runs and that the final report is built from real tool results; which tools to call is deliberately not hardcoded anywhere. Use when a request should be planned and recorded as a spec before anything runs, not just answered directly.
license: Apache-2.0
allowed-tools: create_task_spec, get_city_info, get_weather, get_current_time, load_skill, adk_request_input
---

# Spec runner

This skill demonstrates "agent as orchestrator, LLM does the job": the spec
step is fixed (always record one before acting), but which tools accomplish
the goal is **not** looked up in a table anywhere — you decide, the same way
you'd decide for any other request, by reading each candidate tool's own
`description` and picking the ones actually relevant to the spec's `goal` and
`city`.

Nothing in this file, and nothing in `agent.ts`, enumerates "for this kind of
request, call these tools." That is intentional: it is the one thing this
skill exists to *not* prescribe.

## When to follow this playbook

Follow it when the request is a small task to plan and execute — something
with a goal and a city — rather than a single already-covered factual
question. If the user asks one plain fact ("what's the weather in New York?"),
just call the matching tool directly instead of spec'ing it.

## Steps

1. Read the request and decide the `city`, a one-sentence `goal`, and a short
   free-text `task_type` label for your own reference (e.g. "trip-readiness",
   "city-overview" — whatever best describes the request; it is not looked up
   anywhere, it just makes the persisted spec more legible later). If the
   city is missing or ambiguous, call `adk_request_input` to ask and wait for
   the reply — do not guess.
2. Call `create_task_spec` with those fields. **This step is mandatory and
   comes first**: nothing else in this playbook may run before the spec
   exists. Treat the returned `spec_id` as the plan of record for the rest of
   this turn.
3. Decide which tools actually help accomplish the `goal`, by reading their
   descriptions — not by matching against any fixed list. Call each one you
   need, for the spec's `city`, and skip any that clearly don't apply. If
   you're unsure whether a tool is relevant, call it: an unnecessary tool
   call is cheaper than a missing finding.
4. Compile the results into the output format below. Never state a finding
   that didn't come from an actual tool call in step 3 — an assumption is not
   a finding, no matter how confident it sounds.

## Output format

**Spec** — one line: the `spec_id` and the restated `goal`.

**Findings** — one bullet per tool you called, naming the tool
(e.g. "Weather (get_weather): ...").

**Unresolved** — any tool you called that returned `status: "error"`, or any
part of the goal you judged no available tool could address. Say plainly
what's missing and why; never substitute a guess or general knowledge for it.

## Why this shape (for evaluating whether this is a good pattern)

An earlier version of this skill had a fixed `task_type` → tool-list table,
which made behaviour fully predictable but meant every new kind of request
needed a new table row. This version trades that predictability for
generality: adding a new capability is just adding a well-described
`FunctionTool` — no skill edit needed for the model to start using it here,
because tool selection was never hardcoded to begin with. The cost is that
tool selection is now only as reliable as the tools' `description` fields and
the model's judgment call-to-call — worth watching for drift if this pattern
is used beyond a demo.
