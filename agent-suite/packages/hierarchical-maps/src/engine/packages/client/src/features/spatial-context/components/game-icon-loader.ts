import index from "./game-icons-index.json";

export const gameIcons = new Map(index.map((icon) => [icon.id, icon]));
export interface GameIconGeometry {
  width: number;
  height: number;
  paths: string[];
}
const shards = new Map<string, Promise<Record<string, GameIconGeometry>>>();
export function loadGameIcon(id: string): Promise<GameIconGeometry> {
  const entry = gameIcons.get(id);
  if (!entry) return Promise.reject(new Error("Unknown icon"));
  let promise = shards.get(entry.shard);
  if (!promise) {
    promise = fetch(`/api/capability-packages/hierarchical-maps/assets/assets/icons/${entry.shard}`).then(
      async (response) => {
        if (!response.ok) throw new Error("Icon collection could not load");
        const data = (await response.json()) as Record<string, GameIconGeometry>;
        for (const [key, value] of Object.entries(data)) {
          if (
            gameIcons.get(key)?.shard !== entry.shard ||
            !Number.isFinite(value.width) ||
            value.width <= 0 ||
            value.width > 4096 ||
            !Number.isFinite(value.height) ||
            value.height <= 0 ||
            value.height > 4096 ||
            !Array.isArray(value.paths) ||
            !value.paths.length ||
            value.paths.length > 100 ||
            value.paths.some(
              (path) =>
                typeof path !== "string" || path.length > 100000 || !/^[MmZzLlHhVvCcSsQqTtAaEe\d\s.,+\-]+$/.test(path),
            )
          )
            throw new Error("Invalid icon geometry");
        }
        return data;
      },
    );
    shards.set(entry.shard, promise);
    void promise.catch(() => shards.delete(entry.shard));
  }
  return promise.then((data) => {
    if (!data[id]) throw new Error("Missing icon geometry");
    return data[id];
  });
}
