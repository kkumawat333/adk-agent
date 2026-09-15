/**
 * A local skill toolset for ADK skills stored on disk.
 *
 * ADK v2 ships its own `SkillToolset` (plus `LoadSkillTool`,
 * `LoadSkillResourceTool`, `ListSkillsTool`) under
 * `dist/*'/tools/skill/`, but v2.0.0 does not export any of them: they are
 * absent from both public entry points, `package.json` `exports` has no
 * `./tools/skill` subpath, and `LlmAgent` has no `skills` option. Deep imports
 * do not help either — `dist/esm/...` is refused with
 * `ERR_PACKAGE_PATH_NOT_EXPORTED`, and `dist/web/...` (reachable via the
 * `./dist/web/*` wildcard) fails to parse under Node.
 *
 * So this mirrors ADK's design against its *public* surface: the skill format
 * and parser are ADK's (`loadAllSkillsInDir`), and the tool names, argument
 * names, and system-instruction behaviour follow ADK's implementation, so that
 * swapping in the real `SkillToolset` once it is exported is a deletion rather
 * than a rewrite.
 *
 * Deliberate deviation: ADK's `load_skill` returns the whole `resources` object
 * — every reference, asset, and script body — in one response. This one returns
 * only the resource *paths*, leaving `load_skill_resource` to fetch a single
 * file on request, which is the point of splitting L2 from L3.
 */

import {
  BaseTool,
  BaseToolset,
  loadAllSkillsInDir,
  requireAgent,
  type Context,
  type LlmRequest,
  type ReadonlyContext,
  type Skill,
  type ToolProcessLlmRequest,
} from '@google/adk';
import {Type, type FunctionDeclaration} from '@google/genai';

/**
 * Mirrors ADK's `DEFAULT_SKILL_SYSTEM_INSTRUCTION`, minus the `run_skill_script`
 * paragraph — this toolset has no code executor, so it exposes no script tool.
 */
const SKILL_SYSTEM_INSTRUCTION = `You can use specialized 'skills' to help you with complex tasks. You MUST use the skill tools to interact with these skills.

Skills are folders of instructions and resources that extend your capabilities for specialized tasks. Each skill folder contains:
- **SKILL.md** (required): The main instruction file with skill metadata and detailed markdown instructions.
- **references/** (Optional): Additional documentation or examples for skill usage.
- **assets/** (Optional): Templates or other resources used by the skill.

This is very important:

1. If a skill seems relevant to the current user query, you MUST use the \`load_skill\` tool with \`name="<SKILL_NAME>"\` to read its full instructions before proceeding.
2. Once you have read the instructions, follow them exactly as documented before replying to the user. If the instructions list multiple steps, complete all of them in order.
3. The \`load_skill_resource\` tool is for viewing files within a skill's directory (e.g. \`references/*\`). Do NOT use other tools to access these files.`;

function escapeXml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/** Mirrors ADK's `formatSkillsAsXml`, which is also not exported. */
function formatSkillsAsXml(skills: Skill[]): string {
  if (skills.length === 0) {
    return '<available_skills>\n</available_skills>';
  }
  const lines = ['<available_skills>'];
  for (const {frontmatter} of skills) {
    lines.push('  <skill>');
    lines.push(`    <name>${escapeXml(frontmatter.name)}</name>`);
    lines.push(
      `    <description>${escapeXml(frontmatter.description)}</description>`,
    );
    lines.push('  </skill>');
  }
  lines.push('</available_skills>');
  return lines.join('\n');
}

/** Mirrors ADK's `appendInstructions`, which is also not exported. */
function appendInstructions(llmRequest: LlmRequest, instructions: string[]) {
  const config = (llmRequest.config ??= {});
  const appended = instructions.join('\n\n');
  config.systemInstruction = config.systemInstruction
    ? `${config.systemInstruction}\n\n${appended}`
    : appended;
}

/** The resource subdirectories a skill may have, as ADK names them. */
const RESOURCE_DIRECTORIES = ['references', 'assets', 'scripts'] as const;

/** Every resource path a skill exposes, e.g. `references/clothing-matrix.md`. */
function resourcePaths(skill: Skill): string[] {
  const {references = {}, assets = {}, scripts = {}} = skill.resources ?? {};
  return [
    ...Object.keys(references).map((name) => `references/${name}`),
    ...Object.keys(assets).map((name) => `assets/${name}`),
    ...Object.keys(scripts).map((name) => `scripts/${name}`),
  ];
}

export class LocalSkillToolset extends BaseToolset {
  private readonly skillsDir: string;
  private skills?: Record<string, Skill>;
  private readonly tools: BaseTool[];

  constructor(skillsDir: string) {
    super([]);
    this.skillsDir = skillsDir;
    this.tools = [new LoadSkillTool(this), new LoadSkillResourceTool(this)];
  }

  /**
   * Loads every skill under the base directory, once. ADK's loader logs a
   * warning for each optional resource directory a skill omits, so caching
   * keeps that noise to startup instead of repeating it on every tool call.
   */
  private async getSkills(): Promise<Record<string, Skill>> {
    return (this.skills ??= await loadAllSkillsInDir(this.skillsDir));
  }

  async getSkill(name: string): Promise<Skill | undefined> {
    return (await this.getSkills())[name];
  }

  async getTools(_context?: ReadonlyContext): Promise<BaseTool[]> {
    return this.tools;
  }

  async close(): Promise<void> {}

