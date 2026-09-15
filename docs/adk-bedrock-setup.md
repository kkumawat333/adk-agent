# Connecting Google ADK (TypeScript) to Amazon Bedrock

A practical guide to running a Google ADK agent on Amazon Bedrock models instead
of Gemini.

Everything here was verified against `@google/adk` v2 (TypeScript) calling
Anthropic Claude on Bedrock in `us-east-2`. Where something is untested, it says
so.

---

## 1. Why you need a connector

The **Python** ADK ships `LiteLlm`, so Bedrock is a one-liner:

```python
# Python ADK — not available in TypeScript
from google.adk.models.lite_llm import LiteLlm
model = LiteLlm(model="bedrock/anthropic.claude-sonnet-4-6")
```

The **TypeScript** ADK ships only Gemini and Apigee model support. There is no
`LiteLlm` equivalent
([adk-js issue #45](https://github.com/google/adk-js/issues/45)).

So you have three options:

| Option | Trade-off |
| --- | --- |
| **Custom `BaseLlm` connector** (what this repo does) | No extra infrastructure; you own ~240 lines of translation code |
| [`adk-llm-bridge`](https://www.npmjs.com/package/adk-llm-bridge) + an OpenAI-compatible proxy | Less code, but you must run and maintain a proxy |
| Route through Gemini instead | Not Bedrock |

This guide covers the first option: a connector that extends ADK's `BaseLlm` and
calls Bedrock's **Converse** API directly via the AWS SDK.

We chose Converse over `InvokeModel` because it gives one model-agnostic
request/response shape with native tool-calling support, so the same code works
for Claude, Nova, Llama, and others.

---

## 2. Prerequisites

- Node.js 20+ (this repo runs on 22).
- An AWS account with **Bedrock model access already granted** for the model you
  want, in the region you intend to use. Model access is per-account,
  per-region, and per-model — request it in the Bedrock console.
- AWS credentials that can call Bedrock. See [section 5](#5-authentication-the-part-that-usually-breaks).

Install the two packages:

```bash
npm install @google/adk @aws-sdk/client-bedrock-runtime zod
npm install --save-dev @google/adk-devtools
```

---

## 3. Write the connector

Create `bedrock_llm.ts` exporting a class that extends `BaseLlm`. The full
implementation lives in this repo; the contract you must satisfy is:

```ts
import {BaseLlm, type LlmRequest, type LlmResponse} from '@google/adk';
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from '@aws-sdk/client-bedrock-runtime';

export class BedrockLlm extends BaseLlm {
  // Any model string matching this pattern resolves to this connector.
  static readonly supportedModels: Array<string | RegExp> = [/^bedrock\/.*/];

  private readonly client: BedrockRuntimeClient;
  private readonly modelId: string;

  constructor({model}: {model: string}) {
    super({model});
    // Strip the `bedrock/` prefix — the AWS SDK wants the bare model id.
    this.modelId = model.replace(/^bedrock\//, '');
    this.client = new BedrockRuntimeClient({
      region: process.env.AWS_REGION ?? 'us-east-1',
      profile: process.env.BEDROCK_AWS_PROFILE,
    });
  }

  async *generateContentAsync(
    llmRequest: LlmRequest,
    _stream = false,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    // Translate ADK/genai -> Converse, send, translate the reply back.
  }

  connect(): Promise<BaseLlmConnection> {
    throw new Error('Live/bidi streaming is not supported.');
  }
}
```

### What the translation layer has to handle

ADK speaks Google's `@google/genai` shapes; Bedrock speaks Converse shapes. Four
mappings matter:

| Direction | ADK / genai | Bedrock Converse |
| --- | --- | --- |
| Messages | `Content[]` with `role: 'model' \| 'user'` | `Message[]` with `role: 'assistant' \| 'user'` |
| System prompt | `config.systemInstruction` (string, `Part[]`, or `Content`) | `system: [{text}]` |
| Tool declaration | `config.tools[].functionDeclarations` | `toolConfig.tools[].toolSpec` |
| Tool call / result | `part.functionCall` / `part.functionResponse` | `toolUse` / `toolResult` blocks |

Two details that are easy to get wrong:

- **`role: 'model'` must become `'assistant'`.** Bedrock rejects `model`.
- **genai `Schema.type` is an upper-cased enum** (`OBJECT`, `STRING`), but
  Bedrock's `toolSpec.inputSchema.json` expects lower-case JSON Schema
  (`object`, `string`). Convert recursively, including nested `properties` and
  `items`. Prefer `parametersJsonSchema` when ADK provides it.

Finally, map Bedrock's `stopReason` onto ADK's `FinishReason`:

| Bedrock `stopReason` | ADK `FinishReason` |
| --- | --- |
| `max_tokens` | `MAX_TOKENS` |
| `content_filtered`, `guardrail_intervened` | `SAFETY` |
| `end_turn`, `tool_use`, `stop_sequence` | `STOP` |

---

## 4. Register and use it

Registering the class lets you use plain `bedrock/...` strings anywhere:

```ts
import {FunctionTool, LlmAgent, LLMRegistry} from '@google/adk';
import {z} from 'zod';
import {BedrockLlm} from './bedrock_llm.js';

LLMRegistry.register(BedrockLlm);

const getCurrentTime = new FunctionTool({
  name: 'get_current_time',
  description: 'Returns the current time in a specified city.',
  parameters: z.object({
    city: z.string().describe('The city to retrieve the current time for.'),
  }),
  execute: ({city}) => ({
    status: 'success',
    report: `The current time in ${city} is 10:30 AM`,
  }),
});

export const rootAgent = new LlmAgent({
  name: 'hello_time_agent',
  model: process.env.BEDROCK_MODEL ?? 'bedrock/us.anthropic.claude-sonnet-4-6',
  description: 'Tells the current time in a specified city.',
  instruction: `You are a helpful assistant that tells the current time in a
                city. Use the 'get_current_time' tool for this purpose.`,
  tools: [getCurrentTime],
});
```

You can skip the registry and pass an instance directly instead:

```ts
model: new BedrockLlm({model: 'bedrock/us.anthropic.claude-sonnet-4-6'}),
```

> **Gemini-only tools don't work.** Built-ins like `GOOGLE_SEARCH` are
> implemented server-side by Gemini and have no Bedrock equivalent. Use
> `FunctionTool` instead.

---

## 5. Authentication (the part that usually breaks)

The AWS SDK offers two completely different auth paths for Bedrock, and they
need **different IAM permissions**. Picking the wrong one produces confusing
errors.

| Path | Triggered by | IAM action required |
| --- | --- | --- |
| **Bearer token** (Bedrock API key) | `AWS_BEARER_TOKEN_BEDROCK` being set | `bedrock:CallWithBearerToken` |
| **SigV4** (normal AWS credentials) | Anything else in the credential chain | `bedrock:InvokeModel` |

### The single most important gotcha

**If `AWS_BEARER_TOKEN_BEDROCK` is set, the SDK uses it exclusively and ignores
your IAM credentials entirely.** It does not fall back. So a stale bearer token
in a `.env` file will override a perfectly good SSO session, and you'll get
permission errors that look like credential errors.

Bedrock API keys are also awkward operationally:

- **Short-term keys** are a presigned request valid for ~12 hours, and are
  **bound to the region they were minted in**. Using one against a different
  region fails with `Authentication failed: Please make sure your API Key is
  valid.`
- **Long-term keys** require IAM permission to create, which many managed or
  sandbox accounts deny.
- Many roles — especially IAM Identity Center (SSO) roles — are never granted
  `bedrock:CallWithBearerToken`, so **bearer auth simply cannot work** for them
  regardless of key freshness.

**Recommendation: prefer SigV4.** Don't set `AWS_BEARER_TOKEN_BEDROCK` at all
unless you know your principal has `bedrock:CallWithBearerToken`.

### Setting up SigV4 with IAM Identity Center (SSO)

This is the typical corporate setup. Add to `~/.aws/config`:

```ini
[sso-session my-org]
sso_start_url = https://d-xxxxxxxxxx.awsapps.com/start
sso_region = us-east-1
sso_registration_scopes = sso:account:access

[profile my-bedrock]
sso_session = my-org
sso_account_id = 123456789012
sso_role_name = YourPermissionSet
region = us-east-2
output = json
```

Notes on filling this in:

- `sso_region` is where **Identity Center** is provisioned. It is often *not*
  the same as your Bedrock region.
- `sso_role_name` is the **permission set** name, not the full role name. If you
  have an error message containing
  `arn:aws:sts::123:assumed-role/AWSReservedSSO_MyPermSet_abc123/you@example.com`,
  the permission set is the middle part: `MyPermSet`.

Then log in and verify:

```bash
aws sso login --profile my-bedrock
aws sts get-caller-identity --profile my-bedrock
```

### Credential precedence, highest first

This order explains most "my config change did nothing" situations:

1. `AWS_BEARER_TOKEN_BEDROCK` — for Bedrock only, wins over everything
2. `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN`
3. The client's explicit `profile` option (what `BEDROCK_AWS_PROFILE` feeds)
4. `AWS_PROFILE`
5. `[default]` profile in `~/.aws/credentials` / `~/.aws/config`
6. Container / instance metadata roles

### Why this connector reads `BEDROCK_AWS_PROFILE`, not `AWS_PROFILE`

**Neither `dotenv` nor `node --env-file` overrides a variable that is already
exported in the shell.** If your shell profile contains something like:

```bash
export AWS_PROFILE=some-other-account   # e.g. in ~/.zshrc
```

then `AWS_PROFILE` in your `.env` is silently ignored, and the agent uses the
shell's value. Debugging this is miserable because your `.env` looks correct.

Using a project-specific name avoids the collision entirely:

```ts
profile: process.env.BEDROCK_AWS_PROFILE,
```

Also watch for **stale exported static credentials**. If `AWS_ACCESS_KEY_ID` is
exported from an old session, it outranks any profile. Clear them:

```bash
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_SECURITY_TOKEN
```

The SDK warns when it sees both, which is a useful signal:

```
Multiple credential sources detected: Both AWS_PROFILE and the pair
AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY static credentials are set.
```

### Minimum IAM policy

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "bedrock:ListFoundationModels",
        "bedrock:ListInferenceProfiles"
      ],
      "Resource": "*"
    }
  ]
}
```

The second statement is only needed for the discovery commands in
[section 6](#6-choosing-a-model-id). When calling through a cross-region
inference profile, the policy must permit the underlying foundation models in
**every** region the profile can route to.

---

## 6. Choosing a model id

Newer Claude models **cannot be called by their bare model id**. They are only
available through a *cross-region inference profile*, and using the bare id
fails with:

```
ValidationException: Invocation of model ID anthropic.claude-sonnet-4-6 with
on-demand throughput isn't supported. Retry your request with the ID or ARN of
an inference profile that contains this model.
```

The fix is a region-prefixed profile id:

| Kind | Example | Notes |
| --- | --- | --- |
| Bare model id | `anthropic.claude-3-haiku-20240307-v1:0` | Works for older on-demand models |
| US inference profile | `us.anthropic.claude-sonnet-4-6` | Routes across US regions |
| EU / APAC | `eu.anthropic...`, `apac.anthropic...` | Region-scoped equivalents |
| Global | `global.anthropic.claude-sonnet-4-6` | Widest routing |

Discover what your account can actually use:

```bash
# Which models exist in this region
aws bedrock list-foundation-models \
  --region us-east-2 --by-provider anthropic \
  --query 'modelSummaries[].modelId' --output text | tr '\t' '\n'

