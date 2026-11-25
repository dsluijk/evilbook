# EvilBook

A small chat website built around one property: it tolerates the network failing.

Dropping the connection, killing the server, or closing the laptop lid all end the same
way — the client quietly catches up. No lost messages, no duplicates, no reload.

```
npm install
npm run dev     # http://localhost:5173
```

Or with Docker:

```
docker compose up --build    # http://localhost:8080
```

## How resuming works

Every message gets a random UUID. The client remembers the id of the last message it
rendered and hands it back as a cursor on every connect.

1. `GET /api/messages` returns recent history, the cursor to resume from, and the name
   this server posts under.
2. The client opens `ws://…/ws?since=<id>`.
3. The server answers with **exactly one** of:
   - `sync` — here is the gap between your cursor and now, then live traffic follows.
   - a close with code **4000** — your cursor is missing or unusable; refetch history
     and come back with the cursor it hands you.

There is deliberately no third option, and no partial answer. Serving "as much as we
still have" would leave a hole the client has no way to detect. Failing loudly is what
keeps the view honest, and hanging up is as loud as this protocol gets: a socket that
cannot be told the truth is not left open to be told something else.

A cursor is required. The only time a socket may come in without one is while the log
is empty, when there is nothing to name; after that, a missing `since` is answered like
an unknown one.

### Ordering without ordered ids

Random ids carry no sequence, so nothing may infer order from them. Order lives in the
log itself: messages are only ever appended, so **position is sequence**. That makes a
cursor a lookup — "find this id, send me what came after it" — rather than a
comparison, and it is why the server hangs up instead of trying to work out whether an
id is "too old".

The client cannot compare either, so it de-duplicates against a set of ids it has
already rendered. That set is rebuilt from scratch on every refetch.

### Deleting without deleting

The same rule forbids removing a message: splicing one out would invalidate every cursor
that names it and silently shift the gap a reconnecting client is owed. So a delete is
**a record, not a removal** — a second entry in the same log, naming the message it
retires:

```
{ type: "message", id, author, text, ts }
{ type: "delete",  id, target, author, ts }
```

Both carry an id, so either can be a cursor, and a record is its own frame — the server
sends it as-is and `sync` carries an array of the same shapes. From there the two
transports deliberately diverge:

- `GET /api/messages` **resolves** the log and serves only surviving messages.
- The socket **streams** it raw, and the client applies deletes to its own DOM.

The socket has to, because an append-only backlog is the one thing that can say "and that
old message you still have on screen is gone." Resolving it server-side would leave the
client showing something the server knows is deleted. It also means a replay resolves
itself: records arrive in order, so a message followed by its delete renders and then
collapses to a tombstone, leaving exactly the resolved set's text on screen.

A tombstone keeps the author and time, replaces the text with "Redacted", and flashes briefly so the room sees it happen. The deleted text itself is
dropped from the page. Tombstones only come from the socket: a fresh page load starts
from `GET /api/messages`, which has already resolved deletes away, so earlier deletes
leave no trace there.

Deletes are idempotent and unordered-safe by construction. An unknown or already-deleted
target appends nothing, and a delete whose target the client never rendered is a no-op
rather than an error.

Only a message's author may delete it — the server compares the two names before
appending a delete. Every socket in a deployment posts under the same server-configured author, so
any tab or browser can delete what another one sent, but nobody can delete a villain's
line. The client only draws a delete button on messages posted under its own name.

The log is never trimmed, so a cursor stays usable for the life of the process. A restart
is the one way to lose it: history lives in memory, so a fresh process holds no message
any old cursor could name — the lookup misses, the client is hung up on, and it refetches.

### Why the cursor is a query param, not a header

The browser `WebSocket` constructor takes a URL and subprotocols — it cannot set
request headers. So the cursor travels in the query string, and the server reads it at
upgrade time, which is where a header would have been read anyway.

## Failure handling on the client

All of this lives in [`src/client/connection.ts`](src/client/connection.ts):

| Failure                          | Response                                                       |
| -------------------------------- | -------------------------------------------------------------- |
| Socket closes                    | Reconnect with exponential backoff (500ms → 15s, ±20% jitter)  |
| Network returns / tab refocused  | Skip the remaining backoff and retry immediately               |
| Connection dies without closing  | A 60s silence watchdog forces the close the network never sent |
| Server restarted                 | Closed with `4000` → refetch history, resume from its cursor   |
| A message was deleted while away | The backlog carries the delete record; it becomes a tombstone  |
| Replayed record already applied  | Dropped — ids already applied are tracked in a set             |

The server pairs a protocol-level ping (to reap sockets it can no longer reach) with an
application-level heartbeat every 25s (so the client has something to measure silence
against).

## Scope

Receive-only resilience. Outgoing messages are **not** queued while offline — the
composer is disabled instead, so the UI never accepts text it would drop. History is
in-memory and does not survive a restart; the `4000` close is what makes that safe
rather than confusing. Deletes are not moderation — ownership is by name, not by session.

## Layout

```
src/shared/protocol.ts   wire format, imported by both sides
src/server/store.ts      ring buffer, cursor lookup
src/server/app.ts        HTTP + WebSocket + broadcast hub
src/server/villains.ts   fake villain chatter posted at random
src/server/index.ts      entry point
src/client/connection.ts reconnecting, resuming socket
src/client/ui.ts         rendering
```

## Commands

```
npm run dev        vite on :5173, server on :8080, /api and /ws proxied
npm test           store unit tests + integration tests over real sockets
npm run typecheck
npm run build      client -> dist/
npm start          serves dist/ and the API from :8080
```

`AUTHOR` sets the name messages are posted under (default `J. Bond`). It is deliberately
server config: the browser has no way to set or override it, and the server ignores any
name a client sends, so every message from a deployment carries the same one.

```
AUTHOR=dany npm start
```

`CHATTER` controls the fake conversation. By default a cabal of villains posts into the
chat every 2-10 seconds, through the same log as real messages, so their lines resume,
replay and delete like anything else. A fresh server starts with 25 of their lines
already posted, backdated as if the conversation had been going for a few minutes.
About one post in ten, a villain says something they shouldn't, deletes it 2-6
seconds later and posts a follow-up; the startup backlog always contains one of these.
`CHATTER=off npm start` silences them. The lines live in `src/server/villains.ts`.

`FLAG` sets the CTF flag. It is planted in the villains' startup backlog, so it needs
`CHATTER` on; the startup log says "flag planted" when it is.

```
FLAG='CTF{...}' npm start
```

## Docker

```
docker compose up --build            # http://localhost:8080
AUTHOR=dany docker compose up -d --force-recreate
HOST_PORT=3000 docker compose up -d
```

The client is built in a first stage and only `dist/` carries over. Node 22 strips
TypeScript types natively, so the server runs straight from source — the final image
has no TypeScript toolchain in it and exactly one runtime dependency, `ws`.

`restart: unless-stopped` is safe here despite history living in memory. A restarted
server does not hold the records its clients' cursors name, so they are hung up on and
refetch. That is the ordinary recovery path, not a special case.
