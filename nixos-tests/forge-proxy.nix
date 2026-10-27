# nixosTest: sandbox git/gh/glab reach a fake forge only via the broker.

{ pkgs, lib, sandboxModule, broker }:

let
  PORT = 3129;
  GITHUB_TOKEN = "ghs_real-github-token-the-sandbox-never-sees";
  GITLAB_TOKEN = "glpat-real-gitlab-token-the-sandbox-never-sees";
  SANDBOX_TOKEN = "sandbox-sa-token";
  # Must match the contribs' ForgeHosts; the harness checks this.
  forgeHosts = [ "api.github.com" "github.com" "gitlab.com" "uploads.github.com" ];
  upstreamHosts = forgeHosts ++ [ "other.test" ];

  # An application, so its deps plus its own site-packages.
  python = pkgs.python3.withPackages (_: broker.dependencies);
  brokerPath = "${broker}/${pkgs.python3.sitePackages}";

  # The broker's forge CA, plus a CA for the fake forge.
  certs = pkgs.runCommand "forge-proxy-test-certs" { nativeBuildInputs = [ python pkgs.openssl ]; } ''
    mkdir $out
    PYTHONPATH=${brokerPath} python3 - $out ${lib.escapeShellArgs forgeHosts} <<'PY'
    import sys
    from broker.forge.ca import generate_ca
    out, hosts = sys.argv[1], sys.argv[2:]
    ca = generate_ca(hosts)
    open(f"{out}/ca.crt", "wb").write(ca.cert_pem)
    open(f"{out}/ca.key", "wb").write(ca.key_pem)
    open(f"{out}/hosts", "w").write("\n".join(hosts) + "\n")
    PY
    cd $out
    openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 3650 \
      -subj /CN=fake-forge-ca -addext keyUsage=critical,keyCertSign,cRLSign \
      -keyout upstream-ca.key -out upstream-ca.crt
    openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
      -subj /CN=fake-forge -keyout forge.key -out forge.csr
    # Python's X509_STRICT default needs the AKI and explicit usages.
    cat > san.ext <<EXT
    subjectAltName=${lib.concatMapStringsSep "," (h: "DNS:${h}") upstreamHosts}
    basicConstraints=critical,CA:FALSE
    keyUsage=critical,digitalSignature
    extendedKeyUsage=serverAuth
    authorityKeyIdentifier=keyid,issuer
    EXT
    openssl x509 -req -in forge.csr -CA upstream-ca.crt -CAkey upstream-ca.key -CAcreateserial \
      -days 3650 -extfile san.ext -out forge.crt
  '';

  fixtures = ./fixtures/forge-proxy;
