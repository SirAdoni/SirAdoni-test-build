// Spawns a fixture server script and resolves once it prints its JSON
// `{ port, ... }` line. Windows kills the whole process tree on stop.
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";

const START_TIMEOUT_MS = 180_000;

export function startFixtureServer(script, { env = {}, nodeArgs = [] } = {}) {
  const server = spawn(process.execPath, [...nodeArgs, script], { cwd: path.dirname(script), env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let stderr = "";
  server.stderr.on("data", (chunk) => { stderr += chunk.toString(); process.stderr.write(chunk); });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`fixture server ${path.basename(script)} did not start within ${START_TIMEOUT_MS / 1000}s`)), START_TIMEOUT_MS);
    let buffer = "";
    server.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/u);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        try { const info = JSON.parse(line); if (info && typeof info.port === "number") { clearTimeout(timer); resolve({ base: `http://127.0.0.1:${info.port}`, info }); } }
        catch { process.stdout.write(`${line}\n`); }
      }
    });
    server.once("error", (error) => { clearTimeout(timer); reject(error); });
    server.once("exit", (code) => { clearTimeout(timer); reject(new Error(`fixture server ${path.basename(script)} exited ${code}: ${stderr}`)); });
  });
  return { server, ready };
}

export function stopFixtureServer(server) {
  return new Promise((resolve) => {
    if (!server?.pid || server.exitCode !== null) return resolve();
    server.once("exit", () => resolve());
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(server.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
    else server.kill("SIGTERM");
    setTimeout(() => { try { server.kill("SIGKILL"); } catch {} resolve(); }, 5000).unref();
  });
}
