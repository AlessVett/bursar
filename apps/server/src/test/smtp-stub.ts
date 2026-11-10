import net from "node:net";

export interface SmtpStub {
  host: string;
  port: number;
  /** Raw DATA section of every accepted message (headers and body). */
  messages: string[];
  close(): Promise<void>;
}

/**
 * A minimal plain-text SMTP server on the loopback interface, enough for nodemailer to connect,
 * verify and deliver one message. Tests use it with `security: "none"`, so no mail ever leaves
 * the machine. `rejectRecipients` makes it answer `550` to RCPT TO.
 */
export async function startSmtpStub(
  options: { rejectRecipients?: boolean } = {},
): Promise<SmtpStub> {
  const messages: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let buffer = "";
    let inData = false;
    const reply = (line: string) => socket.write(`${line}\r\n`);
    reply("220 stub ESMTP");
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        if (inData) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end === -1) return;
          messages.push(buffer.slice(0, end));
          buffer = buffer.slice(end + 5);
          inData = false;
          reply("250 queued");
          continue;
        }
        const eol = buffer.indexOf("\r\n");
        if (eol === -1) return;
        const line = buffer.slice(0, eol);
        buffer = buffer.slice(eol + 2);
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === "EHLO") socket.write("250-stub\r\n250 8BITMIME\r\n");
        else if (verb === "RCPT" && options.rejectRecipients) reply("550 no such mailbox");
        else if (verb === "DATA") {
          inData = true;
          reply("354 go ahead");
        } else if (verb === "QUIT") {
          reply("221 bye");
          socket.end();
        } else reply("250 ok");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("SMTP stub did not bind");
  return {
    host: "127.0.0.1",
    port: address.port,
    messages,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
