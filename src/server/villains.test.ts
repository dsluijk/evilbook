import assert from "node:assert/strict";
import { mock, test } from "node:test";

import { MAX_AUTHOR_LENGTH, MAX_TEXT_LENGTH } from "./store.ts";
import {
  flagRetraction,
  RETRACTIONS,
  startChatter,
  VILLAINS,
  type ChatterSink,
} from "./villains.ts";

const total = VILLAINS.reduce((sum, { lines }) => sum + lines.length, 0);

/** Deterministic, so the shuffle — and so this test — is the same every run. */
function seeded(seed: number): () => number {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 2 ** 32;
    return seed / 2 ** 32;
  };
}

/** A sink that records every call, in order, handing out sequential ids. */
function recorder() {
  const log: Array<
    | { kind: "post"; id: string; author: string; text: string; ts: number }
    | { kind: "remove"; id: string; author: string; ts: number }
  > = [];
  const sink: ChatterSink = {
    post: (author, text, ts) => {
      const id = `m${log.length}`;
      log.push({ kind: "post", id, author, text, ts });
      return id;
    },
    remove: (id, author, ts) => void log.push({ kind: "remove", id, author, ts }),
  };
  const posts = () => log.filter((entry) => entry.kind === "post");
  const removes = () => log.filter((entry) => entry.kind === "remove");
  return { log, sink, posts, removes };
}

const fits = (text: string) => text.trim().length > 0 && text.length <= MAX_TEXT_LENGTH;

test("every line fits what the store would accept", () => {
  for (const { author, lines } of VILLAINS) {
    assert.ok(author.length <= MAX_AUTHOR_LENGTH, author);
    for (const text of lines) assert.ok(fits(text), text);
  }

  const authors = new Set(VILLAINS.map(({ author }) => author));
  for (const { author, text, followUp } of [...RETRACTIONS, flagRetraction("CTF{x}")]) {
    assert.ok(authors.has(author), `${author} is not one of the villains`);
    assert.ok(fits(text), text);
    assert.ok(fits(followUp), followUp);
  }
});

test("posts on a timer, never repeats within a round, and stops", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const chat = recorder();
  const stop = startChatter(chat.sink, {
    minDelayMs: 1000,
    maxDelayMs: 1000,
    backlog: 0,
    retractChance: 0,
    random: seeded(7),
  });

  t.mock.timers.tick(999);
  assert.equal(chat.posts().length, 0);

  t.mock.timers.tick(1);
  for (let i = 1; i < total; i++) t.mock.timers.tick(1000);
  const posts = chat.posts();
  assert.equal(posts.length, total);
  assert.equal(new Set(posts.map((post) => post.text)).size, total);

  for (let i = 1; i < posts.length; i++) {
    // The tail of a round may only have one villain left to draw from.
    if (i < total - 5) assert.notEqual(posts[i]!.author, posts[i - 1]!.author);
  }

  stop();
  t.mock.timers.tick(10_000);
  assert.equal(chat.posts().length, total);
});

test("delays stay within the configured window", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const chat = recorder();
  const stop = startChatter(chat.sink, {
    minDelayMs: 2000,
    maxDelayMs: 4000,
    backlog: 0,
    random: mock.fn(() => 0.5),
  });

  t.mock.timers.tick(2999);
  assert.equal(chat.posts().length, 0);
  t.mock.timers.tick(1);
  assert.equal(chat.posts().length, 1);

  stop();
});

