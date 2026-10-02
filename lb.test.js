import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Backend, RoundRobin, LoadBalancer, NoHealthyBackend } from "./lb.js";

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
