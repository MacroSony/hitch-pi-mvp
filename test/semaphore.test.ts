import assert from "node:assert/strict";
import test from "node:test";

import { AsyncSemaphore } from "../src/pi/semaphore.js";

test("semaphore bounds concurrency and preserves FIFO ordering", async () => {
  const semaphore = new AsyncSemaphore(2);
  assert.equal(semaphore.limit, 2);
  assert.equal(semaphore.available, 2);

  const order: Array<string> = [];
  const run = async (name: string): Promise<void> => {
    const release = await semaphore.acquire();
    order.push(name);
    await new Promise((resolve) => setTimeout(resolve, 5));
    release();
  };

  const first = run("first");
  const second = run("second");
  const third = run("third");
  assert.equal(semaphore.available, 0);
  assert.equal(semaphore.waiting, 1);

  await Promise.all([first, second, third]);
  assert.deepEqual(order, ["first", "second", "third"]);
  assert.equal(semaphore.available, 2);
  assert.equal(semaphore.waiting, 0);
});

test("semaphore rejects invalid limits", () => {
  assert.throws(() => new AsyncSemaphore(0), /positive safe integer/u);
  assert.throws(() => new AsyncSemaphore(2.5), /positive safe integer/u);
  assert.throws(() => new AsyncSemaphore(Number.NaN), /positive safe integer/u);
});
