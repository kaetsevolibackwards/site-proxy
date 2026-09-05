// name=server.js
// Site proxy with Puppeteer interactive sessions and improved proxy behavior
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const { URL } = require('url');
const http = require('http');
const WebSocket = require('ws');
const puppeteer = require('puppeteer');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

const PORT = process.env.PORT || 3000;

app.use(express.static('public'));
app.use(express.json());

// --- Existing proxy helpers ---
function proxiedUrlFor(target) {
  return '/proxy?url=' + encodeURIComponent(target);
}

function resolveUrl(attrValue, baseUrl) {
  if (!attrValue) return null;
  if (attrValue.startsWith('//')) {
    return baseUrl.protocol + attrValue;
  }
  try {
    return new URL(attrValue, baseUrl).toString();
  } catch (e) {
    return null;
  }
}

const FORWARD_REQ_HEADERS = [
  'accept', 'accept-language', 'user-agent', 'referer', 'range', 'cookie', 'origin', 'authorization',
  'sec-fetch-mode','sec-fetch-site','sec-fetch-dest'
];
const HOP_BY_HOP = new Set([
  'connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailers','transfer-encoding','upgrade'
]);

// --- Puppeteer session manager ---
const sessions = new Map(); // sessionId -> {page, interval, lastActive}
let browserPromise = null;
async function getBrowser() {
  if (!browserPromise) browserPromise = puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  return browserPromise;
}

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2,8);
}

// Create a puppeteer session and navigate to URL
app.post('/session', async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'Missing url in body' });
  let targetUrl;
  try { targetUrl = new URL(url); } catch (e) { return res.status(400).json({ error: 'Invalid URL' }); }

  try {
    const browser = await getBrowser();
    const page = await browser.newPage();
    // Set a reasonable viewport; client can request resize
    await page.setViewport({ width: 1280, height: 720 });
    await page.goto(targetUrl.toString(), { waitUntil: 'networkidle2', timeout: 45000 }).catch(e => {});

    const sessionId = makeId();
    sessions.set(sessionId, { page, interval: null, lastActive: Date.now(), ws: null });

    // Close session after inactivity (5 minutes)
    setTimeout(() => {
      const s = sessions.get(sessionId);
      if (s && Date.now() - s.lastActive > 5 * 60 * 1000) {
        try { s.page.close(); } catch(e){}
        sessions.delete(sessionId);
      }
    }, 6 * 60 * 1000);

    res.json({ sessionId });
  } catch (err) {
    console.error('session create err', err && err.message);
    res.status(500).json({ error: 'Failed to create session' });
  }
});

// Upgrade HTTP to WebSocket for ws connections
server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (url.pathname === '/ws') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

// Handle incoming WS connections: expect query ?sessionId=<id>
wss.on('connection', async (ws, request) => {
  const params = new URL(request.url, `http://${request.headers.host}`).searchParams;
  const sessionId = params.get('sessionId');
  if (!sessionId || !sessions.has(sessionId)) {
    ws.send(JSON.stringify({ type: 'error', msg: 'Invalid or missing sessionId' }));
    ws.close();
    return;
  }
  const s = sessions.get(sessionId);
  s.ws = ws;
  s.lastActive = Date.now();

  // Start screenshot loop (e.g., 4 fps)
  const fps = 4;
  const intervalMs = Math.max(1000 / fps, 100);
  s.interval = setInterval(async () => {
    try {
      const buf = await s.page.screenshot({ type: 'jpeg', quality: 60, fullPage: false });
      // send binary frame
      if (ws.readyState === WebSocket.OPEN) ws.send(buf);
    } catch (e) {
      // ignore screenshot errors
    }
  }, intervalMs);

  ws.on('message', async (data) => {
    s.lastActive = Date.now();
    // Expect JSON messages for events; binary frames not used from client
    let msg;
    try { msg = JSON.parse(data.toString()); } catch (e) { return; }
    try {
      if (msg.type === 'mouse') {
        const { x, y, action, button = 'left' } = msg;
        if (action === 'move') await s.page.mouse.move(x, y);
        else if (action === 'down') await s.page.mouse.down({ button });
        else if (action === 'up') await s.page.mouse.up({ button });
        else if (action === 'click') await s.page.mouse.click(x, y, { button });
      } else if (msg.type === 'wheel') {
        const { deltaX = 0, deltaY = 0 } = msg;
        await s.page.mouse.wheel({ deltaX, deltaY });
      } else if (msg.type === 'keyboard') {
        const { action, text, key } = msg;
        if (action === 'type' && text) await s.page.keyboard.type(text);
        else if (action === 'down' && key) await s.page.keyboard.down(key);
        else if (action === 'up' && key) await s.page.keyboard.up(key);
        else if (action === 'press' && key) await s.page.keyboard.press(key);
      } else if (msg.type === 'resize') {
        const { width, height } = msg;
        await s.page.setViewport({ width: Math.max(100, width), height: Math.max(100, height) });
      }
    } catch (e) {
      // ignore
    }
  });

  ws.on('close', async () => {
    // stop interval and close page
    clearInterval(s.interval);
    try { await s.page.close(); } catch(e){}
    sessions.delete(sessionId);
  });
});

