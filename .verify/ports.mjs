/** Refuse to run if a port is already taken — a leftover server from a previous
 *  run answers health checks and the test "passes" against someone else's DB. */

import { createServer } from "node:net";

export function bindPorts(ports) {
  return Promise.all(
    ports.map(
      (p) =>
        new Promise((res, rej) => {
          const s = createServer();
          s.once("error", (e) => rej(new Error(`port ${p} is busy (${e.code}) — free it before running`)));
          s.listen(p, "127.0.0.1", () => s.close(() => res(p)));
        })
    )
  );
}
