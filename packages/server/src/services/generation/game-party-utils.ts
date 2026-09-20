import { buildStableGameNpcId } from "@marinara-engine/shared";

export function buildPartyNpcId(name: string): string {
  return buildStableGameNpcId(name);
}

export function isPartyNpcId(id: string): boolean {
  return id.startsWith("npc:");
}
