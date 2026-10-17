import { StringEnum } from '@earendil-works/pi-ai';
import { Type, type Static } from 'typebox';
import { MAX_NOTE } from '../../memory.ts';
import type { ServerCall } from '../../policy.ts';

// The household notes ("About us") live on the server (src/memory.ts). Nothing is saved without the user's yes: the
// tool asks them itself, after the server has checked that the change can be made.
export const description = 'Suggest a note for About us, the household notes you are told in every conversation, or suggest forgetting '
  + 'one. The user is asked to confirm before anything changes.';

export const parameters = Type.Object({
  action: StringEnum(['remember', 'forget'] as const),
  text: Type.String({maxLength: MAX_NOTE,
    description: 'One short fact, e.g. "Vegetarian, but eats fish". To forget a note, copy it exactly as written in About us'}),
  shared: Type.Optional(Type.Boolean({description: 'About the whole household rather than this person, e.g. the city it is in'})),
  replaces: Type.Optional(Type.String({maxLength: MAX_NOTE, description: 'A note this one updates, copied exactly as written'})),
});

// `confirm` asks the user a yes/no question and resolves with their answer.
export async function changeMemory(params: Static<typeof parameters>, call: ServerCall,
  confirm: (title: string, message: string) => Promise<boolean>): Promise<string> {
  await call('/memory', {...params, check: true});
  const where = params.shared ? 'for the whole household' : 'about you';
  const [title, message] = params.action === 'forget' ? ['Forget this note?', params.text]
    : params.replaces ? [`Update this note ${where}?`, `${params.text}\n\nInstead of: ${params.replaces}`]
    : [`Remember this ${where}?`, params.text];
  if (!await confirm(title, message)) return 'The user said no, so nothing changed. Do not suggest it again unless they bring it up.';
  return call('/memory', params);
}
