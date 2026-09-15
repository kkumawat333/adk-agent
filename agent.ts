import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  FunctionTool,
  LlmAgent,
  LLMRegistry,
  requestInputTool,
} from '@google/adk';
import {z} from 'zod';
import {BedrockLlm} from './bedrock_llm.js';
import {LocalSkillToolset} from './skill_toolset.js';

// Register the Bedrock connector so any `bedrock/...` model string resolves to
// it. (You can also pass `new BedrockLlm({model: '...'})` directly instead.)
LLMRegistry.register(BedrockLlm);

/** City -> IANA timezone identifiers this tool knows how to resolve. */
const CITY_TIMEZONES: Record<string, string> = {
  'new york': 'America/New_York',
};

const getCurrentTime = new FunctionTool({
  name: 'get_current_time',
  description: 'Returns the current time in a specified city.',
  parameters: z.object({
    city: z
      .string()
      .describe('The name of the city for which to retrieve the current time.'),
  }),
  execute: ({city}) => {
    const tzIdentifier = CITY_TIMEZONES[city.toLowerCase()];
    if (!tzIdentifier) {
      return {
        status: 'error',
        error_message: `Sorry, I don't have timezone information for ${city}.`,
      };
    }

    const now = new Date();
    const report = `The current time in ${city} is ${now.toLocaleString('en-US', {timeZone: tzIdentifier})}`;

    return {status: 'success', report};
  },
});

const getWeather = new FunctionTool({
    name: 'get_weather',
    description: 'Retrieves the current weather report for a specified city.',
    parameters: z.object({
      city: z.string().describe('The name of the city for which to retrieve the weather report.'),
    }),
    execute: ({ city }) => {
      if (city.toLowerCase() === 'new york') {
        return {
          status: 'success',
          report:
            'The weather in New York is sunny with a temperature of 25 degrees Celsius (77 degrees Fahrenheit).',
        };
      } else {
        return {
          status: 'error',
          error_message: `Weather information for '${city}' is not available.`,
        };
      }
    },
  });

/**
 * Real geocoding lookup — country, region, IANA timezone, coordinates — via
 * Open-Meteo's free geocoding API (no API key required). Unlike `getWeather`
 * and `getCurrentTime`, which only cover a hardcoded city or two, this covers
 * essentially any named place, so it also doubles as a way to check whether a
 * city is real/spelled correctly before other tools are called.
 * Docs: https://open-meteo.com/en/docs/geocoding-api
 */
const getCityInfo = new FunctionTool({
  name: 'get_city_info',
  description:
    "Looks up a city's country, region, IANA timezone, and coordinates. Use " +
    'this for factual questions about where a city is, what country/timezone ' +
    'it belongs to, or to verify a city name — never guess these from general ' +
    'knowledge.',
  parameters: z.object({
    city: z.string().describe('The name of the city to look up.'),
  }),
  execute: async ({city}) => {
    const url = new URL('https://geocoding-api.open-meteo.com/v1/search');
    url.searchParams.set('name', city);
    url.searchParams.set('count', '1');
    url.searchParams.set('language', 'en');
    url.searchParams.set('format', 'json');

    let response: Response;
    try {
      response = await fetch(url);
    } catch (err) {
      return {
        status: 'error',
        error_message: `Could not reach the geocoding service: ${(err as Error).message}`,
      };
    }
    if (!response.ok) {
      return {
        status: 'error',
        error_message: `Geocoding service returned HTTP ${response.status}.`,
      };
    }

    const data = (await response.json()) as {
      results?: Array<{
        name: string;
        country?: string;
        admin1?: string;
        timezone: string;
        latitude: number;
        longitude: number;
        population?: number;
      }>;
    };
    const match = data.results?.[0];
    if (!match) {
      return {
        status: 'error',
        error_message: `Could not find a city named '${city}'.`,
      };
    }

    return {
      status: 'success',
      report:
        `${match.name}${match.admin1 ? `, ${match.admin1}` : ''}, ` +
        `${match.country ?? 'an unknown country'} — timezone ${match.timezone}` +
        (match.population
          ? `, population ~${match.population.toLocaleString('en-US')}`
          : ''),
      city: match.name,
      country: match.country,
      region: match.admin1,
      timezone: match.timezone,
      latitude: match.latitude,
      longitude: match.longitude,
      population: match.population,
    };
  },
});

const PROJECT_ROOT = path.dirname(fileURLToPath(import.meta.url));

