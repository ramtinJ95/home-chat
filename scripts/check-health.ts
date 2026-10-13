import net from 'node:net';
const socket = net.connect({host: '127.0.0.1', port: 8080}, () => {
  socket.write('GET / HTTP/1.1\r\nHost: 127.0.0.1:8787\r\nConnection: close\r\n\r\n');
});
socket.setTimeout(2000, () => { socket.destroy(); process.exitCode = 1; });
socket.once('data', data => { process.exitCode = data.toString().startsWith('HTTP/1.1 200 ') ? 0 : 1; socket.destroy(); });
socket.on('error', () => { process.exitCode = 1; });
