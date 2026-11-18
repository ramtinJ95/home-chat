import { Type } from 'typebox';
import { MAX_FINDING_SUMMARY, MAX_FINDING_TITLE, MAX_FINDING_URL, MAX_FINDINGS_PER_RUN } from '../../policy.ts';

// A run's findings are kept on the server (src/findings.ts), so the tool only forwards the call.
export const description = 'Only in a run of a routine that keeps a list of what it finds: hand over the items found. The app '
  + 'shows them under your reply and leaves out any shared in an earlier run; the result says which were new.';

export const parameters = Type.Object({
  items: Type.Array(Type.Object({
    url: Type.String({maxLength: MAX_FINDING_URL, description: 'The item\'s own page, such as the job ad, not a search or list page'}),
    title: Type.String({maxLength: MAX_FINDING_TITLE, description: 'Short title, e.g. "Backend engineer – Acme"'}),
    summary: Type.String({maxLength: MAX_FINDING_SUMMARY, description: 'One sentence on what it is and why it matters here'}),
  }), {minItems: 1, maxItems: MAX_FINDINGS_PER_RUN}),
});
