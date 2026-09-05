// name=server.js
// Minimal site proxy with improved HTML rewriting
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const { URL } = require('url');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static('public'));

// Helper: build proxied URL for an absolute target
function proxiedUrlFor(target) {
  return '/proxy?url=' + encodeURIComponent(target);
}

// Normalize protocol-relative and relative URLs to absolute using target origin
function resolveUrl(attrValue, baseUrl) {
  if (!attrValue) return null;
  // protocol-relative //example.com/foo
  if (attrValue.startsWith('//')) {
    return baseUrl.protocol + attrValue;
  }
  try {
    return new URL(attrValue, baseUrl).toString();
  } catch (e) {
    return null;
  }
}

app.get('/proxy', async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).send('Missing url param');

  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch (e) {
    return res.status(400).send('Invalid URL');
  }

  try {
    const response = await axios.get(target, {
      responseType: 'arraybuffer',
      validateStatus: null,
      headers: { 'User-Agent': 'site-proxy/0.1' }
    });

    const contentType = (response.headers['content-type'] || '').toLowerCase();

    // Set permissive headers for embedding
    res.setHeader('content-type', contentType || 'application/octet-stream');
    res.setHeader('x-frame-options', 'ALLOWALL');
    res.setHeader('content-security-policy', "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:;");

    if (contentType.includes('text/html')) {
      const html = response.data.toString('utf8');
      const $ = cheerio.load(html, { decodeEntities: false });

      const base = targetUrl;

      // Elements/attributes to rewrite
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

      // srcset handling (images)
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

      // rewrite <meta http-equiv="refresh" content="X; url=...">
      $('meta[http-equiv]').each((i, el) => {
        const he = ($(el).attr('http-equiv') || '').toLowerCase();
        if (he === 'refresh') {
          const content = $(el).attr('content') || '';
          const match = content.match(/url=(.+)$/i);
          if (match) {
            const abs = resolveUrl(match[1].trim().replace(/['"]/g, ''), base);
            if (abs) {
              $(el).attr('content', content.replace(match[1], proxiedUrlFor(abs)));
            }
          }
        }
      });

      // Remove <base> so our rewrites are authoritative
      $('base').remove();

      // Inject a small client-side script to proxy fetch/XHR calls to keep XHR working for relative requests
      const injectedScript = `\n<script>\n(function(){\n  const origin = ${JSON.stringify(base.origin)};\n  function toProxy(u){\n    try{ const full = new URL(u, origin).toString(); return '/proxy?url='+encodeURIComponent(full); } catch(e){ return u; }\n  }\n  // Override fetch\n  const _fetch = window.fetch;\n  window.fetch = function(input, init){\n    if (typeof input === 'string') input = toProxy(input);\n    else if (input && input.url) input = new Request(toProxy(input.url), input);\n    return _fetch.call(this, input, init);\n  };\n  // Override XHR open\n  const XHROpen = XMLHttpRequest.prototype.open;\n  XMLHttpRequest.prototype.open = function(method, url) {\n    try { url = toProxy(url); } catch(e) {}\n    return XHROpen.apply(this, [method, url].concat(Array.prototype.slice.call(arguments,2)));\n  };\n})();\n</script>\n      `;

      // inject script before </body>
      $('body').append(injectedScript);

      // Send modified HTML
      return res.send($.html());
    }

    // Non-HTML: send raw bytes
    res.send(Buffer.from(response.data, 'binary'));
  } catch (err) {
    console.error('proxy error', err && err.message);
    res.status(502).send('Error fetching target URL');
  }
});

app.listen(PORT, () => {
  console.log(`site-proxy listening on http://localhost:${PORT}`);
});
