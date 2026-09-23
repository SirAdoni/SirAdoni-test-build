import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type SharedModule = typeof import("../../../packages/shared/dist/index.js");

/**
 * Load the exact `@marinara-engine/shared` module instance that server source resolves.
 *
 * Registries such as BUILT_IN_AGENTS are module-level state. Importing `packages/shared/dist` by relative path gives
 * a second instance whenever the server's `node_modules/@marinara-engine/shared` link points elsewhere (a worktree
 * linked to another checkout's install, for example), and fixtures seeded into that copy are invisible to the server.
 */
export async function importServerShared(): Promise<SharedModule> {
  const serverRoot = fileURLToPath(new URL("../../../packages/server/", import.meta.url));
  const packageRoot = realpathSync(join(serverRoot, "node_modules", "@marinara-engine", "shared"));
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
    main?: string;
    exports?: { ".": { import?: string } };
  };
  const entry = manifest.exports?.["."]?.import ?? manifest.main ?? "./dist/index.js";
  return (await import(pathToFileURL(join(packageRoot, entry)).href)) as SharedModule;
}
