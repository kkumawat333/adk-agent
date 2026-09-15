import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {FunctionTool, LlmAgent, LLMRegistry, requestInputTool} from '@google/adk';
import {z} from 'zod';
import {BedrockLlm} from './bedrock_llm.js';
import {LocalSkillToolset} from './skill_toolset.js';

// Register the Bedrock connector so any `bedrock/...` model string resolves to
// it. (Same registration `agent.ts` / `planner_agent.ts` do — harmless to call
// more than once.)
LLMRegistry.register(BedrockLlm);

const PROJECT_ROOT = path.dirname(fileURLToPath(import.meta.url));

// Persisted bug-fix plans live here, one JSON file per plan, plus a single
// consolidated human-readable `PLANS.md` rebuilt from all of them. This is the
// auditable record of what the agent proposed and what the user confirmed
// before any file was touched — the analogue of `feature-specs/` for the
// planner agent. Generated at runtime, gitignored, not checked in.
const BUG_PLANS_DIR = path.join(PROJECT_ROOT, 'bug-plans');

// The single human-readable file, rebuilt from every persisted plan on each write.
const PLANS_MARKDOWN_PATH = path.join(BUG_PLANS_DIR, 'PLANS.md');

/** Undo the HTML entity escaping a model sometimes applies to `<`, `>`, `&`. */
function unescapeHtml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Renders one persisted bug-fix plan as a Markdown section. */
function renderPlanMarkdown(plan: Record<string, any>): string {
  const clean = (s: unknown) => unescapeHtml(String(s ?? ''));
  const bullets = (items: unknown): string =>
    Array.isArray(items) && items.length
      ? items.map((i) => `- ${clean(i)}`).join('\n')
      : '_None._';

  const severity = plan.severity ? ` _(severity: ${clean(plan.severity)})_` : '';
  const lines: string[] = [
    `## ${clean(plan.title)}${severity}`,
    '',
    `\`${plan.plan_id}\` · ${plan.status ?? 'planned'} · ${plan.created_at ?? ''}`,
    '',
    `**Symptom** — ${clean(plan.symptom)}`,
    '',
    `**Root cause** — ${clean(plan.root_cause)}`,
    '',
    '**Affected files**',
    bullets(plan.affected_files),
    '',
    '**Planned changes**',
    bullets(plan.planned_changes),
    '',
    '**Verification steps**',
    bullets(plan.verification_steps),
  ];
  if (Array.isArray(plan.risks) && plan.risks.length) {
    lines.push('', '**Risks / side effects**', bullets(plan.risks));
  }
  if (Array.isArray(plan.decisions) && plan.decisions.length) {
    lines.push(
      '',
      '**Decisions made**',
      plan.decisions
        .map((d: any) => `- ${clean(d.question)} → ${clean(d.answer)}`)
        .join('\n'),
    );
  }
  if (Array.isArray(plan.out_of_scope) && plan.out_of_scope.length) {
    lines.push('', '**Out of scope**', bullets(plan.out_of_scope));
  }
  if (plan.notes) {
    lines.push('', `**Notes** — ${clean(plan.notes)}`);
  }
  return lines.join('\n');
}

/**
 * Rebuilds `bug-plans/PLANS.md` from every `*.json` plan on disk, so there is
 * always one human-readable file covering all bug-fix plans, in sync with the
 * machine-readable JSON. Deterministic (code-rendered, not model-written).
 */
export async function rebuildPlansMarkdown(): Promise<string> {
  const entries = await fs.readdir(BUG_PLANS_DIR);
  const plans: Array<Record<string, any>> = [];
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = await fs.readFile(path.join(BUG_PLANS_DIR, name), 'utf-8');
      plans.push(JSON.parse(raw));
    } catch {
      // Skip anything unparseable rather than fail the whole rebuild.
    }
  }
  plans.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));

  const header = [
    '# Bug Fixer — Fix Plans',
    '',
    `_Generated from \`bug-plans/*.json\` · ${plans.length} plan${plans.length === 1 ? '' : 's'} · last updated ${new Date().toISOString()}._`,
    '',
    '> Do not edit by hand — this file is regenerated whenever a plan is written.',
  ].join('\n');

  const body = plans.map(renderPlanMarkdown).join('\n\n---\n\n');
  const doc = plans.length ? `${header}\n\n${body}\n` : `${header}\n`;
  await fs.writeFile(PLANS_MARKDOWN_PATH, doc, 'utf-8');
  return PLANS_MARKDOWN_PATH;
}

