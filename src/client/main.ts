import { ChatView } from "./ui.ts";
import "./style.css";

const RETRY_DELAY_MS = 1000;

/** The server hangs up with this code when our cursor is missing or names no
 *  record it holds. Mirrors RESET_CLOSE_CODE in src/server/app.ts. */
const RESET_CLOSE_CODE = 4000;

class Connection {
  #socket: WebSocket | null = null;
  #cursor: string | null = null;
  #seen = new Set<string>();

  constructor(private readonly view: ChatView) {}

  async start(): Promise<void> {
    try {
      const history = await this.#fetchHistory();
      this.#adopt(history);
      this.view.replace(history.messages);
    } catch {
      this.view.setStatus("offline");
      setTimeout(() => void this.start(), RETRY_DELAY_MS);
      return;
    }
    this.#connect();
  }

  send(text: string): void {
    this.#socket?.send(JSON.stringify({ type: "send", text }));
  }

  delete(id: string): void {
    this.#socket?.send(JSON.stringify({ type: "delete", id }));
  }

  async #fetchHistory(): Promise<any> {
    const res = await fetch("/api/messages", { cache: "no-store" });
    if (!res.ok) throw new Error(`history fetch failed: ${res.status}`);
    return await res.json();
  }

  #adopt(history: any): void {
    this.#cursor = history.cursor;
    this.#seen = new Set<string>(history.messages.map((message: any) => message.id));
    this.view.setAuthors(history.author, history.villains ?? []);
  }

  #connect(): void {
    this.view.setStatus("connecting");

    const url = new URL("/ws", location.href);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    if (this.#cursor !== null) url.searchParams.set("since", this.#cursor);

    const socket = new WebSocket(url);
    this.#socket = socket;

    socket.addEventListener("message", (event) => this.#handleFrame(String(event.data)));

    socket.addEventListener("close", (event) => {
      this.#socket = null;
      this.view.setStatus("offline");

      if (event.code === RESET_CLOSE_CODE) {
        // Our cursor is missing or unusable. Start over from history, which
        // replaces what is on screen and hands us a cursor the server holds.
        void this.start();
        return;
      }

      setTimeout(() => this.#connect(), RETRY_DELAY_MS);
    });
  }

  #handleFrame(raw: string): void {
    const frame = JSON.parse(raw);

    switch (frame.type) {
      case "sync": {
        this.#apply(frame.records);
        this.view.setStatus("online");
        break;
      }

      // A record is its own frame.
      case "message":
      case "delete":
        this.#apply([frame]);
        break;
    }
  }

  #apply(records: any[]): void {
    const fresh = records.filter((record: any) => !this.#seen.has(record.id));
    if (fresh.length === 0) return;
    for (const record of fresh) this.#seen.add(record.id);
    this.#cursor = fresh[fresh.length - 1].id;
    this.view.apply(fresh);
  }
}

const view = new ChatView(
  (text) => connection.send(text),
  (id) => connection.delete(id),
);
const connection = new Connection(view);

view.setStatus("connecting");
void connection.start();
