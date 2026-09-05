// name=server.js
// Lightweight site proxy (no Puppeteer). Focuses on streaming assets, HTML rewriting, and simple protections.
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const { URL } = require('url');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static('public'));

// Optional basic auth middleware if BASIC_AUTH_USER and BASIC_AUTH_PASS are set
function basicAuth(req, res, next) {
  const user = process.env.BASIC_AUTH_USER;
  const pass = process.env.BASIC_AUTH_PASS;
  if (!user || !pass) return next();
  const auth = req.headers.authorization || '';
  const match = auth.match(/^Basic\s+(.*)$/i);
  if (!match) {
    res.setHeader('WWW-Authenticate', 'Basic realm="site-proxy"');
    return res.status(401).send('Authentication required');
  }
  const creds = Buffer.from(match[1], 'base64').toString('utf8').split(':');
  if (creds[0] === user && creds[1] === pass) return next();
  res.setHeader('WWW-Authenticate', 'Basic realm="site-proxy"');
  return res.status(401).send('Authentication required');
}

app.use(basicAuth);

// Allowed hosts optional: comma-separated hostnames in ALLOWED_HOSTS
function isHostAllowed(hostname) {
  const list = (process.env.ALLOWED_HOSTS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (list.length === 0) return true; // no whitelist means allow all (development default)
  return list.includes(hostname);
}

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

app.get('/proxy', async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).send('Missing url param');

  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch (e) {
    return res.status(400).send('Invalid URL');
  }

  if (!isHostAllowed(targetUrl.hostname)) return res.status(403).send('Host not allowed');

  // Build upstream headers from selected incoming headers
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
      // Collect the stream then parse & rewrite HTML
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

      // srcset handling
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

      // meta refresh
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

      // remove base so rewrites work
      $('base').remove();

      // inject client helper to proxy fetch/XHR and noop serviceWorker
      const injectedScript = `\n<script>\n(function(){\n  const origin = ${JSON.stringify(base.origin)};\n  function toProxy(u){\n    try{ const full = new URL(u, origin).toString(); return '/proxy?url='+encodeURIComponent(full); } catch(e){ return u; }\n  }\n  const _fetch = window.fetch;\n  window.fetch = function(input, init){\n    try{ if (typeof input === 'string') input = toProxy(input);\n    else if (input && input.url) input = new Request(toProxy(input.url), input); } catch(e){}\n    return _fetch.call(this, input, init);\n  };\n  const XHROpen = XMLHttpRequest.prototype.open;\n  XMLHttpRequest.prototype.open = function(method, url) {\n    try { url = toProxy(url); } catch(e) {}\n    return XHROpen.apply(this, [method, url].concat(Array.prototype.slice.call(arguments,2)));\n  };\n  if (navigator && navigator.serviceWorker) { navigator.serviceWorker.register = function(){ return Promise.resolve(); }; }\n  try { Object.defineProperty(navigator, 'onLine', { get: function(){ return true; }, configurable: true }); } catch(e){}\n})();\n</script>\n      `;

      $('body').append(injectedScript);

      // Copy headers but filter hop-by-hop; overwrite frame/CSP headers
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

    // Non-HTML: stream back and copy key headers (support Range)
    const toCopy = ['content-type','content-length','content-range','accept-ranges','cache-control','expires','last-modified','etag','set-cookie'];
    toCopy.forEach(h => { if (upstream.headers[h]) res.setHeader(h, upstream.headers[h]); });

    res.setHeader('x-frame-options', 'ALLOWALL');
    res.setHeader('content-security-policy', "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:;");
    res.status(upstream.status);
    upstream.data.pipe(res);

  } catch (err) {
    console.error('proxy error', err && (err.message || err.toString()));
    res.status(502).send('Error fetching target URL');
  }
});

app.listen(PORT, () => {
  console.log(`site-proxy (lightweight) listening on http://localhost:${PORT}`);
});
