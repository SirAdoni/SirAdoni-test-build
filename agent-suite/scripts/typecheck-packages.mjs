/**
 * Typecheck package-owned sources against the Engine tree they are compiled into.
 *
 * The feature bundler is esbuild, which strips types without checking them. Four separate
 * defects reached production this way — a route that read a variable belonging to another
 * handler, a component prop that was used but never declared, a hook that was never
 * imported — each of which built clean, passed lint, and threw at runtime.
 *
 * This overlays a package's sources onto the vendored Engine sources exactly as the bundler
 * does. The default mode is a focused missing-name/export/syntax gate; opt-in current-host
 * mode resolves real dependencies and reports every TypeScript diagnostic.
 *
 * It also reports TS2307 for relative imports, so a moved or deleted package file cannot leave a
 * dangling import behind.
 *
 * Syntax diagnostics (TS1xxx) are reported unconditionally. TypeScript emits no semantic errors for
 * a file it could not parse, so without these a split panel with an unbalanced JSX fragment was
 * reported as clean while every undefined name in it went unmentioned. A syntax error is never
 * acceptable output, so this rule has no allowlist.
 *
 * ponytail: the default gate remains narrow for compatibility. Use current-host mode when a
 * complete diagnostic list is needed against an Engine checkout.
 */
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const engineSources = join(repoRoot, "sources/engine");
const tsc = join(repoRoot, "node_modules/typescript/bin/tsc");
// Node globals resolve through @types/node, which the merged tree does not install.
const IGNORED_NAMES = new Set(["setImmediate", "clearImmediate", "NodeJS"]);
// The missing-export family. TS2305 is the member that does not exist; TS2459 and TS2724 are the
// member that exists but was never exported; TS2300 is the same name bound twice. Each one
// typechecks nowhere and breaks the esbuild bundle, so the gate must name them here.
const CODES = /error (TS2304|TS2552): Cannot find name '([^']+)'|error (TS2305|TS2459|TS2724|TS2300): /;
const MISSING_MODULE = /^(.+?)\(\d+,\d+\): error TS2307: Cannot find module '(\.{1,2}\/[^']+)'/;
// A file that does not parse yields only TS1xxx, so these must never be filtered or allowlisted.
const SYNTAX = /error TS1\d{3}: /;
// Engine host files the bundler resolves from the real Engine checkout; sources/engine omits them.
const ENGINE_HOST_MODULES = new Set([
  "packages/client/src/components/chat/chat-area.types",
  "packages/client/src/hooks/use-gallery",
  "packages/client/src/lib/agent-failures",
  "packages/server/src/db/connection",
  "packages/server/src/services/prompt-overrides/types",
]);
const EXACT_TYPE_ONLY_SUPPORT_MODULES = [
  ...ENGINE_HOST_MODULES,
  "packages/shared/src/features/function-calls/tool-definitions",
].filter((modulePath) => modulePath !== "packages/server/src/db/connection");
const isReportedMissingModule = (line) => {
  const match = MISSING_MODULE.exec(line);
  if (!match) return false;
  const target = posix.join(dirname(match[1]), match[2]).replace(/\.js$/, "");
  return !ENGINE_HOST_MODULES.has(target);
};

export function runCompiler(executable, args, cwd) {
  try {
    return execFileSync(executable, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    const output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    const hasTypeScriptDiagnostics = /error TS\d{4,5}: /u.test(output);
    if (error.code || error.status !== 2 || !hasTypeScriptDiagnostics) {
      throw new Error(`TypeScript compiler failed to launch or exited unexpectedly: ${error.message}`, {
        cause: error,
      });
    }
    // tsc exits with status 2 when it reports diagnostics; the caller filters the known gate.
    return output;
  }
}

export async function runPackageTypecheck(overlay, files, compilerOptions = {}, compiler = tsc) {
  const configPath = join(overlay, "tc.json");
  await writeFile(
    configPath,
    JSON.stringify({
      compilerOptions: {
        noEmit: true,
        skipLibCheck: true,
        jsx: "react-jsx",
        target: "es2022",
        module: "esnext",
        moduleResolution: "bundler",
        ...compilerOptions,
      },
      files,
    }),
  );
  return runCompiler(process.execPath, [compiler, "-p", configPath], overlay);
}

async function findTypeScriptFiles(root, directory = root, files = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await findTypeScriptFiles(root, path, files);
    else if (entry.isFile() && /\.tsx?$/u.test(entry.name)) {
      files.push(relative(root, path).split(sep).join("/"));
    }
  }
  return files;
}

