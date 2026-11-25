import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";

import WebSocket from "ws";

import { createChatServer, RESET_CLOSE_CODE, type ChatServer } from "./app.ts";
import { RETRACTIONS, VILLAINS } from "./villains.ts";

const AUTHOR = "kiosk";

let app: ChatServer;
let port: number;

before(async () => {
  app = createChatServer({ author: AUTHOR });
  await new Promise<void>((resolve) => app.server.listen(0, resolve));
  port = (app.server.address() as AddressInfo).port;
});

after(() => app.close());

function connect(query: string) {
  const socket = new WebSocket(`ws://localhost:${port}/ws${query}`);
  const frames: any[] = [];
  const waiters: Array<() => void> = [];

  socket.on("message", (data) => {
    frames.push(JSON.parse(data.toString()));
    for (const notify of waiters.splice(0)) notify();
  });

  const waitFor = (predicate: (frames: any[]) => boolean) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for frames")), 2000);
      const check = () => {
        if (!predicate(frames)) {
          waiters.push(check);
          return;
        }
        clearTimeout(timer);
        resolve();
      };
      check();
    });

  return { socket, frames, waitFor };
}

/** Connects the way the page does: resuming from the newest record. */
const join = () => connect(app.store.cursor === null ? "" : `?since=${app.store.cursor}`);

const opened = (socket: WebSocket) =>
  new Promise<void>((resolve) => socket.once("open", () => resolve()));

const closed = (socket: WebSocket) =>
  new Promise<number>((resolve) => socket.once("close", (code) => resolve(code)));

const history = async (): Promise<any> =>
  (await fetch(`http://localhost:${port}/api/messages`)).json();

function syncFrame(frames: any[]) {
  const frame = frames.find((f) => f.type === "sync");
  assert.ok(frame, `expected a sync frame, got ${frames.map((f) => f.type).join(", ")}`);
  return frame;
}

const deletes = (frames: any[]) => frames.filter((f) => f.type === "delete");

async function say(...texts: string[]) {
  const client = join();
  await opened(client.socket);
  await client.waitFor((frames) => frames.some((f) => f.type === "sync"));

  for (const text of texts) client.socket.send(JSON.stringify({ type: "send", text }));
  await client.waitFor((frames) => frames.filter((f) => f.type === "message").length >= texts.length);

  client.socket.close();
  await closed(client.socket);
}

test("message ids are random and unique, never sequential", async () => {
  await say("alpha", "beta", "gamma");
  const { messages } = await history();

  const ids = messages.map((m: any) => m.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) {
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-/, "ids should be UUIDs, not counters");
  }
});

test("a client with no cursor is hung up on once there is anything to name", async () => {
  assert.ok(app.store.size > 0);
  const client = connect("");

  assert.equal(await closed(client.socket), RESET_CLOSE_CODE);
  assert.deepEqual(client.frames, [], "it is sent no backlog at all");

  const blank = connect("?since=");
  assert.equal(await closed(blank.socket), RESET_CLOSE_CODE, "nor is an empty cursor");
});

test("an empty log lets a client in without a cursor", async () => {
  const fresh = createChatServer();
  await new Promise<void>((resolve) => fresh.server.listen(0, resolve));
  const { port } = fresh.server.address() as AddressInfo;

  try {
    const socket = new WebSocket(`ws://localhost:${port}/ws`);
    const sync = await new Promise<any>((resolve) =>
      socket.once("message", (data) => resolve(JSON.parse(data.toString()))),
    );
    assert.deepEqual(sync, { type: "sync", records: [] });

    socket.close();
    await closed(socket);
  } finally {
    await fresh.close();
  }
});

