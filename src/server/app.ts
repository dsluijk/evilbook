import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import { WebSocketServer, type WebSocket } from "ws";

import {
  DEFAULT_CAPACITY,
  MAX_AUTHOR_LENGTH,
  MAX_TEXT_LENGTH,
  MessageStore,
} from "./store.ts";
import { startChatter, type ChatterOptions } from "./villains.ts";

const HISTORY_LIMIT = 100;

const DEFAULT_AUTHOR = "anon";

/** Sent instead of a backlog when a cursor names no record we still hold. The
 *  client mirrors this constant in src/client/main.ts. */
export const RESET_CLOSE_CODE = 4000;

export type ChatServerOptions = {
  capacity?: number;
  author?: string;
  /** Villains post into the log at random, as if other people were chatting.
   *  Off unless given. */
  chatter?: ChatterOptions;
};

export type ChatServer = {
  server: Server;
  store: MessageStore;
  author: string;
  close: () => Promise<void>;
};

const DIST = fileURLToPath(new URL("../../dist/", import.meta.url));

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

/**
 * Placeholder. Every socket in a deployment posts under the same
 * server-configured author, so nothing yet distinguishes one client's messages
 * from another's. This is the seam where per-identity ownership lands; until
 * then every request is allowed.
 */
export function canDelete(message: any, requester: string): boolean {
  return true;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const requested = normalize(decodeURIComponent(url.pathname));
  const path = join(DIST, requested === "/" ? "index.html" : requested);

  if (!path.startsWith(DIST)) {
    res.writeHead(403).end("Forbidden");
    return;
  }

  try {
    const body = await readFile(path);
    res.writeHead(200, { "content-type": MIME[extname(path)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    try {
      const body = await readFile(join(DIST, "index.html"));
      res.writeHead(200, { "content-type": MIME[".html"]! }).end(body);
    } catch {
      res.writeHead(404).end("Not found. Run `npm run build` first, or use `npm run dev`.");
    }
  }
}

export function createChatServer(options: ChatServerOptions = {}): ChatServer {
  const store = new MessageStore(options.capacity ?? DEFAULT_CAPACITY);
  const author =
    (options.author ?? "").trim().slice(0, MAX_AUTHOR_LENGTH) || DEFAULT_AUTHOR;
  const clients = new Set<WebSocket>();

  const send = (socket: WebSocket, frame: unknown): void => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
  };

  // A record is its own frame — there is nothing to wrap it in.
  const broadcast = (record: any): void => {
    const payload = JSON.stringify(record);
    for (const client of clients) {
      if (client.readyState === client.OPEN) client.send(payload);
    }
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === "/api/messages") {
      sendJson(res, 200, {
        author,
        cursor: store.cursor,
        messages: store.recent(HISTORY_LIMIT),
      });
      return;
    }

    void serveStatic(req, res);
  });

  const wss = new WebSocketServer({ server, path: "/ws" });

  // Goes through the same append-and-broadcast path as a real send, so fake
  // messages are cursors, replay and delete like any other.
  const stopChatter = options.chatter
    ? startChatter((who, text) => broadcast(store.append(who, text)), options.chatter)
    : () => {};

  wss.on("connection", (socket, req) => {
    const url = new URL(req.url ?? "/ws", "http://localhost");
    const since = url.searchParams.get("since");

    const result = store.after(since);
    if (!result.ok) {
      // Hanging up is the whole answer: the client drops its cursor and comes
      // back without one, and a cursorless backlog is always servable.
      socket.close(RESET_CLOSE_CODE, "cursor unusable");
      return;
    }

    clients.add(socket);
    send(socket, { type: "sync", records: result.records });

    socket.on("message", (data) => {
      let frame: any;
      try {
        frame = JSON.parse(data.toString());
      } catch {
        return;
      }

      switch (frame?.type) {
        case "send": {
          if (typeof frame.text !== "string") return;

          const text = frame.text.trim();
          if (text.length === 0 || text.length > MAX_TEXT_LENGTH) return;

          broadcast(store.append(author, text));
          return;
        }

        case "delete": {
          if (typeof frame.id !== "string") return;

          const target = store.live(frame.id);
          if (target === undefined || !canDelete(target, author)) return;

          const record = store.delete(target.id, author);
          if (record !== null) broadcast(record);
          return;
        }
      }
    });

    socket.on("close", () => clients.delete(socket));
  });

  return {
    server,
    store,
    author,
    close: () =>
      new Promise((resolve, reject) => {
        stopChatter();
        for (const client of clients) client.close(1001, "server shutting down");
        wss.close(() => server.close((error) => (error ? reject(error) : resolve())));
      }),
  };
}