function parseArgs(args) {
  const packages = [];
  let currentHost = false;
  let engineRoot = process.env.MARINARA_ENGINE_ROOT;
  let sharedRoot = process.env.MARINARA_ENGINE_SHARED_ROOT;
  let buildProofRoot = process.env.MARINARA_FEATURE_METAFILE_DIR;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--current-host") currentHost = true;
    else if (arg === "--engine-root" || arg === "--shared-root" || arg === "--build-proof-root") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a path`);
      if (arg === "--engine-root") engineRoot = value;
      else if (arg === "--shared-root") sharedRoot = value;
      else buildProofRoot = value;
      currentHost = true;
      index += 1;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    } else packages.push(arg);
  }
  if (sharedRoot && !engineRoot) {
    const resolved = resolve(sharedRoot);
    engineRoot =
      basename(resolved) === "dist" && basename(dirname(resolved)) === "shared"
        ? resolve(resolved, "..", "..", "..")
        : basename(resolved) === "shared" && basename(dirname(resolved)) === "packages"
          ? resolve(resolved, "..", "..")
          : resolved;
  }
  return {
    packages: packages.length ? packages : ["slurp2"],
    currentHost,
    engineRoot: engineRoot ? resolve(engineRoot) : null,
    buildProofRoot: buildProofRoot ? resolve(buildProofRoot) : null,
  };
}

async function linkHostDependencies(overlay, hostRoot) {
  const links = [
    [join(hostRoot, "node_modules"), join(overlay, "node_modules")],
    [join(hostRoot, "packages/client/node_modules"), join(overlay, "packages/client/node_modules")],
    [join(hostRoot, "packages/server/node_modules"), join(overlay, "packages/server/node_modules")],
    [join(hostRoot, "packages/shared/node_modules"), join(overlay, "packages/shared/node_modules")],
  ];
  for (const [target, link] of links) {
    if (!existsSync(target)) continue;
    await mkdir(dirname(link), { recursive: true });
    await symlink(target, link, "junction");
  }
}

async function linkHostTypeOnlySupport(overlay, hostRoot, proofs) {
  const emitted = new Set(
    proofs.flatMap((proof) => proof.buildProof.sourceInputs.map((source) => source.relativePath.replaceAll("\\", "/"))),
  );
  const linked = [];
  for (const modulePath of EXACT_TYPE_ONLY_SUPPORT_MODULES) {
    if (modulePath === "packages/server/src/db/connection") continue;
    const candidates = [".ts", ".tsx", ".d.ts", ".mts", ".cts", ".js", ".jsx"].map(
      (extension) => `${modulePath}${extension}`,
    );
    const source = candidates.find((candidate) => existsSync(join(hostRoot, candidate)));
    if (!source || emitted.has(source)) continue;
    const target = join(hostRoot, source);
    const declaration = join(overlay, `${modulePath}.d.ts`);
    if (existsSync(join(overlay, source)) || existsSync(declaration)) continue;
    await mkdir(dirname(declaration), { recursive: true });
    const alias = `@marinara-engine/current-host-support/${modulePath}`;
    await writeFile(declaration, `export type * from ${JSON.stringify(alias)};\n`);
    linked.push({
      relativePath: source,
      declarationPath: relative(overlay, declaration).split(sep).join("/"),
      alias,
      hostModulePath: target,
      sha256: createHash("sha256")
        .update(await readFile(target))
        .digest("hex"),
    });
  }
  return linked;
}

export function diagnosticOwner(
  line,
  overlay,
  packageFiles,
  { capturedFiles = new Set(), hostRoot = null, engineSourcesRoot = null } = {},
) {
  const match = /^(.+?)\(\d+,\d+\): error TS\d{4,5}:/u.exec(line);
  if (!match) return "TypeScript configuration";
  const file = resolve(overlay, match[1]);
  const relativeFile = relative(overlay, file).split(sep).join("/");
  if (relativeFile === "tc.json") return "TypeScript configuration";
  if (relativeFile === "package-shared.ts") return "package shared bridge";
  if (relativeFile.endsWith("__exact-sdk-contract.typecheck.ts")) return "exact wrapper SDK harness";
  if (
    relativeFile.endsWith("fastify-package-augmentation.typecheck.d.ts") ||
    relativeFile.endsWith("connection.d.ts")
  ) {
    return "current-host type bridge";
  }
  if (EXACT_TYPE_ONLY_SUPPORT_MODULES.some((modulePath) => relativeFile === `${modulePath}.d.ts`)) {
    return "current-host type bridge";
  }
  if (packageFiles.has(relativeFile)) return "package-owned";
  if (file.includes(`${join("", "node_modules")}${process.platform === "win32" ? "\\" : "/"}`)) return "dependency";
  if (file.includes("marinara-current-shared")) return "package shared bridge";
  if (engineSourcesRoot && (file === engineSourcesRoot || file.startsWith(`${engineSourcesRoot}${sep}`)))
    return "captured Engine";
  if (capturedFiles.has(relativeFile)) return "captured Engine";
  if (hostRoot && (file === hostRoot || file.startsWith(`${hostRoot}${sep}`))) {
    if (file.startsWith(join(hostRoot, "packages/shared/dist") + sep)) return "current-host shared SDK";
    if (file.startsWith(join(hostRoot, "packages") + sep)) return "current-host support";
  }
  return "inherited Engine";
}

export function splitHostFiles(files) {
  const client = files.filter((file) => file.startsWith("packages/client/"));
  const server = files.filter((file) => file.startsWith("packages/server/"));
  const shared = files.filter((file) => file.startsWith("packages/shared/"));
  return { client: [...client, ...shared], server: [...server, ...shared] };
}

export function normalizeHostServerOptions(options) {
  const normalized = { ...options };
  delete normalized.rootDir;
  delete normalized.outDir;
  delete normalized.composite;
  delete normalized.incremental;
  delete normalized.tsBuildInfoFile;
  return normalized;
}

async function readCompilerOptions(path, typescript) {
  const loaded = typescript.readConfigFile(path, typescript.sys.readFile);
  if (loaded.error) {
    throw new Error(
      `Unable to read TypeScript config ${path}: ${typescript.flattenDiagnosticMessageText(loaded.error.messageText, "\\n")}`,
    );
  }
  const parsed = typescript.parseJsonConfigFileContent(loaded.config, typescript.sys, dirname(path), undefined, path);
  if (parsed.errors.length) {
    const messages = parsed.errors.map((error) => typescript.flattenDiagnosticMessageText(error.messageText, "\\n"));
    throw new Error(`Invalid TypeScript config ${path}: ${messages.join("\\n")}`);
  }
  const options = { ...parsed.options };
  delete options.configFilePath;
  delete options.pathsBasePath;
  for (const [name, values] of [
    ["target", typescript.ScriptTarget],
    ["module", typescript.ModuleKind],
    ["moduleResolution", typescript.ModuleResolutionKind],
    ["jsx", typescript.JsxEmit],
    ["newLine", typescript.NewLineKind],
  ]) {
    if (typeof options[name] === "number") options[name] = values[options[name]];
  }
  if (typeof options.jsx === "string") {
    options.jsx =
      {
        React: "react",
        ReactJSX: "react-jsx",
        ReactJSXDev: "react-jsxdev",
        ReactNative: "react-native",
        Preserve: "preserve",
      }[options.jsx] ?? options.jsx;
  }
  if (Array.isArray(options.lib)) {
    options.lib = options.lib.map((library) => basename(library, ".d.ts").replace(/^lib\./u, ""));
  }
  return options;
}

export async function verifyBuildProof(proof, id, target, overlay) {
  if (proof?.buildProof?.featureId !== id || proof.buildProof.target !== target) {
    throw new Error(`Build proof identity mismatch for ${id}.${target}`);
  }
  if (!proof.inputs || !Array.isArray(proof.buildProof.sourceInputs) || proof.buildProof.sourceInputs.length === 0) {
    throw new Error(`Build proof has no source inputs for ${id}.${target}`);
  }
  const inputs = new Set(Object.keys(proof.inputs));
  const roots = [];
  const seen = new Set();
  for (const source of proof.buildProof.sourceInputs) {
    const normalizedSourcePath =
      typeof source.relativePath === "string" ? source.relativePath.replaceAll("\\", "/") : "";
    if (
      !inputs.has(source.metafilePath) ||
      !normalizedSourcePath ||
      normalizedSourcePath.startsWith("/") ||
      /^[a-z]:/iu.test(normalizedSourcePath) ||
      normalizedSourcePath.split("/").includes("..") ||
      isAbsolute(source.relativePath) ||
      typeof source.relativePath !== "string" ||
      !/^[a-f\d]{64}$/u.test(source.sha256)
    ) {
      throw new Error(`Malformed source receipt in ${id}.${target}: ${source.relativePath ?? "<unknown>"}`);
    }
    const path = resolve(overlay, normalizedSourcePath);
    const rel = relative(overlay, path);
    if (isAbsolute(rel) || rel.startsWith(`..${sep}`) || rel === ".." || resolve(path) === resolve(overlay)) {
      throw new Error(`Build proof source escapes graph root: ${source.relativePath}`);
    }
    const actual = createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
    if (actual !== source.sha256)
      throw new Error(`Stale build proof source hash for ${id}.${target}: ${source.relativePath}`);
    if (/\.tsx?$/iu.test(source.relativePath) && !seen.has(source.relativePath)) {
      roots.push(source.relativePath.split("/").join(sep));
      seen.add(source.relativePath);
    }
  }
  if (roots.length === 0) throw new Error(`Build proof has no TypeScript roots for ${id}.${target}`);
  return roots;
}

function samePath(left, right) {
  return (
    typeof left === "string" &&
    typeof right === "string" &&
    resolve(left).toLowerCase() === resolve(right).toLowerCase()
  );
}

export function verifyBuildProvenance(proof, id, hostRoot, engineSourceRoot, packageSourceRoot) {
  const build = proof?.buildProof;
  if (!build || !samePath(build.engineRoot, hostRoot) || !samePath(build.sharedRoot, hostRoot)) {
    throw new Error(`Build proof host/shared roots mismatch for ${id}`);
  }
  if (!samePath(build.sourceRoot, engineSourceRoot)) {
    throw new Error(`Build proof source root mismatch for ${id}: ${build.sourceRoot ?? "<missing>"}`);
  }
  if (id !== "hierarchical-maps" && !samePath(build.packageSourceRoot, packageSourceRoot)) {
    throw new Error(`Build proof package source root mismatch for ${id}`);
  }
}

async function runCurrentHostTypecheck(id, overlay, hostRoot, packageSources, buildProofRoot) {
  const { createPackageSharedEntry } = await import("./package-shared-entry.mjs");
  const bridge = await createPackageSharedEntry(repoRoot, hostRoot);
  try {
    await linkHostDependencies(overlay, hostRoot);
    for (const packagePath of [
      "package.json",
      "packages/client/package.json",
      "packages/server/package.json",
      "packages/shared/package.json",
    ]) {
      const source = join(hostRoot, packagePath);
      if (existsSync(source)) await cp(source, join(overlay, packagePath), { force: true });
    }
    if (id === "noodle" || id === "slurp2") await cp(engineSources, overlay, { recursive: true, force: true });
    await cp(packageSources, overlay, { recursive: true, force: true });
    const clientProof = JSON.parse(await readFile(join(buildProofRoot, `${id}.client.json`), "utf8"));
    const serverProof = JSON.parse(await readFile(join(buildProofRoot, `${id}.server.json`), "utf8"));
    verifyBuildProvenance(clientProof, id, hostRoot, engineSources, packageSources);
    verifyBuildProvenance(serverProof, id, hostRoot, engineSources, packageSources);
    const linkedTypeSupport = await linkHostTypeOnlySupport(overlay, hostRoot, [clientProof, serverProof]);
    const clientFiles = await verifyBuildProof(clientProof, id, "client", overlay);
    const serverFiles = await verifyBuildProof(serverProof, id, "server", overlay);
    const bridgeSource = await readFile(bridge.entry, "utf8");
    const overlayBridge = join(overlay, "package-shared.ts");
    await writeFile(overlayBridge, bridgeSource);

    const hostTsc = join(hostRoot, "packages/client/node_modules/typescript/bin/tsc");
    const hostRequire = createRequire(join(hostRoot, "packages/client/package.json"));
    const hostTypeScript = hostRequire("typescript");
    const clientOptions = normalizeHostServerOptions(
      await readCompilerOptions(join(hostRoot, "packages/client/tsconfig.json"), hostTypeScript),
    );
    const serverOptions = normalizeHostServerOptions(
      await readCompilerOptions(join(hostRoot, "packages/server/tsconfig.json"), hostTypeScript),
    );
    const capabilityRuntime = join(
      hostRoot,
      "packages/server/src/services/capability-packages/capability-module-runtime.service.ts",
    );
    const capabilityRuntimeHash = createHash("sha256")
      .update(await readFile(capabilityRuntime))
      .digest("hex");
    const currentDbContract = join(hostRoot, "packages/server/src/db/connection.ts");
    const currentDbContractHash = createHash("sha256")
      .update(await readFile(currentDbContract))
      .digest("hex");
    const zodPackageJsonPath = join(hostRoot, "packages/shared/node_modules/zod/package.json");
    const zodPackage = JSON.parse(await readFile(zodPackageJsonPath, "utf8"));
    const zodTypesPath = resolve(dirname(zodPackageJsonPath), zodPackage.types ?? zodPackage.typings ?? "index.d.ts");
    const zodTypesHash = createHash("sha256")
      .update(await readFile(zodTypesPath))
      .digest("hex");
    const hostSupportPaths = Object.fromEntries(
      linkedTypeSupport.map(({ alias, hostModulePath }) => [alias, [hostModulePath]]),
    );
    const sharedOptions = {
      baseUrl: overlay,
      noEmit: true,
      // ponytail: noEmit runs do not need TypeScript's emit-only warning for absolute .ts bridge imports.
      rewriteRelativeImportExtensions: false,
      rootDirs: [join(engineSources, "packages/shared/src"), join(overlay, "packages/shared/src")],
      typeRoots: [
        join(hostRoot, "packages/client/node_modules/@types"),
        join(hostRoot, "packages/server/node_modules/@types"),
        join(hostRoot, "node_modules/@types"),
      ],
      // Match the builder's NODE_PATH visibility for the dependency installed in packages/shared.
      paths: { "@marinara-engine/shared": [overlayBridge], zod: [zodTypesPath], ...hostSupportPaths },
    };
    const outputs = [];
    const rawLogDirectory = await mkdtemp(join(tmpdir(), "marinara-exact-typecheck-"));
    const checkTarget = async (target, files, options) => {
      const output = await runPackageTypecheck(overlay, files, options, existsSync(hostTsc) ? hostTsc : tsc);
      const rawLogPath = join(rawLogDirectory, `${id}.${target}.log`);
      await writeFile(rawLogPath, output, { flag: "wx" });
      console.log(`${id}.${target}: full raw TypeScript output ${rawLogPath}`);
      outputs.push({ target, output });
    };
    const clientCheckOptions = {
      ...clientOptions,
      ...sharedOptions,
      allowImportingTsExtensions: true,
      types: ["node"],
      paths: { ...sharedOptions.paths, "@/*": ["packages/client/src/*"] },
    };
    const serverCheckOptions = {
      ...serverOptions,
      ...sharedOptions,
      paths: {
        ...sharedOptions.paths,
        "@marinara-engine/capability-activation-contract": [capabilityRuntime],
        "@marinara-engine/current-db-contract": [currentDbContract],
      },
      allowImportingTsExtensions: true,
      types: ["node"],
    };
    const builderRoots = { client: [...clientFiles], server: [...serverFiles] };
    if (clientFiles.length) {
      clientFiles.push(
        join(hostRoot, "packages/client/node_modules/vite/client.d.ts"),
        join(hostRoot, "packages/client/node_modules/vite-plugin-pwa/client.d.ts"),
      );
    }
    const hasServerFiles = serverFiles.length > 0;
    if (hasServerFiles) {
      const dbSource = join(overlay, "packages/server/src/db/connection.ts");
      const dbDeclaration = join(overlay, "packages/server/src/db/connection.d.ts");
      if (!existsSync(dbSource) && !existsSync(dbDeclaration)) {
        await mkdir(dirname(dbDeclaration), { recursive: true });
        await writeFile(dbDeclaration, 'export type { DB } from "@marinara-engine/current-db-contract";\n');
        serverFiles.push(relative(overlay, dbDeclaration).split(sep).join("/"));
      }
      const augmentation = join(overlay, "packages/server/src/db/fastify-package-augmentation.typecheck.d.ts");
      await writeFile(
        augmentation,
        'import type { DB } from "@marinara-engine/current-db-contract";\ndeclare module "fastify" { interface FastifyInstance { db: DB; } }\n',
      );
      serverFiles.push(relative(overlay, augmentation).split(sep).join("/"));
      const serverEntry =
        id === "noodle"
          ? "packages/server/src/services/noodle/server-entry.ts"
          : id === "slurp2"
            ? "packages/server/src/slp/slp-server-entry.ts"
            : null;
      if (serverEntry) {
        const harness = join(overlay, "packages/server/src/__exact-sdk-contract.typecheck.ts");
        const entryImport = `./${relative(dirname(harness), join(overlay, serverEntry)).split(sep).join("/").replace(/\.ts$/u, ".js")}`;
        await writeFile(
          harness,
          `import type { CapabilityActivationContext } from "@marinara-engine/capability-activation-contract";\n` +
            `import { activate, selfCheck } from ${JSON.stringify(entryImport)};\n` +
            `type Cleanup = () => void | Promise<void>;\n` +
            `const checkedActivate: (context: CapabilityActivationContext) => void | Cleanup | Promise<void | Cleanup> = activate;\n` +
            `const checkedSelfCheck: (context: CapabilityActivationContext) => void | Promise<void> = selfCheck;\n` +
            `void [checkedActivate, checkedSelfCheck];\n`,
        );
        serverFiles.push(relative(overlay, harness).split(sep).join("/"));
      }
    }
    const receiptPath = join(rawLogDirectory, `${id}.receipt.json`);
    await writeFile(
      receiptPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          packageId: id,
          hostRoot,
          sharedRoot: clientProof.buildProof.sharedRoot,
          sourceRoot: clientProof.buildProof.sourceRoot,
          sourceMode:
            id === "noodle" || id === "slurp2" ? "captured-sources-overlaid-by-package-source" : "package-source-only",
          inputs: {
            client: clientProof.buildProof.sourceInputs,
            server: serverProof.buildProof.sourceInputs,
          },
          roots: { builder: builderRoots, compiler: { client: clientFiles, server: serverFiles } },
          compilerOptions: { client: clientCheckOptions, server: serverCheckOptions },
          typeSupport: linkedTypeSupport,
          typeDependencies: {
            zod: {
              packageJsonPath: zodPackageJsonPath,
              version: zodPackage.version,
              declarationPath: zodTypesPath,
              declarationSha256: zodTypesHash,
            },
          },
          capabilityRuntimeSha256: capabilityRuntimeHash,
          currentDbContractSha256: currentDbContractHash,
        },
        null,
        2,
      )}\n`,
      { flag: "wx" },
    );
    console.log(`${id}: input and effective-options receipt ${receiptPath}`);
    if (clientFiles.length) await checkTarget("client", clientFiles, clientCheckOptions);
    if (hasServerFiles) await checkTarget("server", serverFiles, serverCheckOptions);
    const lines = outputs
      .map(({ output }) => output)
      .join("\n")
      .split("\n")
      .filter((line) => /error TS\d{4,5}:/u.test(line));
    if (lines.length) {
      console.error(`${id}: ${lines.length} current-host TypeScript diagnostic(s)`);
      console.error(`${id}: capability runtime SHA-256 ${capabilityRuntimeHash}`);
      const packageFiles = new Set(await findTypeScriptFiles(packageSources));
      const capturedFiles = new Set(
        [...clientProof.buildProof.sourceInputs, ...serverProof.buildProof.sourceInputs].map(
          (source) => source.relativePath,
        ),
      );
      for (const line of lines) {
        console.error(
          `  [${diagnosticOwner(line, overlay, packageFiles, { capturedFiles, hostRoot, engineSourcesRoot: engineSources })}] ${line}`,
        );
      }
      return false;
    }
    console.log(`${id}: capability runtime SHA-256 ${capabilityRuntimeHash}`);
    console.log(`${id}: no current-host TypeScript diagnostics`);
    return true;
  } finally {
    await bridge.cleanup();
  }
}

