// name=server.js
const express = require('express');
const axios = require('axios');
const { URL } = require('url');

const app = express();
const PORT = process.env.PORT || 3000;

// Serve the simple frontend
app.use(express.static('public'));

// Basic proxy endpoint: /proxy?url=<encoded-url>
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
      headers: {
        // Neutral UA
        'User-Agent': 'site-proxy/0.1'
      }
    });

    const contentType = response.headers['content-type'] || 'application/octet-stream';

    // Drop problematic headers on the proxied response
    res.setHeader('content-type', contentType);
    res.setHeader('x-frame-options', 'ALLOWALL');
    res.setHeader('content-security-policy', "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:;");

    // If HTML, rewrite some links to route via this proxy
    if (contentType.includes('text/html')) {
      let html = response.data.toString('utf8');
      const base = targetUrl.origin;

      // Rewrite root-relative src/href ("/path")
      html = html.replace(/(src|href)=["']\/(?!\/)([^"']*)["']/ig, (m, attr, path) => {
        const proxied = `/proxy?url=${encodeURIComponent(base + '/' + path)}`;
        return `${attr}="${proxied}"`;
      });

      // Rewrite absolute http(s) links to go through proxy
      html = html.replace(/(src|href)=["'](https?:\/\/[^"']+)["']/ig, (m, attr, abs) => {
        return `${attr}="/proxy?url=${encodeURIComponent(abs)}"`;
      });

      return res.send(html);
    }

    // Non-HTML: stream bytes back
    res.send(Buffer.from(response.data, 'binary'));
  } catch (err) {
    console.error('proxy error', err && err.message);
    res.status(502).send('Error fetching target URL');
  }
});

app.listen(PORT, () => {
  console.log(`site-proxy listening on http://localhost:${PORT}`);
});
