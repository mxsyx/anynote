// Run inside the real Storage process through the existing desktop inspector.
// These wrappers only observe original calls; DNS records, TLS options and
// response chunks are never substituted. No production transport hook is added.
export function observeNetwork() {
  const dns = process.getBuiltinModule("node:dns/promises");
  const https = process.getBuiltinModule("node:https");
  const sync = process.getBuiltinModule("node:module").syncBuiltinESMExports;
  const lookup = dns.lookup,
    get = https.get;
  const state = { dns: [], requests: [] };
  globalThis.__anynoteNetworkAcceptance = state;
  dns.lookup = async (...args) => {
    const start = performance.now();
    const entry = { hostname: args[0] };
    state.dns.push(entry);
    try {
      const records = await lookup(...args);
      entry.records = records;
      return records;
    } catch (error) {
      entry.error = { code: error.code, message: error.message };
      throw error;
    } finally {
      entry.elapsedMs = Math.round(performance.now() - start);
    }
  };
  sync();
  https.get = (...args) => {
    const start = performance.now();
    const [url, options] = args;
    const entry = {
      url: String(url),
      bytes: 0,
      isolated: options.agent === false,
      rejectUnauthorized: options.rejectUnauthorized,
      headerNames: Object.keys(options.headers).sort(),
    };
    state.requests.push(entry);
    const req = get(...args);
    options.signal.addEventListener(
      "abort",
      () => {
        entry.aborted = true;
      },
      { once: true },
    );
    req.on("socket", (socket) => {
      socket.once("connect", () => {
        entry.remoteAddress = socket.remoteAddress;
      });
      socket.once("secureConnect", () => {
        entry.authorized = socket.authorized;
        entry.protocol = socket.getProtocol();
        entry.fingerprint256 = socket.getPeerCertificate().fingerprint256;
      });
    });
    req.on("response", (res) => {
      entry.status = res.statusCode;
      entry.contentLength = res.headers["content-length"];
      // Observing emit preserves the stream's paused/flowing state and does not
      // consume chunks before the production async iterator can read them.
      const emit = res.emit;
      res.emit = function (event, ...values) {
        if (event === "data") entry.bytes += values[0].length;
        return emit.call(this, event, ...values);
      };
    });
    req.on("error", (error) => {
      entry.error = { code: error.code, message: error.message };
    });
    req.on("close", () => {
      entry.elapsedMs = Math.round(performance.now() - start);
    });
    return req;
  };
  state.restore = () => {
    dns.lookup = lookup;
    https.get = get;
    sync();
  };
}

export function readObservation() {
  const state = globalThis.__anynoteNetworkAcceptance;
  return {
    dns: state.dns,
    requests: state.requests,
    memory: process.memoryUsage(),
  };
}

export function resetObservation() {
  const state = globalThis.__anynoteNetworkAcceptance;
  state.dns.length = 0;
  state.requests.length = 0;
}
