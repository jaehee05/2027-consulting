const http = require('http');
const https = require('https');

const SECRET = process.env.PROXY_SECRET;
const PORT = Number(process.env.PORT || 8080);
if (!SECRET) { console.error('PROXY_SECRET not set'); process.exit(1); }

const server = http.createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'POST only' }));
  }
  if (req.headers['x-proxy-secret'] !== SECRET) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'unauthorized' }));
  }
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    try {
      const { path, method = 'POST', headers = {}, body } = JSON.parse(Buffer.concat(chunks).toString());
      if (!path || !path.startsWith('/')) throw new Error('invalid path');
      const upReq = https.request({
        hostname: 'message.ppurio.com', port: 443, path, method,
        headers: { 'Content-Type': 'application/json', ...headers },
        timeout: 10000,
      }, (upRes) => {
        const bufs = [];
        upRes.on('data', d => bufs.push(d));
        upRes.on('end', () => {
          res.writeHead(upRes.statusCode, { 'Content-Type': 'application/json' });
          res.end(Buffer.concat(bufs).toString());
        });
      });
      upReq.on('error', (e) => {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'upstream error: ' + e.message }));
      });
      upReq.on('timeout', () => {
        upReq.destroy();
        res.writeHead(504, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'upstream timeout' }));
      });
      if (body) upReq.write(typeof body === 'string' ? body : JSON.stringify(body));
      upReq.end();
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
});

server.listen(PORT, '0.0.0.0', () => console.log('뿌리오 프록시 listening on :' + PORT));
