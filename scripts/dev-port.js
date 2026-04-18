import { createServer } from "node:net";

export async function findAvailablePort(preferredPort, host = "127.0.0.1") {
  if (preferredPort === 0) {
    return 0;
  }

  let port = preferredPort;
  for (;;) {
    const available = await new Promise((resolve) => {
      const server = createServer();

      server.once("error", () => {
        resolve(false);
      });

      server.listen(port, host, () => {
        server.close(() => resolve(true));
      });
    });

    if (available) {
      return port;
    }
    port += 1;
  }
}
