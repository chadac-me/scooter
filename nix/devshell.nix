# The developer shell shared by `.envrc` and `nix develop`, kept on the flake's
# single pinned nixpkgs so the sandbox image, its stubs and the dev tools resolve
# against the same package set.
{ pkgs, conversationRouter }:

pkgs.mkShell {
  packages = with pkgs; [
    # JS toolchain (agent-host + ui + tests)
    nodejs_22
    # The fast-e2e harness boots the router in front of agent-host, so it is prebuilt here.
    conversationRouter
    # The fast-e2e harness spins a throwaway local Postgres for the router's agent_host DB.
    postgresql_16
    # cluster tooling — local k8s + control
    kubectl
    kind
    k3d
    kubernetes-helm
    # image plumbing
    skopeo
    # the ACP agent the agent-host spawns
    goose-cli
    # Nix-wrapped Playwright browsers, since the downloaded ones fail on NixOS.
    playwright-driver.browsers
    # misc used by scripts/tests
    jq
    yq-go
    just
    # Atlas owns lib/sql; its dev Postgres is pulled on demand by scripts/atlas-dev.sh.
    atlas
    # `just db-generate` runs sqlacodegen via `uv run`, and uv needs a system Python on NixOS.
    python3
    uv
  ];
  shellHook = ''
    echo "kubenix-agent-manager dev shell"
    echo "  just            — task runner (test-quick, test, test-cluster, ...)"
    echo "  goose: $(command -v goose >/dev/null && goose --version 2>/dev/null | head -1 || echo absent)"
    export GOOSE_BIN="$(command -v goose || true)"
    # Point Playwright at the Nix browsers, whose pinned revision matches `@playwright/test` in package.json.
    export PLAYWRIGHT_BROWSERS_PATH="${pkgs.playwright-driver.browsers}"
    export PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1
    # playwright.config.ts reads PW_CHROME for launchOptions.executablePath; the glob survives a driver-revision bump.
    export PW_CHROME="$(echo "$PLAYWRIGHT_BROWSERS_PATH"/chromium-*/chrome-linux64/chrome | head -n1)"
    if [ ! -x "$PW_CHROME" ]; then
      # Fall back to the chrome-linux/chrome layout.
      export PW_CHROME="$(echo "$PLAYWRIGHT_BROWSERS_PATH"/chromium-*/chrome-linux/chrome | head -n1)"
    fi
    echo "  chrome (e2e): ''${PW_CHROME:-not found}"
    # uv's downloaded interpreters are dynamically linked and fail on NixOS.
    export UV_PYTHON_PREFERENCE=only-system
  '';
}
