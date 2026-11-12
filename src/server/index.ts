import { createChatServer } from "./app.ts";

const PORT = Number(process.env.PORT ?? 8080);
const CAPACITY = Number(process.env.CAPACITY ?? 500);
const AUTHOR = process.env.AUTHOR ?? "";
const CHATTER = process.env.CHATTER !== "off";

const app = createChatServer({
  capacity: CAPACITY,
  author: AUTHOR,
  chatter: CHATTER ? {} : undefined,
});

app.server.listen(PORT, () => {
  console.log(
    `chatchal on http://localhost:${PORT} (posting as ${app.author}, retaining ${CAPACITY} messages${CHATTER ? ", villains chatting" : ""})`,
  );
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