const MAX_FILE_BYTES = 256 * 1024;

/**
 * Reads a local text file so the agent can inspect the buggy code and
 * surrounding context while it forms its understanding of the bug. Read-only
 * and text-only — it never writes, and refuses binary or oversized files rather
 * than dumping garbage into the conversation. Mirrors `planner_agent.ts`'s
 * `read_requirements_file`, generalized to any file.
 */
const readFile = new FunctionTool({
  name: 'read_file',
  description:
    'Reads a local text/source file and returns its contents, so you can ' +
    'inspect the buggy code and its surroundings while diagnosing the bug. ' +
    'Use this during the UNDERSTAND phase to gather evidence before proposing ' +
    'a root cause. Read-only.',
  parameters: z.object({
    path: z
      .string()
      .describe(
        'Path to the file to read. Absolute, or relative to where the agent ' +
          'was started.',
      ),
  }),
  execute: async ({path: filePath}) => {
    const resolved = path.resolve(filePath);
    let stat;
    try {
      stat = await fs.stat(resolved);
    } catch {
      return {status: 'error', error_message: `No file found at '${resolved}'.`};
    }
    if (!stat.isFile()) {
      return {status: 'error', error_message: `'${resolved}' is not a file.`};
    }
    if (stat.size > MAX_FILE_BYTES) {
      return {
        status: 'error',
        error_message: `File is ${stat.size} bytes; refusing to read more than ${MAX_FILE_BYTES}. Read a smaller file or the relevant part.`,
      };
    }
    const buffer = await fs.readFile(resolved);
    // Reject files with NUL bytes — a cheap "this is binary, not text" check.
    if (buffer.includes(0)) {
      return {
        status: 'error',
        error_message: `'${resolved}' looks like a binary file, not text.`,
      };
    }
    return {status: 'success', path: resolved, content: buffer.toString('utf-8')};
  },
});

/**
 * Lists the entries of a directory (names + whether each is a file or a
 * subdirectory), so the agent can locate the files relevant to a bug without
 * guessing paths. Read-only. Skips `node_modules` and dotfiles in the count-
 * heavy case is left to the model's judgement — this just reports what's there.
 */
const listDirectory = new FunctionTool({
  name: 'list_directory',
  description:
    'Lists the files and subdirectories directly inside a directory, so you ' +
    'can find the code relevant to a bug. Use during the UNDERSTAND phase to ' +
    'locate files before reading them. Read-only, non-recursive.',
  parameters: z.object({
    path: z
      .string()
      .describe(
        'Path to the directory to list. Absolute, or relative to where the ' +
          'agent was started.',
      ),
  }),
  execute: async ({path: dirPath}) => {
    const resolved = path.resolve(dirPath);
    let stat;
    try {
      stat = await fs.stat(resolved);
    } catch {
      return {status: 'error', error_message: `No directory found at '${resolved}'.`};
    }
    if (!stat.isDirectory()) {
      return {status: 'error', error_message: `'${resolved}' is not a directory.`};
    }
    const dirents = await fs.readdir(resolved, {withFileTypes: true});
    const entries = dirents.map((d) => ({
      name: d.name,
      type: d.isDirectory() ? 'dir' : d.isFile() ? 'file' : 'other',
    }));
    return {status: 'success', path: resolved, entries};
  },
});

/**
 * Persists the agreed bug-fix PLAN (as JSON) and regenerates a single
 * human-readable `bug-plans/PLANS.md` covering all plans. This is the artifact
 * the agent shares with the user for confirmation. The model fills the
 * structured fields from its investigation; the tool does no diagnosis itself.
 *
 * IMPORTANT: writing the plan does NOT resolve the bug — no file is modified by
 * this tool. Applying the fix (`apply_file_edit` / `create_file`) must wait for
 * the user's explicit confirmation of this plan.
 */
