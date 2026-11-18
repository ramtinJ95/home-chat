import { randomUUID } from 'node:crypto';
import type { FindingItem } from './api.d.ts';
import { jsonStore } from './files.ts';
import { MAX_FINDING_SUMMARY, MAX_FINDING_TITLE, MAX_FINDING_URL, MAX_FINDINGS_PER_RUN } from './policy.ts';

// Findings: what a routine that keeps them (Routine.trackFindings) has shared, in findings.json, kept apart from its
// conversation so a long-running routine never forgets what it already shared. A run hands its items to the findings
// tool; the server leaves out the ones shared before, shows the rest under the run's reply, and records them here once
// that reply is saved (src/server.ts endTurn). Each one is a copy of what was shown, never changed later.

// `key`: the link as compared with earlier ones (findingKey). `run`: when the run that shared it was due, ISO.
export interface Finding extends FindingItem { key: string; run: string }
// Per routine id, oldest first.
type Saved = Record<string, Finding[]>;

// Thrown for input the model can correct; the message goes back to it as the tool result.
export class FindingError extends Error {}

// Query parameters that only say where a click came from. Anything else in a link may be part of what it points at.
const TRACKING = /^(?:utm_\w+|gclid|dclid|gbraid|wbraid|fbclid|msclkid|yclid|mc_cid|mc_eid|_hsenc|_hsmi|igshid)$/i;

// The link a finding is known by. Two links are the same finding when they differ only in tracking parameters, the
// order of the other parameters, a text fragment (#:~:text=, which only highlights words on the page), or what the URL
// standard already treats as equal (letter case of the host, a default port). Paths, other parameters, other fragments
// and trailing slashes stay as they are, since a site may tell its items apart by any of them.
export function findingKey(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_FINDING_URL) throw new FindingError(`url must be a link of at most ${MAX_FINDING_URL} characters`);
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new FindingError(`url is not a link: ${value.slice(0, 100)}`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new FindingError('url must be an http or https link');
  for (const name of [...url.searchParams.keys()]) if (TRACKING.test(name)) url.searchParams.delete(name);
  url.searchParams.sort();
  // Setting an empty hash drops the "#" too, which a bare "#" left behind would not.
  const fragment = url.hash.replace(/:~:.*$/, '');
  url.hash = fragment === '#' ? '' : fragment;
  return url.href;
}

const oneLine = (value: unknown, name: string, maximum: number) => {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (!text || text.length > maximum) throw new FindingError(`Each item's ${name} must be 1 to ${maximum} characters`);
  return text;
};

// The findings tool's items, checked; a new id each.
export function findingItems(value: unknown): (FindingItem & {key: string})[] {
  if (!Array.isArray(value) || !value.length || value.length > MAX_FINDINGS_PER_RUN) {
    throw new FindingError(`items must list 1 to ${MAX_FINDINGS_PER_RUN} findings`);
  }
  return value.map(item => {
    const input = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>;
    const key = findingKey(input.url);
    return {id: randomUUID(), url: key, key, title: oneLine(input.title, 'title', MAX_FINDING_TITLE),
      summary: oneLine(input.summary, 'summary', MAX_FINDING_SUMMARY), site: new URL(key).hostname.replace(/^www\./, '')};
  });
}

export async function createFindings(path: string) {
  const {saved, change} = await jsonStore<Saved>(path, {});
  const of = (routine: string): readonly Finding[] => saved()[routine] ?? [];
  return {
    list: of,
    count: (routine: string) => of(routine).length,
    known: (routine: string, key: string) => of(routine).some(finding => finding.key === key),
    // Adds the ones it does not know yet, so recording the same run again changes nothing.
    record: (routine: string, found: readonly Finding[]) => change(state => {
      const list = state[routine] ??= [];
      for (const finding of found) if (!list.some(known => known.key === finding.key)) list.push(finding);
    }),
    remove: (routine: string) => change(state => { delete state[routine]; }),
  };
}
