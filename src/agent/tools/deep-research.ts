import { StringEnum } from '@earendil-works/pi-ai';
import { Type, type Static } from 'typebox';

// Exa deep research, adapted from the owner's Pi extension (~/.pi/agent/extensions/exa-deep-research.ts). The key comes
// only from EXA_API_KEY, which compose passes to the app; requests leave through the egress proxy, which allows api.exa.ai.
// Calls outside deep research mode are refused (src/agent/extension.ts).
const EXA_SEARCH_URL = 'https://api.exa.ai/search';
const REQUEST_TIMEOUT_MS = 90_000;
const MAX_SOURCES = 8;
const MAX_GROUNDING_FIELDS = 20;
const MAX_CITATIONS_PER_FIELD = 3;
// Every field is bounded, so the output stays whole, valid JSON with its sources instead of being cut at the end.
const MAX_SYNTHESIS = 40_000;

const modes = {
  'deep': {
    output: 'Return a grounded research synthesis with key findings, caveats, notable disagreements, and the most important implications.',
    prompt: 'Aim for thorough coverage while staying grounded and avoiding unnecessary repetition.',
  },
  'deep-reasoning': {
    output: 'Return a grounded research analysis that resolves ambiguity where possible, weighs conflicting evidence, and states the best-supported conclusion with uncertainty.',
    prompt: 'Spend extra effort reconciling ambiguity, conflicting reporting, and edge cases before reaching a conclusion.',
  },
} as const;
type Mode = keyof typeof modes;

const categories = ['company', 'research paper', 'news', 'personal site', 'people', 'financial report'] as const;

export const parameters = Type.Object({
  query: Type.String({minLength: 1, maxLength: 2000}),
  mode: Type.Optional(StringEnum(['deep', 'deep-reasoning'] as const, {
    default: 'deep', description: 'deep by default; deep-reasoning for ambiguity, conflicting evidence, high stakes or judgment-heavy tradeoffs',
  })),
  numResults: Type.Optional(Type.Number({minimum: 1, maximum: 100, description: 'default 10'})),
  category: Type.Optional(StringEnum(categories)),
  includeDomains: Type.Optional(Type.Array(Type.String(), {maxItems: 20})),
  excludeDomains: Type.Optional(Type.Array(Type.String(), {maxItems: 20})),
  startPublishedDate: Type.Optional(Type.String({description: 'ISO date'})),
  endPublishedDate: Type.Optional(Type.String({description: 'ISO date'})),
  maxAgeHours: Type.Optional(Type.Number({description: '0 for live pages; -1 for cached'})),
  additionalQueries: Type.Optional(Type.Array(Type.String(), {maxItems: 10})),
  userLocation: Type.Optional(Type.String({minLength: 2, maxLength: 2, description: 'two-letter country code'})),
});
export type Params = Static<typeof parameters>;

interface ExaResult { title?: string; url?: string; publishedDate?: string | null; author?: string | null; highlights?: string[] }
interface ExaGrounding { field?: string; confidence?: string; citations?: {url?: string; title?: string}[] }
interface ExaResponse { requestId?: string; results?: ExaResult[]; output?: {content?: unknown; grounding?: ExaGrounding[]}; error?: string }

const clip = (value: string | null | undefined, maximum: number) => {
  const text = value?.replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length <= maximum ? text : text.slice(0, maximum - 1) + '…';
};
const unique = (values?: string[]) => {
  const kept = [...new Set(values?.map(value => value.trim()).filter(Boolean))];
  return kept.length ? kept : undefined;
};

// Exa rejects these combinations with a vague error; saying why lets the model correct its call.
function checkFilters(params: Params) {
  const issues: string[] = [];
  const {category} = params;
  if ((category === 'company' || category === 'people') && params.excludeDomains?.length) issues.push(`excludeDomains is not supported with category ${category}`);
  if ((category === 'company' || category === 'people') && (params.startPublishedDate || params.endPublishedDate)) {
    issues.push(`startPublishedDate/endPublishedDate are not supported with category ${category}`);
  }
  if (category === 'people' && params.includeDomains?.some(domain => !domain.toLowerCase().includes('linkedin'))) {
    issues.push('category people only supports LinkedIn domains in includeDomains');
  }
  if (issues.length) throw new Error(issues.join('. '));
}

function failure(status: number, body: ExaResponse | undefined, text: string): string {
  const detail = (typeof body?.error === 'string' ? body.error : undefined) ?? clip(text, 600) ?? `HTTP ${status}`;
  if (status === 401) return `Exa authentication failed (${detail}). The Exa key on this Home Chat needs checking.`;
  if (status === 402) return `Exa needs payment or more credits (${detail}). Research is unavailable until the account is topped up.`;
  if (status === 429) return `Exa rate limited the request (${detail}). Try again later.`;
  if (status >= 400 && status < 500) return `Exa rejected the request (${detail}). Check category and filter compatibility.`;
  return `Exa request failed (${detail}).`;
}

