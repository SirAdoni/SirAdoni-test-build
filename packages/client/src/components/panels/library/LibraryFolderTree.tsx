// ──────────────────────────────────────────────
// Library folder tree: nested folders with indentation
// guides, rename gestures, drag and drop (items and
// folders), and per-folder actions (new subfolder, move,
// delete). Panels supply the item rows.
// ──────────────────────────────────────────────
import { useCallback, useState, type DragEvent, type ReactNode } from "react";
import { ChevronRight, FolderInput, FolderPlus, Trash2 } from "lucide-react";
import { useTranslation as useUiTranslation } from "react-i18next";
import { checkLibraryFolderParent, LIBRARY_FOLDER_MAX_DEPTH } from "@marinara-engine/shared";
import { handleFolderRenameKeyDown, useFolderRenameGesture } from "../../../hooks/use-folder-rename-gesture";
import type { LibraryFolderNode, LibraryFolderView } from "../../../lib/library-folder-view";
import { SmoothFolderContent } from "../../ui/SmoothFolderContent";
import { cn } from "../../../lib/utils";

interface LibraryFolderTreeProps {
  folders: LibraryFolderNode[];
  view: LibraryFolderView;
  filterActive: boolean;
  expandedIds: ReadonlySet<string>;
  onExpandedChange: (folderId: string, expanded: boolean) => void;
  isItemShown: (itemId: string) => boolean;
  renderItem: (itemId: string, folder: LibraryFolderNode) => ReactNode;
  /** DOM attribute that marks folder drop targets for the panel's touch drag. */
  folderIdAttribute: "data-lorebook-folder-id" | "data-character-folder-id";
  /** Drag payload type for folders; distinct per panel so folders never cross panels. */
  folderDragType: string;
  itemDragActive: boolean;
  allowFolderDrag: boolean;
  onItemDrop: (folderId: string, event: DragEvent<HTMLDivElement>) => void;
  onRename: (folderId: string, name: string) => void;
  onDelete: (folder: LibraryFolderNode) => void;
  onCreateSubfolder: (parentId: string) => void;
  onMoveFolder: (folderId: string, parentId: string | null) => void;
  onRequestMoveFolder: (folder: LibraryFolderNode) => void;
  emptyFolderText: string;
  /** Extra small buttons in a folder's action pill (before "New subfolder"). */
  renderFolderActions?: (folder: LibraryFolderNode) => ReactNode;
  /** Dim a folder's name (e.g. every lorebook inside is disabled). */
  isFolderDimmed?: (folder: LibraryFolderNode) => boolean;
}

