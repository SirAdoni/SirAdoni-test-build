// Vite serves the actual client component graph and Tailwind stylesheet for
// this fixture; all API requests are answered locally below.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.dirname(fileURLToPath(import.meta.url));
const client = path.resolve(root, "../../../packages/client");
const shared = path.resolve(root, "../../../packages/shared/src");
const requireClient = createRequire(path.join(client, "package.json"));
const { createServer } = requireClient("vite");
const react = requireClient("@vitejs/plugin-react").default;
const tailwindcss = requireClient("@tailwindcss/vite").default;
const vite = await createServer({
  configFile: false,
  root,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      { find: "@marinara-engine/shared", replacement: shared },
      { find: "@", replacement: path.join(client, "src") },
      { find: "@tanstack/react-query", replacement: requireClient.resolve("@tanstack/react-query") },
      { find: "react-dom/client", replacement: requireClient.resolve("react-dom/client") },
      { find: "react-dom", replacement: requireClient.resolve("react-dom") },
      { find: "react/jsx-dev-runtime", replacement: requireClient.resolve("react/jsx-dev-runtime") },
      { find: "react/jsx-runtime", replacement: requireClient.resolve("react/jsx-runtime") },
      { find: "react", replacement: requireClient.resolve("react") },
    ],
  },
  define: { "import.meta.env.VITE_MARINARA_LITE": "false" },
  server: { host: "127.0.0.1", port: 0, strictPort: true, open: false },
});
vite.middlewares.use((req, res, next) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (!url.pathname.startsWith("/api/")) return next();
  res.setHeader("Content-Type", "application/json");
  if (url.pathname.startsWith("/api/family-tree/")) {
    res.end(JSON.stringify({ people: [], links: [] }));
    return;
  }
  res.end(JSON.stringify({ items: [], nextCursor: null }));
});
await vite.listen();
const address = vite.httpServer.address();
console.log(`FAMILY_TREE_FIXTURE_READY:${JSON.stringify({ base: `http://127.0.0.1:${address.port}` })}`);
process.on("SIGTERM", () => void vite.close().then(() => process.exit(0)));
