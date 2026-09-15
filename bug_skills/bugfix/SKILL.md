---
name: bugfix
description: Diagnose a reported bug (including front-end bugs — HTML/CSS, JS/TS, React/Next.js, layout, state, and the API routes the UI relies on), write a fix plan and share it with the user, and only after the user explicitly confirms, apply the fix to the code. Investigate and REPRODUCE the bug from the real code (read_file, list_directory, run_command, fetch_url) before theorising a root cause, record the diagnosis and proposed fix with create_bug_plan, get confirmation via adk_request_input, and only then modify files with apply_file_edit / create_file, verifying the fix afterward. Use whenever the user reports something is broken or behaving wrongly and wants it fixed.
license: Apache-2.0
allowed-tools: read_file, list_directory, run_command, fetch_url, create_bug_plan, apply_file_edit, create_file, adk_request_input
---

# Bug fix

This playbook is for **fixing a bug safely**: understand it from the real code,
propose a plan, get the user's go-ahead, and only then change anything. The one
rule that matters most: **do not edit any file until the user has confirmed the
plan.** A confident-looking fix applied to a misdiagnosed bug is worse than no
fix at all.

You work in four phases, always in this order:
**UNDERSTAND → PLAN → CONFIRM → RESOLVE.**

## When to follow this playbook

Follow it whenever the user reports something broken or misbehaving and wants it
fixed — "X is broken", "this throws", "it should do Y but does Z", "fix the bug
where…". If the user is only asking a question about the code (not asking for a
fix), just answer it; don't run the fix flow.

## Steps

### 1. UNDERSTAND — ground the diagnosis in the real code, and reproduce it

- Restate the reported symptom in one or two sentences so a misread is caught
  early.
- Investigate before theorising. Use `list_directory` to locate the relevant
  files and `read_file` to inspect them. Trace the actual code path involved in
  the symptom — do **not** propose a root cause you have not grounded in
  something you read.
- **Reproduce, don't assume.** A front-end bug is rarely obvious from source:
  - Use `run_command` to surface a build/type/lint/test failure —
    `npm run build`, `npm run lint`, `npx tsc --noEmit`, or the project's test
    command. A stack trace or type error usually points straight at the cause.
  - For a running app, use `fetch_url` against the dev server (e.g.
    `http://localhost:3001/…` — confirm the port, the project's README/`SPECS.md`
    mention 3001) or its API routes, and read the actual rendered HTML / JSON.
    `run_command` kills long-running processes at a timeout, so **don't** start
    the dev server with it — ask the user to have it running, then `fetch_url`.
- **Think in front-end failure modes** when the bug is in the UI. Check the most
  likely culprits for the symptom:
  - **Rendering / layout / CSS** — wrong or missing classes, specificity/
    override, flexbox/grid, responsive breakpoints, z-index/overflow.
  - **State & data flow** — stale or wrong React state, missing/incorrect
    `useEffect` dependencies, props not threaded through, key collisions in
    lists, controlled-vs-uncontrolled inputs.
  - **Events & handlers** — handler not wired, wrong event, `preventDefault`
    missing, stale closures capturing old state.
  - **Data / API boundary** — the component renders fine but the API route
    (e.g. `PUT /api/…`) returns/persists the wrong shape; verify with
    `fetch_url` and by reading the route handler, not just the component.
  - **Build-time** — TypeScript/lint error, bad import, hydration mismatch
    (SSR markup ≠ client) — these show up via `run_command`.
- If the report is too vague to act on — no reproduction steps, unclear which
  behaviour is wrong, you don't know which file/project it's in, or you need the
  dev-server URL/port — call `adk_request_input` with a focused question and
  WAIT for the reply. Do not guess. Prefer offering concrete options ("Is it A
  or B?") when you can.
- Land on a specific root cause (or clearly-labelled hypothesis) tied to real
  lines of code (and, where you got it, the reproduced failure output), not a
  restatement of the symptom.

### 2. PLAN — record the diagnosis and the proposed fix

- Call `create_bug_plan` once with: `title`, `symptom` (incl. repro if known),
  `root_cause`, `affected_files`, `planned_changes` (concrete, ordered, one
  change per item), `verification_steps` (how you'll prove it's fixed),
  optional `risks`, `severity`, `out_of_scope`, and any `decisions` you settled
  with the user.
- This writes a plan file and regenerates `bug-plans/PLANS.md`. **It changes no
  code.** Treat the returned `plan_id` as the plan of record.

### 3. CONFIRM — share the plan and get explicit go-ahead

- Present the plan to the user in the output format below.
- Call `adk_request_input` asking whether to proceed with the fix as described,
  and WAIT for the answer.
- **This is the gate. Do NOT call `apply_file_edit` or `create_file` — do not
  touch any file — until the user has confirmed.** If they want changes, revise
  (go back to step 1 or 2 as needed) and confirm again. If they decline, stop.

### 4. RESOLVE — apply the fix, then report

- Only after confirmation, carry out `planned_changes` with `apply_file_edit`
  (edit existing files via exact-string replacement) and `create_file` (new
  files). Keep each edit minimal and reviewable; match the plan.
- **Verify the fix, don't just claim it.** Re-run the same `run_command`
  (build/lint/test) that reproduced the failure and show it now passes, and/or
  re-`fetch_url` the affected page/route to confirm the corrected output. If you
  couldn't reproduce it programmatically, say so and give the user precise
  manual steps.
- If reality diverges from the plan mid-fix (the code isn't what you expected),
  stop and go back to CONFIRM with an updated plan rather than improvising a
  larger change than the user agreed to.
- When done, report what changed and the verification result, and tell the user
  exactly which `verification_steps` to run themselves.

## Output format

**Bug** — the `plan_id` and the `title`.

**Symptom** — what was reported/observed (with repro if known).

**Root cause** — the grounded diagnosis, citing the file(s)/logic involved.

**Planned changes** — the bulleted `planned_changes`.

**Verification** — the bulleted `verification_steps`.

**Risks / out of scope** — anything recorded in `risks` or `out_of_scope`,
stated plainly so nothing is silently dropped.

After confirmation and RESOLVE, add:

**Applied** — one bullet per file you edited or created, saying what changed.

## Why this shape

The value of a fix is only as good as the diagnosis behind it, and an
unconfirmed edit to someone's code is a liability. So investigation
(`read_file`/`list_directory`) comes before any theory, the plan
(`create_bug_plan`) is written before any edit, and the edits
(`apply_file_edit`/`create_file`) are deliberately gated behind an explicit
user confirmation — the same "ask before you commit to the irreversible step"
discipline the planner agent uses for locking a spec, applied here to modifying
real code.