# Which inference profiles are available
aws bedrock list-inference-profiles \
  --region us-east-2 \
  --query 'inferenceProfileSummaries[].inferenceProfileId' --output text | tr '\t' '\n'
```

A model appearing in `list-foundation-models` means only that it *exists* in the
region — not that you have access or that on-demand invocation is allowed. The
authoritative test is an actual call.

Remember the `bedrock/` prefix in `BEDROCK_MODEL`; the connector strips it:

```bash
BEDROCK_MODEL="bedrock/us.anthropic.claude-sonnet-4-6"
```

---

## 7. Configuration reference

`.env`:

```bash
# Region where your Bedrock model access is enabled.
AWS_REGION="us-east-2"

# AWS profile to authenticate with. Deliberately NOT named AWS_PROFILE so a
# shell-exported AWS_PROFILE can't shadow it.
BEDROCK_AWS_PROFILE="my-bedrock"

# Model id or inference profile, with the `bedrock/` prefix.
BEDROCK_MODEL="bedrock/us.anthropic.claude-sonnet-4-6"

# Do NOT set AWS_BEARER_TOKEN_BEDROCK unless your principal is granted
# bedrock:CallWithBearerToken. Its presence disables SigV4 auth.
```

`.env` holds credentials and API keys, so make sure it is git-ignored:

```
.env
.env.*
!.env.example
```

---

## 8. Verify before running the agent

Test the credential path and model id in isolation, so a failure isn't confused
with an agent bug. This repo includes `preflight.mjs`:

```bash
node --env-file=.env preflight.mjs
```

It prints the resolved region, model id, and which auth path is active, then
makes one minimal Converse call and maps the failure to a likely cause.

You can do the same with the AWS CLI:

```bash
echo '[{"role":"user","content":[{"text":"Reply with one word: ok"}]}]' > /tmp/msg.json

