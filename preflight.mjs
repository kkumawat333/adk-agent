/**
 * Bedrock preflight check.
 *
 * Verifies, in one shot, the three things that break a Bedrock call:
 * which auth path the SDK picked, which identity/account it resolves to,
 * and whether the configured model id is usable in this region.
 *
 * Run:  node --env-file=.env preflight.mjs
 */
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from '@aws-sdk/client-bedrock-runtime';

const region =
  process.env.AWS_REGION ?? process.env.AWS_REGION_NAME ?? 'us-east-1';
const modelId = (process.env.BEDROCK_MODEL ?? '').replace(/^bedrock\//, '');
const usingBearer = Boolean(process.env.AWS_BEARER_TOKEN_BEDROCK);

console.log('--- configuration ---');
console.log(`region     : ${region}`);
console.log(`model      : ${modelId || '(BEDROCK_MODEL not set)'}`);
console.log(
  `auth path  : ${
    usingBearer
      ? 'BEARER TOKEN  -> requires bedrock:CallWithBearerToken'
      : 'SigV4 chain   -> requires bedrock:InvokeModel'
  }`,
);
console.log(`AWS_PROFILE : ${process.env.AWS_PROFILE ?? '(none)'}`);
console.log(
  `env creds  : ${
    process.env.AWS_ACCESS_KEY_ID
      ? 'AWS_ACCESS_KEY_ID set (takes precedence over AWS_PROFILE)'
      : 'none'
  }`,
);

if (!modelId) {
  console.log('\nBEDROCK_MODEL is empty. Set it in .env, then rerun.');
  process.exit(1);
}

const client = new BedrockRuntimeClient({region});

try {
  const response = await client.send(
    new ConverseCommand({
      modelId,
      messages: [{role: 'user', content: [{text: 'Reply with one word: ok'}]}],
      inferenceConfig: {maxTokens: 16},
    }),
  );
  const text = response.output?.message?.content?.[0]?.text?.trim();
  console.log('\n--- SUCCESS ---');
  console.log(`model replied: ${text}`);
  console.log('Auth, region, and model id are all good.');
} catch (error) {
  console.log('\n--- FAILED ---');
  console.log(`error   : ${error.name}`);
  console.log(`message : ${error.message}`);
  console.log('\n--- diagnosis ---');
  console.log(diagnose(error));
  process.exitCode = 1;
}

function diagnose(error) {
  const message = error.message ?? '';
  const name = error.name ?? '';

  if (message.includes('CallWithBearerToken')) {
    return [
      'The SDK used bearer-token auth and the role is not allowed to.',
      'Remove AWS_BEARER_TOKEN_BEDROCK from .env AND from the shell:',
      '  unset AWS_BEARER_TOKEN_BEDROCK',
      'The account shown in the ARN above is where the API key was minted.',
    ].join('\n');
  }
  if (message.includes('InvokeModel') || message.includes('not authorized')) {
    return [
      'Credentials resolved, but this role lacks Bedrock invoke permission.',
      'Check the account in the ARN above — it must be the account where',
      'Bedrock model access is enabled. If the account is right, the role',
      'needs bedrock:InvokeModel granted by an AWS admin.',
    ].join('\n');
  }
  if (name === 'ExpiredTokenException' || message.includes('expired')) {
    return [
      'Credentials are expired. Refresh them, then rerun.',
      'Also confirm no stale AWS_ACCESS_KEY_ID/AWS_SESSION_TOKEN are exported,',
      'because env vars override AWS_PROFILE.',
    ].join('\n');
  }
  if (name === 'CredentialsProviderError') {
    return [
      'No credentials found at all. Either export sandbox credentials or set',
      'AWS_PROFILE to a profile that has unexpired credentials.',
    ].join('\n');
  }
  if (name === 'ValidationException' || message.includes('model identifier')) {
    return [
      `"${modelId}" is not a valid model id in ${region}.`,
      'Get the exact id from the Bedrock console (Model access → API id).',
      'Newer Claude models need a cross-region inference profile prefix,',
      'e.g. us.anthropic.claude-... instead of anthropic.claude-...',
    ].join('\n');
  }
  if (name === 'AccessDeniedException') {
    return [
      'Access denied. Usually means model access was never requested for',
      `this model in ${region}, or the role lacks Bedrock permissions.`,
    ].join('\n');
  }
  return 'Unrecognized error — see name/message above.';
}
