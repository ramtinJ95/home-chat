import { request } from 'node:http';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { StringEnum } from '@earendil-works/pi-ai';
import { Type } from 'typebox';

// Routines live on the server (src/routines.ts), so this tool only forwards the call: over a Unix socket the server
// listens on for its own workers, with the token it gave this Pi process. The server checks everything, scopes it to the
// conversation's owner, and answers with the text the model gets back.
const weekday = StringEnum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const);
const parameters = Type.Object({
  action: StringEnum(['list', 'create', 'update', 'pause', 'resume', 'delete'] as const),
  id: Type.Optional(Type.String({description: 'The routine to change, from list'})),
  title: Type.Optional(Type.String({maxLength: 80, description: 'Short name, e.g. "Morning briefing"'})),
  prompt: Type.Optional(Type.String({maxLength: 4000,
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

function call(body: unknown): Promise<string> {
  const socketPath = process.env.HOME_CHAT_INTERNAL_SOCKET; const token = process.env.HOME_CHAT_ROUTINE_TOKEN;
  if (!socketPath || !token) return Promise.reject(new Error('Routines are not available in this session'));
  return new Promise((resolve, reject) => {
    // agent: false keeps this off the global agent, which NODE_USE_ENV_PROXY points at the egress proxy.
    const outgoing = request({socketPath, path: '/routine', method: 'POST', agent: false, timeout: 15_000,
      headers: {'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token}}, response => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        let reply: {text?: unknown; error?: unknown};
        try { reply = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reject(new Error('Invalid routine service response')); }
        if (response.statusCode === 200 && typeof reply.text === 'string') resolve(reply.text);
        else reject(new Error(typeof reply.error === 'string' ? reply.error : 'The routine service failed'));
      });
    });
    outgoing.on('timeout', () => outgoing.destroy(new Error('The routine service did not answer')));
    outgoing.on('error', reject);
    outgoing.end(JSON.stringify(body));
  });
}

export const routineTool = defineTool({
  name: 'routine',
  label: 'Routine',
  description: 'List, create, update, pause, resume or delete the user\'s routines: prompts that run on a schedule, each '
    + 'into its own conversation, with a notification when a run is ready. Times are Stockholm time.',
  parameters,
  execute: async (_id, params) => ({content: [{type: 'text' as const, text: await call(params)}], details: {}}),
});
