# site-proxy (http-proxy)

This version uses http-proxy for efficient streaming and cheerio to rewrite HTML responses when small enough to buffer.

Why this design?
- http-proxy handles streaming with proper backpressure and low memory usage for binary assets (video, images, large downloads).
- HTML pages are typically small enough to buffer (configurable limit) and can be reliably rewritten with cheerio.
- If an HTML response is larger than the buffer limit, the proxy falls back to streaming the upstream response directly (best-effort) to avoid consuming too much memory.

Environment variables
- MAX_HTML_BYTES (default 2MB) — maximum HTML size to buffer and rewrite. Larger pages will be streamed raw.
- ALLOWED_HOSTS — comma-separated whitelist of hostnames to allow through the proxy. Empty means allow all.
- BASIC_AUTH_USER / BASIC_AUTH_PASS — enable basic auth to protect the proxy.

Run
- npm install
- npm start
- Open http://localhost:3000 and enter a URL

Security
- This is a development proxy. Do not expose publicly without basic auth and host whitelisting.
