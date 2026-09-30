import ts from "typescript";
const markers = ["about-me-keeper", "About Me Keeper", "aboutMeKeeper"];
const retiredIds =
  '["about-me-keeper","prompt-reviewer","response-orchestrator","schedule-planner","chat-summary","autonomous-messenger","youtube","secret-plot-driver"]';
const identifier = "[A-Za-z_$][\\w$]*";
const escapedIds = retiredIds.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const migrationInitializer = new RegExp(`(${identifier})=${escapedIds},(${identifier})=new Set\\(\\1\\)`, "g");

export function containsPackagedAboutMeAgent(contents, generatedPayload = false) {
  if (!generatedPayload || !contents.includes(retiredIds)) return markers.some((marker) => contents.includes(marker));
  const source = ts.createSourceFile("bundle.js", contents, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const identifiers = [];
  const visit = (node) => {
    if (ts.isIdentifier(node)) identifiers.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  const inspected = contents.replace(migrationInitializer, (initializer, array, set, offset) => {
    if (array === set) return initializer;
    const counts = { [array]: 0, [set]: 0 };
    for (const node of identifiers) {
      if (node.text !== array && node.text !== set) continue;
      const start = node.getStart(source);
      if (start >= offset && start < offset + initializer.length) {
        counts[node.text]++;
      } else if (!(ts.isVariableDeclaration(node.parent) && node.parent.name === node && !node.parent.initializer)) {
        // Any use outside the exact initializer is an active reference, not dead metadata.
        return initializer;
      }
    }
    return counts[array] === 2 && counts[set] === 1 ? initializer.replace(retiredIds, "[]") : initializer;
  });
  return markers.some((marker) => inspected.includes(marker));
}
