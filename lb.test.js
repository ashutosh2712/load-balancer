import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import {
  Backend,
  RoundRobin,
  LoadBalancer,
  NoHealthyBackend,
  LeastConnections,
  IPHash,
  WeightedRoundRobin,
  createProxy,
} from "./lb.js";

describe("Backend", () => {
  test("defaults", () => {
    const b = new Backend("localhost", 3000);
    assert.equal(b.weight, 1);
    assert.equal(b.healthy, true);
    assert.equal(b.active, 0);
    assert.equal(b.addr, "localhost:3000");
  });
});

const tally = (arr) => arr.reduce((m, x) => ((m[x] = (m[x] || 0) + 1), m), {});

describe("RoundRobin", () => {
  test("distributes evenly", () => {
    const backends = [
      new Backend("h", 1),
      new Backend("h", 2),
      new Backend("h", 3),
    ];
    const rr = new RoundRobin();
    const picks = Array.from({ length: 300 }, () => rr.choose(backends).port);
    assert.deepEqual(tally(picks), { 1: 100, 2: 100, 3: 100 });
  });

  test("cycles in order", () => {
    const backends = [new Backend("h", 1), new Backend("h", 2)];
    const rr = new RoundRobin();
    const picks = [1, 2, 3, 4].map(() => rr.choose(backends).port);
    assert.deepEqual(picks, [1, 2, 1, 2]);
  });
});

describe("LeastConnections", () => {
  test("picks the backend with the fewest active requests", () => {
    const [a, b, c] = [B(1), B(2), B(3)];
    a.active = 5;
    b.active = 0;
    c.active = 3;
    const lb = new LoadBalancer([a, b, c], new LeastConnections());
    assert.equal(lb.pick(), b);
  });

  test("ties go to the first backend", () => {
    const [a, b] = [B(1), B(2)];
    const lb = new LoadBalancer([a, b], new LeastConnections());
    assert.equal(lb.pick(), a);
  });

  test("balances itself as active counts change", () => {
    const [a, b] = [B(1), B(2)];
    const lb = new LoadBalancer([a, b], new LeastConnections());
    assert.equal(lb.pick(), a); // a:1 b:0
    assert.equal(lb.pick(), b); // a:1 b:1
    lb.release(a); // a:0 b:1
    assert.equal(lb.pick(), a);
  });
});

describe("IPHash", () => {
  test("same key always maps to the same backend", () => {
    const lb = new LoadBalancer([B(1), B(2), B(3)], new IPHash());
    const first = lb.pick("10.0.0.7").port;
    for (let i = 0; i < 20; i++) assert.equal(lb.pick("10.0.0.7").port, first);
  });

  test("different keys spread across backends", () => {
    const lb = new LoadBalancer([B(1), B(2), B(3)], new IPHash());
    const ports = new Set();
    for (let i = 0; i < 100; i++) ports.add(lb.pick(`10.0.0.${i}`).port);
    assert.equal(ports.size, 3);
  });

  test("copes with a missing key", () => {
    const lb = new LoadBalancer([B(1), B(2)], new IPHash());
    assert.doesNotThrow(() => lb.pick());
  });
});

describe("WeightedRoundRobin", () => {
  test("respects weights over a full cycle", () => {
    const lb = new LoadBalancer(
      [B(1), B(2), B(3)].map((b, i) => ((b.weight = [5, 1, 1][i]), b)),
      new WeightedRoundRobin(),
    );
    const counts = tally(Array.from({ length: 700 }, () => lb.pick().port));
    assert.deepEqual(counts, { 1: 500, 2: 100, 3: 100 });
  });

  test("is smooth, not bursty", () => {
    const bs = [B(1), B(2), B(3)];
    [5, 1, 1].forEach((w, i) => (bs[i].weight = w));
    const lb = new LoadBalancer(bs, new WeightedRoundRobin());
    const seq = Array.from({ length: 7 }, () => lb.pick().port);
    // the heavy backend must not take a long unbroken run
    let longest = 1,
      run = 1;
    for (let i = 1; i < seq.length; i++) {
      run = seq[i] === seq[i - 1] ? run + 1 : 1;
      longest = Math.max(longest, run);
    }
    assert.ok(longest <= 2, `got ${seq.join(",")}`);
  });

  test("equal weights behave like round robin", () => {
    const lb = new LoadBalancer([B(1), B(2), B(3)], new WeightedRoundRobin());
    const counts = tally(Array.from({ length: 300 }, () => lb.pick().port));
    assert.deepEqual(counts, { 1: 100, 2: 100, 3: 100 });
  });
});

const B = (port) => new Backend("h", port);

