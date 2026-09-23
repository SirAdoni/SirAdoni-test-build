// ──────────────────────────────────────────────
// Panel: Lorebooks (overhauled)
// Category tabs, search, click-to-edit, AI generate
// ──────────────────────────────────────────────
import {
  useState,
  useMemo,
  useCallback,
  useEffect,
  useRef,
  type ChangeEvent,
  type DragEvent,
  type ReactNode,
  type TouchEvent,
} from "react";
import { toast } from "sonner";
import {
  Plus,
  Copy,
  Download,
  Check,
  BookOpen,
  Search,
  UserRound,
  ArrowUpDown,
  Tag,
  ChevronDown,
  ChevronUp,
  Folder,
  FolderPlus,
  Swords,
  X,
  Trash2,
  Camera,
} from "lucide-react";
import { useUIStore, type LorebookPanelCategory, type LorebookPanelSort } from "../../stores/ui.store";
import { sortPanelFolders } from "../../lib/panel-sort";
import { useChatStore } from "../../stores/chat.store";
import {
  fetchAllLorebookPages,
  flattenLorebookPages,
  useLorebookPages,
  useCreateLorebook,
  useDeleteLorebook,
  useUpdateLorebook,
  useUploadLorebookImage,
  type LorebookListItem,
} from "../../hooks/use-lorebooks";
import type { Lorebook, LorebookCategory, LorebookEntry, LorebookFolder } from "@marinara-engine/shared";
import { confirmNonEmptyFolderDelete, showConfirmDialog } from "../../lib/app-dialogs";
import { cn } from "../../lib/utils";
import { api } from "../../lib/api-client";
import { getChatCharacterIds } from "../../lib/chat-macros";
import { buildLorebookDuplicateInput } from "../../lib/lorebook-duplicate";
import {
  getNextUnnamedLibraryFolderName,
  useCreateLibraryFolder,
  useDeleteLibraryFolder,
  useLibraryFolders,
  useMoveLibraryItem,
  useUpdateLibraryFolder,
} from "../../hooks/use-library-folders";
import { useTouchFolderDrag } from "../../hooks/use-touch-folder-drag";
import { SelectionActionBar } from "../ui/SelectionActionBar";
import { TouchDragHandle } from "../ui/TouchDragHandle";
import { buildLibraryFolderView, type LibraryFolderNode } from "../../lib/library-folder-view";
import { CAMPAIGN_FILTER_ALL, LibraryCampaignBar } from "./library/LibraryCampaignBar";
import { LibraryCampaignBadges } from "./library/LibraryCampaignBadges";
import { LibraryCampaignSections } from "./library/LibraryCampaignSections";
import { LibraryFolderTree } from "./library/LibraryFolderTree";
import { LibrarySelectionExtraActions } from "./library/LibrarySelectionExtraActions";
import { useAutoLoadAllPages } from "./library/use-auto-load-all-pages";
import { useLibraryOrganizer } from "./library/use-library-organizer";
import { useLorebookFolderToggle } from "./library/use-lorebook-folder-toggle";
import { useLocalizedUiText } from "../../localization/use-localized-ui-text";
import { useTranslation as useUiTranslation } from "react-i18next";
import { PanelLoadMoreBar } from "./PanelLoadMoreBar";
import { clearActiveChatResourceDrag, writeChatResourceDragPayload } from "../../lib/chat-resource-drag";
import { ChatResourceActionButton } from "../chat/ChatResourceActionButton";

const CATEGORIES: Array<{ id: LorebookCategory | "all" | "active"; label: string }> = [
  { id: "all", label: "All" },
  { id: "active", label: "Active" },
  { id: "world", label: "World" },
  { id: "character", label: "Character" },
  { id: "npc", label: "NPC" },
  { id: "spellbook", label: "Spellbook" },
  { id: "uncategorized", label: "Other" },
];
const PRIMARY_CATEGORIES = CATEGORIES.filter((category) => category.id === "all" || category.id === "active");
const TAGGED_CATEGORIES = CATEGORIES.filter((category) => category.id !== "all" && category.id !== "active");

const CATEGORY_COLORS: Record<string, string> = {
  world: "from-amber-400 to-orange-500",
  character: "from-amber-400 to-orange-500",
  npc: "from-amber-400 to-orange-500",
  spellbook: "from-amber-400 to-orange-500",
  uncategorized: "from-amber-400 to-orange-500",
  all: "from-amber-400 to-orange-500",
};

