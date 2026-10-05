export interface CampaignLineageChat {
  id: string;
  mode: string;
  groupId?: string | null;
  metadata: Record<string, unknown>;
  messageIds: readonly string[];
}

export interface CampaignLineageResolution {
  selectedChatId: string;
  gameId: string;
  status: "ready" | "held";
  sessions: Array<{ chatId: string; sessionNumber: number; branchPathChatIds: string[] }>;
  edges: Array<{ childChatId: string; parentChatId: string; kind: "branch" | "session"; verified: boolean }>;
  holds: Array<{ chatId: string; edge: "target" | "branch" | "session"; reason: string }>;
}

/** Resolve only explicitly persisted lineage; selected chat snapshots remain authoritative. */
export function resolveCampaignLineage(
  gameId: string,
  selectedChatId: string,
  chats: readonly CampaignLineageChat[],
): CampaignLineageResolution {
  const byId = new Map(chats.map((chat) => [chat.id, chat]));
  const result: CampaignLineageResolution = {
    selectedChatId,
    gameId,
    status: "ready",
    sessions: [],
    edges: [],
    holds: [],
  };
  const hold = (chatId: string, edge: "target" | "branch" | "session", reason: string) => {
    result.status = "held";
    result.holds.push({ chatId, edge, reason });
  };
  const validGameChat = (chat: CampaignLineageChat | undefined): chat is CampaignLineageChat => {
    if (!chat || chat.mode !== "game") return false;
    if (chat.groupId != null && chat.groupId !== gameId) return false;
    const metadataGameId = chat.metadata.gameId;
    return metadataGameId === undefined ? chat.groupId === gameId : metadataGameId === gameId;
  };
  const target = byId.get(selectedChatId);
  if (!validGameChat(target)) {
    hold(selectedChatId, "target", target ? "selected chat is not in the requested game" : "selected chat is missing");
    return result;
  }

  let leafId = selectedChatId;
  const visitedRoots = new Set<string>();
  while (result.status === "ready") {
    let child = byId.get(leafId)!;
    const branchPathLeafFirst: string[] = [];
    const visitedBranches = new Set<string>();
    while (true) {
      if (visitedBranches.has(child.id)) {
        hold(child.id, "branch", "branch cycle detected");
        break;
      }
      visitedBranches.add(child.id);
      branchPathLeafFirst.push(child.id);
      const meta = child.metadata;
      const parentId = meta.branchParentChatId;
      const hasBranchAnchors = meta.branchParentMessageId != null || meta.branchMessageId != null;
      if (typeof parentId !== "string" || !parentId) {
        if (
          hasBranchAnchors ||
          meta.branchLineageVersion !== undefined ||
          meta.branchCopyMode !== undefined ||
          meta.branchCopiedMessageCount !== undefined
        ) {
          hold(child.id, "branch", "branch metadata has no source chat");
        }
        break;
      }
      const parent = byId.get(parentId);
      const parentNumber = parent?.metadata.gameSessionNumber;
      if (!validGameChat(parent)) {
        result.edges.push({ childChatId: child.id, parentChatId: parentId, kind: "branch", verified: false });
        hold(child.id, "branch", "source chat is missing or belongs to another game");
        break;
      }
      const childNumber = meta.gameSessionNumber;
      if (!Number.isInteger(childNumber) || childNumber !== parentNumber) {
        result.edges.push({ childChatId: child.id, parentChatId: parent.id, kind: "branch", verified: false });
        hold(child.id, "branch", "branch source is not in the same game session");
        break;
      }

      const sourceId = meta.branchParentMessageId;
      const copiedId = meta.branchMessageId;
      const version = meta.branchLineageVersion;
      let anchorsValid = typeof sourceId === "string" && typeof copiedId === "string";
      if (version === 1) {
        const count = meta.branchCopiedMessageCount;
        const mode = meta.branchCopyMode;
        const emptyPrefix = mode === "full-prefix" && count === 0 && sourceId == null && copiedId == null;
        anchorsValid =
          emptyPrefix ||
          ((mode === "full-prefix" || mode === "through-message") &&
            Number.isInteger(count) &&
            Number(count) > 0 &&
            typeof sourceId === "string" &&
            typeof copiedId === "string");
      } else if (
        version !== undefined ||
        meta.branchCopyMode !== undefined ||
        meta.branchCopiedMessageCount !== undefined
      ) {
        anchorsValid = false;
      }
      if (
        !anchorsValid ||
        (sourceId != null && !parent.messageIds.includes(String(sourceId))) ||
        (copiedId != null && !child.messageIds.includes(String(copiedId)))
      ) {
        result.edges.push({ childChatId: child.id, parentChatId: parent.id, kind: "branch", verified: false });
        hold(child.id, "branch", "copy mode, copied count, or source/copy anchor is invalid or stale");
        break;
      }
      result.edges.push({ childChatId: child.id, parentChatId: parent.id, kind: "branch", verified: true });
      child = parent;
    }
    if (result.status !== "ready") break;

    const root = child;
    const sessionNumber = root.metadata.gameSessionNumber;
    if (!Number.isInteger(sessionNumber) || Number(sessionNumber) < 1 || visitedRoots.has(root.id)) {
      hold(root.id, "session", "session number is invalid or session lineage contains a cycle");
      break;
    }
    visitedRoots.add(root.id);
    result.sessions.push({
      chatId: leafId,
      sessionNumber: Number(sessionNumber),
      branchPathChatIds: branchPathLeafFirst.reverse(),
    });
    const parentId = root.metadata.gameSessionParentChatId;
    if (sessionNumber === 1) {
      if (parentId != null) hold(root.id, "session", "first session unexpectedly names a predecessor");
      break;
    }
    if (typeof parentId !== "string" || !parentId) {
      hold(root.id, "session", "required predecessor is missing");
      break;
    }
    const parent = byId.get(parentId);
    if (!validGameChat(parent) || parent.metadata.gameSessionNumber !== Number(sessionNumber) - 1) {
      result.edges.push({ childChatId: root.id, parentChatId: parentId, kind: "session", verified: false });
      hold(root.id, "session", "predecessor is missing, stale, or not the immediately prior session");
      break;
    }
    result.edges.push({ childChatId: root.id, parentChatId: parent.id, kind: "session", verified: true });
    leafId = parent.id;
  }
  if (result.status === "ready") result.sessions.reverse();
  return result;
}