aws bedrock-runtime converse \
  --profile my-bedrock --region us-east-2 \
  --model-id us.anthropic.claude-sonnet-4-6 \
  --messages file:///tmp/msg.json \
  --inference-config '{"maxTokens":16}'
```

Once that returns a response, start the agent:

```bash
adk run agent.ts
```

> **Restart after config changes.** `.env` is read once at process start. A
> running `adk run` keeps its original environment, so edits appear to have no
> effect until you restart it. Suspended background runs are a common cause of
> "I already fixed that."

---

## 9. Troubleshooting

| Error | Cause | Fix |
| --- | --- | --- |
| `Authentication failed: Please make sure your API Key is valid.` | Bearer token expired, or minted for a different region | Match `AWS_REGION` to the key's region, or stop using bearer auth |
| `not authorized to perform: bedrock:CallWithBearerToken` | SDK is on the bearer path; your role can't use API keys | Remove `AWS_BEARER_TOKEN_BEDROCK` from `.env` **and** the shell |
| `not authorized to perform: bedrock:InvokeModel` | SigV4 works, but the role lacks Bedrock permission | Grant `bedrock:InvokeModel`; confirm the account in the ARN is the right one |
| `ExpiredTokenException` | Credentials expired | Re-login; check no stale `AWS_ACCESS_KEY_ID` is exported |
| `CredentialsProviderError` | No credentials resolved at all | Set `BEDROCK_AWS_PROFILE` or log in |
| `ValidationException: ... on-demand throughput isn't supported` | Model needs an inference profile | Use the `us.` / `global.` prefixed id |
| `AccessDeniedException` on a valid model | Model access never requested in this region | Request access in the Bedrock console |
| `ResourceNotFoundException` | Wrong model id, or right id in the wrong region | Verify with `list-foundation-models` |
| Config edits seem ignored | `.env` doesn't override exported shell vars; or a stale process is running | Use `BEDROCK_AWS_PROFILE`; restart `adk run` |