function usePanelMobileOverlay() {
  const [isMobileOverlay, setIsMobileOverlay] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia("(max-width: 767px)").matches : false,
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const query = window.matchMedia("(max-width: 767px)");
    const update = () => setIsMobileOverlay(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return isMobileOverlay;
}

function remapLorebookEntryRelationships(
  relationships: Record<string, string> | null | undefined,
  entryIdMap: Map<string, string>,
) {
  const remapped: Record<string, string> = {};
  if (!relationships) return remapped;

  for (const [sourceEntryId, relationshipType] of Object.entries(relationships)) {
    const clonedEntryId = entryIdMap.get(sourceEntryId);
    if (clonedEntryId) remapped[clonedEntryId] = relationshipType;
  }

  return remapped;
}

export function LorebooksPanel() {
  const { t: localizeUi } = useUiTranslation();
  const localize = useLocalizedUiText();
  const activeCategory = useUIStore((s) => s.lorebookPanelCategory);
  const setActiveCategory = useUIStore((s) => s.setLorebookPanelCategory);
  const searchQuery = useUIStore((s) => s.lorebookPanelSearch);
  const setSearchQuery = useUIStore((s) => s.setLorebookPanelSearch);
  const sort = useUIStore((s) => s.lorebookPanelSort);
  const setSort = useUIStore((s) => s.setLorebookPanelSort);
  const activeTag = useUIStore((s) => s.lorebookPanelActiveTag);
  const setActiveTag = useUIStore((s) => s.setLorebookPanelActiveTag);
  const tagsExpanded = useUIStore((s) => s.lorebookPanelTagsExpanded);
  const setTagsExpanded = useUIStore((s) => s.setLorebookPanelTagsExpanded);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedLorebookIds, setSelectedLorebookIds] = useState<Set<string>>(new Set());
  const [exportingSelected, setExportingSelected] = useState(false);
  const isMobileOverlay = usePanelMobileOverlay();
  const [draggedLorebookId, setDraggedLorebookId] = useState<string | null>(null);
  const lorebookImageInputRef = useRef<HTMLInputElement>(null);
  const imageTargetLorebookIdRef = useRef<string | null>(null);
  const suppressLorebookClickRef = useRef(false);
  const organizer = useLibraryOrganizer("lorebooks", "lorebook");

  // Active chat context for the "Active" filter
  const activeChat = useChatStore((s) => s.activeChat);
  const activeChatMetadata = activeChat?.metadata;
  const activeLorebookIds: string[] = useMemo(() => {
    if (!activeChatMetadata) return [];
    try {
      const meta = typeof activeChatMetadata === "string" ? JSON.parse(activeChatMetadata) : activeChatMetadata;
      return Array.isArray(meta.activeLorebookIds) ? meta.activeLorebookIds : [];
    } catch {
      return [];
    }
  }, [activeChatMetadata]);
  const activeCharacterIds = useMemo(() => getChatCharacterIds(activeChat), [activeChat]);
  const activePersonaId = activeChat?.personaId ?? null;
  const activeChatId = activeChat?.id ?? null;

  const lorebookPages = useLorebookPages({
    category: activeCategory === "active" || activeCategory === "all" ? undefined : activeCategory,
    search: searchQuery,
    sort,
    campaign: organizer.serverCampaignParam,
    campaignRevision: organizer.serverCampaignRevision,
    active:
      activeCategory === "active"
        ? {
            lorebookIds: activeLorebookIds,
            characterIds: activeCharacterIds,
            personaId: activePersonaId,
            chatId: activeChatId,
          }
        : undefined,
  });
  const lorebooks = useMemo(() => flattenLorebookPages(lorebookPages.data), [lorebookPages.data]);
  const isLoading = lorebookPages.isLoading;
  const createLorebook = useCreateLorebook();
  const deleteLorebook = useDeleteLorebook();
  const updateLorebook = useUpdateLorebook();
  const uploadLorebookImage = useUploadLorebookImage();
  const { data: lorebookFolders = [] } = useLibraryFolders("lorebooks");
  const createLorebookFolder = useCreateLibraryFolder("lorebooks");
  const updateLorebookFolder = useUpdateLibraryFolder("lorebooks");
  const deleteLorebookFolder = useDeleteLibraryFolder("lorebooks");
  const moveLorebookItem = useMoveLibraryItem("lorebooks");
  const openModal = useUIStore((s) => s.openModal);
  const openLorebookDetail = useUIStore((s) => s.openLorebookDetail);

  const getCharacterNames = useCallback((lb: LorebookListItem) => {
    if (Array.isArray(lb.characterNames) && lb.characterNames.length > 0) return lb.characterNames;
    const ids =
      Array.isArray(lb.characterIds) && lb.characterIds.length > 0
        ? lb.characterIds
        : lb.characterId
          ? [lb.characterId]
          : [];
    return ids;
  }, []);
  const getPersonaNames = useCallback((lb: LorebookListItem) => {
    if (Array.isArray(lb.personaNames) && lb.personaNames.length > 0) return lb.personaNames;
    const ids =
      Array.isArray(lb.personaIds) && lb.personaIds.length > 0 ? lb.personaIds : lb.personaId ? [lb.personaId] : [];
    return ids;
  }, []);

  const parseTags = (lb: Lorebook): string[] => {
    const raw = lb.tags;
    if (Array.isArray(raw)) return raw;
    if (typeof raw === "string")
      try {
        return JSON.parse(raw);
      } catch {
        return [];
      }
    return [];
  };

  const allTags = useMemo(() => {
    if (!lorebooks) return [] as string[];
    const tagSet = new Set<string>();
    for (const lb of lorebooks as Lorebook[]) {
      for (const t of parseTags(lb)) tagSet.add(t);
    }
    return Array.from(tagSet).sort();
  }, [lorebooks]);
  const categoryTagActive = activeCategory !== "all" && activeCategory !== "active";
  const tagFilterActive = categoryTagActive || !!activeTag;

  const handleDeleteTag = useCallback(
    async (tag: string) => {
      if (
        !(await showConfirmDialog({
          title: localizeUi("ui.panels.characterspanel.removeTag"),
          message: localizeUi("ui.panels.lorebookspanel.removeTagValue1FromAllLorebooks", { value1: tag }),
          confirmLabel: localizeUi("settings.notifications.customSound.actions.remove"),
          tone: "destructive",
        }))
      ) {
        return;
      }
      try {
        const allLorebooks = await fetchAllLorebookPages({ sort });
        const affected = allLorebooks.filter((lb) => parseTags(lb).includes(tag));
        for (const lb of affected) {
          const newTags = parseTags(lb).filter((t) => t !== tag);
          await updateLorebook.mutateAsync({ id: lb.id, tags: newTags });
        }
        if (activeTag === tag) setActiveTag(null);
      } catch {
        toast.error(localizeUi("ui.panels.lorebookspanel.failedToRemoveTagFromSomeLorebooks"));
      }
    },
    [sort, updateLorebook, activeTag, setActiveTag, localizeUi],
  );

  // Filter by search
  const filtered = useMemo(() => {
    if (!lorebooks) return [];
    let list = lorebooks as LorebookListItem[];
    // "Active" filter: show lorebooks active in the current chat
    // Mirrors server-side filterRelevantLorebooks: global + pinned + character-linked + persona-linked + chat-scoped
    if (activeCategory === "active") {
      list = list.filter(
        (lb) =>
          lb.enabled &&
          (lb.isGlobal ||
            activeLorebookIds.includes(lb.id) ||
            (Array.isArray(lb.characterIds) && lb.characterIds.some((id) => activeCharacterIds.includes(id))) ||
            (lb.characterId && activeCharacterIds.includes(lb.characterId)) ||
            (Array.isArray(lb.personaIds) && lb.personaIds.includes(activePersonaId ?? "")) ||
            (lb.personaId && lb.personaId === activePersonaId) ||
            (lb.chatId && lb.chatId === activeChatId)),
      );
    }
    if (activeTag) {
      list = list.filter((lb) => parseTags(lb).includes(activeTag));
    }
    if (!searchQuery) return list;
    const q = searchQuery.toLowerCase();
    return list.filter(
      (lb: LorebookListItem) =>
        lb.name.toLowerCase().includes(q) ||
        lb.description.toLowerCase().includes(q) ||
        getCharacterNames(lb).some((name) => name.toLowerCase().includes(q)) ||
        getPersonaNames(lb).some((name) => name.toLowerCase().includes(q)) ||
        parseTags(lb).some((t) => t.toLowerCase().includes(q)),
    );
  }, [
    lorebooks,
    activeCategory,
    activeLorebookIds,
    activeCharacterIds,
    activePersonaId,
    activeChatId,
    searchQuery,
    activeTag,
    getCharacterNames,
    getPersonaNames,
  ]);

  const sorted = useMemo(() => {
    const list = [...filtered];
    switch (sort) {
      case "name-asc":
        return list.sort((a, b) => a.name.localeCompare(b.name));
      case "name-desc":
        return list.sort((a, b) => b.name.localeCompare(a.name));
      case "newest":
        return list.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
      case "oldest":
        return list.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
      case "tokens":
        return list.sort((a, b) => (b.tokenBudget ?? 0) - (a.tokenBudget ?? 0));
      default:
        return list;
    }
  }, [filtered, sort]);

  const lorebookById = useMemo(() => new Map(sorted.map((lorebook) => [lorebook.id, lorebook])), [sorted]);
  const lorebookOrder = useMemo(
    () => new Map(sorted.map((lorebook, index) => [lorebook.id, index])),
    [sorted],
  );
  const sortedFolders = useMemo(() => {
    const folders = sortPanelFolders(lorebookFolders, sort === "tokens" ? "name-asc" : sort);
    if (sort !== "tokens") return folders;
    const tokens = new Map(sorted.map((lorebook) => [lorebook.id, lorebook.tokenBudget ?? 0]));
    const totals = new Map(
      folders.map((folder) => [folder.id, folder.itemIds.reduce((total, id) => total + (tokens.get(id) ?? 0), 0)]),
    );
    return folders.sort((a, b) => totals.get(b.id)! - totals.get(a.id)!);
  }, [lorebookFolders, sort, sorted]);
  const folderFilterActive =
    searchQuery.trim().length > 0 ||
    activeCategory !== "all" ||
    activeTag !== null ||
    organizer.campaignFilter !== CAMPAIGN_FILTER_ALL;

  const folderNodes = useMemo<LibraryFolderNode[]>(
    () =>
      sortedFolders.map((folder) => ({
        id: folder.id,
        name: folder.name,
        parentId: folder.parentId ?? null,
        // Members follow the panel's sort; ids not loaded or filtered out keep their stored order at the end.
        itemIds: [...folder.itemIds].sort(
          (a, b) => (lorebookOrder.get(a) ?? sorted.length) - (lorebookOrder.get(b) ?? sorted.length),
        ),
      })),
    [sortedFolders, lorebookOrder, sorted.length],
  );
  const folderToggle = useLorebookFolderToggle(folderNodes, lorebooks);
  const folderView = useMemo(
    () => buildLibraryFolderView(folderNodes, (id) => lorebookById.has(id), folderFilterActive),
    [folderNodes, lorebookById, folderFilterActive],
  );
  const folderedLorebookIds = folderView.folderedItemIds;
  const showFolderPaths = searchQuery.trim().length > 0;
  // Tags are matched in the browser, and folders list members by id, so grouping by campaign,
  // a tag filter, the full tag list and folders holding unloaded lorebooks need every page.
  const folderMembersMissing = useMemo(() => {
    if (!lorebookPages.hasNextPage) return false;
    const loaded = new Set(lorebooks.map((lorebook) => lorebook.id));
    return lorebookFolders.some((folder) => folder.itemIds.some((id) => !loaded.has(id)));
  }, [lorebookFolders, lorebookPages.hasNextPage, lorebooks]);
  useAutoLoadAllPages(
    lorebookPages,
    (organizer.groupByCampaign || !!activeTag || tagsExpanded || folderMembersMissing) &&
      !lorebookPages.isFetchNextPageError,
  );

  const rootLorebooks = useMemo(
    () => sorted.filter((lorebook) => !folderedLorebookIds.has(lorebook.id)),
    [sorted, folderedLorebookIds],
  );

  // Group by category for "all" view
  const grouped = useMemo(() => {
    if (activeCategory !== "all") return null;
    const map = new Map<string, LorebookListItem[]>();
    for (const lb of rootLorebooks) {
      const cat = lb.category || "uncategorized";
      const list = map.get(cat) ?? [];
      list.push(lb);
      map.set(cat, list);
    }
    return map;
  }, [rootLorebooks, activeCategory]);

  const exitSelectionMode = useCallback(() => {
    setSelectionMode(false);
    setSelectedLorebookIds(new Set());
  }, []);

  const toggleSelection = useCallback((lorebookId: string) => {
    setSelectedLorebookIds((prev) => {
      const next = new Set(prev);
      if (next.has(lorebookId)) next.delete(lorebookId);
      else next.add(lorebookId);
      return next;
    });
  }, []);

  const handleExportSelected = useCallback(async () => {
    if (selectedLorebookIds.size === 0) return;
    setExportingSelected(true);
    try {
      await api.downloadPost(
        "/lorebooks/export-bulk",
        { ids: [...selectedLorebookIds], format: "native" },
        "marinara-lorebooks.zip",
      );
      toast.success(
        localizeUi("ui.panels.lorebookspanel.exportedValue1LorebookValue2", {
          value1: selectedLorebookIds.size,
          value2: selectedLorebookIds.size === 1 ? "" : localizeUi("ui.noodle.stageprofileview.s"),
        }),
      );
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : localizeUi("ui.panels.lorebookspanel.failedToExportLorebooks"),
      );
    } finally {
      setExportingSelected(false);
    }
  }, [selectedLorebookIds, localizeUi]);

  const handleDeleteSelected = useCallback(async () => {
    const ids = [...selectedLorebookIds];
    if (ids.length === 0) return;

    if (
      !(await showConfirmDialog({
        title: localizeUi("ui.panels.lorebookspanel.deleteLorebooks"),
        message: localizeUi("ui.panels.lorebookspanel.deleteValue1LorebookValue2AllEntriesInsideThemWill", {
          value1: ids.length,
          value2: ids.length === 1 ? "" : localizeUi("ui.noodle.stageprofileview.s"),
        }),
        confirmLabel: localizeUi("lorebook.editor.batch.delete"),
        tone: "destructive",
      }))
    ) {
      return;
    }

    const results = await Promise.allSettled(ids.map((id) => deleteLorebook.mutateAsync(id)));
    const failedIds = ids.filter((_, index) => results[index]?.status === "rejected");
    const deletedCount = ids.length - failedIds.length;

    if (deletedCount > 0) {
      toast.success(
        localizeUi("ui.panels.lorebookspanel.deletedValue1LorebookValue2", {
          value1: deletedCount,
          value2: deletedCount === 1 ? "" : localizeUi("ui.noodle.stageprofileview.s"),
        }),
      );
    }

    if (failedIds.length > 0) {
      setSelectedLorebookIds(new Set(failedIds));
      toast.error(
        localizeUi("ui.panels.lorebookspanel.failedToDeleteValue1LorebookValue2", {
          value1: failedIds.length,
          value2: failedIds.length === 1 ? "" : localizeUi("ui.noodle.stageprofileview.s"),
        }),
      );
      return;
    }

    exitSelectionMode();
  }, [selectedLorebookIds, deleteLorebook, exitSelectionMode, localizeUi]);

  const handlePickLorebookImage = useCallback((lorebookId: string) => {
    imageTargetLorebookIdRef.current = lorebookId;
    if (lorebookImageInputRef.current) {
      lorebookImageInputRef.current.value = "";
      lorebookImageInputRef.current.click();
    }
  }, []);

  const handleDuplicateLorebook = useCallback(
    async (lorebook: Lorebook) => {
      try {
        const [folders, entries] = await Promise.all([
          api.get<LorebookFolder[]>(`/lorebooks/${lorebook.id}/folders`),
          api.get<LorebookEntry[]>(`/lorebooks/${lorebook.id}/entries`),
        ]);
        const created = await createLorebook.mutateAsync(buildLorebookDuplicateInput(lorebook));
        const createdId = created.id;
        const folderIdMap = new Map<string, string>();
        const pendingFolders = [...folders].sort((a, b) => a.order - b.order);

        while (pendingFolders.length > 0) {
          let createdInPass = false;
          for (let index = pendingFolders.length - 1; index >= 0; index--) {
            const folder = pendingFolders[index];
            const parentFolderId = folder.parentFolderId ? folderIdMap.get(folder.parentFolderId) : null;
            if (folder.parentFolderId && !parentFolderId) continue;

            const createdFolder = await api.post<LorebookFolder>(`/lorebooks/${createdId}/folders`, {
              name: folder.name,
              enabled: folder.enabled,
              parentFolderId,
              order: folder.order,
            });
            folderIdMap.set(folder.id, createdFolder.id);
            pendingFolders.splice(index, 1);
            createdInPass = true;
          }

          if (!createdInPass) throw new Error("Could not copy lorebook folders");
        }

        if (entries.length > 0) {
          const clonedEntries = entries.map((entry) => {
            const clone: Partial<LorebookEntry> = { ...entry };
            delete clone.id;
            delete clone.lorebookId;
            delete clone.createdAt;
            delete clone.updatedAt;
            delete clone.embedding;
            clone.folderId = entry.folderId ? (folderIdMap.get(entry.folderId) ?? null) : null;
            clone.relationships = {};
            return clone;
          });

          const createdEntries = await api.post<LorebookEntry[]>(`/lorebooks/${createdId}/entries/bulk`, {
            entries: clonedEntries,
          });

          const entryIdMap = new Map<string, string>();
          entries.forEach((entry, index) => {
            const createdEntry = createdEntries[index];
            if (createdEntry) entryIdMap.set(entry.id, createdEntry.id);
          });

          const relationshipUpdates = entries
            .map((entry, index) => {
              const createdEntry = createdEntries[index];
              if (!createdEntry) return null;

              const relationships = remapLorebookEntryRelationships(entry.relationships, entryIdMap);
              if (Object.keys(relationships).length === 0) return null;

              return api.patch<LorebookEntry>(`/lorebooks/${createdId}/entries/${createdEntry.id}`, { relationships });
            })
            .filter((update): update is Promise<LorebookEntry> => Boolean(update));

          await Promise.all(relationshipUpdates);
        }

        toast.success(localizeUi("ui.panels.agentspanel.copiedValue1", { value1: lorebook.name }));
        openLorebookDetail(createdId);
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : localizeUi("ui.panels.lorebookspanel.failedToCopyLorebook"),
        );
      }
    },
    [createLorebook, openLorebookDetail, localizeUi],
  );

  const handleLorebookImageSelected = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      const lorebookId = imageTargetLorebookIdRef.current;
      if (!file || !lorebookId) return;

      if (!file.type.startsWith("image/")) {
        imageTargetLorebookIdRef.current = null;
        toast.error(localizeUi("ui.panels.lorebookspanel.chooseAnImageFileForTheLorebookPicture"));
        return;
      }

      const reader = new FileReader();
      reader.onload = async () => {
        const image = typeof reader.result === "string" ? reader.result : "";
        if (!image) {
          toast.error(localizeUi("ui.panels.agentspanel.couldNotReadThatImage"));
          return;
        }

        try {
          await uploadLorebookImage.mutateAsync({ id: lorebookId, image });
          toast.success(localizeUi("ui.panels.lorebookspanel.lorebookPictureUpdated"));
        } catch (error) {
          toast.error(
            error instanceof Error
              ? error.message
              : localizeUi("ui.panels.lorebookspanel.failedToUploadLorebookPicture"),
          );
        } finally {
          imageTargetLorebookIdRef.current = null;
        }
      };
      reader.onerror = () => {
        imageTargetLorebookIdRef.current = null;
        toast.error(localizeUi("ui.panels.agentspanel.couldNotReadThatImage"));
      };
      reader.readAsDataURL(file);
    },
    [uploadLorebookImage, localizeUi],
  );

  const { setFolderExpanded, openMovePicker } = organizer;
  const showFolderError = useCallback(
    (error: unknown) =>
      toast.error(error instanceof Error ? error.message : localizeUi("ui.panels.libraryorganize.couldNotMoveFolder")),
    [localizeUi],
  );

  const handleCreateFolder = useCallback(
    (parentId: string | null = null) => {
      createLorebookFolder.mutate(
        { name: getNextUnnamedLibraryFolderName(lorebookFolders), parentId },
        {
          onSuccess: (folder) => {
            if (parentId) setFolderExpanded(parentId, true);
            setFolderExpanded(folder.id, true);
          },
          onError: showFolderError,
        },
      );
    },
    [createLorebookFolder, lorebookFolders, setFolderExpanded, showFolderError],
  );

  const handleRenameFolder = useCallback(
    (folderId: string, name: string) =>
      updateLorebookFolder.mutate({ id: folderId, name }, { onError: showFolderError }),
    [showFolderError, updateLorebookFolder],
  );

  const handleMoveFolder = useCallback(
    (folderId: string, parentId: string | null) =>
      updateLorebookFolder.mutate({ id: folderId, parentId }, { onError: showFolderError }),
    [showFolderError, updateLorebookFolder],
  );

  const handleDeleteFolder = useCallback(
    (folder: LibraryFolderNode) => {
      const parent = folder.parentId ? folderNodes.find((candidate) => candidate.id === folder.parentId) : undefined;
      const subfolderCount = folderView.tree.childrenByParent.get(folder.id)?.length ?? 0;
      void confirmNonEmptyFolderDelete(folder.itemIds.length + subfolderCount, {
        title: localizeUi("ui.panels.backgroundpicker.deleteFolder"),
        message: parent
          ? localizeUi("ui.panels.libraryorganize.deleteFolderValue1ContentsMoveToValue2", {
              value1: folder.name,
              value2: parent.name,
            })
          : localizeUi("ui.panels.libraryorganize.deleteFolderValue1ContentsMoveToTopLevel", { value1: folder.name }),
        confirmLabel: localizeUi("lorebook.editor.batch.delete"),
        tone: "destructive",
      }).then((ok) => {
        if (!ok) return;
        deleteLorebookFolder.mutate(folder.id, { onError: showFolderError });
        setFolderExpanded(folder.id, false);
      });
    },
    [deleteLorebookFolder, folderNodes, folderView, localizeUi, setFolderExpanded, showFolderError],
  );

  const requestMoveFolder = useCallback(
    (folder: LibraryFolderNode) =>
      openMovePicker(folderNodes, folderView, {
        title: localizeUi("ui.panels.libraryorganize.moveValue1To", { value1: folder.name }),
        movingFolderId: folder.id,
        currentFolderId: folder.parentId,
        onPick: (parentId) => handleMoveFolder(folder.id, parentId),
      }),
    [folderNodes, folderView, handleMoveFolder, localizeUi, openMovePicker],
  );

  const getDraggedLorebookIds = useCallback(
    (lorebookId: string) =>
      selectionMode && selectedLorebookIds.has(lorebookId) ? Array.from(selectedLorebookIds) : [lorebookId],
    [selectedLorebookIds, selectionMode],
  );

  const moveLorebooksToFolder = useCallback(
    (lorebookIds: string[], folderId: string | null) => {
      moveLorebookItem.mutate({ itemIds: lorebookIds, folderId }, { onError: showFolderError });
    },
    [moveLorebookItem, showFolderError],
  );

  const handleLorebookDrop = useCallback(
    (folderId: string | null, lorebookIds?: string[]) => {
      if (!draggedLorebookId) return;
      moveLorebooksToFolder(lorebookIds ?? [draggedLorebookId], folderId);
      setDraggedLorebookId(null);
    },
    [draggedLorebookId, moveLorebooksToFolder],
  );

  const finishLorebookTouchDrag = useCallback(
    (lorebookId: string, x: number, y: number) => {
      const target = document.elementFromPoint(x, y);
      const folderElement = target?.closest("[data-lorebook-folder-id]") as HTMLElement | null;
      const rootElement = target?.closest("[data-lorebook-folder-root]") as HTMLElement | null;
      if (folderElement?.dataset.lorebookFolderId) {
        moveLorebooksToFolder(getDraggedLorebookIds(lorebookId), folderElement.dataset.lorebookFolderId);
      } else if (rootElement) {
        moveLorebooksToFolder(getDraggedLorebookIds(lorebookId), null);
      }
      setDraggedLorebookId(null);
      window.setTimeout(() => {
        suppressLorebookClickRef.current = false;
      }, 0);
    },
    [getDraggedLorebookIds, moveLorebooksToFolder],
  );

  const cancelLorebookTouchDrag = useCallback((_lorebookId: string, wasActive: boolean) => {
    setDraggedLorebookId(null);
    if (wasActive) {
      window.setTimeout(() => {
        suppressLorebookClickRef.current = false;
      }, 0);
    } else {
      suppressLorebookClickRef.current = false;
    }
  }, []);

  const { startTouchDrag: startLorebookTouchDrag } = useTouchFolderDrag({
    onActivate: (lorebookId) => {
      suppressLorebookClickRef.current = true;
      setDraggedLorebookId(lorebookId);
    },
    onDrop: finishLorebookTouchDrag,
    onCancel: cancelLorebookTouchDrag,
  });

  const renderLorebookRow = useCallback(
    (lb: LorebookListItem, section?: { rowKey: string; campaignId: string }) => {
      const combinedNames = [...getCharacterNames(lb), ...getPersonaNames(lb)].join(", ") || undefined;
      return (
        <LorebookRow
          key={section?.rowKey ?? lb.id}
          lorebook={lb}
          characterName={combinedNames}
          folderPath={showFolderPaths ? folderView.pathByItemId.get(lb.id) : undefined}
          campaignBadges={
            <LibraryCampaignBadges
              campaigns={organizer.membership.get(lb.id)}
              hideCampaignId={section?.campaignId ?? organizer.filteredCampaignId}
              onSelect={organizer.setCampaignFilter}
            />
          }
          onCampaigns={organizer.campaignsAvailable ? () => organizer.openCampaignPicker([lb.id]) : undefined}
          onClick={() => {
            if (suppressLorebookClickRef.current) return;
            if (selectionMode) toggleSelection(lb.id);
            else openLorebookDetail(lb.id);
          }}
          onDelete={async () => {
            if (
              await showConfirmDialog({
                title: localizeUi("ui.panels.lorebookspanel.deleteLorebook"),
                message: localizeUi("ui.panels.lorebookspanel.deleteValue1AllEntriesWillBeLost", { value1: lb.name }),
                confirmLabel: localizeUi("lorebook.editor.batch.delete"),
                tone: "destructive",
              })
            ) {
              deleteLorebook.mutate(lb.id);
            }
          }}
          onDuplicate={() => void handleDuplicateLorebook(lb)}
          onImagePick={() => handlePickLorebookImage(lb.id)}
          selectionMode={selectionMode}
          isSelected={selectedLorebookIds.has(lb.id)}
          onToggleSelect={() => toggleSelection(lb.id)}
          draggable={!isMobileOverlay}
          isDragging={draggedLorebookId === lb.id}
          onDragStart={(event) => {
            if (isMobileOverlay) return;
            const ids = getDraggedLorebookIds(lb.id);
            setDraggedLorebookId(lb.id);
            event.dataTransfer.effectAllowed = "copyMove";
            event.dataTransfer.setData("application/x-marinara-lorebook-ids", JSON.stringify(ids));
            event.dataTransfer.setData("text/plain", lb.id);
            writeChatResourceDragPayload(event.dataTransfer, {
              version: 1,
              kind: "lorebook",
              ids,
              label:
                ids.length === 1
                  ? lb.name
                  : localizeUi("ui.chat.chatresourcedropoverlay.lorebookCount", { count: ids.length }),
            });
          }}
          onDragEnd={() => {
            setDraggedLorebookId(null);
            clearActiveChatResourceDrag();
          }}
          onTouchStart={(event) => {
            startLorebookTouchDrag(event, lb.id, {
              allowInteractiveTarget: true,
              chatResourcePayload: {
                version: 1,
                kind: "lorebook",
                ids: getDraggedLorebookIds(lb.id),
                label:
                  getDraggedLorebookIds(lb.id).length === 1
                    ? lb.name
                    : localizeUi("ui.chat.chatresourcedropoverlay.lorebookCount", {
                        count: getDraggedLorebookIds(lb.id).length,
                      }),
              },
              sourceElement: event.currentTarget.closest<HTMLElement>('[data-touch-drag-card="lorebook"]'),
            });
          }}
        />
      );
    },
    [
      deleteLorebook,
      draggedLorebookId,
      getCharacterNames,
      getDraggedLorebookIds,
      getPersonaNames,
      handleDuplicateLorebook,
      handlePickLorebookImage,
      isMobileOverlay,
      openLorebookDetail,
      selectedLorebookIds,
      selectionMode,
      startLorebookTouchDrag,
      toggleSelection,
      localizeUi,
      showFolderPaths,
      folderView,
      organizer,
    ],
  );

  const handleMoveSelected = useCallback(() => {
    const ids = [...selectedLorebookIds];
    if (ids.length === 0) return;
    const holders = new Set(ids.map((id) => folderNodes.find((folder) => folder.itemIds.includes(id))?.id ?? null));
    openMovePicker(folderNodes, folderView, {
      title: localizeUi("ui.panels.libraryorganize.moveLorebooks", { count: ids.length }),
      movingFolderId: null,
      currentFolderId: holders.size === 1 ? [...holders][0] : undefined,
      onPick: (folderId) => {
        moveLorebooksToFolder(ids, folderId);
        exitSelectionMode();
      },
    });
  }, [
    exitSelectionMode,
    folderNodes,
    folderView,
    localizeUi,
    moveLorebooksToFolder,
    openMovePicker,
    selectedLorebookIds,
  ]);

  return (
    <div className="flex min-h-full flex-col gap-2 p-3">
      <input
        ref={lorebookImageInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleLorebookImageSelected}
      />

      {/* Action buttons */}
      <div className="flex gap-2">
        <button
          onClick={() => openModal("create-lorebook")}
          className="mari-panel-gradient-button mari-panel-gradient--lorebooks flex-1 text-xs"
          title={localizeUi("ui.lorebooks.lorebookassignmentsection.new")}
        >
          <Plus size="0.8125rem" />
        </button>
        <button
          onClick={() => openModal("import-lorebook")}
          className="mari-chrome-control mari-chrome-control--primary flex-1 text-xs"
          title={localizeUi("ui.chat.chatbranchselector.import")}
        >
          <Download size="0.8125rem" />
        </button>
        <button
          onClick={() => {
            if (selectionMode) exitSelectionMode();
            else setSelectionMode(true);
          }}
          className={cn(
            "mari-chrome-control mari-chrome-control--primary flex-1 text-xs",
            selectionMode && "mari-chrome-control--selected",
          )}
          title={localizeUi("settings.common.select")}
        >
          <Check size="0.8125rem" />
        </button>
      </div>

      {/* Search + Sort */}
      <div className="flex gap-1.5">
        <div className="relative flex-1">
          <Search
            size="0.8125rem"
            className="mari-chrome-field-icon pointer-events-none absolute left-3 top-1/2 -translate-y-1/2"
          />
          <input
            type="text"
            placeholder={localize("Search lorebooks")}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="mari-chrome-field h-10 w-full py-0 pl-8 pr-3 text-xs md:h-9"
          />
        </div>
        <div className="relative">
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as LorebookPanelSort)}
            className="mari-chrome-field mari-chrome-sort-field mari-accent-animated h-10 appearance-none py-0 pl-2.5 pr-7 text-[0.6875rem] md:h-9"
            title={localizeUi("ui.panels.agentspanel.sortOrder")}
          >
            <option value="name-asc">{localizeUi("ui.panels.backgroundpicker.aZ")}</option>
            <option value="name-desc">{localizeUi("ui.panels.backgroundpicker.zA")}</option>
            <option value="newest">{localizeUi("ui.panels.backgroundpicker.newest")}</option>
            <option value="oldest">{localizeUi("ui.panels.backgroundpicker.oldest")}</option>
            <option value="tokens">{localizeUi("ui.lorebooks.lorebookeditor.tokenBudget")}</option>
          </select>
          <ArrowUpDown
            size="0.625rem"
            className="mari-chrome-field-icon mari-chrome-sort-icon mari-accent-animated pointer-events-none absolute right-2 top-1/2 -translate-y-1/2"
          />
        </div>
      </div>

      <LibraryCampaignBar
        campaigns={organizer.campaigns}
        value={organizer.campaignFilter}
        onChange={organizer.setCampaignFilter}
        groupByCampaign={organizer.groupByCampaign}
        onGroupByCampaignChange={organizer.setGroupByCampaign}
      />

      <div className="flex flex-col gap-0.5">
        <div className="flex items-center gap-1">
          <button
            onClick={() => handleCreateFolder()}
            className="mari-chrome-control mari-chrome-control--small flex-1 justify-start text-[0.6875rem]"
          >
            <FolderPlus size="0.75rem" />
            {localizeUi("ui.panels.backgroundpicker.newFolder")}
          </button>
        </div>
        {lorebookFolders.length > 0 && (
          <p className="mari-folder-helper">
            {localizeUi("ui.panels.lorebookspanel.dragAndDropLorebooksToFoldersDoubleClickOr")}
          </p>
        )}
      </div>

      {/* Filters */}
      <div className="flex gap-1 md:hidden">
        <label htmlFor="lorebook-category-filter" className="sr-only">
          {localizeUi("ui.panels.lorebookspanel.lorebookCategory")}
        </label>
        <div className="relative min-w-0 flex-1">
          <select
            id="lorebook-category-filter"
            value={activeCategory}
            onChange={(event) => setActiveCategory(event.target.value as LorebookPanelCategory)}
            className="mari-chrome-field h-10 w-full min-w-0 appearance-none truncate py-0 pl-3 pr-8 text-xs"
            title={localizeUi("ui.panels.lorebookspanel.lorebookCategory")}
          >
            {CATEGORIES.map((cat) => (
              <option key={cat.id} value={cat.id}>
                {cat.label}
              </option>
            ))}
          </select>
          <ChevronDown
            size="0.75rem"
            className="mari-chrome-field-icon pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2"
          />
        </div>
        <button
          onClick={() => setTagsExpanded(!tagsExpanded)}
          className={cn(
            "mari-chrome-control mari-chrome-control--small shrink-0 whitespace-nowrap px-2 text-[0.6875rem]",
            tagFilterActive && "mari-chrome-control--selected",
          )}
          title={
            tagsExpanded
              ? localizeUi("ui.panels.lorebookspanel.collapseTags")
              : localizeUi("ui.panels.lorebookspanel.expandTags")
          }
        >
          <Tag size="0.6875rem" />
          {localizeUi("ui.characters.metadatatab.tags")}
          {tagsExpanded ? <ChevronUp size="0.625rem" /> : <ChevronDown size="0.625rem" />}
        </button>
      </div>

      <div className="hidden flex-wrap gap-1 md:flex">
        {PRIMARY_CATEGORIES.map((cat) => {
          const isActive = activeCategory === cat.id;
          return (
            <button
              key={cat.id}
              onClick={() => setActiveCategory(cat.id)}
              className={cn(
                "mari-chrome-control mari-chrome-control--small whitespace-nowrap text-[0.6875rem]",
                isActive && "mari-chrome-control--selected",
              )}
            >
              {cat.label}
            </button>
          );
        })}
        <button
          onClick={() => setTagsExpanded(!tagsExpanded)}
          className={cn(
            "mari-chrome-control mari-chrome-control--small whitespace-nowrap text-[0.6875rem]",
            tagFilterActive && "mari-chrome-control--selected",
          )}
          title={
            tagsExpanded
              ? localizeUi("ui.panels.lorebookspanel.collapseTags")
              : localizeUi("ui.panels.lorebookspanel.expandTags")
          }
        >
          <Tag size="0.6875rem" />
          {localizeUi("ui.characters.metadatatab.tags")}
          {tagsExpanded ? <ChevronUp size="0.625rem" /> : <ChevronDown size="0.625rem" />}
        </button>
      </div>

      {tagsExpanded && (
        <div className="flex flex-wrap items-center gap-1">
          {tagFilterActive && (
            <button
              onClick={() => {
                setActiveCategory("all");
                setActiveTag(null);
              }}
              className="mari-chrome-control mari-chrome-control--compact mari-chrome-control--danger"
            >
              <X size="0.5rem" /> {localizeUi("lorebook.editor.batch.clear")}
            </button>
          )}
          {TAGGED_CATEGORIES.map((cat) => {
            const isActive = activeCategory === cat.id;
            return (
              <button
                key={cat.id}
                type="button"
                onClick={() => setActiveCategory(isActive ? "all" : cat.id)}
                className={cn(
                  "mari-chrome-control mari-chrome-control--compact hidden cursor-pointer md:inline-flex",
                  isActive && "mari-chrome-control--selected",
                )}
              >
                {cat.label}
              </button>
            );
          })}
          {allTags.map((tag) => (
            <div
              key={tag}
              role="button"
              tabIndex={0}
              onClick={() => setActiveTag(activeTag === tag ? null : tag)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setActiveTag(activeTag === tag ? null : tag);
                }
              }}
              className={cn(
                "mari-chrome-control mari-chrome-control--compact group/tag cursor-pointer whitespace-nowrap",
                activeTag === tag && "mari-chrome-control--selected",
              )}
            >
              {tag}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  handleDeleteTag(tag);
                }}
                className="ml-0.5 rounded-full p-0.5 transition-colors hover:bg-[var(--destructive)]/20 hover:text-[var(--destructive)]"
                title={localizeUi("ui.panels.characterspanel.deleteTagValue1", { value1: tag })}
              >
                <X size="0.5rem" />
              </button>
            </div>
          ))}
        </div>
      )}

      {!organizer.groupByCampaign && (
        <LibraryFolderTree
          folders={folderNodes}
          view={folderView}
          filterActive={folderFilterActive}
          expandedIds={organizer.expandedFolderIds}
          onExpandedChange={organizer.setFolderExpanded}
          isItemShown={(id) => lorebookById.has(id)}
          renderItem={(id) => {
            const lorebook = lorebookById.get(id);
            return lorebook ? renderLorebookRow(lorebook) : null;
          }}
          folderIdAttribute="data-lorebook-folder-id"
          folderDragType="application/x-marinara-lorebook-folder"
          itemDragActive={draggedLorebookId !== null}
          allowFolderDrag={!isMobileOverlay}
          onItemDrop={(folderId, event) => {
            const payload = event.dataTransfer.getData("application/x-marinara-lorebook-ids");
            handleLorebookDrop(folderId, payload ? (JSON.parse(payload) as string[]) : undefined);
          }}
          onRename={handleRenameFolder}
          onDelete={handleDeleteFolder}
          onCreateSubfolder={(parentId) => handleCreateFolder(parentId)}
          onMoveFolder={handleMoveFolder}
          onRequestMoveFolder={requestMoveFolder}
          emptyFolderText={localizeUi("ui.panels.lorebookspanel.dropLorebooksHere")}
          renderFolderActions={folderToggle.renderFolderActions}
          isFolderDimmed={folderToggle.isFolderDimmed}
        />
      )}

      {/* Loading */}
      {isLoading && (
        <div className="flex flex-col gap-2 py-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="shimmer h-14 rounded-xl" />
          ))}
        </div>
      )}

      {/* Empty state */}
      {!isLoading && sorted.length === 0 && (
        <div className="flex flex-col items-center gap-2 py-8 text-center">
          <div className="animate-float flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-amber-400/20 to-orange-500/20">
            <BookOpen size="1.25rem" className="text-amber-400" />
          </div>
          <p className="mari-chrome-text-muted text-xs">
            {searchQuery
              ? localizeUi("ui.panels.lorebookspanel.noLorebooksMatchYourSearch")
              : localizeUi("ui.panels.lorebookspanel.noLorebooksYet")}
          </p>
        </div>
      )}

      {/* Lorebook list */}
      {!isLoading && sorted.length > 0 && (
        <>
          {draggedLorebookId && !organizer.groupByCampaign && (
            <div
              data-lorebook-folder-root
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
              }}
              onDrop={(event) => {
                event.preventDefault();
                const payload = event.dataTransfer.getData("application/x-marinara-lorebook-ids");
                handleLorebookDrop(null, payload ? (JSON.parse(payload) as string[]) : undefined);
              }}
              className="rounded-xl border border-dashed border-amber-400/35 bg-amber-400/5 px-3 py-2 text-[0.625rem] text-amber-300"
            >
              {localizeUi("ui.panels.agentspanel.dropHereToMoveOutOfFolder")}
            </div>
          )}

          <div className="stagger-children flex min-h-8 flex-col gap-1 rounded-xl transition-colors">
            {organizer.groupByCampaign ? (
              <LibraryCampaignSections
                campaigns={
                  organizer.filteredCampaignId
                    ? organizer.campaigns.filter((campaign) => campaign.id === organizer.filteredCampaignId)
                    : organizer.campaigns
                }
                items={sorted}
                membership={organizer.membership}
                collapsedIds={organizer.collapsedCampaignIds}
                onToggle={organizer.setCampaignSectionCollapsed}
                renderItem={(lb, sectionId) =>
                  renderLorebookRow(lb, { rowKey: `${sectionId}:${lb.id}`, campaignId: sectionId })
                }
                showUnassigned={organizer.filteredCampaignId === null}
              />
            ) : activeCategory === "all" && grouped ? (
              // Grouped view
              Array.from(grouped.entries()).map(([category, books]) => {
                const catMeta = CATEGORIES.find((c) => c.id === category) ?? CATEGORIES[6];
                return (
                  <div key={category} className="mb-2">
                    <div className="mb-1 flex items-center gap-1.5 px-1 text-[0.6875rem] font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
                      {catMeta.label}
                      <span className="ml-auto text-[0.625rem] font-normal">{books.length}</span>
                    </div>
                    {books.map((lb) => renderLorebookRow(lb))}
                  </div>
                );
              })
            ) : (
              // Flat view
              rootLorebooks.map((lb) => renderLorebookRow(lb))
            )}
          </div>
        </>
      )}

      {lorebookPages.hasNextPage && (
        <PanelLoadMoreBar
          onLoadMore={() => void lorebookPages.fetchNextPage()}
          disabled={lorebookPages.isFetchingNextPage}
        >
          {lorebookPages.isFetchingNextPage
            ? localizeUi("ui.characters.characterlibraryview.loading")
            : localizeUi("ui.panels.characterspanel.loadMoreValue1Loaded", { value1: lorebooks.length })}
        </PanelLoadMoreBar>
      )}

      {selectionMode && (
        <SelectionActionBar
          placement="panel"
          selectedCount={selectedLorebookIds.size}
          extraAction={
            <LibrarySelectionExtraActions
              disabled={selectedLorebookIds.size === 0}
              onMove={folderNodes.length > 0 ? handleMoveSelected : undefined}
              onCampaigns={
                organizer.campaignsAvailable ? () => organizer.openCampaignPicker([...selectedLorebookIds]) : undefined
              }
            />
          }
          onExport={() => void handleExportSelected()}
          onDelete={handleDeleteSelected}
          exporting={exportingSelected}
        />
      )}
      {organizer.modals}
    </div>
  );
}

