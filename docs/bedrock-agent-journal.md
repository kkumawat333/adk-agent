# Bedrock Agent Build Journal

A human-readable record of how this Google ADK agent is wired to Amazon Bedrock and
deployed on Bedrock AgentCore. Newest entries at the top.

---

## Current state

**Integration: WORKING (locally verified)**
- Google ADK `bug_fixer` agent runs end-to-end inside an AgentCore-compatible container.
- ADK → `BedrockLlm` connector → Bedrock Converse API → `us.anthropic.claude-sonnet-4-6` confirmed live.
- Container starts, Fastify listens on port 8080, responds to `POST /invocations` with correct ADK text output.

**AWS cloud deploy: BLOCKED (sandbox IAM constraints)**
- `agentcore deploy` (CDK-backed) requires `iam:PassRole` for `cdk-hnb659fds-cfn-exec-role-123456789012-us-east-1`.
- The `YourPermissionSet` SSO role does not have this permission; neither can it assume the CDK deploy role.
- CDKToolkit bootstrap exists in `us-east-1` (but not `us-east-2`); the existing `AgentCore-ChatbotAppAgent-default` stack was deployed by a principal with broader permissions.
- Resolution required: AWS admin must grant `iam:PassRole` for the CDK CFN execution role, OR deploy the stack on our behalf.

## Open questions / TODO

- [ ] **Cloud deploy unblocked**: Get `iam:PassRole` for `cdk-hnb659fds-cfn-exec-role-123456789012-us-east-1` added to the `YourPermissionSet` permission set. (Ask AWS admin.)
- [ ] **Bedrock region for container**: Changed deploy target to `us-east-1` (CDKToolkit pre-exists); also updated container `AWS_REGION=us-east-1`. The `us.anthropic.claude-sonnet-4-6` cross-region profile routes across US; model access was verified in `us-east-2`, which the profile covers.
- [ ] **Streaming**: `BedrockLlm.generateContentAsync` yields a single complete response; `connect()` throws. Wire up `ConverseStreamCommand` if streaming is needed.
- [ ] **Tool-calling round-trips**: Multi-turn `toolUse` → `toolResult` confirmed as the most likely failure point in `bedrock_llm.ts`. Has not been exercised end-to-end on Bedrock.
- [ ] **Human-in-the-loop (`adk_request_input`)**: Triggers an ADK event-loop yield/pause; a single AgentCore `POST /invocations` has no resume channel. `InMemoryRunner` state is per-microVM (resets on cold start). Both need architectural resolution (e.g. durable session service, client-side conversational loop).
- [ ] **Filesystem / shell tools in `bug_fixer`**: `read_file`, `list_directory`, `run_command`, `fetch_url` assume a writable local filesystem. In the stateless AgentCore container these can run (ephemeral storage exists), but there is no persistence across invocations.

---

## Timeline

### 2026-09-15 — AWS account ID moved out of committed config into `.env`

**Change: account ID is now an env var injected at CDK synth time.**
- `agentcore/aws-targets.json` keeps the committed `000000000000` placeholder
  (must stay 12 digits — schema `@regex ^[0-9]{12}$` in
  `agentcore/.llm-context/aws-targets.ts`, so a `${VAR}` string can't live in
  the JSON).
- Added `AWS_ACCOUNT_ID` to `.env` (real, git-ignored) and `.env.example`
  (placeholder `123456789012`).
- `agentcore/cdk/bin/cdk.ts`: `main()` calls `process.loadEnvFile(<root>/.env)`
  when `AWS_ACCOUNT_ID` isn't already set (existing env vars win); new
  `resolveAccount()` prefers `process.env.AWS_ACCOUNT_ID` over the JSON value,
  and throws a clear error if it's missing, still the placeholder, or not 12
  digits.
- Net effect: the real account ID lives only in the local `.env` and is never
  committed. Verified `tsc --noEmit` passes and the resolver accepts a valid
  env value while rejecting the placeholder / invalid input.

### 2026-09-15 — Prepared repo for public GitHub publish (security hardening)

**Decision: publish to a personal GitHub repo, scrubbed of internal identifiers.**
- Hardened root `.gitignore` to exclude all `node_modules/`, `dist/`, CDK
  `cdk.out/`, and `agentcore/.cli/logs/` (the logs embed the account id and
  request data), plus the runtime-generated `bug-plans/`, `specs/`,
  `feature-specs/`.