in
pkgs.testers.runNixOSTest {
  name = "dev-env-forge-proxy";
  globalTimeout = 900;

  nodes = {
    forge = { ... }: {
      networking.firewall.allowedTCPPorts = [ 443 ];
      systemd.services.fake-forge = {
        wantedBy = [ "multi-user.target" ];
        after = [ "network.target" ];
        path = [ pkgs.git ];
        environment = {
          inherit GITHUB_TOKEN GITLAB_TOKEN;
          FORGE_ROOT = "/srv/git";
          FORGE_LOG = "/var/log/fake-forge.jsonl";
          TLS_CERT = "${certs}/forge.crt";
          TLS_KEY = "${certs}/forge.key";
        };
        serviceConfig.ExecStart = "${pkgs.python3}/bin/python3 ${fixtures}/fake-forge.py";
      };
      environment.systemPackages = [ pkgs.git pkgs.jq ];
    };

    broker = { nodes, ... }: {
      networking.firewall.allowedTCPPorts = [ PORT ];
      # The forge hostnames resolve to the fake forge.
      networking.hosts.${nodes.forge.networking.primaryIPAddress} = forgeHosts;
      systemd.services.forge-proxy = {
        wantedBy = [ "multi-user.target" ];
        after = [ "network.target" ];
        environment = {
          inherit GITHUB_TOKEN GITLAB_TOKEN SANDBOX_TOKEN;
          CERTS = "${certs}";
          PORT = toString PORT;
          PYTHONPATH = "${fixtures}:${brokerPath}";
          GITHUB_FORGE_POLICY = "forge_test_policy:DenyLocked";
        };
        serviceConfig.ExecStart = "${python}/bin/python3 ${fixtures}/harness.py";
      };
    };

    sandbox = { nodes, ... }: {
      imports = [ sandboxModule ];
      # Only the non-forge host resolves here.
      networking.hosts.${nodes.forge.networking.primaryIPAddress} = [ "other.test" ];
      # Stands in for the scooter-forge-ca ConfigMap mount.
      environment.etc."scooter/forge-ca/ca.crt".source = "${certs}/ca.crt";
      environment.etc."scooter/forge-ca/hosts".source = "${certs}/hosts";
      # Stands in for the pod env and projected SA token.
      systemd.services.scooter-forge-shim.environment.FORGE_PROXY_ADDR = "broker:${toString PORT}";
      systemd.tmpfiles.rules = [
        "d /run/secrets/broker 0755 root root -"
        "f /run/secrets/broker/token 0444 root root - ${SANDBOX_TOKEN}"
      ];
      environment.variables = {
        HTTPS_PROXY = "http://127.0.0.1:3128";
        https_proxy = "http://127.0.0.1:3128";
        NO_PROXY = "localhost,127.0.0.1,::1";
        no_proxy = "localhost,127.0.0.1,::1";
        SSL_CERT_FILE = "/etc/ssl/certs/ca-certificates.crt";
        GIT_SSL_CAINFO = "/etc/ssl/certs/ca-certificates.crt";
        CURL_CA_BUNDLE = "/etc/ssl/certs/ca-certificates.crt";
        GH_TOKEN = "scooter-forge-proxy";
        GITLAB_TOKEN = "scooter-forge-proxy";
        GH_NO_UPDATE_NOTIFIER = "1";
        GH_PROMPT_DISABLED = "1";
        GLAB_CHECK_UPDATE = "false";
      };
      environment.systemPackages = [ pkgs.gh pkgs.glab pkgs.git pkgs.curl pkgs.jq ];
    };
  };

  testScript = ''
    import json, shlex

    start_all()

    def boot(node, unit, port):
        try:
            node.wait_for_unit(unit, timeout=120)
            node.wait_for_open_port(port, timeout=60)
        except Exception:
            node.execute(f"journalctl -u {unit} --no-pager | tail -60 >&2")
            raise

    def sb(cmd):
        return sandbox.succeed("bash -lc " + shlex.quote(cmd))

    def sb_fail(cmd):
        return sandbox.fail("bash -lc " + shlex.quote(cmd))

    def forge_log():
        raw = forge.succeed("cat /var/log/fake-forge.jsonl 2>/dev/null || true")
        return [json.loads(l) for l in raw.splitlines() if l.strip()]

    def bare(host, repo):
        forge.succeed(
            f"git init -q --bare -b main /srv/git/{host}/{repo}.git"
            f" && git -C /srv/git/{host}/{repo}.git config http.receivepack true"
        )

    def seed(host, repo):
        bare(host, repo)
        forge.succeed(
            f"rm -rf /tmp/seed && git init -q -b main /tmp/seed"
            f" && git -C /tmp/seed -c user.name=s -c user.email=s@x commit -q --allow-empty -m seed"
            f" && git -C /tmp/seed push -q /srv/git/{host}/{repo}.git main"
        )

    boot(forge, "fake-forge.service", 443)
    boot(broker, "forge-proxy.service", ${toString PORT})
    sandbox.wait_for_unit("multi-user.target", timeout=180)
    sandbox.wait_for_unit("scooter-forge-shim.service", timeout=60)
    sandbox.wait_for_open_port(3128, timeout=60)

    seed("github.com", "acme/demo")
    seed("github.com", "acme/locked")
    seed("gitlab.com", "acme/demo")
    sb("git config --global user.name agent && git config --global user.email agent@x")

    with subtest("the forge hosts do not resolve in the sandbox"):
        sb_fail("getent hosts github.com")

    with subtest("the forge CA is trusted by the system bundle"):
        sb("grep -q \"$(sed -n 2p /etc/scooter/forge-ca/ca.crt)\" /etc/ssl/certs/ca-certificates.crt")

    with subtest("git clone and push to github.com go through the proxy"):
        sb("git clone -q https://github.com/acme/demo.git /tmp/gh-demo")
        sb("cd /tmp/gh-demo && git commit -q --allow-empty -m from-sandbox && git push -q origin main")
        head = forge.succeed("git -C /srv/git/github.com/acme/demo.git log -1 --format=%s main").strip()
        assert head == "from-sandbox", head

    with subtest("git clone and push to gitlab.com go through the proxy"):
        sb("git clone -q https://gitlab.com/acme/demo.git /tmp/gl-demo")
        sb("cd /tmp/gl-demo && git commit -q --allow-empty -m from-sandbox-gl && git push -q origin main")
        head = forge.succeed("git -C /srv/git/gitlab.com/acme/demo.git log -1 --format=%s main").strip()
        assert head == "from-sandbox-gl", head

    with subtest("gh and glab authenticate with the placeholder tokens"):
        assert sb("gh api user --jq .login").strip() == "forge-test"
        # glab prints release notes on stderr.
        assert sb("glab api user 2>/dev/null | jq -r .username").strip() == "forge-test"

    with subtest("the forge policy denies a push and nothing reaches the forge"):
        sb("git clone -q https://github.com/acme/locked.git /tmp/locked")
        before = forge.succeed("git -C /srv/git/github.com/acme/locked.git rev-parse main")
        out = sb_fail("cd /tmp/locked && git commit -q --allow-empty -m nope && git push origin main 2>&1")
        print(out)
        after = forge.succeed("git -C /srv/git/github.com/acme/locked.git rev-parse main")
        assert before == after
        # The deny lands on info/refs?service=git-receive-pack.
        assert not any(
            r["path"].startswith("/acme/locked.git/") and "receive-pack" in r["path"] + r["query"]
            for r in forge_log()
        ), "a denied push reached the forge"
        broker.succeed("journalctl -u forge-proxy --no-pager | grep -q 'acme/locked is read-only'")

    with subtest("a bad sandbox token gets 407 from the broker"):
        code = sb(
            "curl -s -o /dev/null -w '%{http_connect}' --proxy http://broker:${toString PORT}"
            " --proxy-header 'Proxy-Authorization: Bearer bogus' https://github.com/ || true"
        ).strip()
        assert code == "407", code

    with subtest("a non-forge host is tunnelled directly, not through the broker"):
        assert sb("curl -fsS --cacert ${certs}/upstream-ca.crt https://other.test/").strip() == "direct"
        broker.fail("journalctl -u forge-proxy --no-pager | grep -q other.test")

    with subtest("the forge saw only the real tokens, never the sandbox placeholder"):
        log = forge_log()
        forge_hits = [r for r in log if r["host"] != "other.test"]
        assert forge_hits, "nothing reached the forge"
        for r in log:
            assert "scooter-forge-proxy" not in r["authorization"] + r["private_token"], r
        assert all(r["authorization"] == "" for r in log if r["host"] == "other.test")
  '';
}
