import { defineTool } from '@earendil-works/pi-coding-agent';
import { description, parameters, saveDocument } from '../src/agent/tools/document.ts';

export const documentTool = defineTool({
  name: 'document',
  label: 'Document',
  description,
  parameters,
  async execute(_id, params, _signal, _update, ctx) {
    const {text, doc, version} = await saveDocument(params, ctx.cwd);
    return {content: [{type: 'text' as const, text}], details: {doc, version}};
  },
});
