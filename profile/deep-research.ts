import { defineTool } from '@earendil-works/pi-coding-agent';
import { description, parameters, research } from '../src/agent/tools/deep-research.ts';

export const deepResearchTool = defineTool({
  name: 'deep_research',
  label: 'Deep Research',
  description,
  parameters,
  execute: (_id, params, signal) => research(params, signal),
});
