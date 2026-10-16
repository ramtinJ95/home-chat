import conversion from '@howaboua/pi-codex-conversion';
import web from '@howaboua/pi-codex-web-run';
import imagegen from '@howaboua/pi-codex-imagegen';
import ask from '@howaboua/pi-ask';
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { readFile } from 'node:fs/promises';
import { deepResearchTool } from './deep-research.ts';
import { documentTool } from './document.ts';
import { callServer } from './internal.ts';
import { memoryTool } from './memory.ts';
import { routineTool } from './routine.ts';
import { ALLOWED_TOOLS, POLICY_PREFIX, TURN_LIMITS, isAllowedTool, promptMode, refusedInTurn, validateToolInput, type ToolPolicy } from '../src/policy.ts';

export default async function homeChat(pi: ExtensionAPI): Promise<void> {
  const instructions = await readFile('/app/profile/instructions.md', 'utf8');
  let calls = 0;
  let images = 0;
  // Set per message from the server's notes at the start of the prompt (src/policy.ts composePrompt).
  let mode = {deepResearch: false, routineRun: false};
  // The third-party extensions only ever see this restricted view of the API.
  const overrides: Partial<ExtensionAPI> = {
    registerTool: ((tool: ToolDefinition) => {
      if (!isAllowedTool(tool.name)) return;
      pi.registerTool({
        ...tool,
        execute: async (id, args, signal, update, ctx) => {
          await validateToolInput(tool.name, args, ctx.cwd);
          const refused = refusedInTurn(tool.name, mode);
          if (refused) throw new Error(refused);
          if (++calls > TURN_LIMITS[mode.deepResearch ? 'deep' : 'normal'].toolCalls) throw new Error('Tool-call limit reached for this message');
          if (tool.name === 'imagegen' && ++images > 2) throw new Error('Two image requests per message maximum');
          return tool.execute(id, args, signal, update, ctx);
        },
      });
    }) as ExtensionAPI['registerTool'],
    setActiveTools: names => pi.setActiveTools(names.filter(isAllowedTool)),
    getAllTools: () => pi.getAllTools().filter(tool => isAllowedTool(tool.name)),
    getActiveTools: () => pi.getActiveTools().filter(isAllowedTool),
    registerCommand: (name, command) => {
      // Conversion uses this private startup command only to capture its session context.
      if (name === 'pi-codex-context-tree-capture') pi.registerCommand(name, command);
    },
    registerShortcut: () => {},
    exec: () => { throw new Error('Extension command execution disabled'); },
  };
  const restricted = new Proxy(pi, {
    get(target, property: keyof ExtensionAPI) {
      if (Object.hasOwn(overrides, property)) return overrides[property];
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  await conversion(restricted);
  await web(restricted);
  await imagegen(restricted);
  await ask(restricted);
  // Home Chat's own tools go through the same wrapper, so they share the call limit and input checks.
  restricted.registerTool(documentTool);
  restricted.registerTool(deepResearchTool);
  restricted.registerTool(routineTool);
  restricted.registerTool(memoryTool);

  const enforce = () => {
    const registered = pi.getAllTools().map(tool => tool.name);
    if (!registered.every(isAllowedTool)) throw new Error('Unexpected tool registration: refusing to run');
    if (!ALLOWED_TOOLS.every(name => registered.includes(name))) throw new Error('Required chat tool missing');
    if (JSON.stringify(pi.getActiveTools()) !== JSON.stringify(ALLOWED_TOOLS)) pi.setActiveTools([...ALLOWED_TOOLS]);
  };
  pi.on('session_start', async (_event, ctx) => {
    enforce();
    const policy = {registered: pi.getAllTools().map(t => t.name), active: pi.getActiveTools()} satisfies ToolPolicy;
    ctx.ui.notify(POLICY_PREFIX + JSON.stringify(policy), 'info');
  });
  pi.on('model_select', () => enforce());
  pi.on('before_agent_start', async event => {
    enforce(); calls = 0; images = 0;
    mode = event.messageType === 'user' ? promptMode(event.prompt) : {deepResearch: false, routineRun: false};
    // The household notes as they are now, so an edit under About us counts from the next message on.
    const notes = await callServer('/memory').catch(() => 'The household notes (About us) could not be loaded for this message. '
      + 'If the user refers to something they asked you to remember, say that you cannot see the notes right now.\n');
    return {systemPrompt: notes ? instructions + '\n' + notes : instructions};
  });
  pi.on('tool_call', async (event, ctx) => {
    const refused = refusedInTurn(event.toolName, mode);
    if (refused) return {block: true, reason: refused};
    try {
      await validateToolInput(event.toolName, event.input, ctx.cwd);
    } catch (error) {
      return {block: true, reason: (error as Error).message};
    }
  });
  pi.on('user_bash', () => ({result: {output: 'Shell disabled', exitCode: 1, cancelled: false, truncated: false}}));
}
