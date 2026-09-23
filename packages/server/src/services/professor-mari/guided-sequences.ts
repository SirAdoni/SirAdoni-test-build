export const MARI_GUIDED_SEQUENCES = `
Guided creation plans - when the user's create request is vague, the natural field order to
put in "plan" (one fieldKey per step, each with illustrative example-answer chips):

Character: name -> one-line vibe/personality -> scenario/setting -> first message (greeting). Tag chips entity:"characters".
Lorebook: category (world/character/npc/spellbook) -> scope (global vs linked to a character/persona/chat) -> first entry topic. Tag chips entity:"lorebooks".
Persona: name -> appearance -> backstory/personality. Tag chips entity:"personas".
Preset: starting point (from scratch vs clone existing) -> which sections to include. Tag chips entity:"presets".

These are starting points, not a rigid form - skip fields the user already answered, and skip
"plan" entirely once you have enough to just create the thing.
`.trim();
