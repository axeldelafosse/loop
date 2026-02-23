import { connect } from "bun";

const PORT_PROBE_TIMEOUT_MS = 500;

export const isPortTaken = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), PORT_PROBE_TIMEOUT_MS);
    connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        open(sock) {
          clearTimeout(timer);
          sock.end();
          resolve(true);
        },
        data() {
          // probe only — no data expected
        },
        close() {
          // probe only — close is expected
        },
        error() {
          clearTimeout(timer);
          resolve(false);
        },
      },
    }).catch(() => {
      clearTimeout(timer);
      resolve(false);
    });
  });

export const findFreePort = async (
  basePort: number,
  range: number
): Promise<number> => {
  for (let port = basePort; port < basePort + range; port++) {
    if (!(await isPortTaken(port))) {
      return port;
    }
  }
  throw new Error(`no free port in range ${basePort}-${basePort + range}`);
};
