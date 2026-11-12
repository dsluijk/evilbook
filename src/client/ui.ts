export type Status = "connecting" | "online" | "offline";

const STICK_THRESHOLD_PX = 80;

/** How many --villain-N colours style.css defines. */
const VILLAIN_COLORS = 11;

const time = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
});

export class ChatView {
  readonly #list = document.getElementById("messages") as HTMLOListElement;
  readonly #status = document.getElementById("status") as HTMLDivElement;
  readonly #statusText = document.getElementById(
    "status-text",
  ) as HTMLSpanElement;
  readonly #form = document.getElementById("composer") as HTMLFormElement;
  readonly #input = document.getElementById("input") as HTMLInputElement;
  readonly #send = document.getElementById("send") as HTMLButtonElement;
  readonly #identity = document.getElementById("identity") as HTMLSpanElement;
  #self = "";
  #villains = new Map<string, number>();

  constructor(
    private readonly onSend: (text: string) => void,
    private readonly onDelete: (id: string) => void,
  ) {
    this.#form.addEventListener("submit", (event) => {
      event.preventDefault();
      const text = this.#input.value.trim();
      if (text.length === 0) return;
      this.#input.value = "";
      this.onSend(text);
    });

    // Delegated, so it survives replaceChildren and #render stays a pure builder.
    this.#list.addEventListener("click", (event) => {
      const button = (event.target as Element | null)?.closest(
        ".message__delete",
      );
      const id = button?.closest<HTMLLIElement>(".message")?.dataset.id;
      if (id !== undefined) this.onDelete(id);
    });
  }

  /** Who we post as, and the other people in the room in the server's order.
   *  Each villain keeps its slot in the palette, so its colour never changes
   *  between reloads and no two of them share one. */
  setAuthors(self: string, villains: string[]): void {
    this.#self = self;
    this.#villains = new Map(villains.map((name, i) => [name, i % VILLAIN_COLORS]));
    this.#identity.textContent = self;
  }

  /** Applies a run of log records in order: messages render, deletes leave a
   *  tombstone. Order matters — a message and its delete can arrive in the
   *  same batch. */
  apply(records: any[]): void {
    const following = this.#isNearBottom();

    for (const record of records) {
      if (record.type === "delete") this.#tombstone(record.target);
      else this.#list.append(this.#render(record));
    }

    if (following) this.#scrollToBottom();
  }

  replace(messages: any[]): void {
    this.#list.replaceChildren(
      ...messages.map((message) => this.#render(message)),
    );
    this.#scrollToBottom();
  }

  setStatus(status: Status): void {
    this.#status.dataset.state = status;

    const online = status === "online";
    this.#input.disabled = !online;
    this.#send.disabled = !online;

    switch (status) {
      case "connecting":
        this.#statusText.textContent = "Establishing secure line…";
        break;

      case "online":
        this.#statusText.textContent = "Line secure — nobody suspects a thing";
        this.#input.focus();
        break;

      case "offline":
        this.#statusText.textContent =
          "Line cut — re-establishing… Anything said meanwhile will be recovered.";
        break;
    }
  }

  #render(message: any): HTMLLIElement {
    const item = document.createElement("li");
    item.className = "message";
    item.dataset.id = message.id;
    item.style.setProperty("--author", this.#colorOf(message.author));

    const author = document.createElement("span");
    author.className = "message__author";
    author.textContent = message.author;

    const stamp = document.createElement("time");
    stamp.className = "message__time";
    stamp.dateTime = new Date(message.ts).toISOString();
    stamp.textContent = time.format(message.ts);

    const body = document.createElement("p");
    body.className = "message__text";
    body.textContent = message.text;

    // Only our own messages can be deleted; the server refuses anything else.
    if (message.author !== this.#self) {
      item.append(author, stamp, body);
      return item;
    }

    item.classList.add("message--self");

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "message__delete";
    remove.textContent = "×";
    remove.title = "Delete this message";
    remove.setAttribute("aria-label", "Delete your message");

    item.append(author, stamp, remove, body);
    return item;
  }

  /** The message stays where it was, so the room sees that something was said
   *  and withdrawn — but its text goes: the page keeps nothing the server has
   *  deleted. A delete for a message we never rendered — older than the
   *  snapshot we loaded — is a no-op, not an error. */
  #tombstone(id: string): void {
    const item = this.#list.querySelector<HTMLLIElement>(
      `.message[data-id="${CSS.escape(id)}"]`,
    );
    if (item === null || item.classList.contains("message--deleted")) return;

    item.classList.add("message--deleted");
    item.querySelector(".message__delete")?.remove();
    item.querySelector(".message__text")!.textContent = "Redacted by sender";
  }

  /** Our own messages wear the accent. A name the server did not list still
   *  gets a colour, hashed from the name so it is the same on every load. */
  #colorOf(author: string): string {
    if (author === this.#self) return "var(--self)";

    let slot = this.#villains.get(author);
    if (slot === undefined) {
      let hash = 0;
      for (const char of author) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
      slot = hash % VILLAIN_COLORS;
    }
    return `var(--villain-${slot})`;
  }

  #isNearBottom(): boolean {
    const { scrollTop, scrollHeight, clientHeight } = this.#list;
    return scrollHeight - scrollTop - clientHeight < STICK_THRESHOLD_PX;
  }

  #scrollToBottom(): void {
    this.#list.scrollTop = this.#list.scrollHeight;
  }
}
