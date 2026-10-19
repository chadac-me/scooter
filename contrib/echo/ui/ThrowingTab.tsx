// Fixture: a settings tab whose render throws, so test/e2e/contrib-settings-tab.spec.ts
// can assert the failure stays in its own tab. Never declared in contrib.nix; only a
// test manifest names it, so a real deployment never fetches this chunk.
export default function ThrowingTab(): never {
  throw new Error("echo ThrowingTab fixture: render failed on purpose");
}
