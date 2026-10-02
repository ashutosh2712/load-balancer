import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Backend } from "./lb.js";

describe("Backend", () => {
  test("defaults", () => {
    const b = new Backend("localhost", 3000);
    assert.equal(b.weight, 1);
    assert.equal(b.healthy, true);
    assert.equal(b.active, 0);
    assert.equal(b.addr, "localhost:3000");
  });
});
