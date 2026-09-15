import {BaseLlm, type LlmRequest, type LlmResponse} from '@google/adk';
import type {BaseLlmConnection} from '@google/adk';
import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
  type Message,
  type Tool as BedrockTool,
  type ToolConfiguration,
} from '@aws-sdk/client-bedrock-runtime';
import {type Content, type Part, FinishReason} from '@google/genai';

/**
 * A minimal ADK model connector for Amazon Bedrock, built on the Bedrock
 * `Converse` API. It mirrors what Python ADK's `LiteLlm(model="bedrock/...")`
 * gives you, but talks to Bedrock directly via the AWS SDK — no proxy needed.
 *
 * Authentication uses SigV4 via the AWS SDK credential chain, which needs the
 * `bedrock:InvokeModel` IAM action. Set `BEDROCK_AWS_PROFILE` to choose a
 * profile; region comes from AWS_REGION (then AWS_REGION_NAME, then us-east-1).
 *
 * Do NOT set AWS_BEARER_TOKEN_BEDROCK: its presence makes the SDK use bearer
 * auth *exclusively* for Bedrock, which requires the separate
 * `bedrock:CallWithBearerToken` action that IAM Identity Center roles are
 * typically not granted.
 *
 * Newer Claude models are only reachable through a cross-region inference
 * profile, so prefer a `us.`/`global.`-prefixed id over the bare model id.
 *
 * Use it either directly:
 *   model: new BedrockLlm({model: 'bedrock/us.anthropic.claude-sonnet-4-6'})
 * or via the registry with a plain string (see agent.ts):
 *   LLMRegistry.register(BedrockLlm);
 *   model: 'bedrock/us.anthropic.claude-sonnet-4-6'
 *
 * See docs/adk-bedrock-setup.md for the full setup and troubleshooting guide.
 */
export class BedrockLlm extends BaseLlm {
  /** Any model id prefixed with `bedrock/` is handled by this connector. */
  static readonly supportedModels: Array<string | RegExp> = [/^bedrock\/.*/];

  private readonly client: BedrockRuntimeClient;
  /** The Bedrock model id / inference profile, without the `bedrock/` prefix. */
  private readonly modelId: string;

  constructor({model}: {model: string}) {
    super({model});
    this.modelId = model.replace(/^bedrock\//, '');
    this.client = new BedrockRuntimeClient({
      region:
        process.env.AWS_REGION ?? process.env.AWS_REGION_NAME ?? 'us-east-1',
      // Deliberately not AWS_PROFILE: neither dotenv nor `node --env-file`
      // overrides variables already exported by the shell, so an AWS_PROFILE
      // in ~/.zshrc would silently win over the one in .env.
      profile: process.env.BEDROCK_AWS_PROFILE,
    });
  }

  async *generateContentAsync(
    llmRequest: LlmRequest,
    _stream = false,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    const config = llmRequest.config ?? {};

    const command = new ConverseCommand({
      modelId: this.modelId,
      messages: toBedrockMessages(llmRequest.contents ?? []),
      system: toBedrockSystem(config.systemInstruction),
      toolConfig: toBedrockToolConfig(config.tools),
      inferenceConfig: {
        maxTokens: config.maxOutputTokens ?? 1024,
        temperature: config.temperature,
        topP: config.topP,
      },
    });

    const response = await this.client.send(command, {abortSignal});

    const blocks = response.output?.message?.content ?? [];
    const parts = blocks.map(fromBedrockBlock).filter((p): p is Part => !!p);

    yield {
      content: {role: 'model', parts},
      finishReason: mapStopReason(response.stopReason),
      usageMetadata: response.usage
        ? {
            promptTokenCount: response.usage.inputTokens,
            candidatesTokenCount: response.usage.outputTokens,
            totalTokenCount: response.usage.totalTokens,
          }
        : undefined,
      turnComplete: true,
    };
  }

  connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error(
      'BedrockLlm does not support live/bidi streaming connections.',
    );
  }
}

/** Extracts plain text from a genai system instruction of any shape. */
function toBedrockSystem(
  systemInstruction: unknown,
): {text: string}[] | undefined {
  const text = extractText(systemInstruction);
  return text ? [{text}] : undefined;
}