export async function research(params: Params, signal?: AbortSignal) {
  const apiKey = process.env.EXA_API_KEY?.trim();
  if (!apiKey) throw new Error('Deep research is not set up on this Home Chat (no Exa key)');
  const query = params.query.trim();
  if (!query) throw new Error('query must not be empty');
  const mode: Mode = params.mode ?? 'deep';
  const includeDomains = unique(params.includeDomains?.map(domain => domain.toLowerCase()));
  const excludeDomains = unique(params.excludeDomains?.map(domain => domain.toLowerCase()));
  const additionalQueries = unique(params.additionalQueries)?.filter(value => value !== query);
  checkFilters({...params, includeDomains, excludeDomains});
  const contents: Record<string, unknown> = {highlights: {maxCharacters: 2000, query}};
  if (params.maxAgeHours !== undefined) contents.maxAgeHours = params.maxAgeHours;
  const body = {
    query, type: mode, numResults: params.numResults ?? 10,
    systemPrompt: ['Perform grounded web research using the retrieved evidence.',
      'Prefer primary, official, and first-hand sources when they exist, then high-quality secondary sources.',
      'Deduplicate repetitive coverage and call out uncertainty or conflicts explicitly.', modes[mode].prompt].join('\n\n'),
    outputSchema: {type: 'text', description: modes[mode].output},
    contents,
    ...(params.category && {category: params.category}),
    ...(includeDomains && {includeDomains}),
    ...(excludeDomains && {excludeDomains}),
    ...(params.startPublishedDate && {startPublishedDate: params.startPublishedDate}),
    ...(params.endPublishedDate && {endPublishedDate: params.endPublishedDate}),
    ...(additionalQueries && {additionalQueries}),
    ...(params.userLocation && {userLocation: params.userLocation.trim().toUpperCase()}),
  };
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  let response: Response; let text: string;
  try {
    response = await fetch(EXA_SEARCH_URL, {
      method: 'POST', headers: {'content-type': 'application/json', 'x-api-key': apiKey}, body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    text = await response.text();
  } catch (error) {
    if (timeout.aborted) throw new Error(`Exa did not answer within ${REQUEST_TIMEOUT_MS / 1000} seconds`);
    if (signal?.aborted) throw new Error('Research stopped');
    throw new Error('Could not reach Exa', {cause: error});
  }
  let parsed: ExaResponse | undefined;
  try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = undefined; }
  if (!response.ok) throw new Error(failure(response.status, parsed, text));
  if (!parsed) throw new Error('Exa returned an empty or non-JSON response');

  const results = Array.isArray(parsed.results) ? parsed.results : [];
  const grounding = parsed.output?.grounding ?? [];
  const warnings: string[] = [];
  if (results.length > MAX_SOURCES) warnings.push(`Only the first ${MAX_SOURCES} of ${results.length} sources are listed.`);
  if (grounding.length > MAX_GROUNDING_FIELDS) warnings.push(`Only the first ${MAX_GROUNDING_FIELDS} of ${grounding.length} grounding entries are listed.`);
  const content = parsed.output?.content;
  let synthesis = content === undefined || content === null ? null : typeof content === 'string' ? content : JSON.stringify(content);
  if (synthesis === null) warnings.push('Exa returned no synthesis; rely on the listed sources.');
  else if (synthesis.length > MAX_SYNTHESIS) {
    synthesis = synthesis.slice(0, MAX_SYNTHESIS) + '…';
    warnings.push(`The synthesis was shortened to ${MAX_SYNTHESIS} characters; the sources are complete.`);
  }
  const output = {
    mode, query,
    synthesizedOutput: synthesis,
    grounding: grounding.slice(0, MAX_GROUNDING_FIELDS).map(entry => ({
      field: clip(entry.field, 200) ?? 'content', confidence: clip(entry.confidence, 40) ?? null,
      citations: (entry.citations ?? []).slice(0, MAX_CITATIONS_PER_FIELD).map(citation => ({url: clip(citation.url, 2000) ?? null, title: clip(citation.title, 300) ?? null})),
    })),
    sources: results.slice(0, MAX_SOURCES).map(result => ({
      title: clip(result.title, 300) ?? 'Untitled', url: clip(result.url, 2000) ?? null,
      publishedDate: clip(result.publishedDate, 40) ?? null, author: clip(result.author, 200) ?? null,
      highlights: (result.highlights ?? []).map(highlight => clip(highlight, 320)).filter(Boolean).slice(0, 2),
    })),
    warnings,
  };
  return {
    output: [{type: 'text' as const, text: JSON.stringify(output, null, 2)}],
    details: {mode, requestId: parsed.requestId ?? null, resultCount: results.length},
  };
}

export const description = 'Run Exa deep research: a grounded, multi-source web synthesis with citations. Takes up to a minute or two per call.';
