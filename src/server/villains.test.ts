import assert from "node:assert/strict";
import { mock, test } from "node:test";

import { MAX_AUTHOR_LENGTH, MAX_TEXT_LENGTH } from "./store.ts";
import { startChatter, VILLAINS } from "./villains.ts";

const total = VILLAINS.reduce((sum, { lines }) => sum + lines.length, 0);

/** Deterministic, so the shuffle — and so this test — is the same every run. */
function seeded(seed: number): () => number {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 2 ** 32;
    return seed / 2 ** 32;
  };
}

test("every line fits what the store would accept", () => {
  for (const { author, lines } of VILLAINS) {
    assert.ok(author.length <= MAX_AUTHOR_LENGTH, author);
    for (const text of lines) {
      assert.ok(text.trim().length > 0 && text.length <= MAX_TEXT_LENGTH, text);
    }
  }
});

test("posts on a timer, never repeats within a round, and stops", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const posts: Array<{ author: string; text: string }> = [];
  const stop = startChatter((author, text) => posts.push({ author, text }), {
    minDelayMs: 1000,
    maxDelayMs: 1000,
    random: seeded(7),
  });

  t.mock.timers.tick(999);
  assert.equal(posts.length, 0);

  t.mock.timers.tick(1);
  for (let i = 1; i < total; i++) t.mock.timers.tick(1000);
  assert.equal(posts.length, total);
  assert.equal(new Set(posts.map((post) => post.text)).size, total);

  for (let i = 1; i < posts.length; i++) {
    // The tail of a round may only have one villain left to draw from.
    if (i < total - 5) assert.notEqual(posts[i]!.author, posts[i - 1]!.author);
  }

  stop();
  t.mock.timers.tick(10_000);
  assert.equal(posts.length, total);
});

test("delays stay within the configured window", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const posts: string[] = [];
  const stop = startChatter((_, text) => posts.push(text), {
    minDelayMs: 2000,
    maxDelayMs: 4000,
    random: mock.fn(() => 0.5),
  });

  t.mock.timers.tick(2999);
  assert.equal(posts.length, 0);
  t.mock.timers.tick(1);
  assert.equal(posts.length, 1);

  stop();
});
