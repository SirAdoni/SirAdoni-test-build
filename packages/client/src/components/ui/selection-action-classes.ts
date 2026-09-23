// Shared classes for the buttons in a selection action bar, so no label ever shows as "Ex..." or "De...".
//
// Export and Delete (the bar's own buttons) are each an inline-size container: the label hides, kept for screen
// readers, whenever that one button is too narrow to show it whole. Two-button bars keep their words everywhere.
//
// Extra buttons a panel passes in (Tags, Move, Campaign, Enable, Disable) turn icon-only and content-sized on
// phones and in a narrow right panel (under 28rem), which leaves Export and Delete room for their labels. In a
// wider panel they share the row and, like Export and Delete, hide their label when their own width is too small.
// Every button carries title and aria-label so the icon-only state stays usable.

/** Export and Delete. */
export const SELECTION_ACTION_BUTTON_CLASS = "@container mari-chrome-control min-w-0 flex-1 px-2 py-2 text-xs";
export const SELECTION_ACTION_LABEL_CLASS = "truncate @max-[5rem]:sr-only";

/**
 * Panel extras. A size container cannot be content-sized (it would collapse to its padding), so the container
 * switches off exactly where the button turns flex-none.
 */
export const SELECTION_EXTRA_ACTION_BUTTON_CLASS =
  "@container mari-chrome-control min-w-0 flex-1 px-2 py-2 text-xs " +
  "max-[400px]:flex-none max-[400px]:[container-type:normal] " +
  "@max-[28rem]/panel:flex-none @max-[28rem]/panel:[container-type:normal]";
export const SELECTION_EXTRA_ACTION_LABEL_CLASS =
  "truncate max-[400px]:sr-only @max-[28rem]/panel:sr-only @max-[6rem]:sr-only";