const createBugPlan = new FunctionTool({
  name: 'create_bug_plan',
  description:
    'Persists a structured bug-fix PLAN (as JSON) and regenerates a single ' +
    'human-readable `bug-plans/PLANS.md`. Returns the plan with a `plan_id`, ' +
    'the JSON path, and the Markdown path. Call this once you understand the ' +
    'bug — it records the diagnosis and the proposed fix so you can share it ' +
    'with the user for confirmation. This tool does NOT change any code; it ' +
    'only writes the plan. Do not apply the fix until the user confirms the ' +
    'plan (via `adk_request_input`).',
  parameters: z.object({
    title: z
      .string()
      .describe('Short name for the bug, e.g. "Bookmark edit drops group value".'),
    symptom: z
      .string()
      .describe(
        'What the user observes going wrong — the reported/observed behaviour, ' +
          'in plain language, including how to reproduce it if known.',
      ),
    root_cause: z
      .string()
      .describe(
        'The underlying cause you diagnosed, tied to specific code/logic — not ' +
          'a restatement of the symptom. Say if it is a hypothesis vs confirmed.',
      ),
    affected_files: z
      .array(z.string())
      .describe(
        'The files (paths) the fix will touch or that are central to the bug.',
      ),
    planned_changes: z
      .array(z.string())
      .describe(
        'The concrete, ordered steps of the proposed fix — one unambiguous ' +
          'change per item, specific enough that the user can judge it.',
      ),
    verification_steps: z
      .array(z.string())
      .describe(
        'How the fix will be verified (tests to run, commands, manual checks) ' +
          'so "done" is objectively checkable.',
      ),
    risks: z
      .array(z.string())
      .optional()
      .describe(
        'Known risks or side effects of the change (regressions, data, scope).',
      ),
    decisions: z
      .array(
        z.object({
          question: z.string().describe('A clarifying question you asked the user.'),
          answer: z
            .string()
            .describe("The user's answer that resolved it (or the agreed default)."),
        }),
      )
      .optional()
      .describe(
        'Any ambiguities about the bug or the fix you surfaced and how they ' +
          'were settled with the user.',
      ),
    out_of_scope: z
      .array(z.string())
      .optional()
      .describe('Related problems explicitly NOT being fixed by this plan.'),
    severity: z
      .enum(['low', 'medium', 'high', 'critical'])
      .optional()
      .describe('How severe the bug is, if you can judge it.'),
    notes: z.string().optional().describe('Any extra context worth carrying forward.'),
  }),
  execute: async (args) => {
    const plan = {
      plan_id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      created_at: new Date().toISOString(),
      status: 'planned' as const,
      ...args,
    };
    await fs.mkdir(BUG_PLANS_DIR, {recursive: true});
    const planPath = path.join(BUG_PLANS_DIR, `${plan.plan_id}.json`);
    await fs.writeFile(planPath, JSON.stringify(plan, null, 2), 'utf-8');
    const markdownPath = await rebuildPlansMarkdown();
    return {status: 'success', plan, plan_path: planPath, markdown_path: markdownPath};
  },
});

/**
 * Applies the fix to an EXISTING file by replacing an exact string. This is a
 * WRITE — it mutates a real file on disk, and is the "resolve the bug" step. It
 * must only be called AFTER the user has confirmed the plan via
 * `adk_request_input`. Uses exact-string replacement (like a surgical patch)
 * rather than rewriting whole files, so the change stays minimal and reviewable.
 */
