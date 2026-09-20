// Compiles packages/client/src/styles/globals.css with the same Tailwind v4
// engine the Vite build uses (@tailwindcss/node + @tailwindcss/oxide), without
// running the client build and without touching any packages/*/dist folder.
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { repoRoot } from "./fixture-paths.mjs";

const clientRoot = path.join(repoRoot, "packages", "client");
const globalsCss = path.join(clientRoot, "src", "styles", "globals.css");

function resolveTailwindModules() {
  const clientRequire = createRequire(path.join(clientRoot, "package.json"));
  const viteRequire = createRequire(clientRequire.resolve("@tailwindcss/vite"));
  return {
    node: pathToFileURL(viteRequire.resolve("@tailwindcss/node")).href,
    oxide: pathToFileURL(viteRequire.resolve("@tailwindcss/oxide")).href,
  };
}

export async function buildClientCss(outFile) {
  const modules = resolveTailwindModules();
  const { compile, optimize } = await import(modules.node);
  const { Scanner } = await import(modules.oxide);
  const css = await fs.readFile(globalsCss, "utf8");
  const compiler = await compile(css, { base: path.dirname(globalsCss), onDependency: () => undefined });
  const root = compiler.root === "none" ? [] : compiler.root === null ? [{ base: clientRoot, pattern: "**/*", negated: false }] : [{ ...compiler.root, negated: false }];
  const scanner = new Scanner({ sources: root.concat(compiler.sources) });
  const output = optimize(compiler.build(scanner.scan()), { minify: false });
  await fs.mkdir(path.dirname(outFile), { recursive: true });
  await fs.writeFile(outFile, output.code);
  return outFile;
}