/**
 * DEMO: "agent as orchestrator, LLM does the job" — the same shape a
 * spec-driven runner (e.g. an internal "Oracle Agent"-style tool) would use:
 * take a raw request, record a spec, then act on it. The orchestration this
 * project guarantees is deliberately thin: a spec gets persisted before
 * anything runs (this tool), and the model is expected to report only real
 * tool results (enforced by `skills/spec-runner/SKILL.md`'s output format).
 * *Which* tools accomplish the spec's goal is intentionally not decided here
 * or in the skill — no lookup table, no dispatch code. The model reads each
 * candidate tool's own `description` and decides, the same way it would for
 * any other request. See `skills/spec-runner/SKILL.md` for the reasoning.
 */
const SPECS_DIR = path.join(PROJECT_ROOT, 'specs');

const createTaskSpec = new FunctionTool({
  name: 'create_task_spec',
  description:
    'Turns a free-form request into a structured, persisted task spec ' +
    '(goal, city, task_type). Always call this first when following the ' +
    "`spec-runner` skill — it is the auditable record of what was asked " +
    'for, before anything else runs. Returns the saved spec and its ' +
    '`spec_id`. This tool does not decide which other tools to call next — ' +
    'that judgment call is on the model, based on each tool\'s description.',
  parameters: z.object({
    goal: z.string().describe('One-sentence restatement of what the user wants.'),
    city: z.string().describe('The city the request is about.'),
    task_type: z
      .string()
      .describe(
        'A short free-text label for this request, for your own reference ' +
          "in the persisted spec (e.g. 'trip-readiness', 'city-overview'). " +
          'Not looked up anywhere — it does not constrain which tools you ' +
          'call afterward.',
      ),
    notes: z
      .string()
      .optional()
      .describe('Any extra detail from the request worth carrying forward.'),
  }),
  execute: async ({goal, city, task_type, notes}) => {
    const spec = {
      spec_id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      created_at: new Date().toISOString(),
      goal,
      city,
      task_type,
      notes,
    };
    await fs.mkdir(SPECS_DIR, {recursive: true});
    const specPath = path.join(SPECS_DIR, `${spec.spec_id}.json`);
    await fs.writeFile(specPath, JSON.stringify(spec, null, 2), 'utf-8');
    return {status: 'success', spec, spec_path: specPath};
  },
});

// Skills live as directories under `skills/`, in ADK's own SKILL.md format.
// The toolset advertises whichever skills it finds in the system instruction
// and exposes `load_skill` / `load_skill_resource`, so adding a skill means
// adding a directory — no change to this file.
const skillToolset = new LocalSkillToolset(path.join(PROJECT_ROOT, 'skills'));

export const rootAgent = new LlmAgent({
  name: 'city_assistant',
  // Amazon Bedrock model id (with the `bedrock/` prefix). Override via env.
  // Note: `GOOGLE_SEARCH` is a Gemini-only built-in tool and cannot be used
  // with Bedrock — use function tools like `getCurrentTime` instead.
  model:
    process.env.BEDROCK_MODEL ?? 'bedrock/us.anthropic.claude-sonnet-4-6',
  description:
    'Agent to answer questions about the time and weather in a city, and to ' +
    'brief a user on what to expect when heading there.',
  // Only the two direct flows are described here. The trip-briefing flow is
  // defined by its skill, and the toolset appends the skill catalogue and the
  // "load a skill before proceeding" rule to the system instruction itself.
  instruction: [
    'You are a helpful assistant for questions about cities.',
    '',
    'When the user wants current conditions, call `get_weather` and answer',
    'directly. When they want the local time, call `get_current_time` and',
    'answer directly. When they ask what country/region/timezone a city is in,',
    'or you need to confirm a city is real, call `get_city_info`. For a request',
    'a skill covers, follow the skill instead of answering from your own',
    'judgement.',
    '',
    'The weather and time tools cover only some cities. When a tool returns an',
    'error, say so plainly rather than guessing a value.',
    '',
    "If you're missing information you genuinely need to proceed (e.g. which",
    'city, or a choice between two reasonable interpretations of the request),',
    'call `adk_request_input` to ask the user directly and wait for their reply',
    "— do not guess, and do not silently pick one. Only ask when you can't",
    'proceed without the answer; use your own judgement for everything else.',
  ].join('\n'),
  tools: [
    getWeather,
    getCurrentTime,
    getCityInfo,
    createTaskSpec,
    requestInputTool,
    skillToolset,
  ],
});
