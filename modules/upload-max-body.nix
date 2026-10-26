# The request body limit that scooter.uploads implies, as an nginx size ("144m").
#
# A message carries up to maxFilesPerMessage files, each up to maxFileBytes, sent
# base64-encoded (4/3) inside the AG-UI JSON. The headroom (10% of the payload, at
# least 1MiB) covers the envelope, the message text and the thread history the client
# resends. Rounded up to whole MiB. The ui nginx (`client_max_body_size`) and the
# ingress-nginx annotation both use it, and pkgs/ui-image/nginx.nix defaults to the
# value for the defaults (4 x 25MiB = 144m).
{ maxFileBytes, maxFilesPerMessage }:
let
  mib = 1024 * 1024;
  ceilDiv = a: b: (a + b - 1) / b;
  payload = maxFilesPerMessage * maxFileBytes;
  encoded = ceilDiv (payload * 4) 3;
  headroom = let tenth = ceilDiv payload 10; in if tenth > mib then tenth else mib;
in
"${toString (ceilDiv (encoded + headroom) mib)}m"
