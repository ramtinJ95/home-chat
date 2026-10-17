import { request } from 'node:http';
import type { ServerCall } from '../src/policy.ts';

// Routines and the household notes live on the server, so the tools that change them, and the extension reading the
// notes, call it: over a Unix socket the server listens on for its own workers, with the token it gave this Pi
// process. The server checks everything, scopes it to the conversation's owner, and answers with text for the model.
export const callServer: ServerCall = (path, body) => {
  const socketPath = process.env.HOME_CHAT_INTERNAL_SOCKET; const token = process.env.HOME_CHAT_INTERNAL_TOKEN;
  if (!socketPath || !token) return Promise.reject(new Error('Home Chat is not available in this session'));
  return new Promise((resolve, reject) => {
    // agent: false keeps this off the global agent, which NODE_USE_ENV_PROXY points at the egress proxy.
    const outgoing = request({socketPath, path, method: body === undefined ? 'GET' : 'POST', agent: false, timeout: 15_000,
      headers: {'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token}}, response => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        let reply: {text?: unknown; error?: unknown};
        try { reply = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reject(new Error('Invalid Home Chat response')); }
        if (response.statusCode === 200 && typeof reply.text === 'string') resolve(reply.text);
        else reject(new Error(typeof reply.error === 'string' ? reply.error : 'Home Chat could not do that'));
      });
    });
    outgoing.on('timeout', () => outgoing.destroy(new Error('Home Chat did not answer')));
    outgoing.on('error', reject);
    outgoing.end(body === undefined ? undefined : JSON.stringify(body));
  });
};
