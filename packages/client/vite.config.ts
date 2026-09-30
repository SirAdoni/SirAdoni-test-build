import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import { execFileSync } from "node:child_process";
import path from "path";

const ENABLE_SOURCE_MAPS = process.env.VITE_ENABLE_SOURCEMAP === "true";
const PWA_DISABLED = Boolean(process.env.SKIP_PWA);
const DEV_SERVER_PORT = Number.parseInt(process.env.VITE_PORT ?? "5173", 10);
const DEV_SERVER_HOST = process.env.VITE_HOST?.trim() || undefined;
const DEV_SERVER_OPEN = process.env.VITE_OPEN_BROWSER !== "false" && process.env.AUTO_OPEN_BROWSER !== "false";
const BUILD_COMMIT_LENGTH = 12;

function normalizeBuildCommit(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, BUILD_COMMIT_LENGTH) : null;
}

function resolveBuildCommit() {
  const environmentCommit =
    normalizeBuildCommit(process.env.MARINARA_GIT_COMMIT) ??
    normalizeBuildCommit(process.env.GITHUB_SHA) ??
    normalizeBuildCommit(process.env.BUILD_COMMIT);
  if (environmentCommit) return environmentCommit;

  try {
    return normalizeBuildCommit(
      execFileSync("git", ["rev-parse", `--short=${BUILD_COMMIT_LENGTH}`, "HEAD"], {
        cwd: path.resolve(__dirname, "../.."),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }),
    );
  } catch {
    return null;
  }
}

const BUILD_COMMIT = resolveBuildCommit();

function manualChunks(id: string) {
  id = id.replace(/\\/gu, "/");
  if (id.endsWith("/components/game/FloatingGamePanel.tsx")) return "game-floating-panels";
  if (id.endsWith("/components/game/game-narration-format.ts")) return "game-narration-format";
  if (id.endsWith("/components/game/GameNarrationVisuals.tsx")) return "game-narration-visuals";
  if (id.endsWith("/lib/game-tag-parser.ts")) return "game-tag-parser";
  if (id.endsWith("/schemas/ruleset.schema.js")) return "ruleset-schema";
  if (/\/packages\/shared\/dist\/utils\/(?:game-inventory-(?:tags|ops|stacks)|inventory-command-tag)\.js$/u.test(id))
    return "game-inventory-contract";
  // The inventory screen grows with every kind of item a ruleset can describe, so it is its own chunk
  // rather than weight on GameSurface's budget.
  if (id.endsWith("/components/game/GameInventory.tsx") || id.endsWith("/components/game/RulesetItemPicker.tsx"))
    return "game-inventory";
  // So is the book the inventory reads a ruleset's items through, and the items the Game Master
  // invents, rather than weight on the game tag parser's chunk, which takes the rest of the shared code.
  if (/\/shared\/(?:dist|src)\/features\/rulesets\/(?:item-book|invented-items)\.(?:js|ts)$/u.test(id))
    return "ruleset-items";

  const nodeModulesIndex = id.lastIndexOf("/node_modules/");
  if (nodeModulesIndex < 0) return undefined;

  // Standard pnpm paths carry peer metadata in the .pnpm locator. Custom virtual stores
  // use <package@semver_peers>/node_modules/<package>; retain that locator only when it
  // matches the installed package and its version/peer shape. Plain npm paths normalize
  // at node_modules, so arbitrary checkout names cannot affect package chunk routing.
  const pnpmIndex = id.indexOf("/.pnpm/");
  if (pnpmIndex >= 0) {
    id = id.slice(pnpmIndex);
  } else {
    const prefixSegments = id.slice(0, nodeModulesIndex).split("/");
    const locator = prefixSegments.at(-1) ?? "";
    const afterNodeModules = id.slice(nodeModulesIndex + "/node_modules/".length);
    const installedParts = afterNodeModules.split("/");
    const installedName = installedParts[0]?.startsWith("@")
      ? installedParts.slice(0, 2).join("/")
      : (installedParts[0] ?? "");
    const locatorSeparator = locator.indexOf("@", locator.startsWith("@") ? 1 : 0);
    const locatorName = locatorSeparator > 0 ? locator.slice(0, locatorSeparator).replace(/\+/gu, "/") : "";
    const locatorVersionAndPeers = locatorSeparator > 0 ? locator.slice(locatorSeparator + 1) : "";
    const isCustomPeerStore =
      locatorName === installedName &&
      /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?_.+/u.test(locatorVersionAndPeers);
    id = isCustomPeerStore ? "/" + locator + "/node_modules/" + afterNodeModules : id.slice(nodeModulesIndex);
  }

  // Keep dynamically selected Lucide glyphs in small alphabetical chunks
  // instead of pulling the complete icon catalog into one eager vendor file.
  const lucideIcon = id.match(/lucide-react\/dist\/esm\/icons\/([^/]+)\.js$/u);
  if (lucideIcon) return `vendor-icons-${lucideIcon[1]?.[0] ?? "misc"}`;
  if (id.includes("lucide-react")) return "vendor-icons";
  if (id.includes("react") || id.includes("scheduler")) return "vendor-react";
  if (id.includes("@tanstack")) return "vendor-tanstack";
  if (id.includes("framer-motion")) return "vendor-motion";
  if (id.includes("zustand")) return "vendor-state";
  if (id.includes("dompurify") || id.includes("sonner")) return "vendor-ui";

  return "vendor-misc";
}

