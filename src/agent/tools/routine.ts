import { StringEnum } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { MAX_ROUTINE_PROMPT, MAX_ROUTINE_TITLE, WEEKDAYS } from '../../policy.ts';

// Routines live on the server (src/routines.ts), so the tool only forwards the call.
export const description = 'List, create, update, pause, resume or delete the user\'s routines: prompts that run on a schedule, each '
  + 'into its own conversation, with a notification when a run is ready. Times are Stockholm time.';

const weekday = StringEnum(WEEKDAYS);
export const parameters = Type.Object({
  action: StringEnum(['list', 'create', 'update', 'pause', 'resume', 'delete'] as const),
  id: Type.Optional(Type.String({description: 'The routine to change, from list'})),
  title: Type.Optional(Type.String({maxLength: MAX_ROUTINE_TITLE, description: 'Short name, e.g. "Morning briefing"'})),
  prompt: Type.Optional(Type.String({maxLength: MAX_ROUTINE_PROMPT,
    description: 'Self-contained instructions for every run, written for a run with nobody watching and no earlier context'})),
  schedule: Type.Optional(Type.Object({
    kind: StringEnum(['daily', 'weekdays', 'weekly', 'monthly', 'once'] as const),
    time: Type.String({pattern: '^\\d{2}:\\d{2}$', description: 'HH:MM, 24-hour, Stockholm time'}),
    days: Type.Optional(Type.Array(weekday, {description: 'For weekly'})),
    day: Type.Optional(Type.Integer({minimum: 1, maximum: 28, description: 'Day of the month, for monthly'})),
    date: Type.Optional(Type.String({pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'YYYY-MM-DD, for once'})),
  })),
  deepResearch: Type.Optional(Type.Boolean({description: 'Use deep research in each run; only when the user asks for it'})),
});