export function LibraryFolderTree(props: LibraryFolderTreeProps) {
  const { t: localizeUi } = useUiTranslation();
  const { folders, view, folderDragType, onMoveFolder } = props;
  const [draggedFolderId, setDraggedFolderId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);

  const canNestUnder = useCallback(
    (folderId: string, parentId: string | null) => checkLibraryFolderParent(folders, folderId, parentId).ok,
    [folders],
  );

  const readDraggedFolder = (event: DragEvent<HTMLElement>) =>
    draggedFolderId && event.dataTransfer.types.includes(folderDragType) ? draggedFolderId : null;

  const endFolderDrag = () => {
    setDraggedFolderId(null);
    setDropTargetId(null);
  };

  const roots = view.tree.roots.filter((folder) => view.shownFolderIds.has(folder.id));
  if (roots.length === 0) return null;

  return (
    <div className="flex flex-col gap-0.5" data-component="LibraryFolderTree">
      {draggedFolderId && (
        <div
          onDragOver={(event) => {
            if (!readDraggedFolder(event) || !canNestUnder(draggedFolderId, null)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
          }}
          onDrop={(event) => {
            const folderId = readDraggedFolder(event);
            if (!folderId) return;
            event.preventDefault();
            onMoveFolder(folderId, null);
            endFolderDrag();
          }}
          className="rounded-xl border border-dashed border-[var(--marinara-chat-chrome-button-border-active)] bg-[var(--marinara-chat-chrome-highlight-bg)] px-3 py-2 text-[0.625rem] text-[var(--marinara-chat-chrome-button-text-active)]"
        >
          {localizeUi("ui.panels.libraryorganize.dropHereForTopLevel")}
        </div>
      )}
      {roots.map((folder) => (
        <FolderNode
          key={folder.id}
          {...props}
          folder={folder}
          depth={1}
          draggedFolderId={draggedFolderId}
          dropTargetId={dropTargetId}
          setDropTargetId={setDropTargetId}
          onFolderDragStart={setDraggedFolderId}
          onFolderDragEnd={endFolderDrag}
          canNestUnder={canNestUnder}
          readDraggedFolder={readDraggedFolder}
        />
      ))}
    </div>
  );
}

type FolderNodeProps = LibraryFolderTreeProps & {
  folder: LibraryFolderNode;
  depth: number;
  draggedFolderId: string | null;
  dropTargetId: string | null;
  setDropTargetId: (id: string | null) => void;
  onFolderDragStart: (id: string) => void;
  onFolderDragEnd: () => void;
  canNestUnder: (folderId: string, parentId: string | null) => boolean;
  readDraggedFolder: (event: DragEvent<HTMLElement>) => string | null;
};

function FolderNode(props: FolderNodeProps) {
  const {
    folder,
    depth,
    view,
    filterActive,
    expandedIds,
    onExpandedChange,
    isItemShown,
    renderItem,
    folderIdAttribute,
    folderDragType,
    itemDragActive,
    allowFolderDrag,
    onItemDrop,
    onRename,
    onDelete,
    onCreateSubfolder,
    onMoveFolder,
    onRequestMoveFolder,
    emptyFolderText,
    renderFolderActions,
    isFolderDimmed,
    draggedFolderId,
    dropTargetId,
    setDropTargetId,
    onFolderDragStart,
    onFolderDragEnd,
    canNestUnder,
    readDraggedFolder,
  } = props;
  const { t: localizeUi } = useUiTranslation();
  const handleFolderRenameGesture = useFolderRenameGesture();
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState("");

  const children = (view.tree.childrenByParent.get(folder.id) ?? []).filter((child) =>
    view.shownFolderIds.has(child.id),
  );
  const directItemIds = folder.itemIds.filter(isItemShown);
  const count = view.counts.get(folder.id) ?? 0;
  const isExpanded = view.revealedFolderIds.has(folder.id) || expandedIds.has(folder.id);
  // Rows mount on first open (large folders stay cheap) and then stay for the close animation.
  const [contentMounted, setContentMounted] = useState(isExpanded);
  if (isExpanded && !contentMounted) setContentMounted(true);
  const canAddSubfolder = depth < LIBRARY_FOLDER_MAX_DEPTH;
  const isDropTarget = dropTargetId === folder.id;
  const toggle = () => onExpandedChange(folder.id, !isExpanded);
  const startRename = () => {
    setEditing(true);
    setEditName(folder.name);
  };
  const finishRename = () => {
    const name = editName.trim();
    if (name && name !== folder.name) onRename(folder.id, name);
    setEditing(false);
    setEditName("");
  };

  return (
    <div
      {...{ [folderIdAttribute]: folder.id }}
      data-library-folder-depth={depth}
      onDragOver={(event) => {
        const movingFolder = readDraggedFolder(event);
        if (movingFolder && !canNestUnder(movingFolder, folder.id)) {
          // Stop here: an ancestor further up must not light up and swallow a drop
          // aimed at the folder itself or one of its own subfolders.
          event.stopPropagation();
          event.dataTransfer.dropEffect = "none";
          if (dropTargetId !== null) setDropTargetId(null);
          return;
        }
        if (!movingFolder && !itemDragActive) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "move";
        if (dropTargetId !== folder.id) setDropTargetId(folder.id);
      }}
      onDragLeave={(event) => {
        if (isDropTarget && !event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTargetId(null);
      }}
      onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setDropTargetId(null);
        const movingFolder = readDraggedFolder(event);
        if (movingFolder) {
          if (canNestUnder(movingFolder, folder.id)) onMoveFolder(movingFolder, folder.id);
          onFolderDragEnd();
          if (!isExpanded) onExpandedChange(folder.id, true);
          return;
        }
        onItemDrop(folder.id, event);
      }}
      className={cn(
        "flex flex-col rounded-lg transition-colors",
        isDropTarget &&
          "bg-[var(--marinara-chat-chrome-highlight-bg)] ring-1 ring-[var(--marinara-chat-chrome-button-border-active)]",
        draggedFolderId === folder.id && "opacity-50",
      )}
    >
      <div
        role="button"
        tabIndex={0}
        aria-expanded={isExpanded}
        aria-label={localizeUi("ui.panels.agentspanel.value1FolderValue2DoubleTapOrPressF2To", {
          value1: isExpanded
            ? localizeUi("ui.panels.ttsconfigcard.collapse")
            : localizeUi("ui.panels.ttsconfigcard.expand"),
          value2: folder.name,
        })}
        title={localizeUi("ui.panels.backgroundpicker.doubleClickDoubleTapOrPressF2ToRename")}
        draggable={allowFolderDrag && !editing}
        onDragStart={(event) => {
          event.stopPropagation();
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData(folderDragType, folder.id);
          onFolderDragStart(folder.id);
        }}
        onDragEnd={onFolderDragEnd}
        className="group relative flex cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1.5 transition-all hover:bg-[var(--sidebar-accent)]/40 max-md:pr-28 [@media(pointer:coarse)]:pr-28"
        onClick={(event) =>
          handleFolderRenameGesture(folder.id, event, { onSingleClick: toggle, onRename: startRename })
        }
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          handleFolderRenameKeyDown(event, { onSingleClick: toggle, onRename: startRename });
        }}
      >
        <ChevronRight
          size="0.75rem"
          className={cn(
            "mari-chrome-accent-icon mari-accent-animated shrink-0 transition-transform duration-200 ease-out",
            isExpanded && "rotate-90",
          )}
        />
        <div className="min-w-0 flex-1">
          {editing ? (
            <input
              autoFocus
              value={editName}
              onChange={(event) => setEditName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") {
                  setEditing(false);
                  setEditName("");
                }
              }}
              onClick={(event) => event.stopPropagation()}
              onBlur={finishRename}
              className="w-full rounded bg-transparent px-1 py-0.5 text-xs font-medium outline-none ring-1 ring-[var(--marinara-chat-chrome-input-border-focus)]"
            />
          ) : (
            <div
              className={cn(
                "mari-chrome-text-muted truncate text-xs font-medium",
                isFolderDimmed?.(folder) && "opacity-50",
              )}
            >
              {folder.name}
            </div>
          )}
        </div>
        {count > 0 && (
          <span
            data-folder-item-count="inline"
            className="shrink-0 text-[0.5625rem] text-[var(--muted-foreground)] max-md:hidden [@media(pointer:coarse)]:hidden"
          >
            {count}
          </span>
        )}
        <div
          data-folder-actions
          className="pointer-events-none absolute right-2 top-1/2 flex -translate-y-1/2 shrink-0 items-center gap-0.5 rounded-lg bg-[var(--sidebar)] px-1 py-0.5 opacity-0 shadow-sm ring-1 ring-[var(--border)] transition-opacity group-hover:opacity-100 [@media(pointer:fine)]:group-focus-within:opacity-100 max-md:opacity-100 [@media(pointer:coarse)]:opacity-100 group-hover:[&_button]:pointer-events-auto [@media(pointer:fine)]:group-focus-within:[&_button]:pointer-events-auto max-md:[&_button]:pointer-events-auto [@media(pointer:coarse)]:[&_button]:pointer-events-auto"
        >
          {count > 0 && (
            <span
              data-folder-item-count="actions"
              className="hidden px-1 text-[0.5625rem] text-[var(--muted-foreground)] max-md:inline [@media(pointer:coarse)]:inline"
            >
              {count}
            </span>
          )}
          {renderFolderActions?.(folder)}
          {canAddSubfolder && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onCreateSubfolder(folder.id);
                if (!isExpanded) onExpandedChange(folder.id, true);
              }}
              className="mari-chrome-control mari-chrome-control--small p-1"
              title={localizeUi("ui.panels.libraryorganize.newSubfolder")}
              aria-label={localizeUi("ui.panels.libraryorganize.newSubfolder")}
            >
              <FolderPlus size="0.6875rem" />
            </button>
          )}
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onRequestMoveFolder(folder);
            }}
            className="mari-chrome-control mari-chrome-control--small p-1"
            title={localizeUi("ui.panels.libraryorganize.moveFolderTo")}
            aria-label={localizeUi("ui.panels.libraryorganize.moveFolderTo")}
          >
            <FolderInput size="0.6875rem" />
          </button>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onDelete(folder);
            }}
            className="mari-chrome-control mari-chrome-control--small p-1"
            title={localizeUi("ui.panels.backgroundpicker.deleteFolder")}
            aria-label={localizeUi("ui.panels.backgroundpicker.deleteFolder")}
          >
            <Trash2 size="0.6875rem" />
          </button>
        </div>
      </div>
      <SmoothFolderContent
        open={isExpanded}
        className="ml-3 border-l border-[var(--border)]/30 pb-1 pl-1 md:ml-4"
        innerClassName="flex flex-col gap-0.5"
      >
        {contentMounted && (
          <>
            {children.map((child) => (
              <FolderNode key={child.id} {...props} folder={child} depth={depth + 1} />
            ))}
            {directItemIds.map((itemId) => renderItem(itemId, folder))}
            {children.length === 0 && directItemIds.length === 0 && !filterActive && (
              <p className="mari-chrome-text-muted py-2 text-[0.625rem] italic">{emptyFolderText}</p>
            )}
          </>
        )}
      </SmoothFolderContent>
    </div>
  );
}
