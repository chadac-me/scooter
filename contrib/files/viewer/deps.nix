# The viewer's browser assets, pinned by hash and fetched at BUILD time: the page
# must render behind a strict CSP and in a deployment with no egress, so a CDN
# <script> is not an option. Why not buildNpmPackage: PR #772.
#
# Upgrading: bump the version and paste the hash Nix reports as the mismatch.

{ lib, fetchurl, runCommand }:

let
  versions = {
    markdown-it = "15.0.2";
    dompurify = "3.4.17";
    highlight-js = "11.12.0";
  };

  # Both ship a browser build in the npm tarball, so the registry serves them.
  npmTarball = { pname, version, hash }: fetchurl {
    url = "https://registry.npmjs.org/${pname}/-/${pname}-${version}.tgz";
    inherit hash;
  };

  markdownItSrc = npmTarball {
    pname = "markdown-it";
    version = versions.markdown-it;
    hash = "sha256-Mjf17KxDL5lFPm2NNFtuR2SiLxeByW4C3J6Jd3ucI8E=";
  };

  dompurifySrc = npmTarball {
    pname = "dompurify";
    version = versions.dompurify;
    hash = "sha256-BWy9ridolyCLiMIdHXea36Ca175Iii9RCijpANO7/+c=";
  };

  # highlight.js is the exception: its npm tarball has no browser bundle, so the
  # built one comes from cdnjs's immutable per-version URL. Why safe: PR #772.
  hljsUrl = path:
    "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/${versions.highlight-js}/${path}";

  highlightJs = fetchurl {
    url = hljsUrl "highlight.min.js";
    hash = "sha256-ircesJxR9QHl4lFX2c/xAORswpvL/HRNC3RtRR/Kf1M=";
  };

  # The common bundle omits Nix, which is most of what this workspace holds; a
  # grammar is a standalone registration, so this is 3 kB rather than a rebundle.
  highlightNix = fetchurl {
    url = hljsUrl "languages/nix.min.js";
    hash = "sha256-s/tBSyY6Pnw8STpJ2i6fGqy8BiSPTL9cYkfDOMqv3zo=";
  };

  # BSD-3 wants the conditions reproduced; the bundle's banner has only the
  # copyright line, so the license text is fetched beside it.
  highlightLicense = fetchurl {
    url = "https://raw.githubusercontent.com/highlightjs/highlight.js/${versions.highlight-js}/LICENSE";
    hash = "sha256-bAgUMVkdnfaWyC3FmP4UI3ZbiimbIA7QCyga/Q9kxJA=";
  };
in
runCommand "scooter-files-vendor"
{
  meta.description = "Pinned browser assets for the scooter files viewer";
  # Read by the viewer's about-line, so a bug report names exact versions.
  passthru = { inherit versions; };
} ''
  mkdir -p $out/licenses

  # Explicit members: only the built browser file and the license belong in an image.
  tar xzf ${markdownItSrc} -O package/dist/browser/markdown-it.umd.min.js > $out/markdown-it.min.js
  tar xzf ${markdownItSrc} -O package/LICENSE > $out/licenses/markdown-it.txt

  tar xzf ${dompurifySrc} -O package/dist/purify.min.js > $out/purify.min.js
  tar xzf ${dompurifySrc} -O package/LICENSE > $out/licenses/dompurify.txt

  cp ${highlightJs} $out/highlight.min.js
  cp ${highlightNix} $out/highlight-nix.min.js
  cp ${highlightLicense} $out/licenses/highlight.js.txt

  # A non-empty file for each asset or the viewer ships a silently broken renderer.
  for f in markdown-it.min.js purify.min.js highlight.min.js highlight-nix.min.js; do
    test -s "$out/$f" || { echo "vendor asset $f is empty"; exit 1; }
  done

  cat > $out/VERSIONS <<EOF
markdown-it ${versions.markdown-it}
dompurify ${versions.dompurify}
highlight.js ${versions.highlight-js}
EOF
''
