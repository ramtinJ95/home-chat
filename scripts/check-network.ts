import assert from 'node:assert/strict';
import net from 'node:net';
import { readFile } from 'node:fs/promises';
import { ProxyAgent, fetch as proxyFetch } from 'undici';

// Probe the proxy this container is actually configured with (compose.yaml HTTPS_PROXY).
if (!process.env.HTTPS_PROXY) throw new Error('HTTPS_PROXY is not set; run inside the app container');
const proxy = new URL(process.env.HTTPS_PROXY);

async function blocked(host: string, port: number) {
  const result = await new Promise<string>(resolve => {
    const socket = net.connect({host, port});
    socket.once('connect', () => { socket.destroy(); resolve('CONNECTED'); });
    socket.once('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? 'ERROR'));
    socket.setTimeout(1500, () => { socket.destroy(); resolve('TIMEOUT'); });
  });
  assert.notEqual(result, 'CONNECTED', `Unexpected direct connection to ${host}:${port}`);
  console.log(`DENIED ${host}:${port} (${result})`);
}
async function proxyStatus(target: string) {
  return new Promise<string>((resolve, reject) => {
    const socket = net.connect({host: proxy.hostname, port: Number(proxy.port)}, () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    socket.once('error', reject);
    socket.setTimeout(5000, () => { socket.destroy(); reject(new Error('Proxy timed out')); });
    socket.once('data', data => { socket.destroy(); resolve(data.toString().split('\r\n')[0]); });
  });
}
const status = await readFile('/proc/self/status', 'utf8');
assert.match(status, /CapEff:\s+0000000000000000/);
for (const [host, port] of [
  ['172.30.91.1', 8080], ['172.30.91.1', 8765], ['100.64.0.1', 8765],
  ['100.64.0.2', 22], ['100.127.255.254', 22], ['192.168.1.1', 80],
  ['169.254.169.254', 80], ['1.1.1.1', 443], ['127.0.0.11', 53],
  ['::ffff:100.64.0.1', 8765], ['fd7a:115c:a1e0::1', 443], ['2606:4700:4700::1111', 443],
] as [string, number][]) await blocked(host, port);
for (const destination of ['127.0.0.1:443', 'host.docker.internal:443', '100.64.0.1:443', 'example.com:443', 'chatgpt.com:80', 'chatgpt.com.evil.test:443']) {
  assert.match(await proxyStatus(destination), /403/); console.log(`PROXY DENIED ${destination}`);
}
assert.match(await proxyStatus('chatgpt.com:443'), /200/);
const dispatcher = new ProxyAgent(proxy.href);
try {
  const response = await proxyFetch('https://chatgpt.com/backend-api/codex/responses', {dispatcher, signal: AbortSignal.timeout(15000)});
  console.log(`PROVIDER TLS REACHABLE (unauthenticated HTTP ${response.status}; not an inference test)`);
  await response.body?.cancel();
} finally { await dispatcher.close(); }