function bundleBudget(): Plugin {
  return {
    name: "bundle-budget",
    generateBundle(_options, bundle) {
      const chunks = Object.values(bundle)
        .filter((item): item is import("rollup").OutputChunk => item.type === "chunk")
        .map((chunk) => ({
          fileName: chunk.fileName,
          sizeKb: Buffer.byteLength(chunk.code, "utf8") / 1024,
          isEntry: chunk.isEntry,
        }))
        .sort((a, b) => b.sizeKb - a.sizeKb);

      const lines = chunks.slice(0, 10).map((chunk) => {
        const label = chunk.isEntry ? "entry" : "chunk";
        return `  - ${chunk.fileName} (${label}, ${chunk.sizeKb.toFixed(2)} kB)`;
      });
      if (lines.length > 0) {
        console.log(["[bundle] Largest JS chunks:", ...lines].join("\n"));
      }

      const oversizedEntries = chunks.filter((chunk) => chunk.isEntry && chunk.sizeKb > 1000);
      if (oversizedEntries.length > 0) {
        this.error(
          `Main eager bundle exceeded 1000 kB: ${oversizedEntries
            .map((chunk) => `${chunk.fileName} (${chunk.sizeKb.toFixed(2)} kB)`)
            .join(", ")}`,
        );
      }

      // Keep lazy feature chunks below the 500 KiB bundle limit. Game narration's
      // reusable HTML formatter has its own boundary so GameSurface does not absorb it.
      const oversizedChunks = chunks.filter((chunk) => chunk.sizeKb > 500);
      if (oversizedChunks.length > 0) {
        this.error(
          `Chunk size warning budget exceeded: ${oversizedChunks
            .map((chunk) => `${chunk.fileName} (${chunk.sizeKb.toFixed(2)} kB)`)
            .join(", ")}`,
        );
      }
    },
  };
}

/** Stub for virtual:pwa-register when the real PWA plugin is skipped (e.g. Termux). */
function pwaStub(): Plugin {
  const id = "virtual:pwa-register";
  const resolved = "\0" + id;
  return {
    name: "pwa-stub",
    resolveId(source) {
      if (source === id) return resolved;
    },
    load(loadedId) {
      if (loadedId === resolved) return "export function registerSW() { return () => {}; }";
    },
  };
}

export default defineConfig({
  define: {
    __MARINARA_BUILD_COMMIT__: JSON.stringify(BUILD_COMMIT),
  },
  plugins: [
    react({
      babel: {
        // Keep Babel from auto-compacting large components and printing a noisy
        // 500 kB deoptimisation warning during local development and UI tests.
        generatorOpts: process.env.NODE_ENV === "production" ? undefined : { compact: false },
      },
    }),
    tailwindcss(),
    bundleBudget(),
    !PWA_DISABLED
      ? VitePWA({
          injectRegister: false,
          registerType: "prompt",
          devOptions: { enabled: false },
          manifest: false, // We use the static manifest.json in public/
          workbox: {
            importScripts: ["notification-events.js"],
            // Intentionally exclude html so index.html is not precached and does not interfere with the PWA stale-version/update flow.
            globPatterns: ["**/*.{js,css,json,png,svg,ico,woff2}"],
            navigateFallback: null,
            // Keep the offline shell lean. Large decorative sprites and splash art are fetched on demand.
            globIgnores: ["**/sprites/**", "logo.png", "logo-splash.gif"],
            navigateFallbackAllowlist: [],
            runtimeCaching: [
              {
                urlPattern: ({ url }: { url: URL }) => url.pathname.startsWith("/api/"),
                handler: "NetworkOnly",
              },
            ],
          },
        })
      : pwaStub(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    host: DEV_SERVER_HOST,
    port: Number.isFinite(DEV_SERVER_PORT) ? DEV_SERVER_PORT : 5173,
    open: DEV_SERVER_OPEN,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${process.env.PORT ?? 7860}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    manifest: true,
    target: "es2020",
    cssTarget: "safari14",
    // Vite reports decimal kB; 512 kB matches the bundle plugin's enforced 500 KiB ceiling.
    chunkSizeWarningLimit: 512,
    sourcemap: ENABLE_SOURCE_MAPS,
    rollupOptions: {
      output: {
        manualChunks,
      },
    },
  },
  esbuild: {
    // Strip debug console.log in production; keep warn/error
    pure: process.env.NODE_ENV === "production" ? ["console.log"] : [],
  },
});