// --- Proxy endpoint (unchanged behavior but keeps streaming and header forwarding) ---
app.get('/proxy', async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).send('Missing url param');

  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch (e) {
    return res.status(400).send('Invalid URL');
  }

  const upstreamHeaders = {};
  FORWARD_REQ_HEADERS.forEach(h => {
    if (req.headers[h]) upstreamHeaders[h] = req.headers[h];
  });

  try {
    const upstream = await axios.get(target, {
      responseType: 'stream',
      validateStatus: null,
      headers: upstreamHeaders,
      maxRedirects: 5
    });

    const upstreamContentType = (upstream.headers['content-type'] || '').toLowerCase();

    if (upstreamContentType.includes('text/html')) {
      const chunks = [];
      await new Promise((resolve, reject) => {
        upstream.data.on('data', c => chunks.push(c));
        upstream.data.on('end', resolve);
        upstream.data.on('error', reject);
      });
      const html = Buffer.concat(chunks).toString('utf8');

      const $ = cheerio.load(html, { decodeEntities: false });
      const base = targetUrl;

      const ATTRS = [
        { sel: 'img', attr: 'src' },
        { sel: 'script', attr: 'src' },
        { sel: 'link[rel="stylesheet"]', attr: 'href' },
        { sel: 'link[rel="icon"]', attr: 'href' },
        { sel: 'a', attr: 'href' },
        { sel: 'form', attr: 'action' },
        { sel: 'source', attr: 'src' },
        { sel: 'iframe', attr: 'src' },
        { sel: 'embed', attr: 'src' },
        { sel: 'video', attr: 'src' },
        { sel: 'audio', attr: 'src' }
      ];

      ATTRS.forEach(({ sel, attr }) => {
        $(sel).each((i, el) => {
          const val = $(el).attr(attr);
          const abs = resolveUrl(val, base);
          if (abs) $(el).attr(attr, proxiedUrlFor(abs));
        });
      });

      $('[srcset]').each((i, el) => {
        const raw = $(el).attr('srcset');
        const parts = raw.split(',').map(p => p.trim()).map(item => {
          const [urlPart, descriptor] = item.split(/\s+/, 2);
          const abs = resolveUrl(urlPart, base);
          if (abs) return proxiedUrlFor(abs) + (descriptor ? ' ' + descriptor : '');
          return item;
        });
        $(el).attr('srcset', parts.join(', '));
      });

      $('meta[http-equiv]').each((i, el) => {
        const he = ($(el).attr('http-equiv') || '').toLowerCase();
        if (he === 'refresh') {
          const content = $(el).attr('content') || '';
          const match = content.match(/url=(.+)$/i);
          if (match) {
            const abs = resolveUrl(match[1].trim().replace(/['\"]/g, ''), base);
            if (abs) {
              $(el).attr('content', content.replace(match[1], proxiedUrlFor(abs)));
            }
          }
        }
      });

      $('base').remove();

      const injectedScript = `\n<script>\n(function(){\n  const origin = ${JSON.stringify(base.origin)};\n  function toProxy(u){\n    try{ const full = new URL(u, origin).toString(); return '/proxy?url='+encodeURIComponent(full); } catch(e){ return u; }\n  }\n  const _fetch = window.fetch;\n  window.fetch = function(input, init){\n    try{ if (typeof input === 'string') input = toProxy(input);\n    else if (input && input.url) input = new Request(toProxy(input.url), input); } catch(e){}\n    return _fetch.call(this, input, init);\n  };\n  const XHROpen = XMLHttpRequest.prototype.open;\n  XMLHttpRequest.prototype.open = function(method, url) {\n    try { url = toProxy(url); } catch(e) {}\n    return XHROpen.apply(this, [method, url].concat(Array.prototype.slice.call(arguments,2)));\n  };\n  if (navigator && navigator.serviceWorker) {\n    navigator.serviceWorker.register = function(){ return Promise.resolve(); };\n  }\n  try { Object.defineProperty(navigator, 'onLine', { get: function(){ return true; }, configurable: true }); } catch(e){}\n})();\n</script>\n      `;

      $('body').append(injectedScript);

      const respHeaders = Object.assign({}, upstream.headers);
      Object.keys(respHeaders).forEach(h => {
        if (HOP_BY_HOP.has(h.toLowerCase())) delete respHeaders[h];
      });
      respHeaders['x-frame-options'] = 'ALLOWALL';
      respHeaders['content-security-policy'] = "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:;";
      delete respHeaders['content-length'];

      res.status(upstream.status);
      Object.entries(respHeaders).forEach(([k, v]) => {
        try { res.setHeader(k, v); } catch(e){}
      });

      return res.send($.html());
    }

    const toCopy = ['content-type','content-length','content-range','accept-ranges','cache-control','expires','last-modified','etag','set-cookie'];
    toCopy.forEach(h => {
      if (upstream.headers[h]) res.setHeader(h, upstream.headers[h]);
    });

    res.setHeader('x-frame-options', 'ALLOWALL');
    res.setHeader('content-security-policy', "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:;");

    res.status(upstream.status);

    upstream.data.pipe(res);

  } catch (err) {
    console.error('proxy error', err && (err.message || err.toString()));
    res.status(502).send('Error fetching target URL');
  }
});

// Serve a simple page for joining a session (optional)
app.get('/session/:id', (req, res) => {
  const id = req.params.id;
  if (!sessions.has(id)) return res.status(404).send('Session not found');
  // redirect to the frontend page which can connect via WS
  res.redirect('/');
});

server.listen(PORT, () => {
  console.log(`site-proxy listening on http://localhost:${PORT}`);
});
