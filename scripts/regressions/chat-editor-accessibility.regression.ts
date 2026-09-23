import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const privateNotebookSource = readFileSync(
  new URL("../../packages/client/src/components/chat/PrivateNotebookPanel.tsx", import.meta.url),
  "utf8",
);
const chatAreaSource = readFileSync(
  new URL("../../packages/client/src/components/chat/ChatArea.tsx", import.meta.url),
  "utf8",
);
const messageEditorSource = readFileSync(
  new URL("../../packages/client/src/components/chat/MessageEditTextarea.tsx", import.meta.url),
  "utf8",
);

assert.match(
  chatAreaSource,
  /type PrivateNotebookSession = \{[\s\S]*?opener: HTMLElement \| null;[\s\S]*?\};/u,
  "Private Notebook sessions must retain the exact toolbar control that opened them",
);
assert.match(
  chatAreaSource,
  /const opener =[\s\S]*?event\?\.currentTarget[\s\S]*?document\.activeElement[\s\S]*?setPrivateNotebookSession\(\{[\s\S]*?opener,/u,
  "Private Notebook opening must capture the activated control with a keyboard-safe fallback",
);
assert.match(
  privateNotebookSource,
  /const target = activeDraft[\s\S]*?editorRef\.current[\s\S]*?notebook\.isError[\s\S]*?retryButtonRef\.current[\s\S]*?closeButtonRef\.current/u,
  "Private Notebook must place initial focus in the editor, retry action, or safe loading control",
);
assert.match(
  privateNotebookSource,
  /if \(saved\) \{[\s\S]*?onClose\(\);[\s\S]*?restoreOpenerFocus\(\);[\s\S]*?\} else \{[\s\S]*?setTransitionPending\(false\);/u,
  "Private Notebook must restore opener focus only after a successful close",
);
assert.match(
  privateNotebookSource,
  /if \(!opener\?\.isConnected\) return;[\s\S]*?opener\.focus\(\{ preventScroll: true \}\)/u,
  "Private Notebook must not focus a stale opener",
);

assert.match(
  messageEditorSource,
  /messageRole === "user"[\s\S]*?editUserMessage[\s\S]*?messageRole === "assistant"[\s\S]*?editAssistantMessage[\s\S]*?messageRole === "narrator"[\s\S]*?editNarratorMessage[\s\S]*?editSystemMessage/u,
  "The shared message editor must derive a localized accessible name for every message role",
);
assert.match(
  messageEditorSource,
  /<textarea[\s\S]*?aria-label=\{editorAccessibleLabel\}/u,
  "The shared Conversation, Roleplay, and Game textarea must expose its role-aware accessible name",
);

process.stdout.write("Chat editor accessibility regression checks passed.\n");
