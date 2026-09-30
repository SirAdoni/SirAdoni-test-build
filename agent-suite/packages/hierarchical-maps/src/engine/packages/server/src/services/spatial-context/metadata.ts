export const SPATIAL_AUTO_TRAVEL_NOW_METADATA_KEY = "spatialContextAutoTravelNowEnabled";

export function parseSpatialMetadata(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return parseSpatialMetadata(JSON.parse(value) as unknown);
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function readSpatialAutoTravelNowEnabled(value: unknown): boolean {
  return parseSpatialMetadata(value)[SPATIAL_AUTO_TRAVEL_NOW_METADATA_KEY] === true;
}
