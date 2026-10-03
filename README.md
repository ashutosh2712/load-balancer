# Node Load Balancer

A small, dependency-free HTTP load balancer written in Node.js. It distributes incoming requests across a pool of backend servers, detects failures, and recovers automatically.

Built as a learning project: the code is short enough to read in one sitting, and every behavior is covered by tests.

## Features

- **Four balancing strategies**: round robin, smooth weighted round robin, least connections, and IP hash
- **Streaming reverse proxy**: request and response bodies are piped, not buffered
- **Passive health checks**: a backend that fails a request is ejected immediately
- **Active health checks**: a background timer probes every backend, so recovered servers rejoin automatically
- **Automatic retries** for safe requests (`GET`, `HEAD`, `OPTIONS`) so clients don't see a single dead backend
- **503 responses** when no backend is healthy
- **Upstream timeouts** and cleanup when clients disconnect mid-request
- **Zero dependencies**: only Node built-ins (`http`, `crypto`, `node:test`)

## Requirements

- Node.js 20 or newer (developed on Node 22)

## Project structure

```
.
├── lb.js          # Backend, strategies, LoadBalancer, createProxy
├── lb.test.js     # Unit tests (logic) and integration tests (real sockets)
├── backend.mjs    # Tiny demo backend server
├── run.mjs        # Starts the load balancer on :8080
└── package.json   # "type": "module"
```

## Quick start

You need four terminals, because the load balancer and each backend are separate processes.

**1. Start three backends** (one per terminal):

```bash
node backend.mjs A 4001
node backend.mjs B 4002
node backend.mjs C 4003
```

`backend.mjs`:

```js
import http from "node:http";

const [name, port] = [process.argv[2], Number(process.argv[3])];

http
  .createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200);
      return res.end("ok");
    }
    res.end(`Hello from backend ${name} (pid ${process.pid}, port ${port})\n`);
  })
  .listen(port, "127.0.0.1", () => console.log(`Backend ${name} on :${port}`));
```

**2. Start the load balancer:**

```bash
node run.mjs
```

`run.mjs`:

```js
import { Backend, LoadBalancer, createProxy } from "./lb.js";

const lb = new LoadBalancer(
  [4001, 4002, 4003].map((port) => new Backend("127.0.0.1", port)),
);
lb.startHealthChecks({ intervalMs: 1000 });
createProxy(lb).listen(8080, "127.0.0.1", () => console.log("LB on :8080"));
```

**3. Send traffic:**

```bash
for i in 1 2 3 4 5 6 7 8 9; do curl -s localhost:8080; done
```

You should see responses rotate A, B, C, A, B, C, and so on.

## Try the failure scenarios

| Do this                               | Expect                                         |
| ------------------------------------- | ---------------------------------------------- |
| `Ctrl+C` backend B while curling      | No client errors. Traffic continues on A and C |
| Restart B (`node backend.mjs B 4002`) | Within about a second, B rejoins the rotation  |
| Stop all three backends               | `503 No healthy backends`                      |
| Restart any backend                   | Traffic resumes automatically                  |

## Usage as a library

```js
import {
  Backend,
  LoadBalancer,
  createProxy,
  RoundRobin,
  WeightedRoundRobin,
  LeastConnections,
  IPHash,
} from "./lb.js";

const backends = [
  new Backend("10.0.0.1", 3000, 5), // host, port, weight
  new Backend("10.0.0.2", 3000, 1),
];

const lb = new LoadBalancer(backends, new WeightedRoundRobin());
const stopChecks = lb.startHealthChecks({
  intervalMs: 2000,
  timeoutMs: 500,
  path: "/health",
});

const proxy = createProxy(lb, { retries: 2, upstreamTimeoutMs: 5000 });
proxy.listen(8080);

// Later, to shut down cleanly:
stopChecks();
proxy.close();
```

## Strategies

| Strategy             | Picks                                                     | Good for                                |
| -------------------- | --------------------------------------------------------- | --------------------------------------- |
| `RoundRobin`         | Each healthy backend in turn                              | Identical servers, similar request cost |
| `WeightedRoundRobin` | Backends proportionally to `weight`, interleaved smoothly | Servers with different capacity         |
| `LeastConnections`   | The backend with the fewest in-flight requests            | Requests with uneven duration           |
| `IPHash`             | A backend derived from the client address                 | Sticky sessions                         |

