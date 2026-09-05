// name=tproxy-adapter.js
// Adapter to integrate SevenworksDev/stop-using-this tProxy (lib/index.js) into our server.
const TProxyClass = require('./tproxy/lib/index');

const PREFIX = process.env.TPROXY_PREFIX || '/web';
const tproxyInstance = new TProxyClass(PREFIX, { localAddress: [], blacklist: [] });

function middleware(req, res, next) {
  // let the tproxy handle its configured prefix and the /prox endpoint
  if (req.url.startsWith(PREFIX) || req.url.startsWith('/prox') || req.url.startsWith('/session')) {
    try {
      return tproxyInstance.http(req, res, next);
    } catch (e) {
      console.error('tproxy middleware error', e && e.message);
      return res.statusCode ? res.end() : next();
    }
  }
  return next();
}

function attachWs(server) {
  // the tProxy has a ws(server) method to attach websocket handler
  try {
    tproxyInstance.ws(server);
  } catch (e) {
    console.error('tproxy attachWs error', e && e.message);
  }
}

module.exports = { middleware, attachWs };