const applyFileEdit = new FunctionTool({
  name: 'apply_file_edit',
  description:
    'RESOLVES the bug by editing an existing file: replaces an exact ' +
    '`old_string` with `new_string`. This WRITES to disk. Only call it AFTER ' +
    'the user has confirmed the plan (via `adk_request_input`). `old_string` ' +
    'must match the file exactly (including whitespace) and, unless ' +
    '`replace_all` is true, must be unique in the file — otherwise the edit is ' +
    'refused so you never patch the wrong place. To create a brand-new file, ' +
    'use `create_file` instead.',
  parameters: z.object({
    path: z
      .string()
      .describe('Path to the existing file to edit. Absolute or relative.'),
    old_string: z
      .string()
      .describe(
        'The exact text to replace, copied verbatim from the file (include ' +
          'enough surrounding context to make it unique).',
      ),
    new_string: z
      .string()
      .describe('The text to replace it with. Must differ from `old_string`.'),
    replace_all: z
      .boolean()
      .optional()
      .describe('Replace every occurrence instead of requiring a unique match.'),
  }),
  execute: async ({path: filePath, old_string, new_string, replace_all}) => {
    const resolved = path.resolve(filePath);
    if (old_string === new_string) {
      return {
        status: 'error',
        error_message: '`new_string` must differ from `old_string`.',
      };
    }
    let stat;
    try {
      stat = await fs.stat(resolved);
    } catch {
      return {
        status: 'error',
        error_message: `No file found at '${resolved}'. To create a new file, use create_file.`,
      };
    }
    if (!stat.isFile()) {
      return {status: 'error', error_message: `'${resolved}' is not a file.`};
    }
    const buffer = await fs.readFile(resolved);
    if (buffer.includes(0)) {
      return {
        status: 'error',
        error_message: `'${resolved}' looks like a binary file, not text.`,
      };
    }
    const content = buffer.toString('utf-8');
    const occurrences = content.split(old_string).length - 1;
    if (occurrences === 0) {
      return {
        status: 'error',
        error_message: `\`old_string\` was not found in '${resolved}'. Re-read the file and copy the text exactly.`,
      };
    }
    if (occurrences > 1 && !replace_all) {
      return {
        status: 'error',
        error_message: `\`old_string\` appears ${occurrences} times in '${resolved}'. Add more surrounding context to make it unique, or set replace_all.`,
      };
    }
    const updated = replace_all
      ? content.split(old_string).join(new_string)
      : content.replace(old_string, new_string);
    await fs.writeFile(resolved, updated, 'utf-8');
    return {
      status: 'success',
      path: resolved,
      replacements: replace_all ? occurrences : 1,
    };
  },
});

/**
 * Creates a brand-new file as part of resolving the bug (e.g. a missing seed
 * file or a new module). This is a WRITE — call it only after the user has
 * confirmed the plan. Refuses to clobber an existing file unless `overwrite` is
 * explicitly set, so it can't silently destroy code.
 */
const createFile = new FunctionTool({
  name: 'create_file',
  description:
    'RESOLVES the bug by creating a new file with the given contents. This ' +
    'WRITES to disk. Only call it AFTER the user has confirmed the plan. ' +
    'Refuses to overwrite an existing file unless `overwrite` is true — to ' +
    'change existing code, use `apply_file_edit` instead.',
  parameters: z.object({
    path: z.string().describe('Path of the file to create. Absolute or relative.'),
    content: z.string().describe('The full contents to write into the new file.'),
    overwrite: z
      .boolean()
      .optional()
      .describe('Allow replacing the file if it already exists (default false).'),
  }),
  execute: async ({path: filePath, content, overwrite}) => {
    const resolved = path.resolve(filePath);
    let exists = false;
    try {
      await fs.stat(resolved);
      exists = true;
    } catch {
      exists = false;
    }
    if (exists && !overwrite) {
      return {
        status: 'error',
        error_message: `'${resolved}' already exists. Use apply_file_edit to change it, or set overwrite to replace it.`,
      };
    }
    await fs.mkdir(path.dirname(resolved), {recursive: true});
    await fs.writeFile(resolved, content, 'utf-8');
    return {status: 'success', path: resolved, created: !exists, overwritten: exists};
  },
});

// Front-end bugs are rarely visible from source alone — you have to run the
// project to see the compile/type/lint error or the broken behaviour, and often
// look at what the app actually serves. These two tools give the agent that
// "reproduce and verify" loop.

const MAX_OUTPUT_CHARS = 20_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const MAX_COMMAND_TIMEOUT_MS = 600_000;

