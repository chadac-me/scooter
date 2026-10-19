// Lint fixture: breaks the contrib-tab import boundary on purpose, once per way out.
// eslint.contrib.test.ts asserts ESLint rejects each import. Not a tab: the module
// table only globs ui/*.tsx, and the normal lint run ignores this directory.
import { viewStore } from "@/src/view";
import { sessionStore } from "../../../../ui/src/sessions";

export default function EscapesBoundary() {
  return <div>{String(viewStore) + String(sessionStore)}</div>;
}
