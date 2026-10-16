import { defineTool } from '@earendil-works/pi-coding-agent';
import { StringEnum } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { MAX_NOTE } from '../src/memory.ts';
import { callServer } from './internal.ts';

// The household notes ("About us") live on the server (src/memory.ts). Nothing is saved without the user's yes: the
// tool asks them itself, after the server has checked that the change can be made.
const parameters = Type.Object({
  action: StringEnum(['remember', 'forget'] as const),
  text: Type.String({maxLength: MAX_NOTE,
    description: 'One short fact, e.g. "Vegetarian, but eats fish". To forget a note, copy it exactly as written in About us'}),
  shared: Type.Optional(Type.Boolean({description: 'About the whole household rather than this person, e.g. the city it is in'})),
  replaces: Type.Optional(Type.String({maxLength: MAX_NOTE, description: 'A note this one updates, copied exactly as written'})),
});

const reply = (text: string) => ({content: [{type: 'text' as const, text}], details: {}});

export const memoryTool = defineTool({
  name: 'memory',
  label: 'Memory',
  description: 'Suggest a note for About us, the household notes you are told in every conversation, or suggest forgetting '
    + 'one. The user is asked to confirm before anything changes.',
  parameters,
  // One question at a time: the app shows a single question, so a second asked alongside would never be answered.
  executionMode: 'sequential',
  execute: async (_id, params, signal, _update, ctx) => {
    await callServer('/memory', {...params, check: true});
    const where = params.shared ? 'for the whole household' : 'about you';
    const [title, message] = params.action === 'forget' ? ['Forget this note?', params.text]
      : params.replaces ? [`Update this note ${where}?`, `${params.text}\n\nInstead of: ${params.replaces}`]
      : [`Remember this ${where}?`, params.text];
    // Stop dismisses the question along with the turn.
    if (!await ctx.ui.confirm(title, message, {signal})) return reply('The user said no, so nothing changed. Do not suggest it again unless they bring it up.');
    return reply(await callServer('/memory', params));
  },
});