test("a reconnecting client receives exactly the messages it missed", async () => {
  const sender = join();
  await opened(sender.socket);
  await sender.waitFor((frames) => frames.some((f) => f.type === "sync"));

  const listener = join();
  await listener.waitFor((frames) => frames.some((f) => f.type === "sync"));

  sender.socket.send(JSON.stringify({ type: "send", text: "seen" }));
  await listener.waitFor((frames) => frames.some((f) => f.type === "message"));

  const cursor = app.store.cursor!;
  listener.socket.close();
  await closed(listener.socket);

  const missed = ["missed-1", "missed-2", "missed-3"];
  const sentBefore = sender.frames.filter((f) => f.type === "message").length;
  for (const text of missed) sender.socket.send(JSON.stringify({ type: "send", text }));
  await sender.waitFor(
    (frames) => frames.filter((f) => f.type === "message").length >= sentBefore + missed.length,
  );

  const resumed = connect(`?since=${cursor}`);
  await resumed.waitFor((frames) => frames.some((f) => f.type === "sync"));

  assert.deepEqual(
    syncFrame(resumed.frames).records.map((m: any) => m.text),
    missed,
    "the backlog should be the gap, with nothing repeated and nothing dropped",
  );

  sender.socket.send(JSON.stringify({ type: "send", text: "live" }));
  await resumed.waitFor((frames) => frames.some((f) => f.type === "message"));

  const live = resumed.frames.filter((f) => f.type === "message");
  assert.equal(live.length, 1);
  assert.equal(live[0]!.text, "live");

  sender.socket.close();
  resumed.socket.close();
  await Promise.all([closed(sender.socket), closed(resumed.socket)]);
});

test("an id the server never issued is answered by hanging up", async () => {
  const client = connect("?since=11111111-2222-3333-4444-555555555555");

  assert.equal(await closed(client.socket), RESET_CLOSE_CODE);
  assert.deepEqual(client.frames, [], "a doomed socket is sent no backlog at all");
});