/** Truncate long tool output so a noisy build log can't blow up the context. */
function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return (
    text.slice(0, MAX_OUTPUT_CHARS) +
    `\n… [truncated ${text.length - MAX_OUTPUT_CHARS} more chars]`
  );
}

/**
 * Runs a project command so the agent can REPRODUCE a bug (e.g. `npm run build`,
 * `npm run lint`, `tsc --noEmit`, a test command) and later VERIFY the fix.
 * Captures stdout+stderr and the exit code. It is meant for finite,
 * reproduce/verify commands — it always kills the process at a timeout, so a
 * long-running dev server will be terminated rather than blocking the turn (for
 * a running app, have the user start the server and use `fetch_url` instead).
 * This is a real side-effecting capability; the model is told (in the skill and
 * instruction) to use it for diagnosis/verification, not for destructive work.
 */
const runCommand = new FunctionTool({
  name: 'run_command',
  description:
    'Runs a shell command in the project (e.g. `npm run build`, `npm run ' +
    'lint`, `npx tsc --noEmit`, a test command) and returns its stdout, ' +
    'stderr, and exit code. Use this to REPRODUCE a front-end bug (surface the ' +
    'compile/type/lint/test failure) during UNDERSTAND, and to VERIFY the fix ' +
    'after RESOLVE. It always stops the process at a timeout, so do NOT use it ' +
    'to start a long-running dev server — for a running app, ask the user to ' +
    'start it and use `fetch_url`. Keep to reproduce/verify commands, not ' +
    'destructive ones.',
  parameters: z.object({
    command: z
      .string()
      .describe('The shell command to run, e.g. "npm run build".'),
    cwd: z
      .string()
      .optional()
      .describe(
        'Working directory to run in (the project root of the app under ' +
          'investigation). Absolute or relative; defaults to where the agent ' +
          'was started.',
      ),
    timeout_ms: z
      .number()
      .optional()
      .describe(
        `How long to allow before killing the process. Default ${DEFAULT_COMMAND_TIMEOUT_MS}ms, max ${MAX_COMMAND_TIMEOUT_MS}ms.`,
      ),
  }),
  execute: async ({command, cwd, timeout_ms}) => {
    const resolvedCwd = cwd ? path.resolve(cwd) : process.cwd();
    try {
      const stat = await fs.stat(resolvedCwd);
      if (!stat.isDirectory()) {
        return {status: 'error', error_message: `cwd '${resolvedCwd}' is not a directory.`};
      }
    } catch {
      return {status: 'error', error_message: `cwd '${resolvedCwd}' does not exist.`};
    }
    const timeout = Math.min(
      Math.max(timeout_ms ?? DEFAULT_COMMAND_TIMEOUT_MS, 1_000),
      MAX_COMMAND_TIMEOUT_MS,
    );

    return await new Promise((resolve) => {
      const child = spawn(command, {cwd: resolvedCwd, shell: true});
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeout);

      child.stdout?.on('data', (d) => {
        stdout += d.toString();
      });
      child.stderr?.on('data', (d) => {
        stderr += d.toString();
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({
          status: 'error',
          error_message: `Failed to run command: ${err.message}`,
        });
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        resolve({
          status: 'success',
          command,
          cwd: resolvedCwd,
          exit_code: code,
          signal,
          timed_out: timedOut,
          stdout: truncate(stdout),
          stderr: truncate(stderr),
        });
      });
    });
  },
});

/**
 * Fetches a URL (typically the running dev server, e.g.
 * http://localhost:3001/…, or an API route) and returns the status, headers,
 * and body, so the agent can inspect the actual rendered HTML or API JSON when
 * diagnosing a front-end/API bug. Read-only GET only.
 */
