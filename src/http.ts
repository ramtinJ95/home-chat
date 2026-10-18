import type http from 'node:http';

// Thrown for client-visible failures; any other error becomes a generic 500.
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export const fail = (status: number, message: string) => new HttpError(status, message);

// The times in `log` for `key` within the last `ms`, for the rate limits. Older ones are dropped from the same list,
// so a time pushed after a wait still lands in it, however many requests read it meanwhile.
export function recent<K>(log: Map<K, number[]>, key: K, ms: number): number[] {
  let times = log.get(key);
  if (!times) log.set(key, times = []);
  const kept = times.findIndex(time => time > Date.now() - ms);
  times.splice(0, kept === -1 ? times.length : kept);
  return times;
}

export async function jsonBody(req: http.IncomingMessage, maximum = 64_000): Promise<Record<string, unknown>> {
  if (req.headers['content-type'] !== 'application/json') throw fail(415, 'Use application/json');
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > maximum) throw fail(413, 'Request is too large');
    chunks.push(chunk);
  }
  let body: unknown;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw fail(400, 'Invalid JSON'); }
  if (typeof body !== 'object' || body === null) throw fail(400, 'Invalid JSON');
  return body as Record<string, unknown>;
}