function LorebookRow({
  lorebook,
  characterName,
  folderPath,
  campaignBadges,
  onCampaigns,
  onClick,
  onDelete,
  onDuplicate,
  onImagePick,
  selectionMode,
  isSelected,
  onToggleSelect,
  draggable,
  isDragging,
  onDragStart,
  onDragEnd,
  onTouchStart,
}: {
  lorebook: Lorebook;
  characterName?: string;
  /** Folder breadcrumb, shown while searching. */
  folderPath?: string;
  campaignBadges?: ReactNode;
  onCampaigns?: () => void;
  onClick: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onImagePick: () => void;
  selectionMode?: boolean;
  isSelected?: boolean;
  onToggleSelect?: () => void;
  draggable?: boolean;
  isDragging?: boolean;
  onDragStart?: (event: DragEvent<HTMLDivElement>) => void;
  onDragEnd?: () => void;
  onTouchStart?: (event: TouchEvent<HTMLButtonElement>) => void;
}) {
  const { t: localizeUi } = useUiTranslation();
  const gradient = CATEGORY_COLORS[lorebook.category] ?? CATEGORY_COLORS.uncategorized;
  const imageContent = lorebook.imagePath ? (
    <img src={lorebook.imagePath} alt="" className="h-full w-full object-cover" draggable={false} />
  ) : (
    <BookOpen size="1rem" />
  );
  const imageClasses = cn(
    "relative flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-xl text-white shadow-sm",
    lorebook.imagePath ? "bg-[var(--muted)]" : `bg-gradient-to-br ${gradient}`,
  );

  return (
    <div
      data-touch-drag-card="lorebook"
      className={cn(
        "group relative flex touch-pan-y cursor-pointer items-center gap-3 rounded-xl p-2.5 transition-all hover:bg-[var(--sidebar-accent)]",
        selectionMode &&
          isSelected &&
          "bg-[var(--marinara-chat-chrome-highlight-bg)] ring-1 ring-[var(--marinara-chat-chrome-button-border-active)]",
        isDragging && "opacity-50",
      )}
      onClick={onClick}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      {selectionMode && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggleSelect?.();
          }}
          className={cn(
            "flex h-5 w-5 shrink-0 items-center justify-center rounded border-2 transition-colors",
            isSelected
              ? "border-[var(--marinara-chat-chrome-button-border-active)] bg-[var(--marinara-chat-chrome-button-bg-active)] text-[var(--marinara-chat-chrome-button-text-active)]"
              : "border-[var(--muted-foreground)]/40 bg-[var(--secondary)] text-transparent",
          )}
          aria-label={
            isSelected
              ? localizeUi("ui.panels.lorebookrow.deselectLorebook")
              : localizeUi("ui.panels.lorebookrow.selectLorebook")
          }
        >
          <span className="text-[0.75rem]">✓</span>
        </button>
      )}
      {onTouchStart && (
        <TouchDragHandle
          label={localizeUi("ui.panels.lorebookrow.dragLorebook")}
          onTouchStart={(event) => {
            onTouchStart(event);
          }}
        />
      )}
      {selectionMode ? (
        <div className={imageClasses}>{imageContent}</div>
      ) : (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onImagePick();
          }}
          className={cn(
            imageClasses,
            "transition-transform hover:scale-105 focus:outline-none focus:ring-2 focus:ring-[var(--marinara-chat-chrome-focus-ring)]",
          )}
          title={
            lorebook.imagePath
              ? localizeUi("ui.panels.lorebookrow.replaceLorebookPicture")
              : localizeUi("ui.panels.lorebookrow.uploadLorebookPicture")
          }
          aria-label={
            lorebook.imagePath
              ? localizeUi("ui.panels.lorebookrow.replaceLorebookPicture")
              : localizeUi("ui.panels.lorebookrow.uploadLorebookPicture")
          }
        >
          {imageContent}
          <span className="absolute inset-0 flex items-center justify-center bg-black/45 opacity-0 transition-opacity group-hover:opacity-100">
            <Camera size="0.875rem" />
          </span>
        </button>
      )}
      <div className={cn("min-w-0 flex-1", !selectionMode && "pr-0 max-md:pr-24 [@media(pointer:coarse)]:pr-24")}>
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate text-sm font-medium">{lorebook.name}</span>
          {!lorebook.enabled && (
            <span className="shrink-0 rounded bg-[var(--muted)]/50 px-1 py-0.5 text-[0.5625rem] text-[var(--muted-foreground)]">
              {localizeUi("ui.panels.lorebookrow.off")}
            </span>
          )}
        </div>
        <div className="flex min-w-0 items-center gap-1 text-[0.6875rem] text-[var(--muted-foreground)]">
          {campaignBadges}
          <span className="min-w-0 truncate">
            {characterName ? (
              <span className="inline-flex items-center gap-1">
                <UserRound size="0.625rem" className="shrink-0" />
                {characterName}
                {lorebook.description
                  ? localizeUi("ui.panels.lorebookrow.value1", { value1: lorebook.description })
                  : ""}
              </span>
            ) : (
              lorebook.description || "No description"
            )}
          </span>
        </div>
        {folderPath && (
          <div
            data-library-folder-path
            className="flex min-w-0 items-center gap-1 text-[0.5625rem] text-[var(--muted-foreground)]"
          >
            <Folder size="0.5625rem" className="shrink-0" />
            <span className="truncate">{folderPath}</span>
          </div>
        )}
      </div>
      {!selectionMode && (
        <div className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 flex shrink-0 items-center gap-0.5 rounded-lg bg-[var(--sidebar)] px-1 py-0.5 opacity-0 shadow-sm ring-1 ring-[var(--border)] transition-opacity group-hover:opacity-100 [@media(pointer:fine)]:group-focus-within:opacity-100 max-md:opacity-100 [@media(pointer:coarse)]:opacity-100 group-hover:[&_button]:pointer-events-auto [@media(pointer:fine)]:group-focus-within:[&_button]:pointer-events-auto max-md:[&_button]:pointer-events-auto [@media(pointer:coarse)]:[&_button]:pointer-events-auto">
          <ChatResourceActionButton
            payload={{ version: 1, kind: "lorebook", ids: [lorebook.id], label: lorebook.name }}
          />
          {onCampaigns && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onCampaigns();
              }}
              // Touch layouts keep row actions always visible, so campaigns stay in selection mode there.
              className="mari-chrome-control mari-chrome-control--small p-1.5 max-md:hidden [@media(pointer:coarse)]:hidden"
              title={localizeUi("ui.panels.libraryorganize.campaigns")}
              aria-label={localizeUi("ui.panels.libraryorganize.campaigns")}
            >
              <Swords size="0.75rem" />
            </button>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDuplicate();
            }}
            className="mari-chrome-control mari-chrome-control--small p-1.5"
            title={localizeUi("lorebook.editor.batch.copy")}
          >
            <Copy size="0.75rem" />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            className="mari-chrome-control mari-chrome-control--small p-1.5"
            title={localizeUi("lorebook.editor.batch.delete")}
          >
            <Trash2 size="0.75rem" />
          </button>
        </div>
      )}
    </div>
  );
}
