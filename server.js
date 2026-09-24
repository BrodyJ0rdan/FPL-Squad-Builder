// FPL Squad Planner - local server
// Serves your site AND forwards /api/... requests to the official FPL API,
// so the browser never hits a CORS problem and no third-party proxy is needed.
//
// Run:  node server.js     then open  http://localhost:3000
// Put this file in the same folder as index.html.

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.json': 'application/json'
};

http.createServer((req, res) => {
    // Forward /api/... to the FPL API
    if (req.url.startsWith('/api/')) {
        const upstream = https.request({
            hostname: 'fantasy.premierleague.com',
            path: req.url,
            method: 'GET',
            headers: { 'User-Agent': 'Mozilla/5.0 (FPL Squad Planner)', 'Accept': 'application/json' }
        }, (up) => {
            res.writeHead(up.statusCode, { 'Content-Type': up.headers['content-type'] || 'application/json' });
            up.pipe(res);
        });
        upstream.on('error', (e) => { res.writeHead(502); res.end('Proxy error: ' + e.message); });
        upstream.end();
        return;
    }

    // Serve static files
    let urlPath;
    try { urlPath = decodeURIComponent(req.url.split('?')[0]); }
    catch { res.writeHead(400); return res.end('Bad request'); }
    if (urlPath === '/') urlPath = '/index.html';

    const file = path.join(ROOT, path.normalize(urlPath));
    if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); }

    fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); return res.end('Not found'); }
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' });
        res.end(data);
    });
}).listen(PORT, () => console.log(`FPL Squad Planner running at http://localhost:${PORT}`));