async function main() {
  const { packages, currentHost, engineRoot, buildProofRoot } = parseArgs(process.argv.slice(2));
  if (currentHost && !engineRoot) {
    throw new Error(
      "Current-host mode needs --engine-root PATH, --shared-root PATH, MARINARA_ENGINE_ROOT, or MARINARA_ENGINE_SHARED_ROOT",
    );
  }
  if (currentHost && !existsSync(join(engineRoot, "packages/shared/dist/index.d.ts"))) {
    throw new Error(
      `Current host has no built shared declarations at ${join(engineRoot, "packages/shared/dist/index.d.ts")}`,
    );
  }
  if (currentHost && !buildProofRoot)
    throw new Error("Current-host mode requires --build-proof-root PATH with retained exact builder proofs");
  if (currentHost && !existsSync(buildProofRoot))
    throw new Error(`Build proof directory does not exist: ${buildProofRoot}`);

  let failed = false;
  for (const id of packages) {
    const packageSources = join(repoRoot, `packages/${id}/src/engine`);
    if (!existsSync(packageSources)) throw new Error(`No package-owned source for ${id}`);

    const overlay = await mkdtemp(join(tmpdir(), `marinara-typecheck-${id}-`));
    try {
      if (!currentHost) await cp(engineSources, overlay, { recursive: true, force: true });
      const files = await findTypeScriptFiles(packageSources);

      if (currentHost) {
        if (!(await runCurrentHostTypecheck(id, overlay, engineRoot, packageSources, buildProofRoot))) failed = true;
        continue;
      }

      await cp(packageSources, overlay, { recursive: true, force: true });

      const output = await runPackageTypecheck(overlay, files);
      const lines = [...new Set(output.split("\n"))];
      const found = [
        ...lines.filter((line) => {
          if (!CODES.test(line)) return false;
          const match = CODES.exec(line);
          return !match?.[2] || !IGNORED_NAMES.has(match[2]);
        }),
        ...lines.filter(isReportedMissingModule),
        ...lines.filter((line) => SYNTAX.test(line)),
      ];
      if (found.length > 0) {
        failed = true;
        console.error(`${id}: ${found.length} syntax error(s), undefined name(s) or unresolved module(s)`);
        for (const line of found) console.error(`  ${line}`);
      } else {
        console.log(`${id}: no syntax errors, undefined names or unresolved modules`);
      }
    } finally {
      await rm(overlay, { recursive: true, force: true });
    }
  }
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
