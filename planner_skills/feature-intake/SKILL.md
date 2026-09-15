---
name: feature-intake
description: Turn one or more rough feature requests for the planner project into a single, comprehensive, agreed, LOCKED spec. Gather every feature the user wants, surface the ambiguities and scope decisions each one leaves open, ask the user about the ones that genuinely change the outcome (via adk_request_input) instead of guessing, and only once nothing blocking remains, persist ALL of them in one document with create_project_spec. Use whenever the user describes features they want in their planner project.
license: Apache-2.0
allowed-tools: read_requirements_file, create_project_spec, adk_request_input
---

# Feature intake

This playbook is for **capturing and locking requirements**, not for building.
The output is **one comprehensive spec** that comprises every feature the user
asked for — never a separate file per feature, and never a spec that quietly
papered over a decision the user should have made.

The core discipline is one rule: **ask before you lock.** A feature request
almost always leaves real choices open (who it's for, where the boundary is,
what happens in the awkward cases). Resolve the ones that change the outcome
*with the user* before writing anything.

## When to follow this playbook

Follow it whenever the user describes one or more features they want in the
planner project — anything of the shape "I want the planner to…", "can we
add…", "implement these…". If the user is instead asking a plain question about
an existing spec or the project, just answer it; don't run intake.

## Steps

1. **Assemble the full list of features.** If the user gave a file path, call
   `read_requirements_file` first and read it. Then write down **every** feature
   or gap to be specified. If a doc lists many, capture them all now — the final
   spec must comprise all of them, so do not drop or defer any silently.

2. **Restate the set.** Briefly list back the features you understood, so a
   misread is caught before it costs anything.

3. **Find the open decisions — across all features.** For each feature, list
   what the request does *not* pin down. Look especially for:
   - **Scope / boundary** — what is in, and what is deliberately out.
   - **Users & permissions** — who can do this; does role or ownership matter.
   - **Data & state** — what is stored, edited, deleted; what happens to
     existing data.
   - **Behaviour in the awkward cases** — empty states, conflicts, concurrent
     edits, limits, failures, undo.
   - **Non-functional needs** — scale, latency, offline, accessibility, only
     when the feature plausibly implies them.
   - **Dependencies & priority** — does it rely on something not built yet; how
     the features rank against each other.

4. **Triage each open decision.**
   - If it **genuinely changes the outcome** (scope, behaviour, or what "done"
     means) → it is *blocking*. You must ask.
   - If a **sensible default exists** and getting it slightly wrong is cheap →
     don't interrupt. Assume the default, and record it in that feature's
     `decisions` as a stated assumption (e.g. question: "Sort order?", answer:
     "Assumed newest-first — not confirmed").

5. **Ask the blocking questions.** For each blocking decision, call
   `adk_request_input` with a *focused* question and WAIT for the reply. Do not
   guess and do not silently pick one interpretation. Batch tightly related
   questions (including ones spanning several features) into a single
   `adk_request_input` call rather than dripping them out, but keep unrelated
   decisions in separate asks so the user can answer clearly. Where helpful,
   offer the concrete options you see ("A: …, B: …") so the user can just pick.

6. **Repeat until nothing blocking remains** for any feature. A user's answer
   may open a new decision; if it is blocking, go back to step 5. Stop when
   every remaining unknown, across all features, is non-blocking.

7. **Lock the whole thing in one call.** Call `create_project_spec` **exactly
   once**, with:
   - `project` (e.g. "personal-planner"),
   - a short integrated `overview` tying the features together,
   - a `features` array containing **every** feature, each with its `title`,
     `summary`, `motivation`, `requirements`, `acceptance_criteria`, the full
     `decisions` audit trail (every question asked + answer, plus any
     stated-default assumptions), `out_of_scope`, any non-blocking
     `open_questions`, and `priority` if given.
   This is the only step that writes anything, and it must come after step 6.
   **Never** call it once per feature.

8. **Report back** in the output format below, using the returned `markdown_path`
   (`feature-specs/project-spec.md`) — point the user at that one file.

## Output format

**Spec** — the returned `spec_id`, the `feature_count`, and the `markdown_path`.

**Overview** — the integrated `overview` you wrote.

**Features** — one short block per feature: its title, a one-line summary, and
the key decisions that were settled (mark stated-default assumptions as such).

**Out of scope / open questions** — anything recorded across the features'
`out_of_scope` or `open_questions`, stated plainly so nothing is silently dropped.

## Why this shape

The spec is only worth as much as the decisions behind it are real, and it is
most useful as **one document a person can read end to end** rather than
scattered fragments. So the write (`create_project_spec`) is deliberately the
*last* step and happens *once*, every choice that shaped it is captured in each
feature's `decisions`, and the whole set is tied together by a single overview.
