// Playwright launches its web-server shell and force-cleanup taskkill without
// windowsHide. Cover both launch APIs, including dependency-owned callers.
if (process.platform === "win32") {
  const childProcess = require("node:child_process");
  for (const name of ["spawn", "spawnSync"]) {
    const original = childProcess[name];
    childProcess[name] = function (command, args, options) {
      if (Array.isArray(args)) {
        return original.call(this, command, args, { windowsHide: true, ...options });
      }
      return original.call(this, command, { windowsHide: true, ...args });
    };
  }
  require("node:module").syncBuiltinESMExports();
}
