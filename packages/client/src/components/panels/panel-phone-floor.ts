// Phone floor for side panels. On narrow screens and coarse pointers every
// control inside a panel gets a 36px hit area and no text renders below the
// 0.6875rem label size. Desktop with a fine pointer is untouched.
//
// Tailwind only generates classes it can read literally, so both media
// variants are spelled out. Compact inline controls opt out of the hit area
// with data-touch-compact, matching the shell rule in globals.css. The
// utilities are important because the unlayered mari-chrome-* control
// classes would otherwise win over any layered Tailwind utility.
export const PANEL_PHONE_FLOOR_CLASS = [
  "max-md:[&_button:not([data-touch-compact])]:min-h-9!",
  "max-md:[&_button:not([data-touch-compact])]:min-w-9!",
  "max-md:[&_select:not([data-touch-compact])]:min-h-9!",
  "max-md:[&_input:is([type=text],[type=search],[type=number],:not([type])):not([data-touch-compact])]:min-h-9!",
  "pointer-coarse:[&_button:not([data-touch-compact])]:min-h-9!",
  "pointer-coarse:[&_button:not([data-touch-compact])]:min-w-9!",
  "pointer-coarse:[&_select:not([data-touch-compact])]:min-h-9!",
  "pointer-coarse:[&_input:is([type=text],[type=search],[type=number],:not([type])):not([data-touch-compact])]:min-h-9!",
  "max-md:[&_[class*='text-[0.5']]:text-[0.6875rem]!",
  "max-md:[&_[class*='text-[0.6rem]']]:text-[0.6875rem]!",
  "max-md:[&_[class*='text-[0.625rem]']]:text-[0.6875rem]!",
  "max-md:[&_[class*='text-[0.65rem]']]:text-[0.6875rem]!",
  "max-md:[&_[class*='text-[10px]']]:text-[0.6875rem]!",
  "pointer-coarse:[&_[class*='text-[0.5']]:text-[0.6875rem]!",
  "pointer-coarse:[&_[class*='text-[0.6rem]']]:text-[0.6875rem]!",
  "pointer-coarse:[&_[class*='text-[0.625rem]']]:text-[0.6875rem]!",
  "pointer-coarse:[&_[class*='text-[0.65rem]']]:text-[0.6875rem]!",
  "pointer-coarse:[&_[class*='text-[10px]']]:text-[0.6875rem]!",
  "max-md:[&_.mari-folder-helper]:text-[0.6875rem]!",
  "max-md:[&_.mari-chrome-control--compact]:text-[0.6875rem]!",
  "pointer-coarse:[&_.mari-folder-helper]:text-[0.6875rem]!",
  "pointer-coarse:[&_.mari-chrome-control--compact]:text-[0.6875rem]!",
  // Switches are a label around a visually hidden checkbox; the label gets an
  // invisible hit area so the 20px track stays the same size.
  "max-md:[&_label:has(>input.sr-only)]:before:absolute",
  "max-md:[&_label:has(>input.sr-only)]:before:-inset-y-2",
  "max-md:[&_label:has(>input.sr-only)]:before:-inset-x-1",
  "max-md:[&_label:has(>input.sr-only)]:before:content-['']",
  "pointer-coarse:[&_label:has(>input.sr-only)]:before:absolute",
  "pointer-coarse:[&_label:has(>input.sr-only)]:before:-inset-y-2",
  "pointer-coarse:[&_label:has(>input.sr-only)]:before:-inset-x-1",
  "pointer-coarse:[&_label:has(>input.sr-only)]:before:content-['']",
].join(" ");

// Row titles in side-panel lists: phones give the name two lines instead of
// cutting it to a few letters next to the row actions.
export const PANEL_ROW_NAME_WRAP_CLASS = [
  "max-md:line-clamp-2 max-md:whitespace-normal max-md:[overflow-wrap:break-word]",
  "pointer-coarse:line-clamp-2 pointer-coarse:whitespace-normal pointer-coarse:[overflow-wrap:break-word]",
].join(" ");