const fetchUrl = new FunctionTool({
  name: 'fetch_url',
  description:
    'HTTP GET a URL — usually the running dev server (e.g. ' +
    'http://localhost:3001/...) or an API route — and return the status, ' +
    'content-type, and body. Use it to inspect the actual rendered HTML or the ' +
    'API JSON a front-end bug depends on, once the app is running. Read-only.',
  parameters: z.object({
    url: z.string().describe('The http(s) URL to GET.'),
    timeout_ms: z
      .number()
      .optional()
      .describe('How long to wait before giving up. Default 15000ms.'),
  }),
  execute: async ({url, timeout_ms}) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return {status: 'error', error_message: `'${url}' is not a valid URL.`};
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return {status: 'error', error_message: 'Only http and https URLs are supported.'};
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout_ms ?? 15_000);
    let response: Response;
    try {
      response = await fetch(url, {signal: controller.signal});
    } catch (err) {
      clearTimeout(timer);
      return {
        status: 'error',
        error_message: `Could not fetch '${url}': ${(err as Error).message}. Is the dev server running?`,
      };
    }
    clearTimeout(timer);
    const body = await response.text();
    return {
      status: 'success',
      url,
      http_status: response.status,
      content_type: response.headers.get('content-type') ?? undefined,
      body: truncate(body),
    };
  },
});

// The bug-fix playbook (understand → plan → confirm → resolve) lives in a skill
// so the "confirm before resolving" discipline is a documented, inspectable
// artifact editable without touching this file. A dedicated skills dir keeps
// this agent's catalogue to just the bugfix skill (the shared `skills/` and
// `planner_skills/` dirs carry unrelated skills).
const skillToolset = new LocalSkillToolset(path.join(PROJECT_ROOT, 'bug_skills'));

export const rootAgent = new LlmAgent({
  name: 'bug_fixer',
  model: process.env.BEDROCK_MODEL ?? 'bedrock/us.anthropic.claude-sonnet-4-6',
  description:
    'Diagnoses a reported bug, writes a fix plan and shares it with the user, ' +
    'and only after the user confirms does it apply the fix to the code.',
  instruction: [
    'You are a careful bug-fixing agent, comfortable with front-end bugs',
    '(HTML/CSS, JavaScript/TypeScript, React/Next.js, layout & styling, state,',
    'hooks, hydration, and the API routes the UI depends on). You work in four',
    'phases, in order: UNDERSTAND → PLAN → CONFIRM → RESOLVE. Follow the `bugfix`',
    'skill for the full playbook; load it before you begin.',
    '',
    'UNDERSTAND: investigate before theorising. Use `read_file` and',
    '`list_directory` to inspect the actual code, and REPRODUCE the bug rather',
    'than assuming it: `run_command` to surface a compile/type/lint/test failure',
    '(e.g. `npm run build`, `npm run lint`, `npx tsc --noEmit`), and — for a',
    'running app — `fetch_url` to inspect the rendered HTML or API JSON the',
    'front-end depends on. Do not guess a root cause you have not grounded in',
    'something you read or reproduced. If the report is too vague to act on',
    '(missing repro steps, unclear which behaviour is wrong, you need a file',
    'path or the dev-server URL/port), call `adk_request_input` to ask a focused',
    'question and WAIT for the reply.',
    '',
    'PLAN: once you have a grounded diagnosis, call `create_bug_plan` to record',
    'the symptom, root cause, affected files, the concrete proposed changes,',
    'and how you will verify the fix. This only writes a plan — it changes no',
    'code.',
    '',
    'CONFIRM: share the plan with the user and call `adk_request_input` to ask',
    'for explicit confirmation to proceed. WAIT for their answer. This gate is',
    'the single most important rule: DO NOT modify any file (do not call',
    '`apply_file_edit` or `create_file`) until the user has confirmed the plan.',
    'If they ask for changes, revise the plan and confirm again.',
    '',
    'RESOLVE: only after confirmation, apply the fix with `apply_file_edit`',
    '(edit existing files) and `create_file` (new files), following the plan.',
    'Keep edits minimal and reviewable. Then VERIFY it — re-run the same',
    '`run_command` (build/lint/test) and/or `fetch_url` you used to reproduce,',
    'to show the failure is gone — and report what you changed plus the',
    'verification steps the user should run.',
  ].join('\n'),
  tools: [
    readFile,
    listDirectory,
    runCommand,
    fetchUrl,
    createBugPlan,
    applyFileEdit,
    createFile,
    requestInputTool,
    skillToolset,
  ],
});
