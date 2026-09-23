import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

for (const target of ["node_modules"]) {
  rmSync(resolve(repoRoot, target), { recursive: true, force: true });
}