describe("LoadBalancer", () => {
  test("pick increments active, release decrements it", () => {
    const b1 = B(1);
    const lb = new LoadBalancer([b1], new RoundRobin());
    const picked = lb.pick();
    assert.equal(picked, b1);
    assert.equal(b1.active, 1);
    lb.release(b1);
    assert.equal(b1.active, 0);
  });

  test("release never goes below zero", () => {
    const b1 = B(1);
    const lb = new LoadBalancer([b1]);
    lb.release(b1);
    assert.equal(b1.active, 0);
  });

  test("skips unhealthy backends", () => {
    const bs = [B(1), B(2), B(3)];
    const lb = new LoadBalancer(bs, new RoundRobin());
    lb.mark(bs[1], false);
    const ports = new Set(Array.from({ length: 50 }, () => lb.pick().port));
    assert.ok(!ports.has(2));
    assert.ok(ports.has(1) && ports.has(3));
  });

  test("throws NoHealthyBackend when all are down", () => {
    const bs = [B(1), B(2)];
    const lb = new LoadBalancer(bs);
    bs.forEach((b) => lb.mark(b, false));
    assert.throws(() => lb.pick(), NoHealthyBackend);
  });

  test("recovers when marked healthy again", () => {
    const b1 = B(1);
    const lb = new LoadBalancer([b1]);
    lb.mark(b1, false);
    lb.mark(b1, true);
    assert.equal(lb.pick(), b1);
  });
});

// ===========================================================================
// A real HTTP server on a random free port. Replies with its own name.
function startBackend(name) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(server.up ? 200 : 500);
        return res.end("ok");
      }
      if (req.method === "POST") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => res.end(`${name}:${body}`));
        return;
      }
      res.end(name);
    });
    server.up = true; // flip to false to make /health fail
    server.listen(0, "127.0.0.1", () => resolve(server)); // port 0 = OS picks one
  });
}

const closeServer = (s) =>
  new Promise((r) => {
    s.closeAllConnections?.();
    s.close(() => r());
  });

async function get(port, path = "/") {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { connection: "close" },
  });
  return {
    status: res.status,
    body: await res.text(),
    backend: res.headers.get("x-backend"),
  };
}

async function waitFor(predicate, timeoutMs = 3000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("fake backend", () => {
  test("answers requests with its name", async () => {
    const s = await startBackend("A");
    const r = await get(s.address().port);
    assert.equal(r.body, "A");
    await closeServer(s);
  });
});

describe("proxy", () => {
  let backends, lb, proxy, port;

  beforeEach(async () => {
    backends = await Promise.all(["A", "B", "C"].map(startBackend));
    const pool = backends.map(
      (s) => new Backend("127.0.0.1", s.address().port),
    );
    lb = new LoadBalancer(pool, new RoundRobin());
    proxy = createProxy(lb);
    await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
    port = proxy.address().port;
  });

  afterEach(async () => {
    await closeServer(proxy);
    await Promise.all(
      backends.map((s) => (s.listening ? closeServer(s) : null)),
    );
  });

  test("spreads traffic evenly", async () => {
    const bodies = [];
    for (let i = 0; i < 30; i++) bodies.push((await get(port)).body);
    assert.deepEqual(tally(bodies), { A: 10, B: 10, C: 10 });
  });

  test("adds an x-backend header", async () => {
    const r = await get(port);
    assert.match(r.backend, /^127\.0\.0\.1:\d+$/);
  });

  test("forwards POST bodies", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      body: "hello",
      headers: { connection: "close" },
    });
    assert.match(await res.text(), /^[ABC]:hello$/);
  });

  test("releases backends after requests finish", async () => {
    await Promise.all(Array.from({ length: 50 }, () => get(port)));
    await waitFor(() => lb.backends.every((b) => b.active === 0));
  });

  test("active health check ejects and restores a backend", async () => {
    const stop = lb.startHealthChecks({ intervalMs: 100 });

    backends[1].up = false; // /health now returns 500
    await waitFor(() => lb.backends[1].healthy === false);

    backends[1].up = true; // /health returns 200 again
    await waitFor(() => lb.backends[1].healthy === true);

    stop();
  });

  test("fails over when a backend dies (clients see no errors)", async () => {
    await closeServer(backends[0]); // kill A
    const results = [];
    for (let i = 0; i < 30; i++) results.push(await get(port));

    assert.ok(results.every((r) => r.status === 200)); // no errors at all
    assert.ok(!results.slice(3).some((r) => r.body === "A")); // A is ejected
  });

  test("returns 503 when all backends are down", async () => {
    await Promise.all(backends.map(closeServer));
    for (let i = 0; i < 5; i++) await get(port); // let it discover the failures
    assert.equal((await get(port)).status, 503);
  });

  test("does not retry POST, but still ejects the dead backend", async () => {
    await closeServer(backends[0]); // round robin hits A first
    const post = () =>
      fetch(`http://127.0.0.1:${port}/`, {
        method: "POST",
        body: "x",
        headers: { connection: "close" },
      });
    assert.equal((await post()).status, 502); // one attempt, no replay
    assert.equal((await post()).status, 200); // A is out, B answers
  });

  test("times out a backend that never answers", async () => {
    const hang = http.createServer(() => {}); // accepts, never replies
    await new Promise((r) => hang.listen(0, "127.0.0.1", r));
    const lb2 = new LoadBalancer([
      new Backend("127.0.0.1", hang.address().port),
    ]);
    const p2 = createProxy(lb2, { upstreamTimeoutMs: 200, retries: 0 });
    await new Promise((r) => p2.listen(0, "127.0.0.1", r));

    const r = await get(p2.address().port);
    assert.equal(r.status, 502);

    await closeServer(p2);
    await closeServer(hang);
  });
});
