# ADK Agents on Amazon Bedrock

Google **ADK** (Agent Development Kit, TypeScript) agents that run on **Amazon
Bedrock** models instead of Gemini, using a small custom model connector — and
that can be deployed to **Amazon Bedrock AgentCore Runtime** as a container.

The TypeScript ADK ships only Gemini/Apigee model support (there is no
`LiteLlm` equivalent like the Python ADK). This repo bridges that gap with
[`bedrock_llm.ts`](bedrock_llm.ts): a `BaseLlm` subclass that translates ADK's
`@google/genai` request/response shapes to and from Bedrock's
[Converse API](https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference.html),
so any model string prefixed with `bedrock/` (e.g.
`bedrock/us.anthropic.claude-sonnet-4-6`) is routed to Bedrock via the AWS SDK.

## What's in here

Several example ADK agents share the same Bedrock connector:

| Agent | File | What it does |
| --- | --- | --- |
| **City assistant** | [`agent.ts`](agent.ts) | Answers questions about a city's time, weather, and location (real geocoding via the free Open-Meteo API), and can follow a persisted "trip-briefing" skill. |
| **Bug fixer** | [`bug_agent.ts`](bug_agent.ts) | A careful bug-fixing agent that works in phases (understand → plan → confirm → resolve). It reads files, runs commands, reproduces the bug, writes a fix plan, and only edits code **after** the user confirms the plan. |
| **Feature planner** | [`planner_agent.ts`](planner_agent.ts) | Turns a free-form request into a structured, persisted feature spec. |
| **Weather agent** | [`weatherAgent.ts`](weatherAgent.ts) | Minimal single-tool starter example. |

Supporting pieces:

- [`bedrock_llm.ts`](bedrock_llm.ts) — the ADK↔Bedrock connector (the core of this repo).
- [`skill_toolset.ts`](skill_toolset.ts) — a local [ADK skills](https://adk.dev) toolset that loads `SKILL.md` files from disk.
- [`agentcore_runtime.ts`](agentcore_runtime.ts) — wraps the `bug_fixer` agent behind the AgentCore Runtime HTTP contract (`POST /invocations`, `GET /ping`) for container deployment.
- [`preflight.mjs`](preflight.mjs) — one-shot check that your AWS auth, region, and model id can actually make a Bedrock call.
- [`agentcore/`](agentcore/) — Amazon Bedrock AgentCore project config + CDK app for cloud deployment.
- [`docs/`](docs/) — a full [ADK↔Bedrock setup guide](docs/adk-bedrock-setup.md) and a build journal.

## Prerequisites

- **Node.js 20+** (developed on Node 22).
- An **AWS account** with **Bedrock model access granted** for the model you
  want, in the region you'll use (model access is per-account, per-region,
  per-model — request it in the Bedrock console).
- AWS credentials that can call Bedrock (SigV4, e.g. an SSO profile). See the
  [setup guide](docs/adk-bedrock-setup.md#5-authentication-the-part-that-usually-breaks)
  for the auth details, which are the usual source of trouble.
- (Optional) [`agentcore` CLI](docs/bedrock-agent-journal.md) if you want to deploy to AgentCore Runtime.

## Local setup

1. **Clone and install**

   ```bash
   git clone https://github.com/kkumawat333/adk-agent.git
   cd adk-agent
   npm install
   ```

2. **Create your `.env`** from the template and fill in real values:

   ```bash
   cp .env.example .env
   ```

   | Variable | Purpose |
   | --- | --- |
   | `AWS_REGION` | Region where your Bedrock model access is enabled. |
   | `BEDROCK_AWS_PROFILE` | AWS profile used for SigV4 auth. Named this (not `AWS_PROFILE`) so a shell-exported `AWS_PROFILE` can't silently shadow it. |
   | `BEDROCK_MODEL` | Model id / inference profile, **with** the `bedrock/` prefix. |
   | `GEMINI_API_KEY` | Only needed if you run an ADK flow against Gemini instead of Bedrock. |

   > `.env` is git-ignored and must never be committed — it holds credentials.
   > Only `.env.example` (placeholders, no secrets) is tracked.

3. **Log in to AWS** (if using SSO) and refresh credentials:

   ```bash
   aws sso login --profile <your-profile>
   ```

4. **Preflight** — verify auth, region, and model id in isolation before
   running an agent:

   ```bash
   npm run preflight
   ```

   It prints the resolved region, model id, and active auth path, then makes one
   minimal Converse call and maps any failure to a likely cause.

5. **Run an agent** (interactive, via the ADK CLI):

   ```bash
   npm run agent:city      # city assistant   (agent.ts)
   npm run agent:bugfix    # bug fixer         (bug_agent.ts)
   npm run agent:planner   # feature planner   (planner_agent.ts)
   ```

   > `.env` is read once at process start. After editing it, restart the agent.

## Choosing a model id

Newer Claude models can't be called by their bare model id — they require a
**cross-region inference profile** (a `us.` / `global.` prefix), otherwise you
get `on-demand throughput isn't supported`. For example use
`bedrock/us.anthropic.claude-sonnet-4-6`, not `bedrock/anthropic.claude-sonnet-4-6`.
See [the setup guide](docs/adk-bedrock-setup.md#6-choosing-a-model-id) for how
to discover valid ids for your account.

## Deploying to Bedrock AgentCore (optional)

[`agentcore_runtime.ts`](agentcore_runtime.ts) exposes the `bug_fixer` agent on
the AgentCore Runtime HTTP contract; [`Dockerfile`](Dockerfile) builds the
container. In the deployed container, model auth uses the runtime's **execution
role** (SigV4 via instance metadata) — do not set `BEDROCK_AWS_PROFILE` there.
The execution role needs `bedrock:InvokeModel` /
`bedrock:InvokeModelWithResponseStream` (see
[`agentcore-bedrock-policy.json`](agentcore-bedrock-policy.json)).

Deployment target account/region live in
[`agentcore/aws-targets.json`](agentcore/aws-targets.json) — set them to your
own account before deploying. See [`AGENTS.md`](AGENTS.md) and the
[build journal](docs/bedrock-agent-journal.md) for the full deployment story
and known limitations (streaming, human-in-the-loop, session persistence).

## Security notes

- **No secrets are committed.** `.env` (and any `.env.*` except `.env.example`)
  is git-ignored, as are `node_modules/`, build artifacts (`dist/`,
  `cdk.out/`), and AgentCore CLI logs (which can contain account ids).
- All AWS account ids, emails, and internal profile/permission-set names in the
  committed docs and config are **placeholders** — replace them with your own.
- Bedrock auth prefers **SigV4** over bearer tokens; do not set
  `AWS_BEARER_TOKEN_BEDROCK` unless your principal is granted
  `bedrock:CallWithBearerToken`.

## License

[MIT](LICENSE)
