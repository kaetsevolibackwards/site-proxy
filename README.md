# site-proxy

Development site proxy for viewing and interacting with other sites via localhost. This project focuses on functionality, not visuals.

## Run

1. git clone git@github.com:kaetsevolibackwards/site-proxy.git
2. cd site-proxy
3. npm install
4. npm start
5. Visit http://localhost:3000 and enter a URL (e.g. https://example.com)

## What it does

- Serves a tiny frontend at `/` where you can enter a URL.
- Proxies requests server-side at `/proxy?url=<target>` and returns the remote site's content.
- For HTML responses, performs simple rewrites of `src`/`href` so some resources load through the proxy.
- Forces permissive framing/CSP headers so the proxied page can be embedded in an iframe.

## Limitations & security

- This is a development-only, open proxy. Do NOT expose it publicly — it can be abused.
- Some sites still won't render correctly due to complex CSPs, anti-bot measures, or JS that requires same-origin.
- Cookies and some auth flows will not work reliably through this simple proxy.

## Next steps / Improvements

- Add a host whitelist to prevent open proxy abuse.
- Support POST requests, form submissions, and web sockets if needed.
- Use a headless browser (Puppeteer) for sites that require full JS execution.

