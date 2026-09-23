import { createServer } from "node:net";

const rawPort = process.env.PORT ?? "7860";
const port = Number.parseInt(rawPort, 10);
const host = process.env.HOST ?? "0.0.0.0";
const protocol = process.env.SSL_CERT && process.env.SSL_KEY ? "https" : "http";
const browserHost = host === "" || host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
const urlHost = browserHost.includes(":") && !browserHost.startsWith("[") ? `[${browserHost}]` : browserHost;
const browserUrl = `${protocol}://${urlHost}:${rawPort}`;

const HEALTH_PROBE_TIMEOUT_MS = 1_500;
const HEALTH_RETRY_TIMEOUT_MS = 5_000;

async function findRunningMarinara(timeoutMs = HEALTH_PROBE_TIMEOUT_MS) {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetch(`${browserUrl}/api/health`, {
      signal,
    });
    if (!response.ok) return { health: null, timedOut: false };
    const health = await response.json();
    if (
      !health ||
      typeof health !== "object" ||
      health.status !== "ok" ||
      typeof health.version !== "string" ||
      typeof health.build !== "string"
    ) {
      return { health: null, timedOut: false };
    }
    return { health, timedOut: false };
  } catch {
    return { health: null, timedOut: signal.aborted };
  }
}

function printPortBusyMessage(unresponsive = false) {
  console.error("");
  console.error(`  [ERROR] Port ${rawPort} is already in use.`);
  if (unresponsive) {
    console.error("  The service on that port accepted a connection but did not answer Marinara's health check.");
    console.error("  It may be a stalled Marinara Engine or another local service.");
    console.error("  Close or restart it, or start Marinara on another port:");
  } else {
    console.error(
      "  Marinara Engine did not start, and the browser was not opened to avoid showing another local service.",
    );
    console.error("  Close the app using that port or start Marinara on another port:");
  }
  console.error("");
  console.error("    macOS/Linux:       PORT=7869 bash ./start.sh");
  console.error("    Windows PowerShell: $env:PORT=7869; .\\start.bat");
  console.error("    Windows cmd:        set PORT=7869 && start.bat");
  console.error("");
}

if (!Number.isFinite(port) || port <= 0 || port > 65_535) {
  console.error("");
  console.error(`  [ERROR] PORT must be a number from 1 to 65535. Received: ${rawPort}`);
  console.error("");
  process.exitCode = 1;
} else {
  const firstProbe = await findRunningMarinara();
  if (firstProbe.health) {
    console.log(`  [OK] Marinara Engine ${firstProbe.health.build} is already running at ${browserUrl}`);
    // Let Node drain fetch/Undici handles before exiting. A forced process.exit() can trip a
    // libuv UV_HANDLE_CLOSING assertion on Windows and incorrectly return success to start.bat.
    process.exitCode = 2;
  } else {
    const server = createServer();

    server.once("error", async (err) => {
      if (err && typeof err === "object" && "code" in err && err.code === "EADDRINUSE") {
        if (firstProbe.timedOut) {
          const retryProbe = await findRunningMarinara(HEALTH_RETRY_TIMEOUT_MS);
          if (retryProbe.health) {
            console.log(`  [OK] Marinara Engine ${retryProbe.health.build} is already running at ${browserUrl}`);
            process.exitCode = 2;
            return;
          }
          printPortBusyMessage(retryProbe.timedOut);
        } else {
          printPortBusyMessage();
        }
      } else {
        console.error("");
        console.error(`  [ERROR] Could not check whether ${host}:${rawPort} is available.`);
        console.error(err);
        console.error("");
      }
      process.exitCode = 1;
    });

    server.listen({ host, port }, () => {
      server.close((error) => {
        if (error) {
          console.error(error);
          process.exitCode = 1;
        }
      });
    });
  }
}
