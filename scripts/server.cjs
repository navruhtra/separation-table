// Static server for the Separation Table. Sends COOP/COEP so the browser allows multi-threaded WASM.
const http = require("http"), fs = require("fs"), path = require("path");
// The page is src/. SEP_ROOT serves another folder the same way.
const ROOT = process.env.SEP_ROOT ? path.resolve(process.env.SEP_ROOT) : path.join(__dirname, "../src"), PORT = +process.env.PORT || 8369;
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm", ".onnx": "application/octet-stream", ".json": "application/json", ".md": "text/plain; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp", ".webm": "video/webm", ".mp4": "video/mp4" };
http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p === "/") p = "/index.html";
  // the website serves its own icon; here answer empty so the browser logs no 404 (e2e fails on any console error)
  if (p === "/favicon.ico") { res.writeHead(204); return res.end(); }
  // the page links CHANGELOG.md next to itself; the file is at the repository root
  const changelog = !process.env.SEP_ROOT && p === "/CHANGELOG.md";
  const f = changelog ? path.join(__dirname, "../CHANGELOG.md") : path.normalize(path.join(ROOT, p));
  if (!changelog && !f.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    let body = data;
    // index.html is written as a page body; wrap it in a document when served directly
    if (p === "/index.html") body = Buffer.from(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body>${data}</body></html>`);
    res.writeHead(200, { "Content-Type": TYPES[path.extname(f)] || "application/octet-stream", "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp", "Cache-Control": "no-cache" });
    res.end(body);
  });
}).listen(PORT, "127.0.0.1", () => console.log(`Separation Table: http://localhost:${PORT}`));
