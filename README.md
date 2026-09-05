# site-proxy (lightweight)

A lightweight development site proxy for viewing and interacting with other sites via localhost. This version removes Puppeteer and streaming; it focuses on being small and easy to run.

Features
- Server-side proxy at `/proxy?url=<target>`
- Streams non-HTML assets and preserves Range headers (helpful for video/audio)
- Parses HTML and rewrites resource links (src, href, srcset, form action, meta refresh) so resources load through the proxy
- Injects a small client helper to proxy fetch/XHR and noop serviceWorker registrations
- Optional host whitelist via `ALLOWED_HOSTS` and optional Basic Auth via `BASIC_AUTH_USER` / `BASIC_AUTH_PASS`

Quick start
1. Clone or update your local copy:
   git clone https://github.com/kaetsevolibackwards/site-proxy.git
   cd site-proxy

2. Install and run:
   npm install
   npm start

3. Open http://localhost:3000 and enter a URL (e.g. https://example.com)

Environment variables
- ALLOWED_HOSTS (optional): comma-separated hostnames to allow through the proxy (development default: allow all)
  Example: ALLOWED_HOSTS=example.com,static.example.com

- BASIC_AUTH_USER and BASIC_AUTH_PASS (optional): enable Basic Auth for the entire site
  Example (Linux/macOS): BASIC_AUTH_USER=alice BASIC_AUTH_PASS=secret npm start
  On Windows PowerShell: $env:BASIC_AUTH_USER='alice'; $env:BASIC_AUTH_PASS='secret'; npm start

Security
- This proxy is intended for local development only. Do not expose it to the public internet without strong authentication and host whitelisting.
- Some sites (Google/YouTube, DRM, reCAPTCHA) still will not function correctly through a proxy due to origin checks or anti-bot protections. For those, consider using official embed APIs or a remote browser approach.

If you want me to add a small Basic Auth UI, stricter host whitelist behavior, or package this for easy deployment (Docker/Render), tell me which and I'll prepare it.
