import { Type, type Static } from 'typebox';
import type { Question } from '../../api.d.ts';

// The questions the app shows (Question without its id). Resolves with the answer: the chosen option or typed text, true
// or false for confirm, undefined when the user dismissed it.
export type Dialog = (question: Omit<Question, 'id'>) => Promise<string | boolean | undefined>;

// The same questions as @howaboua/pi-ask asked through the Pi CLI, which the app was built around: a choice list with
// "Other/rephrase", repeated picks for multiple choice, and an optional comment after each prompt. Its steering and
// handoff deliveries are left out; nothing here can take an answer after the turn moves on.
const OTHER = 'Other/rephrase';
const REPHRASE = 'User asked for rephrase, split, or follow-up.';

export const description = 'Request user input or a choice. Other/rephrase is added automatically; omit choices for free text. '
  + 'A blank Other/rephrase means rephrase or follow up.';

export const parameters = Type.Object({
  prompts: Type.Array(Type.Object({
    title: Type.String({minLength: 1}),
    body: Type.Optional(Type.String()),
    multiple: Type.Optional(Type.Boolean()),
    choices: Type.Optional(Type.Array(Type.Object({label: Type.String({minLength: 1}), description: Type.Optional(Type.String())},
      {additionalProperties: false}))),
  }, {additionalProperties: false}), {minItems: 1}),
}, {additionalProperties: false});

const typed = (value: string | boolean | undefined) => typeof value === 'string' ? value.trim() || REPHRASE : undefined;

// Undefined when the user dismissed any of the questions; one answer dismissed dismisses the whole ask.
export async function ask({prompts}: Static<typeof parameters>, dialog: Dialog): Promise<string | undefined> {
  const lines: string[] = [];
  for (const prompt of prompts) {
    const title = prompt.title.trim();
    const text = prompt.body?.trim() ? `${title}\n\n${prompt.body.trim()}` : title;
    const choices = (prompt.choices ?? []).map(choice => choice.label.trim()).filter(label => label && label !== OTHER);
    const other = async () => typed(await dialog({method: 'input', title, message: 'Alternative; blank = rephrase', options: [], prefill: ''}));
    const picked: string[] = [];
    if (!choices.length) {
      const answer = typed(await dialog({method: 'input', title: text, message: 'Response', options: [], prefill: ''}));
      if (answer === undefined) return undefined;
      picked.push(answer);
    } else if (!prompt.multiple) {
      const answer = await dialog({method: 'select', title: text, message: '', options: [...choices, OTHER], prefill: ''});
      const chosen = answer === OTHER ? await other() : typeof answer === 'string' ? answer : undefined;
      if (chosen === undefined) return undefined;
      picked.push(chosen);
    } else {
      let finish = 'Finish selection';
      for (let suffix = 2; [...choices, OTHER].includes(finish); suffix++) finish = `Finish selection (${suffix})`;
      while (true) {
        const answer = await dialog({method: 'select', title: text, message: '',
          options: [...choices.filter(choice => !picked.includes(choice)), OTHER, finish], prefill: ''});
        if (answer === finish) break;
        const chosen = answer === OTHER ? await other() : typeof answer === 'string' ? answer : undefined;
        if (chosen === undefined) return undefined;
        picked.push(chosen);
      }
    }
    const comment = await dialog({method: 'input', title: `${title} — comment`, message: 'Optional comment', options: [], prefill: ''});
    if (typeof comment !== 'string') return undefined;
    lines.push(`${title}: ${picked.join(', ') || 'No selection'}` + (comment.trim() ? `\n  Comment: ${comment.trim()}` : ''));
  }
  return lines.join('\n');
}
