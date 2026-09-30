import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  diagnosticOwner,
  normalizeHostServerOptions,
  runCompiler,
  runPackageTypecheck,
  splitHostFiles,
  verifyBuildProof,
  verifyBuildProvenance,
} from "../typecheck-packages.mjs";

let fixture = null;

try {
  fixture = await mkdtemp(join(tmpdir(), "marinara-typecheck-launch-"));
  await writeFile(join(fixture, "missing-name.ts"), "const value = missingName;\n");
  const packageSource = "packages/client/src/feature.tsx";
  const packageFiles = new Set([packageSource]);
  assert.equal(
    diagnosticOwner(`${packageSource}(3,4): error TS2304: Cannot find name 'x'.`, fixture, packageFiles),
    "package-owned",
  );
  assert.equal(
    diagnosticOwner("packages/client/src/App.tsx(3,4): error TS2304: Cannot find name 'x'.", fixture, packageFiles),
    "inherited Engine",
  );
  assert.equal(
    diagnosticOwner("tc.json(1,4): error TS5090: Invalid compiler option.", fixture, packageFiles),
    "TypeScript configuration",
  );
  assert.equal(
    diagnosticOwner("package-shared.ts(5,15): error TS2877: Import path warning.", fixture, packageFiles),
    "package shared bridge",
  );
  assert.equal(
    diagnosticOwner("error TS2688: Cannot find type definition file.", fixture, packageFiles),
    "TypeScript configuration",
  );
  assert.deepEqual(
    splitHostFiles([
      "packages/client/src/feature.tsx",
      "packages/server/src/feature.ts",
      "packages/shared/src/feature.ts",
    ]),
    {
      client: ["packages/client/src/feature.tsx", "packages/shared/src/feature.ts"],
      server: ["packages/server/src/feature.ts", "packages/shared/src/feature.ts"],
    },
    "feature files must be checked with the corresponding production project options",
  );
  assert.deepEqual(
    normalizeHostServerOptions({
      rootDir: "./src",
      outDir: "./dist",
      composite: true,
      incremental: true,
      tsBuildInfoFile: "./tsconfig.tsbuildinfo",
      strict: true,
      noUncheckedIndexedAccess: true,
    }),
    { strict: true, noUncheckedIndexedAccess: true },
    "emit layout options must not be rebased against the temporary overlay",
  );

  assert.throws(
    () => runCompiler(join(fixture, "missing-executable"), [], fixture),
    /failed to launch or exited unexpectedly/u,
    "a missing compiler executable must fail closed",
  );
  assert.throws(
    () => runCompiler(process.execPath, ["-e", "process.exit(7)"], fixture),
    /failed to launch or exited unexpectedly/u,
    "a non-TypeScript subprocess failure must fail closed",
  );

  const oversizedFileList = Array(818).fill("missing-name.ts");
  const output = await runPackageTypecheck(fixture, oversizedFileList);
  assert.match(output, /error TS2304: Cannot find name 'missingName'/u);

  const graphRoot = join(fixture, "exact-graph");
  const graphFile = "packages/client/src/feature.tsx";
  const graphPath = join(graphRoot, graphFile);
  const graphText = "export type FeatureValue = string;\n";
  await mkdir(join(graphRoot, "packages/client/src"), { recursive: true });
  await writeFile(graphPath, graphText);
  const localeFile = "packages/client/src/locale.json";
  const localeText = "{}\n";
  await writeFile(join(graphRoot, localeFile), localeText);
  const sourceHash = createHash("sha256").update(graphText).digest("hex");
  const hostRoot = join(fixture, "host");
  const engineSourceRoot = join(fixture, "captured-engine");
  const packageSourceRoot = join(fixture, "package-source");
  const proof = {
    inputs: { [graphFile]: {} },
    buildProof: {
      featureId: "fixture",
      target: "client",
      engineRoot: hostRoot,
      sharedRoot: hostRoot,
      sourceRoot: engineSourceRoot,
      packageSourceRoot,
      sourceInputs: [
        { metafilePath: graphFile, relativePath: graphFile, sha256: sourceHash },
        {
          metafilePath: localeFile,
          relativePath: localeFile,
          sha256: createHash("sha256").update(localeText).digest("hex"),
        },
      ],
    },
  };
  proof.inputs["packages/client/src/locale.json"] = {};
  assert.deepEqual(await verifyBuildProof(proof, "fixture", "client", graphRoot), [
    graphFile.replaceAll("/", process.platform === "win32" ? "\\" : "/"),
  ]);
  assert.doesNotThrow(
    () => verifyBuildProvenance(proof, "fixture", hostRoot, engineSourceRoot, packageSourceRoot),
    "builder host, shared root and package source mode must match the requested graph",
  );
  assert.throws(
    () =>
      verifyBuildProvenance(
        { ...proof, buildProof: { ...proof.buildProof, sharedRoot: join(fixture, "other-host") } },
        "fixture",
        hostRoot,
        engineSourceRoot,
        packageSourceRoot,
      ),
    /host\/shared roots mismatch/u,
    "a proof from another shared SDK checkout must fail closed",
  );
  await assert.rejects(
    verifyBuildProof(
      {
        ...proof,
        buildProof: {
          ...proof.buildProof,
          sourceInputs: [{ ...proof.buildProof.sourceInputs[0], relativePath: graphPath }],
        },
      },
      "fixture",
      "client",
      graphRoot,
    ),
    /Malformed source receipt/u,
    "absolute receipts must not escape the reconstructed graph root",
  );
  await assert.rejects(
    verifyBuildProof(
      {
        ...proof,
        buildProof: {
          ...proof.buildProof,
          sourceInputs: [{ ...proof.buildProof.sourceInputs[0], relativePath: "../outside.ts" }],
        },
      },
      "fixture",
      "client",
      graphRoot,
    ),
    /Malformed source receipt/u,
    "parent path receipts must not escape the reconstructed graph root",
  );
  await assert.rejects(
    verifyBuildProof(
      {
        ...proof,
        buildProof: {
          ...proof.buildProof,
          sourceInputs: [{ ...proof.buildProof.sourceInputs[0], sha256: "f".repeat(64) }],
        },
      },
      "fixture",
      "client",
      graphRoot,
    ),
    /Stale build proof source hash/u,
    "a changed captured source must invalidate its build proof",
  );
  await assert.rejects(
    verifyBuildProof(proof, "other-package", "client", graphRoot),
    /identity mismatch/u,
    "source roots from another package must not enter the checked graph",
  );
} finally {
  if (fixture) await rm(fixture, { recursive: true, force: true });
}

console.log("Typecheck launch regression passed.");
