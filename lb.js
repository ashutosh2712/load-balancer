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
export class RoundRobin {
  #n = 0;
  choose(backends) {
    return backends[this.#n++ % backends.length];
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
