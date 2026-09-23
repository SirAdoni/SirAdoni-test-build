// ──────────────────────────────────────────────
// Lorebook Entry List Item
// Memoized adapter between the editor's entry list and LorebookEntryRow.
// The editor passes one stable handlers object plus the row's container and
// index, so a keystroke or a toggle on one row no longer re-renders every
// other row of a large lorebook.
// ──────────────────────────────────────────────
import {
  memo,
  useCallback,
  type ComponentProps,
  type DragEvent as ReactDragEvent,
  type TouchEvent as ReactTouchEvent,
} from "react";
import type { LorebookEntry } from "@marinara-engine/shared";
import { LorebookEntryRow } from "./LorebookEntryRow";

type RowProps = ComponentProps<typeof LorebookEntryRow>;

export interface LorebookEntryListHandlers {
  toggleExpand: (entryId: string) => void;
  /** Receives the click so the editor can extend the selection with Shift. */
  toggleSelected: (entryId: string, event?: { shiftKey: boolean }) => void;
  dragHandleMouseDown: (containerId: string | null, index: number) => void;
  dragHandleMouseUp: () => void;
  dragHandleTouchStart: (
    entryId: string,
    e: ReactTouchEvent<HTMLButtonElement>,
    sourceElement: HTMLDivElement | null,
  ) => void;
  dragStart: (containerId: string | null, index: number, entryId: string, e: ReactDragEvent<HTMLDivElement>) => void;
  dragOver: (containerId: string | null, index: number, e: ReactDragEvent<HTMLDivElement>) => void;
  drop: (containerId: string | null, e: ReactDragEvent<HTMLDivElement>) => void;
  dragEnd: () => void;
  updateEntry: (
    entryId: string,
    changes: Partial<LorebookEntry>,
    changedFields: Partial<LorebookEntry>,
  ) => Promise<unknown>;
}

interface Props {
  entry: LorebookEntry;
  lorebookId: string;
  /** Folder id, null for root entries. Ignored when `sortable` is false. */
  containerId: string | null;
  index: number;
  /** False for the flat (search / non-Order sort) list, which has no drag wiring. */
  sortable: boolean;
  handlers: LorebookEntryListHandlers;
  isExpanded: boolean;
  characters: RowProps["characters"];
  characterTags: RowProps["characterTags"];
  folders: RowProps["folders"];
  draggable: boolean;
  isDragging: boolean;
  isDragReady: boolean;
  selectionMode: boolean;
  isSelected: boolean;
  previewMatch?: RowProps["previewMatch"];
  activationStat?: RowProps["activationStat"];
  mapBacklinks?: RowProps["mapBacklinks"];
}

const noop = () => undefined;

export const LorebookEntryListItem = memo(function LorebookEntryListItem({
  entry,
  lorebookId,
  containerId,
  index,
  sortable,
  handlers,
  isExpanded,
  characters,
  characterTags,
  folders,
  draggable,
  isDragging,
  isDragReady,
  selectionMode,
  isSelected,
  previewMatch,
  activationStat,
  mapBacklinks,
}: Props) {
  const entryId = entry.id;
  const onToggleExpand = useCallback(() => handlers.toggleExpand(entryId), [handlers, entryId]);
  const onToggleSelected = useCallback(
    (event?: { shiftKey: boolean }) => handlers.toggleSelected(entryId, event),
    [handlers, entryId],
  );
  const onDragHandleMouseDown = useCallback(
    () => handlers.dragHandleMouseDown(containerId, index),
    [handlers, containerId, index],
  );
  const onDragHandleTouchStart = useCallback(
    (e: ReactTouchEvent<HTMLButtonElement>, sourceElement: HTMLDivElement | null) =>
      handlers.dragHandleTouchStart(entryId, e, sourceElement),
    [handlers, entryId],
  );
  const onDragStart = useCallback(
    (e: ReactDragEvent<HTMLDivElement>) => handlers.dragStart(containerId, index, entryId, e),
    [handlers, containerId, index, entryId],
  );
  const onDragOver = useCallback(
    (e: ReactDragEvent<HTMLDivElement>) => handlers.dragOver(containerId, index, e),
    [handlers, containerId, index],
  );
  const onDrop = useCallback(
    (e: ReactDragEvent<HTMLDivElement>) => handlers.drop(containerId, e),
    [handlers, containerId],
  );

  return (
    <LorebookEntryRow
      entry={entry}
      lorebookId={lorebookId}
      isExpanded={isExpanded}
      onToggleExpand={onToggleExpand}
      characters={characters}
      characterTags={characterTags}
      folders={folders}
      draggable={sortable && draggable}
      isDragging={sortable && isDragging}
      isDragReady={sortable && isDragReady}
      onDragHandleMouseDown={sortable ? onDragHandleMouseDown : noop}
      onDragHandleMouseUp={sortable ? handlers.dragHandleMouseUp : noop}
      onDragHandleTouchStart={sortable ? onDragHandleTouchStart : undefined}
      onDragStart={sortable ? onDragStart : noop}
      onDragOver={sortable ? onDragOver : noop}
      onDrop={sortable ? onDrop : noop}
      onDragEnd={sortable ? handlers.dragEnd : noop}
      selectionMode={selectionMode}
      isSelected={isSelected}
      onToggleSelected={onToggleSelected}
      previewMatch={previewMatch}
      activationStat={activationStat}
      mapBacklinks={mapBacklinks}
      onUpdateEntry={handlers.updateEntry}
    />
  );
});
