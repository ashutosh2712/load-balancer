import { Backend, LoadBalancer, createProxy } from "./lb.js";
const lb = new LoadBalancer(
  [4001, 4002, 4003].map((p) => new Backend("127.0.0.1", p)),
);
lb.startHealthChecks({ intervalMs: 1000 });
createProxy(lb).listen(8080, "127.0.0.1", () => console.log("LB on :8080"));
