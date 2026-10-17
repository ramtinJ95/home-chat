import { defineTool } from '@earendil-works/pi-coding-agent';
import { changeMemory, description, parameters } from '../src/agent/tools/memory.ts';
import { callServer } from './internal.ts';

export const memoryTool = defineTool({
  name: 'memory',
  label: 'Memory',
  description,
  parameters,
  // One question at a time: the app shows a single question, so a second asked alongside would never be answered.
  executionMode: 'sequential',
  // Stop dismisses the question along with the turn.
  execute: async (_id, params, signal, _update, ctx) => ({
    content: [{type: 'text' as const, text: await changeMemory(params, callServer, (title, message) => ctx.ui.confirm(title, message, {signal}))}],
    details: {},
  }),
});
