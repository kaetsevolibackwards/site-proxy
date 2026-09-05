// name=server.js
// Lightweight site proxy using http-proxy for efficient streaming and cheerio for HTML rewrites.
// Buffers HTML up to a configured limit and rewrites resource URLs to route through /proxy.

const express = require('express');
const httpProxy = require('http-proxy');
const cheerio = require('cheerio');
const { URL } = require('url');
const zlib = require('zlib');
const { promisify } = require('util');

const gunzip = promisify(zlib.gunzip);
const brotliDecompress = promisify(zlib.brotliDecompress);
const inflate = promisify(zlib.inflate);

const app = express();
const proxy = httpProxy.createProxyServer({});

const PORT = process.env.PORT || 3000;
const MAX_HTML_BYTES = parseInt(process.env.MAX_HTML_BYTES || String(2 * 1024 * 1024), 10); // 2MB default

app.use(express.static('public'));

// Basic auth (optional)
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

function isHostAllowed(hostname) {
  const list = (process.env.ALLOWED_HOSTS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (list.length === 0) return true;
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

// Forward selected request headers to upstream
proxy.on('proxyReq', function(proxyReq, req, res, options) {
  FORWARD_REQ_HEADERS.forEach(h => {
    if (req.headers[h]) proxyReq.setHeader(h, req.headers[h]);
  });
});

async function tryDecompress(buffer, encoding) {
  if (!encoding) return buffer;
  const enc = encoding.toLowerCase();
  try {
    if (enc.includes('br')) {
      return await brotliDecompress(buffer);
    }
    if (enc.includes('gzip')) {
      return await gunzip(buffer);
    }
    if (enc.includes('deflate')) {
      return await inflate(buffer);
    }
  } catch (e) {
    // decompression failed
    return null;
  }
  return null;
}

// Main proxy handler: uses selfHandleResponse so we can intercept HTML responses
app.get('/proxy', (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).send('Missing url param');

  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch (e) {
    return res.status(400).send('Invalid URL');
  }

  if (!isHostAllowed(targetUrl.hostname)) return res.status(403).send('Host not allowed');

  // adjust req.url for proxy to pass correct path
  req.url = targetUrl.pathname + targetUrl.search;

  proxy.once('proxyRes', function(proxyRes, req2, res2) {
    // filter headers
    const respHeaders = Object.assign({}, proxyRes.headers);
    Object.keys(respHeaders).forEach(h => { if (HOP_BY_HOP.has(h.toLowerCase())) delete respHeaders[h]; });
    // override framing/CSP to allow embedding (development convenience)
    respHeaders['x-frame-options'] = 'ALLOWALL';
    respHeaders['content-security-policy'] = "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:;";

    const contentType = (proxyRes.headers['content-type'] || '').toLowerCase();
    const contentEncoding = proxyRes.headers['content-encoding'];

    if (contentType.includes('text/html')) {
      // Buffer HTML up to MAX_HTML_BYTES and rewrite; if exceeded, stream raw upstream response
      let buffers = [];
      let total = 0;
      let aborted = false;

      proxyRes.on('data', chunk => {
        if (aborted) return;
        total += chunk.length;
        if (total <= MAX_HTML_BYTES) buffers.push(chunk);
        else {
          aborted = true;
          // send headers and pipe remaining data directly
          try { res2.writeHead(proxyRes.statusCode, respHeaders); } catch (e) {}
          try { res2.write(Buffer.concat(buffers)); } catch (e) {}
          proxyRes.pipe(res2);
        }
      });

      proxyRes.on('end', async () => {
        if (aborted) return; // already piped
        const rawBuf = Buffer.concat(buffers);
        // Try to decompress if needed
        let decompressed = rawBuf;
        if (contentEncoding) {
          const d = await tryDecompress(rawBuf, contentEncoding);
          if (d) {
            decompressed = d;
            // remove content-encoding and content-length headers because we're sending decompressed HTML
            delete respHeaders['content-encoding'];
            delete respHeaders['content-length'];
          } else {
            // decompression failed - fallback to streaming raw compressed content
            try { res2.writeHead(proxyRes.statusCode, respHeaders); } catch (e) {}
            return res2.end(rawBuf);
          }
        }

        const html = decompressed.toString('utf8');
        try {
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

          const injectedScript = `\n<script>\n(function(){\n  const origin = ${JSON.stringify(base.origin)};\n  function toProxy(u){\n    try{ const full = new URL(u, origin).toString(); return '/proxy?url='+encodeURIComponent(full); } catch(e){ return u; }\n  }\n  const _fetch = window.fetch;\n  window.fetch = function(input, init){\n    try{ if (typeof input === 'string') input = toProxy(input);\n    else if (input && input.url) input = new Request(toProxy(input.url), input); } catch(e){}\n    return _fetch.call(this, input, init);\n  };\n  const XHROpen = XMLHttpRequest.prototype.open;\n  XMLHttpRequest.prototype.open = function(method, url) {\n    try { url = toProxy(url); } catch(e) {}\n    return XHROpen.apply(this, [method, url].concat(Array.prototype.slice.call(arguments,2)));\n  };\n  if (navigator && navigator.serviceWorker) { navigator.serviceWorker.register = function(){ return Promise.resolve(); }; }\n  try { Object.defineProperty(navigator, 'onLine', { get: function(){ return true; }, configurable: true }); } catch(e){}\n})();\n</script>\n`;

          $('body').append(injectedScript);

          const out = $.html();
          // remove content-length if present (we're sending new body)
          delete respHeaders['content-length'];
          try { res2.writeHead(proxyRes.statusCode, respHeaders); } catch (e) {}
          return res2.end(out);
        } catch (err) {
          console.error('html rewrite error', err && err.message);
          try { res2.writeHead(proxyRes.statusCode, respHeaders); } catch (e) {}
          return res2.end(decompressed);
        }
      });

      proxyRes.on('error', (err) => {
        console.error('proxyRes error', err && err.message);
        if (!res2.headersSent) {
          try { res2.writeHead(proxyRes.statusCode || 502); } catch(e){}
        }
        try { res2.end(); } catch(e){}
      });

    } else {
      // Non-HTML: stream directly, copying a subset of headers
      const toCopy = ['content-type','content-length','content-range','accept-ranges','cache-control','expires','last-modified','etag','set-cookie','content-encoding'];
      const outHeaders = {};
      toCopy.forEach(h => { if (proxyRes.headers[h]) outHeaders[h] = proxyRes.headers[h]; });
      // ensure framing/CSP relaxed
      outHeaders['x-frame-options'] = 'ALLOWALL';
      outHeaders['content-security-policy'] = "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:;";

      try { res2.writeHead(proxyRes.statusCode, outHeaders); } catch (e) {}
      proxyRes.pipe(res2);
    }
  });

  // Perform the proxy request. changeOrigin makes Host header match target.
  proxy.web(req, res, { target: targetUrl.origin, changeOrigin: true, selfHandleResponse: true }, (err) => {
    console.error('proxy.web error', err && err.message);
    if (!res.headersSent) res.status(502).send('Proxy error');
  });
});

app.listen(PORT, () => {
  console.log(`site-proxy (http-proxy) listening on http://localhost:${PORT}`);
});