test("starts with a backdated backlog holding exactly one retraction", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const chat = recorder();
  const before = Date.now();
  const stop = startChatter(chat.sink, {
    minDelayMs: 1000,
    maxDelayMs: 1000,
    backlog: 10,
    retractChance: 0,
    minRetractMs: 1500,
    maxRetractMs: 1500,
    random: seeded(3),
  });
  const after = Date.now();

  // Ten slots, one of which is a retraction: its line, its delete, and the
  // follow-up posted once it is gone.
  const posts = chat.posts();
  const [removed, ...others] = chat.removes();
  assert.equal(posts.length, 11);
  assert.ok(removed && others.length === 0);

  const target = chat.log.findIndex((entry) => entry.id === removed.id);
  const retraction = RETRACTIONS.find(({ text }) => text === (chat.log[target] as any).text)!;
  assert.ok(retraction, "the deleted line is a retraction");
  assert.ok(target < chat.log.indexOf(removed), "a delete follows its target");
  assert.equal(removed.ts - chat.log[target]!.ts, 1500);
  assert.deepEqual(chat.log[chat.log.indexOf(removed) + 1], {
    kind: "post",
    id: `m${chat.log.indexOf(removed) + 1}`,
    author: retraction.author,
    text: retraction.followUp,
    ts: removed.ts,
  });

  const stamps = chat.log.map((entry) => entry.ts);
  assert.deepEqual(stamps, [...stamps].sort((a, b) => a - b), "the backlog is in time order");
  assert.ok(stamps.at(-1)! >= before && stamps.at(-1)! <= after, "the newest lands now");

  t.mock.timers.tick(1000);
  assert.equal(chat.posts().length, 12);
  assert.equal(new Set(chat.posts().map((post) => post.text)).size, 12, "live chatter repeats nothing");

  stop();
});

test("the flag is posted and deleted in the backlog, and never live", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const flag = "CTF{test_flag}";
  const chat = recorder();
  const before = Date.now();
  const stop = startChatter(chat.sink, {
    minDelayMs: 1000,
    maxDelayMs: 1000,
    backlog: 10,
    retractChance: 0,
    minRetractMs: 1500,
    maxRetractMs: 1500,
    flag,
    random: seeded(5),
  });

  // The flag and the usual retraction each add a follow-up and a delete.
  assert.equal(chat.posts().length, 12);
  assert.equal(chat.removes().length, 2);

  const planted = chat.posts().filter((post) => post.text.includes(flag));
  assert.equal(planted.length, 1);
  const removal = chat.removes().find((entry) => entry.id === planted[0]!.id);
  assert.ok(removal, "the flag is deleted before chatter returns");
  assert.ok(removal.ts < before, "and dated before startup");
  assert.equal(
    chat.log[chat.log.indexOf(removal) + 1]!.kind === "post" &&
      (chat.log[chat.log.indexOf(removal) + 1] as any).text,
    flagRetraction(flag).followUp,
  );

  t.mock.timers.tick(1000);
  t.mock.timers.tick(1000);
  assert.equal(chat.posts().filter((post) => post.text.includes(flag)).length, 1);

  stop();
});

test("the flag is never the first line of the backlog", () => {
  const flag = "CTF{not_first}";
  for (const backlog of [2, 3, 4, 10, 25]) {
    for (let seed = 1; seed <= 200; seed++) {
      const chat = recorder();
      startChatter(chat.sink, { backlog, retractChance: 0, flag, random: seeded(seed) })();

      const at = chat.log.findIndex((entry) => entry.kind === "post" && entry.text.includes(flag));
      assert.ok(at > 0, `backlog ${backlog}, seed ${seed}: flag at ${at}`);
    }
  }
});

test("a live retraction is deleted after the window, then followed up", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const chat = recorder();
  const stop = startChatter(chat.sink, {
    minDelayMs: 1000,
    maxDelayMs: 1000,
    backlog: 0,
    retractChance: 1,
    minRetractMs: 500,
    maxRetractMs: 500,
    random: seeded(11),
  });

  t.mock.timers.tick(1000);
  const [posted] = chat.posts();
  const retraction = RETRACTIONS.find(({ text }) => text === posted!.text);
  assert.ok(retraction);

  t.mock.timers.tick(499);
  assert.equal(chat.removes().length, 0, "still up");
  t.mock.timers.tick(1);
  assert.deepEqual(
    chat.log.slice(1).map((entry) => (entry.kind === "remove" ? entry.id : entry.text)),
    [posted!.id, retraction.followUp],
  );

  // A retraction still waiting on its delete is cancelled by stop() too.
  t.mock.timers.tick(500);
  assert.equal(chat.posts().length, 3);
  stop();
  t.mock.timers.tick(10_000);
  assert.equal(chat.removes().length, 1);
});
