import assert from "node:assert/strict";
import { test } from "node:test";

import { MessageStore } from "./store.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test("assigns a random, unique id to every message", () => {
  const store = new MessageStore();
  assert.equal(store.cursor, null);

  const ids = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const { id } = store.append("a", `m${i}`);
    assert.match(id, UUID);
    ids.add(id);
  }

  assert.equal(ids.size, 200, "ids must not collide");
  assert.equal(store.cursor, store.recent(1)[0]!.id, "the cursor is the newest id");
});

test("a caught-up cursor returns an empty backlog, not a miss", () => {
  const store = new MessageStore();
  store.append("a", "one");

  assert.deepEqual(store.after(store.cursor), { ok: true, records: [] });
});

test("returns exactly the messages after the cursor", () => {
  const store = new MessageStore();
  const first = store.append("a", "one");
  store.append("a", "two");
  store.append("a", "three");

  const result = store.after(first.id);
  assert.ok(result.ok);
  assert.deepEqual(
    result.records.map((m) => m.text),
    ["two", "three"],
  );
});

test("a null cursor asks for everything retained", () => {
  const store = new MessageStore();
  store.append("a", "one");
  store.append("a", "two");

  const result = store.after(null);
  assert.ok(result.ok);
  assert.deepEqual(
    result.records.map((m) => m.text),
    ["one", "two"],
    "a client holding nothing must not be told it is caught up",
  );
});

test("an empty store accepts a null cursor", () => {
  const store = new MessageStore();
  assert.deepEqual(store.after(null), { ok: true, records: [] });
});

test("an id we never issued is rejected", () => {
  const store = new MessageStore();
  store.append("a", "one");

  assert.deepEqual(store.after("11111111-2222-3333-4444-555555555555"), { ok: false });
});

test("a cursor whose message has been evicted is rejected rather than silently truncated", () => {
  const store = new MessageStore(5);
  const stale = store.append("a", "first");
  for (let i = 0; i < 20; i++) store.append("a", `m${i}`);

  assert.equal(store.size, 5);
  assert.deepEqual(store.after(stale.id), { ok: false });

  const oldest = store.recent(5)[0]!;
  const result = store.after(oldest.id);
  assert.ok(result.ok);
  assert.equal(result.records.length, 4);
});

test("recent() returns the newest messages, oldest first", () => {
  const store = new MessageStore();
  for (let i = 1; i <= 10; i++) store.append("a", `m${i}`);

  assert.deepEqual(
    store.recent(3).map((m) => m.text),
    ["m8", "m9", "m10"],
  );
  assert.equal(store.recent(100).length, 10);
});

test("truncates over-long authors and text rather than rejecting them", () => {
  const store = new MessageStore();
  const message = store.append("x".repeat(200), "y".repeat(5000));

  assert.equal(message.author.length, 40);
  assert.equal(message.text.length, 2000);
});

test("deleting appends a record instead of removing one", () => {
  const store = new MessageStore();
  const keep = store.append("a", "one");
  const doomed = store.append("a", "two");

  const record = store.delete(doomed.id, "a");

  assert.ok(record);
  assert.equal(record.type, "delete");
  assert.equal(record.target, doomed.id);
  assert.equal(store.size, 3, "the log grew; nothing was spliced out");
  assert.deepEqual(
    store.recent(10).map((m) => m.id),
    [keep.id],
    "but the deleted message stops surviving",
  );
  assert.equal(store.cursor, record.id, "the delete record is the newest cursor");
});

test("a delete reaches clients that are already caught up", () => {
  const store = new MessageStore();
  const message = store.append("a", "one");

  const cursor = store.cursor;
  const record = store.delete(message.id, "a")!;

  const result = store.after(cursor);
  assert.ok(result.ok);
  assert.deepEqual(
    result.records,
    [record],
    "a live client is told about the delete the same way it is told about a message",
  );
});

test("deletes carry their own id, so they can be resumed from", () => {
  const store = new MessageStore();
  const message = store.append("a", "one");
  const record = store.delete(message.id, "a")!;

  assert.match(record.id, UUID);
  assert.notEqual(record.id, message.id);
  assert.deepEqual(store.after(record.id), { ok: true, records: [] });
});

test("an unknown, repeated or already-deleted target appends nothing", () => {
  const store = new MessageStore();
  const message = store.append("a", "one");

  assert.equal(store.delete("11111111-2222-3333-4444-555555555555", "a"), null);
  assert.equal(store.size, 1, "an unknown id must not leave a record behind");

  assert.ok(store.delete(message.id, "a"));
  assert.equal(store.delete(message.id, "a"), null, "deleting twice is not two records");
  assert.equal(store.size, 2);
});

test("a delete record is not itself deletable", () => {
  const store = new MessageStore();
  const message = store.append("a", "one");
  const record = store.delete(message.id, "a")!;

  assert.equal(store.delete(record.id, "a"), null);
  assert.equal(store.size, 2);
});

test("live() answers whether a message is still standing", () => {
  const store = new MessageStore();
  const message = store.append("a", "one");

  assert.equal(store.live(message.id)?.text, "one");
  assert.equal(store.live("11111111-2222-3333-4444-555555555555"), undefined);

  store.delete(message.id, "a");
  assert.equal(store.live(message.id), undefined, "a deleted message is not live");
});

test("recent() counts surviving messages, never delete records", () => {
  const store = new MessageStore();
  const ids = [];
  for (let i = 1; i <= 5; i++) ids.push(store.append("a", `m${i}`).id);

  store.delete(ids[1]!, "a");
  store.delete(ids[3]!, "a");

  assert.deepEqual(
    store.recent(10).map((m) => m.text),
    ["m1", "m3", "m5"],
  );
  assert.deepEqual(
    store.recent(2).map((m) => m.text),
    ["m3", "m5"],
    "the limit applies after deletes are resolved",
  );
});

test("eviction never resurrects a deleted message", () => {
  const store = new MessageStore(4);
  const doomed = store.append("a", "gone");
  store.delete(doomed.id, "a");

  // Push until the delete record itself has aged out of the buffer.
  for (let i = 0; i < 20; i++) store.append("a", `m${i}`);

  assert.equal(store.size, 4);
  assert.ok(
    !store.recent(100).some((m) => m.id === doomed.id),
    "the message is evicted at or before its own delete record, so it cannot come back",
  );
});