  /**
   * Advertises the available skills in the system instruction, so the agent's
   * own `instruction` never has to name them and adding a skill is just adding
   * a directory.
   *
   * NOTE: this deliberately does *not* live in an override of
   * `BaseToolset.processLlmRequest`, which is where ADK's `SkillToolset` puts
   * it. In v2.0.0 that hook is never called: `LlmAgent` flattens a toolset with
   * `convertToolUnionToTools`, which only calls `toolUnion.getTools(context)`,
   * and then invokes `processLlmRequest` on each resulting *tool*
   * (`agents/llm_agent.js`). `llm_agent.js` never references `isBaseToolset`.
   * Verified the hard way — with the override in place, the catalogue never
   * reached the model and the agent answered from its own judgement instead of
   * loading the skill. `LoadSkillTool.processLlmRequest` calls this instead.
   */
  async injectSkillCatalogue(llmRequest: LlmRequest): Promise<void> {
    const skills = Object.values(await this.getSkills());
    appendInstructions(llmRequest, [
      SKILL_SYSTEM_INSTRUCTION,
      formatSkillsAsXml(skills),
    ]);
  }

  /**
   * Records that a skill was loaded, under the same session-state key ADK's
   * `SkillToolset` uses, so the activation survives a swap to the real toolset.
   */
  markActivated(toolContext: Context, skillName: string) {
    const agentName = requireAgent(toolContext.invocationContext).name;
    const stateKey = `_adk_activated_skill_${agentName}`;
    const activated = (toolContext.state.get(stateKey) as string[]) ?? [];
    if (!activated.includes(skillName)) {
      toolContext.state.set(stateKey, [...activated, skillName]);
    }
  }
}

/** Argument names and error codes follow ADK's `LoadSkillTool`. */
class LoadSkillTool extends BaseTool {
  constructor(private readonly toolset: LocalSkillToolset) {
    super({
      name: 'load_skill',
      description: 'Loads the SKILL.md instructions for a given skill.',
    });
  }

  override _getDeclaration(): FunctionDeclaration {
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: Type.OBJECT,
        properties: {
          name: {
            type: Type.STRING,
            description: 'The name of the skill to load.',
          },
        },
        required: ['name'],
      },
    };
  }

  /**
   * The tool-level hook LlmAgent does call. `super` registers this tool's
   * declaration, so it has to run first or the tool is never offered.
   */
  override async processLlmRequest(request: ToolProcessLlmRequest): Promise<void> {
    await super.processLlmRequest(request);
    await this.toolset.injectSkillCatalogue(request.llmRequest);
  }

  override async runAsync({args, toolContext}: {
    args: Record<string, unknown>;
    toolContext: Context;
  }): Promise<unknown> {
    const skillName = args['name'] as string | undefined;
    if (!skillName) {
      return {error: 'Skill name is required.', error_code: 'MISSING_SKILL_NAME'};
    }

    const skill = await this.toolset.getSkill(skillName);
    if (!skill) {
      return {
        error: `Skill '${skillName}' not found.`,
        error_code: 'SKILL_NOT_FOUND',
      };
    }

    this.toolset.markActivated(toolContext, skillName);

    return {
      skill_name: skillName,
      instructions: skill.instructions,
      frontmatter: skill.frontmatter,
      // Paths only — fetch a body with `load_skill_resource`.
      available_resources: resourcePaths(skill),
    };
  }
}

/** Argument names and error codes follow ADK's `LoadSkillResourceTool`. */
class LoadSkillResourceTool extends BaseTool {
  constructor(private readonly toolset: LocalSkillToolset) {
    super({
      name: 'load_skill_resource',
      description:
        "Loads a single resource file (from a skill's references/, assets/, or " +
        'scripts/ directory) from within a skill.',
    });
  }

  override _getDeclaration(): FunctionDeclaration {
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: Type.OBJECT,
        properties: {
          skill_name: {type: Type.STRING, description: 'The name of the skill.'},
          path: {
            type: Type.STRING,
            description:
              "The relative path to the resource, as listed in the skill's " +
              "available_resources (e.g. 'references/my_doc.md').",
          },
        },
        required: ['skill_name', 'path'],
      },
    };
  }

  override async runAsync({args}: {
    args: Record<string, unknown>;
    toolContext: Context;
  }): Promise<unknown> {
    const skillName = args['skill_name'] as string | undefined;
    const resourcePath = args['path'] as string | undefined;
    if (!skillName) {
      return {error: 'Skill name is required.', error_code: 'MISSING_SKILL_NAME'};
    }
    if (!resourcePath) {
      return {
        error: 'Resource path is required.',
        error_code: 'MISSING_RESOURCE_PATH',
      };
    }

    const skill = await this.toolset.getSkill(skillName);
    if (!skill) {
      return {
        error: `Skill '${skillName}' not found.`,
        error_code: 'SKILL_NOT_FOUND',
      };
    }

    // Resolved as a key in the already-loaded resource records, never against
    // the filesystem, so a traversal path in `resourcePath` simply misses.
    const directory = RESOURCE_DIRECTORIES.find((candidate) =>
      resourcePath.startsWith(`${candidate}/`),
    );
    const name = directory
      ? resourcePath.slice(directory.length + 1)
      : undefined;
    const resources = skill.resources ?? {};
    const content =
      directory === 'references'
        ? resources.references?.[name!]
        : directory === 'assets'
          ? resources.assets?.[name!]
          : directory === 'scripts'
            ? resources.scripts?.[name!]?.src
            : undefined;

    if (content === undefined) {
      return {
        error: `Skill '${skillName}' has no resource '${resourcePath}'.`,
        error_code: 'RESOURCE_NOT_FOUND',
        available_resources: resourcePaths(skill),
      };
    }
    if (Buffer.isBuffer(content)) {
      return {
        error: `Resource '${resourcePath}' is a binary file (${content.byteLength} bytes) and cannot be shown as text.`,
        error_code: 'BINARY_RESOURCE',
      };
    }

    return {skill_name: skillName, path: resourcePath, content};
  }
}
