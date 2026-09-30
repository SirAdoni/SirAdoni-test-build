import { realpathSync } from "node:fs";

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const clientRoot = path.join(repoRoot, "packages", "client");
const requireClient = createRequire(path.join(clientRoot, "package.json"));
const { loadConfigFromFile } = requireClient("vite");

// Loading the real config is enough to exercise Rollup's actual manualChunks callback;
// supplying a commit avoids its normal Git fallback, and PWA stays disabled.
process.env.MARINARA_GIT_COMMIT = "regression-fixture";
process.env.SKIP_PWA = "1";
const loaded = await loadConfigFromFile(
  { command: "build", mode: "test" },
  path.join(clientRoot, "vite.config.ts"),
  clientRoot,
  "silent",
);
assert.ok(loaded, "Vite config loads");
const manualChunks = loaded.config.build?.rollupOptions?.output?.manualChunks;
assert.equal(typeof manualChunks, "function", "the configured callback is available");

assert.equal(
  manualChunks("/repo/node_modules/.pnpm/ui-widget@2.1.0_react@19.3.0/node_modules/ui-widget/index.js"),
  "vendor-react",
  "standard pnpm peer metadata groups the consumer with React",
);
assert.equal(
  manualChunks(
    "C:\\cache\\packages\\ui-widget@2.1.0_react@19.3.0\\node_modules\\ui-widget\\index.js",
  ),
  "vendor-react",
  "custom Windows virtual-store peer metadata groups the consumer with React",
);
const virtualStoreRoot = "C:\\cache\\packages\\";
const peerLocators = [
  [
    "zustand@5.0.15_@types+react@19.3.0_react@19.3.0_38dfb6a8184ad95904ac5eb3ad079881",
    "zustand",
  ],
  [
    "framer-motion@13.3.0_react-dom@19.3.0_react@19.3.0__react@19.3.0",
    "framer-motion",
  ],
  [
    "sonner@2.0.8_@types+react@19.3.0_react-dom@19.3.0_react@19.3.0__react@19.3.0",
    "sonner",
  ],
];

for (const [locator, packageName] of peerLocators) {
  const installedPackagePath = realpathSync(path.join(clientRoot, "node_modules", packageName));
  assert.equal(
    manualChunks(path.join(installedPackagePath, "index.js")),
    "vendor-react",
    packageName + " routes its installed realpath with React peers to vendor-react",
  );

  assert.equal(
    manualChunks("C:/cache/packages/" + locator + "/node_modules/" + packageName + "/index.js"),
    "vendor-react",
    packageName + " retains hashed peers under an arbitrary virtual-store root",
  );

  assert.equal(
    manualChunks(virtualStoreRoot + locator + "\\node_modules\\" + packageName + "\\index.js"),
    "vendor-react",
    packageName + " keeps hashed React peer metadata in the custom virtual store",
  );
  assert.equal(
    manualChunks("/repo/node_modules/.pnpm/" + locator + "/node_modules/" + packageName + "/index.js"),
    "vendor-react",
    packageName + " keeps the equivalent standard pnpm peer metadata",
  );
}

assert.equal(
  manualChunks("C:/cache/packages/ui-widget@2.1.0-beta.1+build.5_react@19.3.0/node_modules/ui-widget/index.js"),
  "vendor-react",
  "custom-store locators retain prerelease and build version metadata",
);

assert.equal(
  manualChunks("C:/cache/packages/@scope+ui-widget@3.4.5_react@19.3.0/node_modules/@scope/ui-widget/index.js"),
  "vendor-react",
  "scoped custom-store package locators normalize to their installed package name",
);

assert.equal(
  manualChunks("/repo/node_modules/react/index.js"),
  "vendor-react",
  "plain npm React paths retain their React chunk",
);
assert.equal(
  manualChunks("/repo/node_modules/ui-widget/index.js"),
  "vendor-misc",
  "plain npm paths keep ordinary packages in the misc vendor chunk",
);

assert.equal(
  manualChunks("C:\\repo\\react-checkout\\packages\\client\\node_modules\\ui-widget\\index.js"),
  "vendor-misc",
  "Windows npm paths do not infer React from checkout names",
);
assert.equal(
  manualChunks("/repo/node_modules/parent/node_modules/ui-widget/index.js"),
  "vendor-misc",
  "plain nested npm installs normalize at their innermost node_modules",
);
assert.equal(
  manualChunks(
    "/repo/react-checkout@2026.09_react@19.3.0/node_modules/ui-widget/index.js",
  ),
  "vendor-misc",
  "versioned checkout names cannot donate peer metadata to a different installed package",
);
assert.equal(
  manualChunks("C:\\repo\\react-checkout\\packages\\client\\src\\index.ts"),
  undefined,
  "React in a checkout name does not route source files to vendor-react",
);
assert.equal(
  manualChunks(
    "/repo/node_modules/.pnpm/lucide-react@0.468.0_react@19.3.0/node_modules/lucide-react/dist/esm/icons/alarm-clock.js",
  ),
  "vendor-icons-a",
  "alphabetized Lucide icon chunks remain intact",
);
assert.equal(
  manualChunks("C:\\repo\\packages\\client\\src\\components\\game\\FloatingGamePanel.tsx"),
  "game-floating-panels",
  "Windows game source paths retain their dedicated chunk",
);

process.stdout.write("vite-manual-chunks regression passed\n");
