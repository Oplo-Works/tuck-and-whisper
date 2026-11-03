import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve('web');
http.createServer(async (req, res) => {
  const file = path.resolve(root, '.' + (req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0]));
  if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  try { const data = await readFile(file); res.setHeader('Content-Type', ({ '.css': 'text/css', '.js': 'text/javascript', '.html': 'text/html', '.svg': 'image/svg+xml', '.json': 'application/json' })[path.extname(file)] || 'application/octet-stream'); res.end(data); }
  catch { res.writeHead(404).end(); }
}).listen(4173, '127.0.0.1');