- `.env` was already git-ignored; added `.env.example` documenting the four env
  vars (`GEMINI_API_KEY`, `AWS_REGION`, `BEDROCK_AWS_PROFILE`, `BEDROCK_MODEL`)
  with placeholder values and no secrets.
- Scrubbed internal identifiers from committed files: real AWS account id
  `620734…` → `123456789012`, permission-set name → `YourPermissionSet`, SSO
  profile names → generic placeholders, in `docs/adk-bedrock-setup.md`,
  `docs/bedrock-agent-journal.md`, and `agentcore/aws-targets.json`.
- Added a top-level `README.md` (what the agents are + local setup).

### 2026-09-10 — End-to-end local verification; cloud deploy blocked by sandbox IAM

**Discovery: ADK → Bedrock path fully working in-container.**
- Built the container image locally with `agentcore dev --runtime bug_fixer --logs`.
- Sent a real prompt; the container responded correctly via `us.anthropic.claude-sonnet-4-6` in `us-east-1`.
- This confirms: `BedrockAgentCoreApp` HTTP contract → `InMemoryRunner` → `LlmAgent` → `BedrockLlm` → Bedrock Converse → Claude Sonnet all work together.

**Discovery: `agentcore deploy` blocked by sandbox IAM.**
- `agentcore deploy` synthesizes CDK, then calls CloudFormation with a CDK execution role.
- The sandbox SSO role (`YourPermissionSet`) lacks `iam:PassRole` for `cdk-hnb659fds-cfn-exec-role-123456789012-us-east-1`.
- Attempting to assume the CDK deploy role also fails (`sts:AssumeRole` not permitted).
- CDK bootstrap does not exist in `us-east-2` (CreateChangeSet denied); does exist in `us-east-1` — switched target to `us-east-1` for future deploy attempt.

**Decision: switched deploy target from `us-east-2` to `us-east-1`.**
- `CDKToolkit` stack is `CREATE_COMPLETE` in `us-east-1`; not present in `us-east-2`.
- `us.anthropic.claude-sonnet-4-6` is a cross-region inference profile covering all US regions; Bedrock model access verified in `us-east-2` satisfies the profile.
- Updated `agentcore/aws-targets.json` and the container `AWS_REGION` env var to `us-east-1`.
  - Source: AWS CDK bootstrap behavior (local file inspection)

**Decision: `runtimeVersion: NODE_22` (was `PYTHON_3_14`).**
- The entrypoint is `agentcore_runtime.ts` (Node.js/tsx). `PYTHON_3_14` was a copy-paste error from the agentcore CLI scaffold template (it defaults to Python). For a `Container` build the runtime version is metadata for the CLI; the Dockerfile controls the actual runtime (`node:22-slim`).

**Decision: `envVars` in `agentcore.json` for container credentials.**
- `AWS_REGION=us-east-1`, `BEDROCK_MODEL=bedrock/us.anthropic.claude-sonnet-4-6` added to the `bug_fixer` runtime in `agentcore/agentcore.json`.
- `.env` is dockerignored — env vars must be declared in `agentcore.json` (injected by AgentCore Runtime as container env at runtime).
- `BEDROCK_AWS_PROFILE` deliberately NOT set: in-container auth uses the execution role (SigV4 via instance metadata), not a named profile.

**Decision: `additionalPolicies` referencing `agentcore-bedrock-policy.json`.**
- The AgentCore Runtime execution role (created by CDK) must have `bedrock:InvokeModel` + `bedrock:InvokeModelWithResponseStream`.
- Added an inline policy file (`agentcore-bedrock-policy.json`) at the project root, referenced from `agentcore.json` via `additionalPolicies`.
- Policy allows both actions on `arn:aws:bedrock:*::foundation-model/anthropic.*` and `arn:aws:bedrock:*:*:inference-profile/us.anthropic.*`.

