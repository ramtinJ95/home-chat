import conversion from '@howaboua/pi-codex-conversion';
import web from '/app/node_modules/@howaboua/pi-codex-web-run/index.ts';
import imagegen from '/app/node_modules/@howaboua/pi-codex-imagegen/index.ts';
import ask from '/app/node_modules/@howaboua/pi-ask/index.ts';
import { readFile } from 'node:fs/promises';
import { ALLOWED_TOOLS, validateToolInput } from '../src/policy.mjs';

export default async function homeChat(pi) {
  const instructions = await readFile('/app/profile/instructions.md', 'utf8');
  let calls = 0;
  let images = 0;
  const restricted = new Proxy(pi, {
    get(target, property) {
      if (property === 'registerTool') return tool => {
        if (!ALLOWED_TOOLS.includes(tool.name)) return;
        target.registerTool({
          ...tool,
          execute: async (id, args, signal, update, ctx) => {
            await validateToolInput(tool.name, args, ctx.cwd);
            if (++calls > 12) throw new Error('Tool-call limit reached for this message');
            if (tool.name === 'imagegen' && ++images > 2) throw new Error('Two image requests per message maximum');
            return tool.execute(id, args, signal, update, ctx);
          },
        });
      };
      if (property === 'setActiveTools') return names => target.setActiveTools(names.filter(name => ALLOWED_TOOLS.includes(name)));
      if (property === 'getAllTools') return () => target.getAllTools().filter(tool => ALLOWED_TOOLS.includes(tool.name));
      if (property === 'getActiveTools') return () => target.getActiveTools().filter(name => ALLOWED_TOOLS.includes(name));
      if (property === 'registerCommand') return (name, command) => {
        // Conversion uses this private startup command only to capture its session context.
        if (name === 'pi-codex-context-tree-capture') target.registerCommand(name, command);
      };
      if (property === 'registerShortcut') return () => {};
      if (property === 'exec') return () => { throw new Error('Extension command execution disabled'); };
      return typeof target[property] === 'function' ? target[property].bind(target) : target[property];
    },
  });
  await conversion(restricted);
  await web(restricted);
  await imagegen(restricted);
  await ask(restricted);

  const enforce = () => {
    const registered = pi.getAllTools().map(tool => tool.name);
    if (registered.some(name => !ALLOWED_TOOLS.includes(name))) throw new Error('Unexpected tool registration: refusing to run');
    if (!ALLOWED_TOOLS.every(name => registered.includes(name))) throw new Error('Required chat tool missing');
    if (JSON.stringify(pi.getActiveTools()) !== JSON.stringify(ALLOWED_TOOLS)) pi.setActiveTools([...ALLOWED_TOOLS]);
  };
  pi.on('session_start', async (_event, ctx) => {
    enforce();
    ctx.ui.notify('HOME_CHAT_POLICY:' + JSON.stringify({registered: pi.getAllTools().map(t => t.name), active: pi.getActiveTools()}), 'info');
  });
  pi.on('model_select', () => enforce());
  pi.on('before_agent_start', () => {
    enforce(); calls = 0; images = 0;
    return {systemPrompt: instructions};
  });
  pi.on('tool_call', async (event, ctx) => {
    try {
      await validateToolInput(event.toolName, event.input, ctx.cwd);
    } catch (error) {
      return {block: true, reason: error.message};
    }
  });
  pi.on('user_bash', () => ({result: {output: 'Shell disabled', exitCode: 1, cancelled: false, truncated: false}}));
}
