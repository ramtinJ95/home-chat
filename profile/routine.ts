import { defineTool } from '@earendil-works/pi-coding-agent';
import { description, parameters } from '../src/agent/tools/routine.ts';
import { callServer } from './internal.ts';

export const routineTool = defineTool({
  name: 'routine',
  label: 'Routine',
  description,
  parameters,
  execute: async (_id, params) => ({content: [{type: 'text' as const, text: await callServer('/routine', params)}], details: {}}),
});
