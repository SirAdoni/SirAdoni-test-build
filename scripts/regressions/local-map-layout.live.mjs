import assert from "node:assert/strict";

// Explicit opt-in: creates and removes only a uniquely named disposable chat.
if (process.env.MARINARA_TEST_BASE_URL !== "http://127.0.0.1:7860") throw new Error("Set MARINARA_TEST_BASE_URL to the local test server");
const base = process.env.MARINARA_TEST_BASE_URL + "/api";
const request = (path, method = "GET", body) => fetch(base + path, { method, headers: { "x-marinara-csrf": "1", ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const creation = await request("/chats", "POST", { name: "Disposable Local map layout regression " + Date.now(), mode: "game" });
assert.ok(creation.ok, await creation.clone().text());
const chat = await creation.json();
try {
  const map = { id: "fixture-local", type: "node", name: "Fixture", description: "Keep description", partyPosition: "a", nodes: [
    {id:"a",label:"Manor",emoji:"🏡",x:20,y:20,discovered:true,description:"Preserve room details"},
    {id:"b",label:"Secret room",emoji:"🚪",x:70,y:60,discovered:false},
  ], edges:[{from:"a",to:"b",label:"Hallway"}] };
  const metadata = await request(`/chats/${chat.id}/metadata`, "PATCH", { gameMap: map, gameMaps:[map], activeGameMapId:map.id });
  assert.ok(metadata.ok, await metadata.clone().text());
  const input = { chatId:chat.id, mapId:map.id, expectedMap:JSON.stringify(map), nodes:map.nodes.map(({id,x,y})=>({id,x:x-200,y:y+200})), edges:map.edges };
  const response = await request("/game/map/layout", "POST", input);
  assert.ok(response.ok, await response.clone().text());
  const result = await response.json();
  assert.equal(result.map.nodes[0].x,-180);
  assert.equal(result.map.nodes[0].y,220);
  assert.equal(result.map.nodes[0].description,"Preserve room details");
  assert.equal(result.map.nodes[1].discovered,false);
  assert.equal(result.map.partyPosition,"a");
  assert.equal((await request("/game/map/layout","POST",input)).status,409,"stale edits rejected");
  const invalid = await request("/game/map/layout","POST",{...input,expectedMap:JSON.stringify(result.map),edges:[{from:"a",to:"missing"}]});
  assert.ok(!invalid.ok,"unknown endpoints rejected");
  const reread = await (await request(`/chats/${chat.id}`)).json();
  const meta = typeof reread.metadata === "string" ? JSON.parse(reread.metadata) : reread.metadata;
  assert.deepEqual(meta.gameMap,result.map,"failed edits leave persisted map untouched");
  const spatialPath = `/chats/${chat.id}/spatial-context`;
  const spatialBefore = await (await request(spatialPath)).json();
  const worldDefinition = {schemaVersion:1,ownerMode:"game",enabled:false,revision:spatialBefore.definition?.revision ?? 0,startingLocationId:null,locations:[{id:"world-fixture",parentId:null,name:"Fixture world",kind:"region",description:"",childPresentation:"map",placement:{x:-200,y:250},lorebookEntryIds:[],links:[],status:"active",sortOrder:0}]};
  const worldSave = await request(spatialPath,"PUT",{expectedRevision:worldDefinition.revision,expectedCurrentLocationId:spatialBefore.currentLocationId ?? null,definition:worldDefinition});
  assert.ok(worldSave.ok,await worldSave.clone().text());
  const worldAfter=await (await request(spatialPath)).json();
  assert.deepEqual(worldAfter.definition.locations[0].placement,{x:-200,y:250},"World map coordinates also persist beyond original bounds");
  process.stdout.write("Local map API: placement persisted; room details, discovery and party preserved; stale/invalid edits rejected.\n");
} finally {
  const removed = await request(`/chats/${chat.id}`, "DELETE");
  assert.ok(removed.ok, "Disposable test chat cleanup failed: " + chat.id);
}
