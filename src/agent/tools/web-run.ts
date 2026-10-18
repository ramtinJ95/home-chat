import type { MutableModels } from '@earendil-works/pi-ai';
import { Type, type Static } from 'typebox';
import { codexPost } from '../codex.ts';

// Codex's own web tool, as @howaboua/pi-codex-web-run called it from the Pi CLI: the same schema and request. Requests
// with the same `id` share their refs, so a conversation passes one id for all its calls.
export const description = 'Search/open web. Calls use returned turn refs; final answers use Markdown result URLs, never refs or cite….';

const query = Type.Object({q: Type.String(), recency: Type.Optional(Type.Number({description: 'Days'})), domains: Type.Optional(Type.Array(Type.String()))},
  {additionalProperties: true});
const level = <const T extends string[]>(...values: T) => Type.Union(values.map(value => Type.Literal(value)));
export const parameters = Type.Object({
  search_query: Type.Optional(Type.Array(query)),
  image_query: Type.Optional(Type.Array(query)),
  open: Type.Optional(Type.Array(Type.Object({ref_id: Type.String(), lineno: Type.Optional(Type.Number())}, {additionalProperties: true}),
    {description: 'ref_id or URL'})),
  click: Type.Optional(Type.Array(Type.Object({ref_id: Type.String(), id: Type.Number()}, {additionalProperties: true}))),
  find: Type.Optional(Type.Array(Type.Object({ref_id: Type.String(), pattern: Type.String()}, {additionalProperties: true}))),
  response_length: Type.Optional(level('short', 'medium', 'long')),
  settings: Type.Optional(Type.Object({search_context_size: Type.Optional(level('low', 'medium', 'high'))}, {additionalProperties: true})),
}, {additionalProperties: true});

export async function webRun(models: MutableModels, id: string, args: Static<typeof parameters>, signal?: AbortSignal) {
  const {settings, ...commands} = args;
  const result = await codexPost(models, '/alpha/search', {
    id, model: 'gpt-6-luna', commands,
    settings: {...settings, allowed_callers: ['direct'], external_web_access: true}, max_output_tokens: 2_500,
  }, signal) as Record<string, unknown> | null;
  const text = typeof result?.output_text === 'string' ? result.output_text : typeof result?.output === 'string' ? result.output : undefined;
  const results = result?.search_results ?? result?.results;
  if (text === undefined && !Array.isArray(results)) throw new Error('web_run search returned no output');
  return text || JSON.stringify({search_results: results}, null, 2);
}