test("GET /api/messages returns history paired with the cursor to resume from", async () => {
  const res = await fetch(`http://localhost:${port}/api/messages`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");

  const snapshot = (await res.json()) as any;
  assert.equal(snapshot.cursor, app.store.cursor, "the cursor names the newest record");

  const resumed = connect(`?since=${snapshot.cursor}`);
  await resumed.waitFor((frames) => frames.length >= 1);
  assert.deepEqual(syncFrame(resumed.frames).records, []);

  resumed.socket.close();
  await closed(resumed.socket);
});

test("history is never capped, so its oldest message stays the oldest one held", async () => {
  for (let i = 0; i < 150; i++) app.store.append(AUTHOR, `bulk ${i}`);

  const { messages } = await history();
  assert.ok(messages.length >= 150);
  assert.deepEqual(
    messages.map((m: any) => m.id),
    app.store.messages().map((m) => m.id),
  );
});

test("messages are posted under the configured name, whatever the client claims", async () => {
  const client = connect(`?since=${app.store.cursor}&author=impostor`);
  await opened(client.socket);
  await client.waitFor((frames) => frames.some((f) => f.type === "sync"));

  client.socket.send(JSON.stringify({ type: "send", text: "who am i" }));
  await client.waitFor((frames) => frames.some((f) => f.type === "message"));

  const broadcast = client.frames.find((f) => f.type === "message")!;
  assert.equal(broadcast.author, AUTHOR);
  assert.equal((await history()).author, AUTHOR, "history tells the client who it posts as");

  client.socket.close();
  await closed(client.socket);
});

test("a deployment that configures no name falls back to a placeholder", async () => {
  const plain = createChatServer({ author: "   " });
  await new Promise<void>((resolve) => plain.server.listen(0, resolve));

  try {
    assert.equal(plain.author, "J. Bond");

    const res = await fetch(`http://localhost:${(plain.server.address() as AddressInfo).port}/api/messages`);
    assert.equal(((await res.json()) as any).author, "J. Bond");
  } finally {
    await plain.close();
  }
});

test("history lists the villains only while they are chatting", async () => {
  assert.deepEqual((await history()).villains, [], "a quiet room has no one else in it");

  const chatty = createChatServer({ author: AUTHOR, chatter: { backlog: 0 } });
  await new Promise<void>((resolve) => chatty.server.listen(0, resolve));

  try {
    const res = await fetch(`http://localhost:${(chatty.server.address() as AddressInfo).port}/api/messages`);
    assert.deepEqual(
      ((await res.json()) as any).villains,
      VILLAINS.map((villain) => villain.author),
    );
  } finally {
    await chatty.close();
  }
});

test("malformed frames and blank messages are ignored, not broadcast", async () => {
  const client = join();
  await opened(client.socket);
  await client.waitFor((frames) => frames.some((f) => f.type === "sync"));

  const before = app.store.cursor;
  client.socket.send("not json");
  client.socket.send(JSON.stringify({ type: "nonsense" }));
  client.socket.send(JSON.stringify({ type: "send", text: "   " }));
  client.socket.send(JSON.stringify({ type: "send", text: "real" }));

  await client.waitFor((frames) => frames.some((f) => f.type === "message"));
  const broadcast = client.frames.filter((f) => f.type === "message");
  assert.equal(broadcast.length, 1, "only the real message should have landed");
  assert.equal(broadcast[0]!.text, "real");
  assert.notEqual(app.store.cursor, before);

  client.socket.close();
  await closed(client.socket);
});

test("a delete is streamed to every client as a record of its own", async () => {
  const sender = join();
  await opened(sender.socket);
  await sender.waitFor((frames) => frames.some((f) => f.type === "sync"));

  const listener = join();
  await listener.waitFor((frames) => frames.some((f) => f.type === "sync"));

  sender.socket.send(JSON.stringify({ type: "send", text: "regret" }));
  await listener.waitFor((frames) => frames.some((f) => f.type === "message"));

  const posted = listener.frames.find((f) => f.type === "message")!;
  sender.socket.send(JSON.stringify({ type: "delete", id: posted.id }));
  await listener.waitFor((frames) => deletes(frames).length >= 1);

  const record = deletes(listener.frames)[0]!;
  assert.equal(record.target, posted.id);
  assert.notEqual(record.id, posted.id, "the delete is its own record, with its own id");
  assert.equal(
    deletes(sender.frames).length,
    1,
    "the client that asked for the delete is told about it like everyone else",
  );

  sender.socket.close();
  listener.socket.close();
  await Promise.all([closed(sender.socket), closed(listener.socket)]);
});

test("any tab may delete a message another tab sent, since they post under one name", async () => {
  const sender = join();
  await opened(sender.socket);
  await sender.waitFor((frames) => frames.some((f) => f.type === "sync"));

  const other = join();
  await opened(other.socket);
  await other.waitFor((frames) => frames.some((f) => f.type === "sync"));

  sender.socket.send(JSON.stringify({ type: "send", text: "not yours, but still ours" }));
  await other.waitFor((frames) => frames.some((f) => f.type === "message"));

  const posted = other.frames.find((f) => f.type === "message")!;
  other.socket.send(JSON.stringify({ type: "delete", id: posted.id }));
  await sender.waitFor((frames) => deletes(frames).length >= 1);
  assert.equal(deletes(sender.frames)[0]!.target, posted.id);

  sender.socket.close();
  other.socket.close();
  await Promise.all([closed(sender.socket), closed(other.socket)]);
});

test("a villain's message cannot be deleted", async () => {
  const villains = createChatServer({
    author: AUTHOR,
    chatter: { backlog: 6, minDelayMs: 60_000, maxDelayMs: 60_000 },
  });
  await new Promise<void>((resolve) => villains.server.listen(0, resolve));
  const { port } = villains.server.address() as AddressInfo;

  try {
    const snapshot = (await (await fetch(`http://localhost:${port}/api/messages`)).json()) as any;
    const target = snapshot.messages.at(-1);
    assert.notEqual(target.author, AUTHOR);

    const socket = new WebSocket(`ws://localhost:${port}/ws?since=${snapshot.cursor}`);
    const frames: any[] = [];
    socket.on("message", (data) => frames.push(JSON.parse(data.toString())));
    await opened(socket);

    socket.send(JSON.stringify({ type: "delete", id: target.id }));
    socket.send(JSON.stringify({ type: "send", text: "after" }));
    await new Promise<void>((resolve) => {
      const check = () => (frames.some((f) => f.text === "after") ? resolve() : setTimeout(check, 10));
      check();
    });

    assert.deepEqual(deletes(frames), [], "no delete record was made");
    assert.ok(villains.store.live(target.id), "and the villain's line still stands");

    socket.close();
    await closed(socket);
  } finally {
    await villains.close();
  }
});

test("GET /api/messages resolves deletes away, but its cursor still names them", async () => {
  const client = join();
  await opened(client.socket);
  await client.waitFor((frames) => frames.some((f) => f.type === "sync"));

  client.socket.send(JSON.stringify({ type: "send", text: "doomed" }));
  await client.waitFor((frames) => frames.some((f) => f.type === "message"));

  const posted = client.frames.find((f) => f.type === "message")!;
  const before = deletes(client.frames).length;
  client.socket.send(JSON.stringify({ type: "delete", id: posted.id }));
  await client.waitFor((frames) => deletes(frames).length > before);

  const snapshot = await history();
  assert.ok(
    !snapshot.messages.some((m: any) => m.id === posted.id),
    "the HTTP snapshot is resolved; the socket stream is not",
  );
  assert.ok(
    !snapshot.messages.some((m: any) => m.type === "delete"),
    "and it carries no delete records either",
  );
  assert.equal(
    snapshot.cursor,
    deletes(client.frames).at(-1)!.id,
    "the cursor names the delete record, which is in no snapshot",
  );

  const resumed = connect(`?since=${snapshot.cursor}`);
  await resumed.waitFor((frames) => frames.length >= 1);
  assert.deepEqual(syncFrame(resumed.frames).records, [], "and it is still usable");

  client.socket.close();
  resumed.socket.close();
  await Promise.all([closed(client.socket), closed(resumed.socket)]);
});

test("a client that missed a delete is sent the delete record, not a gap", async () => {
  const sender = join();
  await opened(sender.socket);
  await sender.waitFor((frames) => frames.some((f) => f.type === "sync"));

  sender.socket.send(JSON.stringify({ type: "send", text: "vanishes" }));
  await sender.waitFor((frames) => frames.some((f) => f.type === "message"));

  const posted = sender.frames.filter((f) => f.type === "message").at(-1)!;
  const cursor = app.store.cursor!;

  const before = deletes(sender.frames).length;
  sender.socket.send(JSON.stringify({ type: "delete", id: posted.id }));
  await sender.waitFor((frames) => deletes(frames).length > before);

  const resumed = connect(`?since=${cursor}`);
  await resumed.waitFor((frames) => frames.some((f) => f.type === "sync"));

  assert.deepEqual(
    syncFrame(resumed.frames).records.map((r: any) => [r.type, r.target ?? r.text]),
    [["delete", posted.id]],
    "the backlog tells it to unrender what it already has on screen",
  );

  sender.socket.close();
  resumed.socket.close();
  await Promise.all([closed(sender.socket), closed(resumed.socket)]);
});

test("a client that was hung up on refetches history and resumes from its cursor", async () => {
  const client = connect("?since=11111111-2222-3333-4444-555555555555");
  assert.equal(await closed(client.socket), RESET_CLOSE_CODE);

  // What the client does next: refetch, and come back holding that cursor.
  const snapshot = await history();
  const retried = connect(`?since=${snapshot.cursor}`);
  await retried.waitFor((frames) => frames.some((f) => f.type === "sync"));
  assert.deepEqual(syncFrame(retried.frames).records, [], "it is caught up, not hung up on");

  retried.socket.close();
  await closed(retried.socket);
});

test("resuming from an older message replays everything after it, deletes included", async () => {
  const snapshot = await history();
  const [oldest, ...rest] = snapshot.messages;

  const replay = connect(`?since=${oldest.id}`);
  await replay.waitFor((frames) => frames.some((f) => f.type === "sync"));
  const records = syncFrame(replay.frames).records;
  assert.ok(deletes(records).length > 0, "the deletes earlier tests made are in the gap");

  // Resolve the replay the way the client's apply() does, in order.
  const live = new Set<string>();
  for (const record of records) {
    if (record.type === "delete") live.delete(record.target);
    else live.add(record.id);
  }

  assert.deepEqual(
    [...live],
    rest.map((m: any) => m.id),
    "and resolving it lands on exactly what HTTP served after that message",
  );

  replay.socket.close();
  await closed(replay.socket);
});

test("a delete for an id the server never issued is ignored, not broadcast", async () => {
  const client = join();
  await opened(client.socket);
  await client.waitFor((frames) => frames.some((f) => f.type === "sync"));

  const before = app.store.cursor;
  const deletesBefore = deletes(client.frames).length;

  client.socket.send(JSON.stringify({ type: "delete", id: "11111111-2222-3333-4444-555555555555" }));
  client.socket.send(JSON.stringify({ type: "delete" }));
  client.socket.send(JSON.stringify({ type: "send", text: "still here" }));
  await client.waitFor((frames) => frames.some((f) => f.type === "message"));

  assert.equal(deletes(client.frames).length, deletesBefore, "no delete record was made");

  // Deleting the same message twice is one record, not two.
  const posted = client.frames.filter((f) => f.type === "message").at(-1)!;
  client.socket.send(JSON.stringify({ type: "delete", id: posted.id }));
  await client.waitFor((frames) => deletes(frames).length > deletesBefore);

  const after = app.store.cursor;
  client.socket.send(JSON.stringify({ type: "delete", id: posted.id }));
  client.socket.send(JSON.stringify({ type: "send", text: "ping" }));
  await client.waitFor((frames) => frames.some((f) => f.text === "ping"));

  assert.equal(
    deletes(client.frames).length,
    deletesBefore + 1,
    "the second delete of the same message appended nothing",
  );
  assert.notEqual(after, before);

  client.socket.close();
  await closed(client.socket);
});

test("the flag is gone from history and the newest cursor, but replayed from an older one", async () => {
  const flag = "CTF{end_to_end}";
  const started = Date.now();
  const villains = createChatServer({
    chatter: { backlog: 6, minDelayMs: 60_000, maxDelayMs: 60_000, flag },
  });
  await new Promise<void>((resolve) => villains.server.listen(0, resolve));
  const { port } = villains.server.address() as AddressInfo;

  try {
    const snapshot = (await (await fetch(`http://localhost:${port}/api/messages`)).json()) as any;
    assert.ok(!JSON.stringify(snapshot).includes(flag), "history never shows the flag");

    const resumed = new WebSocket(`ws://localhost:${port}/ws?since=${snapshot.cursor}`);
    const gap = await new Promise<any>((resolve) =>
      resumed.once("message", (data) => resolve(JSON.parse(data.toString()))),
    );
    assert.ok(!JSON.stringify(gap).includes(flag), "nor does the gap after the cursor");
    resumed.close();
    await closed(resumed);

    const cursorless = new WebSocket(`ws://localhost:${port}/ws`);
    assert.equal(await closed(cursorless), RESET_CLOSE_CODE, "there is no full replay");

    // The way in: resume from the oldest message history still shows.
    const socket = new WebSocket(`ws://localhost:${port}/ws?since=${snapshot.messages[0].id}`);
    const sync = await new Promise<any>((resolve) =>
      socket.once("message", (data) => resolve(JSON.parse(data.toString()))),
    );
    const message = sync.records.find((r: any) => r.type === "message" && r.text.includes(flag));
    const removal = sync.records.find((r: any) => r.type === "delete" && r.target === message?.id);
    assert.ok(message, "the flag is still in the raw log");
    assert.ok(removal, "followed by its delete");
    assert.ok(removal.ts < started, "deleted before the server started");

    socket.close();
    await closed(socket);
  } finally {
    await villains.close();
  }
});

test("a retracted villain line is gone from history but replayed as message plus delete", async () => {
  const villains = createChatServer({
    chatter: { backlog: 6, minDelayMs: 60_000, maxDelayMs: 60_000 },
  });
  await new Promise<void>((resolve) => villains.server.listen(0, resolve));
  const { port } = villains.server.address() as AddressInfo;

  try {
    const retracted = new Set(RETRACTIONS.map(({ text }) => text));

    const snapshot = (await (await fetch(`http://localhost:${port}/api/messages`)).json()) as any;
    assert.equal(snapshot.messages.length, 6, "six lines and a follow-up, less the one deleted");
    assert.ok(!snapshot.messages.some((m: any) => retracted.has(m.text)));

    const socket = new WebSocket(`ws://localhost:${port}/ws?since=${snapshot.messages[0].id}`);
    const sync = await new Promise<any>((resolve) =>
      socket.once("message", (data) => resolve(JSON.parse(data.toString()))),
    );
    const message = sync.records.find((r: any) => r.type === "message" && retracted.has(r.text));
    const removal = sync.records.find((r: any) => r.type === "delete");
    assert.ok(message, "the deleted line is still in the raw log");
    assert.equal(removal.target, message.id);
    assert.ok(sync.records.indexOf(removal) > sync.records.indexOf(message));

    socket.close();
    await closed(socket);
  } finally {
    await villains.close();
  }
});
