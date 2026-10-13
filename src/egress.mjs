import http from 'node:http';
import net from 'node:net';
import { lookup } from 'node:dns/promises';
import { allowedDestination, publicAddress } from './policy.mjs';

const server = http.createServer((_req, res) => res.writeHead(405).end());
let connections = 0;
server.on('connect', async (req, client, head) => {
  let upstream;
  client.on('error', () => upstream?.destroy());
  if (++connections > 32) { connections--; client.end('HTTP/1.1 429 Too Many Requests\r\n\r\n'); return; }
  client.once('close', () => { connections--; upstream?.destroy(); });
  client.setTimeout(180_000, () => client.destroy());
  try {
    const host = allowedDestination(req.url);
    const addresses = await Promise.race([
      lookup(host, {all: true}),
      new Promise((_, reject) => setTimeout(() => reject(new Error('DNS timeout')), 5_000).unref()),
    ]);
    if (!addresses.length || addresses.some(({address}) => !publicAddress(address))) throw new Error('Private resolution denied');
    // Connect to the validated address, not the hostname: no second DNS lookup/rebinding.
    const target = addresses.find(item => item.family === 4) ?? addresses[0];
    upstream = net.connect({host: target.address, family: target.family, port: 443});
    upstream.setTimeout(180_000, () => upstream.destroy());
    upstream.once('error', () => client.destroy());
    upstream.once('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream).pipe(client);
    });
  } catch {
    client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
  }
});
server.headersTimeout = 10_000;
server.requestTimeout = 10_000;
server.maxHeadersCount = 32;
server.listen(3128, '0.0.0.0', () => console.log('Restricted provider egress ready'));
