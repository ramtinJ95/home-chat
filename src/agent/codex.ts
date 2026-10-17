// The Codex subscription: the login in /data/profile/auth.json, the model through pi-ai's openai-codex provider, and
// requests to the Codex endpoints web_run and imagegen use.
import { createModels, type Credential, type CredentialInfo, type CredentialStore, type MutableModels } from '@earendil-works/pi-ai';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { atomicJson, readJson } from '../files.ts';

const CODEX_BASE = 'https://chatgpt.com/backend-api/codex';

// The shape the Pi CLI wrote and scripts/accept-auth.ts writes: one credential per provider id. A token refresh rewrites
// the file; changes take turns, so two refreshes never overwrite each other.
export class FileCredentialStore implements CredentialStore {
  readonly path: string;
  #chain: Promise<unknown> = Promise.resolve();
  constructor(path: string) { this.path = path; }

  async #all(): Promise<Record<string, Credential>> { return await readJson<Record<string, Credential>>(this.path) ?? {}; }

  async read(providerId: string): Promise<Credential | undefined> { return (await this.#all())[providerId]; }

  async list(): Promise<readonly CredentialInfo[]> {
    return Object.entries(await this.#all()).map(([providerId, credential]) => ({providerId, type: credential.type}));
  }

  // `change` returning undefined leaves the credential as it is (pi-ai's CredentialStore contract).
  modify(providerId: string, change: (current: Credential | undefined) => Promise<Credential | undefined>): Promise<Credential | undefined> {
    return this.#write(async all => {
      const next = await change(all[providerId]);
      if (next) all[providerId] = next;
      return next ?? all[providerId];
    }, providerId);
  }

  async delete(providerId: string): Promise<void> {
    await this.#write(async all => { delete all[providerId]; return undefined; }, providerId);
  }

  #write(change: (all: Record<string, Credential>) => Promise<Credential | undefined>, providerId: string): Promise<Credential | undefined> {
    const run = this.#chain.then(async () => {
      const all = await this.#all();
      const before = JSON.stringify(all[providerId]);
      const result = await change(all);
      if (JSON.stringify(all[providerId]) !== before) await atomicJson(this.path, all);
      return result;
    });
    this.#chain = run.catch(() => {});
    return run;
  }
}

export function codexModels(authPath: string): MutableModels {
  const models = createModels({credentials: new FileCredentialStore(authPath)});
  models.setProvider(openaiCodexProvider());
  return models;
}

// The account id sits in the access token's claims; the endpoints want it as a header.
function accountId(token: string): string {
  const claims = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'));
  const id = claims?.['https://api.openai.com/auth']?.chatgpt_account_id;
  if (typeof id !== 'string' || !id) throw new Error('The Codex login has no account id');
  return id;
}

// For a refused request, the error's own message, cut short and with anything token-like removed.
async function reason(response: Response): Promise<string> {
  const body = await response.json().catch(() => undefined) as {error?: {message?: unknown}; detail?: unknown} | undefined;
  const message = body?.error?.message ?? body?.detail;
  return typeof message === 'string' ? ': ' + message.replace(/[A-Za-z0-9_\-.]{32,}/g, '[redacted]').slice(0, 200) : '';
}

// POST to a Codex endpoint (e.g. /alpha/search, /images/generations). Of a refused request only `reason` is shown,
// never the whole body: it can echo request details.
export async function codexPost(models: MutableModels, path: string, body: unknown, signal?: AbortSignal,
  headers: Record<string, string> = {}): Promise<unknown> {
  // Refreshes the access token first when it has expired.
  const token = (await models.getAuth('openai-codex'))?.auth.apiKey;
  if (!token) throw new Error('Codex is not signed in to this Home Chat');
  const response = await fetch(CODEX_BASE + path, {
    method: 'POST', signal,
    headers: {
      'Authorization': 'Bearer ' + token, 'ChatGPT-Account-ID': accountId(token), 'originator': 'codex_cli_rs',
      'version': '0.0.0', 'content-type': 'application/json', 'accept': 'application/json', ...headers,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Codex ${path} failed: HTTP ${response.status}${await reason(response)}`);
  return response.json();
}
