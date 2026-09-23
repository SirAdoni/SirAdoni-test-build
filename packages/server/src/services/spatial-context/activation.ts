export function isHierarchicalMapsEnabledForChat(chatMetadata: unknown): boolean {
  let metadata = chatMetadata;
  if (typeof metadata === "string") {
    try {
      metadata = JSON.parse(metadata);
    } catch {
      return false;
    }
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  const record = metadata as Record<string, unknown>;
  return (
    record.enableAgents === true &&
    Array.isArray(record.activeAgentIds) &&
    record.activeAgentIds.includes("hierarchical-maps")
  );
}
