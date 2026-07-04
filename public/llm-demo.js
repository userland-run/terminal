// llm-demo.js — run INSIDE the NanoVM guest (node /root/llm-demo.js "question")
//
// Talks to the in-browser nanoinfer model through the VM's OpenAI facade:
// the guest has no sockets, so HTTP goes over the /dev/__net__ device —
// write "<METHOD> <URL>\n<Header: v>...\n\n<body>" to the fd, then read the
// framed HTTP/1.1 response off the same fd until EOF (readSync returns 0).
// With stream:true the host serves SSE chat.completion.chunk frames that
// arrive here token-by-token, straight from the WebGPU model in the page.
const fs = require("fs");

const question = process.argv.slice(2).join(" ") ||
  "In one sentence: where are you running right now?";
const body = JSON.stringify({
  model: "nanoinfer-local",
  stream: true,
  max_tokens: 128,
  messages: [{ role: "user", content: question }],
});

const fd = fs.openSync("/dev/__net__", "r+");
fs.writeSync(fd,
  "POST http://nanoinfer.internal/v1/chat/completions\n" +
  "Content-Type: application/json\n\n" + body);

const buf = Buffer.alloc(4096);
let raw = "", bodyStart = -1, pending = "";
for (;;) {
  const n = fs.readSync(fd, buf, 0, buf.length); // blocks until the next chunk
  if (n === 0) break; // EOF — host stream finished
  raw += buf.toString("utf8", 0, n);
  if (bodyStart < 0) { // wait for the "\r\n\r\n" end-of-head marker
    bodyStart = raw.indexOf("\r\n\r\n");
    if (bodyStart < 0) continue;
    const status = raw.slice(0, raw.indexOf("\r\n"));
    console.error(status); // e.g. HTTP/1.1 200 OK (503 = prepare Local GPU first)
    pending = raw.slice(bodyStart + 4);
  } else {
    pending += buf.toString("utf8", 0, n);
  }
  // Parse complete SSE events (separated by a blank line) as they arrive.
  let sep;
  while ((sep = pending.indexOf("\n\n")) >= 0) {
    const event = pending.slice(0, sep); pending = pending.slice(sep + 2);
    for (const line of event.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6);
      if (data === "[DONE]") { process.stdout.write("\n[done]\n"); fs.closeSync(fd); return; }
      const obj = JSON.parse(data);
      if (obj.error) { console.error("\nerror: " + obj.error.message); fs.closeSync(fd); process.exit(1); }
      const delta = obj.choices && obj.choices[0].delta.content;
      if (delta) process.stdout.write(delta); // token-by-token
    }
  }
}
fs.closeSync(fd);
// No [DONE] seen: non-SSE body (e.g. a JSON error like the 503) — print it.
if (pending.trim()) console.log(pending.trim());
