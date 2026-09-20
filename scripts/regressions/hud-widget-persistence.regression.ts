import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = mkdtempSync(join(tmpdir(), "marinara-widgets-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");
process.env.NODE_ENV = "test";
process.env.MARINARA_LITE = "true";
const { buildApp } = await import("../../packages/server/src/app.js");
const app = await buildApp();
try {
  await app.ready();
  const created = await app.inject({
    method: "POST",
    url: "/api/chats",
    payload: { name: "Widget proof", mode: "game", characterIds: [] },
  });
  assert.equal(created.statusCode, 200);
  const id = created.json().id;
  const widgets = Array.from({ length: 150 }, (_, i) => ({
    id: `widget_${i}`,
    type: "counter",
    label: `Widget ${i}`,
    position: "hud_left",
    config: { count: i },
  }));
  const save = await app.inject({ method: "PUT", url: `/api/game/${id}/widgets`, payload: { widgets } });
  assert.equal(save.statusCode, 200, save.body);
  let chat = (await app.inject({ method: "GET", url: `/api/chats/${id}` })).json();
  let meta = typeof chat.metadata === "string" ? JSON.parse(chat.metadata) : chat.metadata;
  assert.deepEqual(meta.gameWidgetState, widgets);
  const clear = await app.inject({ method: "PUT", url: `/api/game/${id}/widgets`, payload: { widgets: [] } });
  assert.equal(clear.statusCode, 200);
  chat = (await app.inject({ method: "GET", url: `/api/chats/${id}` })).json();
  meta = typeof chat.metadata === "string" ? JSON.parse(chat.metadata) : chat.metadata;
  assert.equal(meta.gameWidgetState.length, 0);
  assert.equal(meta.enableCustomWidgets, true, "removing the last display does not disable dynamic widgets");
  const malformed = await app.inject({
    method: "PUT",
    url: `/api/game/${id}/widgets`,
    payload: { widgets: [{ ...widgets[0], type: "arbitrary_code" }] },
  });
  assert.equal(malformed.statusCode, 400, "widget shape validation remains enforced");
  console.log("HUD persistence accepts 150 widgets, retains dynamic mode at zero, and rejects invalid widget types.");
} finally {
  await app.close();
  const { closeDB } = await import("../../packages/server/src/db/connection.js");
  await closeDB();
  rmSync(root, { recursive: true, force: true });
}
