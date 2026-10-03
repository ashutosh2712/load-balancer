import crypto from "node:crypto";
import http from "node:http";

export class NoHealthyBackend extends Error {
  constructor() {
    super("no healthy backends available");
    this.name = "NoHealthyBackend";
  }
}

// ---------- Step 1: Backend ----------
export class Backend {
  constructor(host, port, weight = 1) {
    this.host = host;
    this.port = port;
    this.weight = weight;
    this.healthy = true;
    this.active = 0; // in-flight requests
    this.current = 0; // used by smooth weighted round robin
  }
  get addr() {
    return `${this.host}:${this.port}`;
  }
}

// ---------- Strategies: receive HEALTHY backends only ----------

// ---------- 1: RoundRobin ----------
export class RoundRobin {
  #n = 0;
  choose(backends) {
    return backends[this.#n++ % backends.length];
  }
}

// ---------- 2: LeastConnections ----------
export class LeastConnections {
  choose(backends) {
    return backends.reduce((a, b) => (b.active < a.active ? b : a));
  }
}

// Sticky: same key -> same backend while the healthy pool is unchanged
// ---------- 3: IPHash ----------
export class IPHash {
  choose(backends, key = "") {
    const h = crypto
      .createHash("md5")
      .update(String(key))
      .digest()
      .readUInt32BE(0);
    return backends[h % backends.length];
  }
}

// Smooth weighted round robin (nginx-style)
// ---------- 4: WeightedRoundRobin ----------
export class WeightedRoundRobin {
  choose(backends) {
    const total = backends.reduce((s, b) => s + b.weight, 0);
    let best = null;
    for (const b of backends) {
      b.current += b.weight;
      if (best === null || b.current > best.current) best = b;
    }
    best.current -= total;
    return best;
  }
}

// ---------- Step 3: LoadBalancer ----------
// No locks needed: pick() is synchronous, and Node never interrupts sync code.
export class LoadBalancer {
  constructor(backends, strategy = new RoundRobin()) {
    this.backends = backends;
    this.strategy = strategy;
  }

  pick(key) {
    const healthy = this.backends.filter((b) => b.healthy);
    if (healthy.length === 0) throw new NoHealthyBackend();
    const b = this.strategy.choose(healthy, key);
    b.active++;
    return b;
  }

  release(backend) {
    backend.active = Math.max(0, backend.active - 1);
  }

  mark(backend, healthy) {
    backend.healthy = healthy;
  }

  // Active health checks: GET /health every interval; 200 = healthy.
  // Checks every backend (including unhealthy ones) so recovery is automatic.
  startHealthChecks({
    intervalMs = 1000,
    timeoutMs = 500,
    path = "/health",
  } = {}) {
    const probe = async (b) => {
      try {
        const res = await fetch(`http://${b.addr}${path}`, {
          signal: AbortSignal.timeout(timeoutMs),
        });
        await res.arrayBuffer(); // drain so the socket is freed
        this.mark(b, res.ok);
      } catch {
        this.mark(b, false);
      }
    };
    const timer = setInterval(() => {
      this.backends.forEach(probe);
    }, intervalMs);
    timer.unref(); // don't keep the process alive just for this
    return () => clearInterval(timer);
  }
}

// ---------- Step 6/7: Reverse proxy ----------
const HOP_BY_HOP = new Set([
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
]);

export function createProxy(
  lb,
  { retries = 2, upstreamTimeoutMs = 5000 } = {},
) {
  const idempotent = new Set(["GET", "HEAD", "OPTIONS"]);

  return http.createServer((req, res) => {
    // Only bodyless/idempotent requests are retried: a piped body can't be replayed.
    const maxAttempts = idempotent.has(req.method) ? retries + 1 : 1;
    let attempt = 0;
    let current = null; // the in-flight attempt: { proxyReq, release }
    let clientGone = false;

    const fail = (code, msg) => {
      if (res.headersSent) return res.destroy();
      res.writeHead(code, { "content-type": "text/plain" });
      res.end(msg);
    };

    // Registered ONCE, outside the retry loop.
    res.on("close", () => {
      clientGone = true;
      if (current) {
        if (!res.writableFinished) current.proxyReq.destroy(); // stop wasted work
        current.release();
      }
    });
    const tryNext = () => {
      attempt++;
      let backend;
      try {
        backend = lb.pick(req.socket.remoteAddress);
      } catch (e) {
        if (e instanceof NoHealthyBackend)
          return fail(503, "No healthy backends");
        throw e;
      }

      let released = false;
      const release = () => {
        if (!released) {
          released = true;
          lb.release(backend);
        }
      };

      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (!HOP_BY_HOP.has(k)) headers[k] = v;
      }

      const proxyReq = http.request({
        host: backend.host,
        port: backend.port,
        method: req.method,
        path: req.url,
        headers,
        timeout: upstreamTimeoutMs,
        agent: false, // fresh connection per request: simple and shutdown-friendly
      });

      current = { proxyReq, release };

      proxyReq.on("response", (proxyRes) => {
        const out = {};
        for (const [k, v] of Object.entries(proxyRes.headers)) {
          if (!HOP_BY_HOP.has(k)) out[k] = v;
        }
        out["x-backend"] = backend.addr;
        res.writeHead(proxyRes.statusCode, out);
        proxyRes.pipe(res);
        // Release when the *response* is finished, not when this handler returns.
        res.on("close", release);
        proxyRes.on("error", release);
      });

      // Without an 'error' listener, a refused connection would crash the process.
      proxyReq.on("error", () => {
        release();
        lb.mark(backend, false); // passive health check
        if (res.headersSent) return res.destroy();
        if (attempt < maxAttempts) return tryNext();
        fail(502, "Bad gateway");
      });

      proxyReq.on("timeout", () =>
        proxyReq.destroy(new Error("upstream timeout")),
      );

      // If the client goes away mid-request, abort upstream work too.
      //   res.on("close", () => {
      //     if (!res.writableFinished) proxyReq.destroy();
      //     release();
      //   });

      // Idempotent requests are treated as bodyless: end immediately (this also
      // works on retries, where `req` has already been consumed). Others stream.
      if (idempotent.has(req.method)) proxyReq.end();
      else req.pipe(proxyReq);
    };

    tryNext();
  });
}
