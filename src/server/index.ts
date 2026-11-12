import { createChatServer } from "./app.ts";

const PORT = Number(process.env.PORT ?? 8080);
const AUTHOR = process.env.AUTHOR ?? "";
const CHATTER = process.env.CHATTER !== "off";
const FLAG = process.env.FLAG || undefined;

const app = createChatServer({
  author: AUTHOR,
  chatter: CHATTER ? { flag: FLAG } : undefined,
});

app.server.listen(PORT, () => {
  console.log(
    `elevenEyes on http://localhost:${PORT} (posting as ${app.author}${CHATTER ? ", villains chatting" : ""}${CHATTER && FLAG ? ", flag planted" : ""})`,
  );
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
