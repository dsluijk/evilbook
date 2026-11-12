import { randomUUID } from "node:crypto";

export const MAX_TEXT_LENGTH = 2000;
export const MAX_AUTHOR_LENGTH = 40;

export type CursorResult = { ok: true; records: any[] } | { ok: false };

/**
 * An append-only log of records. A record is either a posted message or a
 * delete naming the message it retires. Nothing is ever removed — not by a
 * delete, and not by age — so a cursor stays valid for the life of the process.
 */
export class MessageStore {
  #records: any[] = [];

  get cursor(): string | null {
    return this.#records.at(-1)?.id ?? null;
  }

  get size(): number {
    return this.#records.length;
  }

  /** `ts` defaults to now; chatter backdates its startup backlog. */
  append(author: string, text: string, ts: number = Date.now()): any {
    return this.#push({
      type: "message",
      id: randomUUID(),
      author: author.slice(0, MAX_AUTHOR_LENGTH),
      text: text.slice(0, MAX_TEXT_LENGTH),
      ts,
    });
  }

  /** Retires a live message. Returns null — appending nothing — if it is
   *  unknown or already deleted. */
  delete(target: string, author: string, ts: number = Date.now()): any | null {
    if (this.live(target) === undefined) return null;

    return this.#push({
      type: "delete",
      id: randomUUID(),
      target,
      author: author.slice(0, MAX_AUTHOR_LENGTH),
      ts,
    });
  }

  /** The message with this id, if it is still standing. */
  live(id: string): any | undefined {
    return this.#resolve().find((record) => record.id === id);
  }

  /** The newest surviving messages, oldest first — deletes applied, and never
   *  the delete records themselves. */
  recent(limit: number): any[] {
    return this.#resolve().slice(-limit);
  }

  after(cursor: string | null): CursorResult {
    if (cursor === null) return { ok: true, records: [...this.#records] };

    const index = this.#records.findIndex((record) => record.id === cursor);
    if (index === -1) return { ok: false };

    return { ok: true, records: this.#records.slice(index + 1) };
  }

  #push(record: any): any {
    this.#records.push(record);
    return record;
  }

  #resolve(): any[] {
    const deleted = new Set<string>();
    for (const record of this.#records) {
      if (record.type === "delete") deleted.add(record.target);
    }

    return this.#records.filter(
      (record) => record.type === "message" && !deleted.has(record.id),
    );
  }
}
