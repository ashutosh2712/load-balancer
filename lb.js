import crypto from "node:crypto";

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
}