function extractText(value: unknown): string {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(extractText).join('\n');
  const obj = value as {text?: string; parts?: Part[]};
  if (typeof obj.text === 'string') return obj.text;
  if (Array.isArray(obj.parts)) {
    return obj.parts.map((p) => p.text ?? '').join('');
  }
  return '';
}

/** Maps ADK conversation history to Bedrock Converse messages. */
function toBedrockMessages(contents: Content[]): Message[] {
  const messages: Message[] = [];
  for (const content of contents) {
    const role = content.role === 'model' ? 'assistant' : 'user';
    const blocks = (content.parts ?? [])
      .map(toBedrockBlock)
      .filter((b): b is ContentBlock => !!b);
    if (blocks.length > 0) {
      messages.push({role, content: blocks});
    }
  }
  return messages;
}

function toBedrockBlock(part: Part): ContentBlock | undefined {
  if (part.functionCall) {
    return {
      toolUse: {
        toolUseId: part.functionCall.id ?? part.functionCall.name ?? 'tool',
        name: part.functionCall.name ?? '',
        input: (part.functionCall.args ?? {}) as never,
      },
    };
  }
  if (part.functionResponse) {
    return {
      toolResult: {
        toolUseId:
          part.functionResponse.id ?? part.functionResponse.name ?? 'tool',
        content: [{json: (part.functionResponse.response ?? {}) as never}],
      },
    };
  }
  if (typeof part.text === 'string' && part.text.length > 0) {
    return {text: part.text};
  }
  return undefined;
}

function fromBedrockBlock(block: ContentBlock): Part | undefined {
  if (block.toolUse) {
    return {
      functionCall: {
        id: block.toolUse.toolUseId,
        name: block.toolUse.name,
        args: (block.toolUse.input ?? {}) as Record<string, unknown>,
      },
    };
  }
  if (typeof block.text === 'string') {
    return {text: block.text};
  }
  return undefined;
}

/** Converts ADK/genai function declarations into a Bedrock tool config. */
function toBedrockToolConfig(
  tools: unknown,
): ToolConfiguration | undefined {
  if (!Array.isArray(tools)) return undefined;
  const bedrockTools: BedrockTool[] = [];
  for (const tool of tools) {
    const declarations = (tool as {functionDeclarations?: unknown[]})
      .functionDeclarations;
    if (!Array.isArray(declarations)) continue;
    for (const fd of declarations as Array<Record<string, unknown>>) {
      bedrockTools.push({
        toolSpec: {
          name: fd.name as string,
          description: (fd.description as string) ?? '',
          inputSchema: {
            json: (fd.parametersJsonSchema ??
              toJsonSchema(fd.parameters) ?? {
                type: 'object',
                properties: {},
              }) as never,
          },
        },
      });
    }
  }
  return bedrockTools.length > 0 ? {tools: bedrockTools} : undefined;
}

/**
 * Converts a genai `Schema` (whose `type` is an upper-cased enum like `OBJECT`)
 * into a JSON Schema that Bedrock's `Converse` tool config expects.
 */
function toJsonSchema(schema: unknown): Record<string, unknown> | undefined {
  if (!schema || typeof schema !== 'object') return undefined;
  const s = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  if (typeof s.type === 'string') out.type = (s.type as string).toLowerCase();
  if (s.description) out.description = s.description;
  if (Array.isArray(s.enum)) out.enum = s.enum;
  if (Array.isArray(s.required)) out.required = s.required;
  if (s.format) out.format = s.format;

  if (s.properties && typeof s.properties === 'object') {
    const props: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(
      s.properties as Record<string, unknown>,
    )) {
      props[key] = toJsonSchema(value);
    }
    out.properties = props;
  }
  if (s.items) out.items = toJsonSchema(s.items);

  return out;
}

function mapStopReason(stopReason: string | undefined): FinishReason {
  switch (stopReason) {
    case 'max_tokens':
      return FinishReason.MAX_TOKENS;
    case 'content_filtered':
    case 'guardrail_intervened':
      return FinishReason.SAFETY;
    case 'end_turn':
    case 'tool_use':
    case 'stop_sequence':
    default:
      return FinishReason.STOP;
  }
}