**Discovery: agentcore CLI requires AWS CLI ≥ v2.32.0.**
- `agentcore deploy` detected AWS CLI v2.27.53 and refused with "Update AWS CLI from v2.27.53 to v2.32.0+".
- Resolved by `brew upgrade awscli` → v2.36.42. (No `sudo` needed via Homebrew.)
- The new `aws login` command (used by agentcore's credential check) conflicts with existing SSO profiles; `aws sso login --profile your-aws-profile` still works for SSO refresh.

**Discovery: preflight.mjs uses default credential chain, not BEDROCK_AWS_PROFILE.**
- `preflight.mjs` creates `BedrockRuntimeClient({region})` without passing `profile`.
- Must run with `AWS_PROFILE=your-aws-profile node --env-file=.env preflight.mjs` to get the right profile.
- `bedrock_llm.ts` correctly reads `process.env.BEDROCK_AWS_PROFILE` and passes it to the client.

**Discovery: stale shell-exported credentials override `.env`.**
- The shell had `AWS_ACCESS_KEY_ID` and `AWS_PROFILE=some-other-profile` exported, which silently won over `BEDROCK_AWS_PROFILE=your-aws-profile` from `.env`.
- Fix: `unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_PROFILE` before any Bedrock or agentcore call.
- See [`docs/adk-bedrock-setup.md`](adk-bedrock-setup.md) section 5 for full explanation.

---

### 2026-09-10 — Initial wiring: ADK connector + AgentCore entrypoint

*(This entry reconstructed from codebase inspection — authored retroactively.)*

**Decision: custom `BaseLlm` connector over adk-llm-bridge or Gemini.**
- TypeScript ADK has no `LiteLlm` equivalent (unlike Python ADK). See [adk-js issue #45](https://github.com/google/adk-js/issues/45).
- Three options evaluated: custom connector (this repo), `adk-llm-bridge` + OpenAI-compatible proxy, or route through Gemini.
- Chose custom connector: no extra infrastructure, ~240 lines of translation code, full control.
- Sources: [adk.dev/runtime](https://adk.dev/runtime/), [npm/adk-llm-bridge](https://www.npmjs.com/package/adk-llm-bridge)

**Decision: Bedrock Converse API over InvokeModel.**
- Converse gives one model-agnostic shape with native tool-calling support; works for Claude, Nova, Llama.
- Source: [AWS Bedrock Converse docs](https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference.html)

**Decision: `us.anthropic.claude-sonnet-4-6` (cross-region inference profile).**
- Bare model id `anthropic.claude-sonnet-4-6` fails with `on-demand throughput isn't supported`.
- Newer Claude models require a `us./global.`-prefixed inference profile.
- Source: [AWS cross-region inference docs](https://docs.aws.amazon.com/bedrock/latest/userguide/cross-region-inference.html)

**Decision: `BedrockAgentCoreApp` wrapper for AgentCore Runtime HTTP contract.**
- AgentCore Runtime expects `POST /invocations` + `GET /ping` on port 8080.
- `bedrock-agentcore` npm package provides `BedrockAgentCoreApp` that handles the contract.
- `InMemoryRunner` is used (state resets on cold start; acceptable for first deploy).
- Source: [AgentCore Runtime service contract docs](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-service-contract.html)

---

## Sources / references

| URL | What it backs up |
|-----|-----------------|
| https://github.com/google/adk-js/issues/45 | No `LiteLlm` in TypeScript ADK — why a custom connector is needed |
| https://adk.dev/runtime/ | ADK run/deploy surfaces are Google-side (Vertex/Cloud Run/GKE); no native Bedrock path |
| https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference.html | Bedrock Converse API shape and `toolConfig` |
| https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/Package/-aws-sdk-client-bedrock-runtime/ | `ConverseCommand` type definitions |
| https://docs.aws.amazon.com/bedrock/latest/userguide/cross-region-inference.html | Why `us.anthropic.claude-sonnet-4-6` is needed (newer models require inference profile) |
| https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-service-contract.html | `/invocations` + `/ping` HTTP contract |
| https://www.npmjs.com/package/adk-llm-bridge | Proxy-based alternative considered but not used |
| https://raw.githubusercontent.com/aws/agent-toolkit-for-aws/refs/heads/main/setup-instructions/setup.md | Agent Toolkit setup (optional track for AWS MCP server + credentials) |
| Local: `node_modules/@google/adk/dist/types/` | `BaseLlm`, `LlmRequest`, `LlmResponse` contracts |
