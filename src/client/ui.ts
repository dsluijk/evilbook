export type Status = "connecting" | "online" | "offline";

const STICK_THRESHOLD_PX = 80;

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

  setAuthor(author: string): void {
    this.#identity.textContent = author;
  }

  /** Applies a run of log records in order: messages render, deletes unrender.
   *  Order matters — a message and its delete can arrive in the same batch. */
  apply(records: any[]): void {
    const following = this.#isNearBottom();

    for (const record of records) {
      if (record.type === "delete") this.#remove(record.target);
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
        this.#statusText.textContent = "Connecting…";
        break;

      case "online":
        this.#statusText.textContent = "Connected";
        this.#input.focus();
        break;

      case "offline":
        this.#statusText.textContent =
          "Offline — reconnecting… You'll catch up on anything said meanwhile.";
        break;
    }
  }

  #render(message: any): HTMLLIElement {
    const item = document.createElement("li");
    item.className = "message";
    item.dataset.id = message.id;

    const author = document.createElement("span");
    author.className = "message__author";
    author.textContent = message.author;

    const stamp = document.createElement("time");
    stamp.className = "message__time";
    stamp.dateTime = new Date(message.ts).toISOString();
    stamp.textContent = time.format(message.ts);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "message__delete";
    remove.textContent = "×";
    remove.title = "Delete this message";
    remove.setAttribute("aria-label", `Delete message from ${message.author}`);

    const body = document.createElement("p");
    body.className = "message__text";
    body.textContent = message.text;

    item.append(author, stamp, remove, body);
    return item;
  }

  /** A delete for a message we never rendered — older than the snapshot we
   *  loaded — is a no-op, not an error. */
  #remove(id: string): void {
    this.#list.querySelector(`.message[data-id="${CSS.escape(id)}"]`)?.remove();
  }

  #isNearBottom(): boolean {
    const { scrollTop, scrollHeight, clientHeight } = this.#list;
    return scrollHeight - scrollTop - clientHeight < STICK_THRESHOLD_PX;
  }

  #scrollToBottom(): void {
    this.#list.scrollTop = this.#list.scrollHeight;
  }
}