Every strategy implements one method, `choose(healthyBackends, key)`, and only ever sees healthy backends. To add your own, write a class with that method and pass an instance to `LoadBalancer`.

**Weighted round robin** uses the smooth algorithm popularized by nginx. With weights 5:1:1 it produces a spread-out sequence rather than five requests in a row to the heavy backend.

**IP hash** is sticky only while the healthy pool is unchanged. If a backend is ejected or restored, some clients will remap.

## How it works

### Request flow

```
client ──(connection 1)──> proxy ──(connection 2)──> backend
       <─────────────────        <─────────────────
```

The proxy is a server to the client and a client to the backend at the same time. For each request it:

1. Calls `lb.pick()` to choose a healthy backend (and increment its in-flight count)
2. Forwards the method, path, headers (minus hop-by-hop headers), and body
3. Streams the backend's response back, adding an `x-backend` header showing who served it
4. Releases the backend slot when the response closes

### Health checking

- **Passive**: if connecting to or reading from a backend fails, it is marked unhealthy right away.
- **Active**: every `intervalMs`, the load balancer sends `GET /health` to every backend, including unhealthy ones. A `2xx` response marks it healthy; an error, timeout, or non-2xx marks it unhealthy. Probing the unhealthy ones is what makes recovery automatic.

### Retries

Only `GET`, `HEAD`, and `OPTIONS` are retried, up to `retries` extra attempts (default 2). A request body that has been streamed to one backend cannot be replayed to another, and replaying a `POST` could repeat a side effect. Non-idempotent requests get one attempt; if it fails, the client receives `502`, and the failed backend is still ejected for subsequent requests.

### Response codes the proxy generates

| Code  | Meaning                                                     |
| ----- | ----------------------------------------------------------- |
| `502` | The chosen backend failed and no retry was possible or left |
| `503` | No healthy backends available                               |

## Testing

```bash
npm test      # or: node --test
```

The suite has two layers:

- **Unit tests** exercise strategies and `LoadBalancer` logic with no networking.
- **Integration tests** start real HTTP servers on random free ports and send real requests through the proxy. They cover even distribution, `x-backend` headers, POST bodies, failover, 503 behavior, health check ejection and recovery, timeouts, and concurrent load (checking that in-flight counts return to zero).

## Design notes

- **No locks.** `pick()` is synchronous and Node never interrupts synchronous code, so two requests cannot interleave inside it. The real risk in Node is forgetting to decrement counters when async work ends.
- **Release on `res` close, not at handler return.** The handler returns long before the backend answers. Releasing there would make least connections see every backend as idle.
- **Release once per attempt.** Multiple events can fire for one attempt (`error`, then `close`), so release is guarded.
- **Every request has an `error` listener.** In Node, an unhandled `error` event crashes the process.
- **Timers are `unref`'d** so health checks alone don't keep the process alive.
- **`agent: false`** gives each upstream request a fresh connection, which is simple and shutdown-friendly (at the cost of connection reuse).

## Known limitations

- HTTP only (layer 7). No TLS termination, no WebSocket/upgrade support, no TCP (layer 4) mode.
- No connection pooling or keep-alive to backends.
- Health state is binary: one failure ejects a backend, with no failure thresholds or backoff.
- A recovered backend's weighted-round-robin counter (`current`) is stale from before it went down, so it can get a lopsided share briefly after recovery.
- Configuration is code-only; there is no config file or CLI.
- Single process. No shared state across multiple load balancer instances.

## Ideas for next steps

1. Reset `backend.current = 0` when a backend is marked healthy again
2. Failure and success thresholds for health checks (for example, eject after 3 failures, restore after 2 successes)
3. Slow start, so a recovered backend ramps up traffic gradually
4. A circuit breaker with growing probe intervals for repeatedly failing backends
5. A load-generation script comparing strategies when one backend is slow
6. Consistent hashing for cache-friendly routing
7. A TCP (layer 4) balancer using Node's `net` module
8. Config file support and graceful shutdown (draining in-flight requests)

## License

MIT