### Reading the identity in an error

Access-denied messages include the calling principal, which is the fastest way
to learn *which account* you're actually hitting:

```
User: arn:aws:sts::123456789012:assumed-role/AWSReservedSSO_YourPermissionSet_abc/you@example.com
      is not authorized to perform: bedrock:InvokeModel
```

That tells you the account (`123456789012`), the permission set
(`YourPermissionSet`), and the user. If the account isn't the one where you
enabled model access, your credentials are pointing at the wrong place.

One subtlety: when bearer auth is active, the identity shown is the one embedded
in **the token**, not your shell credentials — which is a handy way to find out
which account a mystery API key came from.

---

## 10. Known limitations of this connector

- **No streaming.** `generateContentAsync` yields a single complete response,
  and `connect()` throws. Bedrock supports `ConverseStream`; wiring it up would
  mean yielding partial `LlmResponse` chunks.
- **Tool-calling round-trips are unverified.** Single-turn text generation is
  confirmed working; multi-turn `toolUse` → `toolResult` has not been exercised
  end to end. The `toolUseId` correlation between a call and its result is the
  most likely place for a bug.
- **No retry or throttling logic** beyond AWS SDK defaults.
- **Bespoke code.** This was derived from the ADK and AWS SDK type contracts
  plus official docs, not from a vetted upstream example. Treat it as a starting
  point.

---

## 11. References

- [adk-js issue #45](https://github.com/google/adk-js/issues/45) — confirms the
  TypeScript ADK has no `LiteLlm`/Bedrock support.
- [ADK docs — AI models overview](https://github.com/google/adk-docs/blob/5331a07f/docs/agents/models/index.md)
  — registry string vs. model connector.
- [ADK docs — LiteLLM models](https://adk.dev/agents/models/litellm/) — the
  Python `LiteLlm(model="bedrock/...")` pattern this mirrors.
- [AWS — Bedrock Converse API](https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference.html)
  — request/response shape, `toolConfig`, `toolUse`/`toolResult`.
- [`@aws-sdk/client-bedrock-runtime` reference](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/Package/-aws-sdk-client-bedrock-runtime/)
  — `ConverseCommand` types.
- [AWS — cross-region inference](https://docs.aws.amazon.com/bedrock/latest/userguide/cross-region-inference.html)
  — why newer models require a `us.`/`global.` inference profile.
- [AWS — Bedrock API keys](https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys.html)
  — bearer tokens and `bedrock:CallWithBearerToken`.
- [AWS — configuring IAM Identity Center in the CLI](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sso.html)
  — `sso-session` / profile syntax.
- [Node.js — `--env-file`](https://nodejs.org/api/cli.html#--env-fileconfig) —
  confirms already-set variables are not overridden.
- [Running Google ADK on AWS Bedrock via LiteLLM (blog)](https://blog.mphomphego.co.za/blog/2026/03/05/Running-Google-ADK-Agents-on-AWS-Bedrock-via-LiteLLM.html)
  — the `bedrock/` prefix and explicit-region gotchas.
- [adk-llm-bridge (npm)](https://www.npmjs.com/package/adk-llm-bridge) — the
  proxy-based alternative not used here.
- *local* — `@google/adk` type definitions in
  `node_modules/@google/adk/dist/types/` (`models/base_llm.d.ts`,
  `models/registry.d.ts`, `models/llm_request.d.ts`, `models/llm_response.d.ts`)
  — the contracts `BedrockLlm` implements.
