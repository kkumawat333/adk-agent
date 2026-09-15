/**
 * AgentCore Runtime entrypoint (bring-your-own container).
 *
 * Wraps the existing ADK `bug_fixer` root agent (see `bug_agent.ts`) behind the
 * Amazon Bedrock AgentCore Runtime HTTP service contract:
 *   POST /invocations   — one turn of the conversation
 *   GET  /ping          — health check
 * both served on port 8080. The contract itself is implemented by
 * `BedrockAgentCoreApp` from the `bedrock-agentcore` package (the same helper
 * the AgentCore CLI's own TypeScript templates use). We only provide the
 * invocation handler that drives the ADK Runner.
 *
 * Model auth: `BedrockLlm` (bedrock_llm.ts) uses the default AWS credential
 * chain, which on AgentCore resolves to the runtime's execution role. Do NOT
 * set BEDROCK_AWS_PROFILE in the deployed container — there is no profile
 * there; leaving it unset lets the SDK use the execution role (which must be
 * granted `bedrock:InvokeModel` — see the runtime's additionalPolicies).
 *
 * See docs/bedrock-agent-journal.md for the full deployment story and the known
 * limitations (human-in-the-loop `adk_request_input` and the filesystem tools).
 */
import {BedrockAgentCoreApp} from 'bedrock-agentcore/runtime';
import {z} from 'zod';
import {InMemoryRunner, type Event} from '@google/adk';
import {rootAgent} from './bug_agent.js';

const APP_NAME = 'bug_fixer';

// One Runner for the life of the process. On AgentCore Runtime each session
// runs in its own microVM/process, so the in-memory session service keeps that
// single session's conversation history across invocations for the microVM's
// lifetime (best-effort — it resets on a cold start). Attach a durable session
// service later if cross-restart history is needed.
const runner = new InMemoryRunner({agent: rootAgent, appName: APP_NAME});

const requestSchema = z.object({
  // The user's message for this turn.
  prompt: z.string().default(''),
  // Optional caller-supplied actor id; defaults to the runtime session id.
  userId: z.string().optional(),
});

// Sessions we've already created in this process, so we create each one once
// and then append to it on later turns.
const createdSessions = new Set<string>();

async function ensureSession(userId: string, sessionId: string): Promise<void> {
  const key = `${userId}::${sessionId}`;
  if (createdSessions.has(key)) return;
  await runner.sessionService.createSession({
    appName: APP_NAME,
    userId,
    sessionId,
  });
  createdSessions.add(key);
}

/** Concatenates the text parts of an event (tool-call/result parts have none). */
function textFrom(event: Event): string {
  const parts = event.content?.parts ?? [];
  return parts.map((p) => (typeof p.text === 'string' ? p.text : '')).join('');
}

const app = new BedrockAgentCoreApp({
  invocationHandler: {
    requestSchema,
    async *process(payload, context) {
      const sessionId = context?.sessionId ?? 'default-session';
      const userId = payload.userId ?? sessionId;
      await ensureSession(userId, sessionId);

      for await (const event of runner.runAsync({
        userId,
        sessionId,
        newMessage: {role: 'user', parts: [{text: payload.prompt}]},
      })) {
        const text = textFrom(event);
        if (text) yield {data: text};
      }
    },
  },
});

app.run({port: parseInt(process.env.PORT ?? '8080', 10)});
