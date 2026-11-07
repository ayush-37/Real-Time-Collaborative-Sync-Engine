// Tiny static file server so the browser can load the page AND the very same
// CRDT modules the server runs. Deliberately strict: only an allow-list of folders.
//   /            -> public/index.html
//   /app.js ...  -> public/*
//   /src/{crdt,doc,net,client}/*.js -> shared modules (never /src/server)
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const SHARED_DIRS = ['crdt', 'doc', 'net', 'client'].map((d) => path.join(ROOT, 'src', d));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

function reply(res, status, body = '', headers = {}) {
  res.writeHead(status, { 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(body);
}

export async function serveStatic(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return reply(res, 405, '', { Allow: 'GET, HEAD' });

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    return reply(res, 400);
  }
  if (pathname === '/') pathname = '/index.html';
  if (pathname.includes('\0')) return reply(res, 404);

  const isShared = pathname.startsWith('/src/');
  const filePath = path.normalize(isShared ? path.join(ROOT, pathname) : path.join(PUBLIC_DIR, pathname));

  // the path must still be INSIDE an allowed folder after '..' segments were resolved
  const allowed = isShared
    ? SHARED_DIRS.some((dir) => filePath.startsWith(dir + path.sep))
    : filePath.startsWith(PUBLIC_DIR + path.sep);
  const type = TYPES[path.extname(filePath)];
  if (!allowed || !type) return reply(res, 404);

  try {
    const body = await fs.readFile(filePath);
    return reply(res, 200, req.method === 'HEAD' ? '' : body, {
      'Content-Type': type,
      'Cache-Control': 'no-cache',
    });
  } catch {
    return reply(res, 404);
  }
}