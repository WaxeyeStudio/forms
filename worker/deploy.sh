#!/usr/bin/env bash
#
# Deploy the Waxeye Forms worker to Cloudflare via the REST API.
# No wrangler/node required — only curl and python3.
#
#   CF_API_TOKEN=... ./deploy.sh
#
# The token needs, for the Waxeye account and the waxeye.co.nz zone:
#   Account → Workers Scripts → Edit
#   Zone    → Workers Routes  → Edit
#   Zone    → DNS             → Read   (pre-flight check only)
#
# Optional environment:
#   CF_ACCOUNT_ID         defaults to the Waxeye account
#   CF_ZONE_ID            defaults to the waxeye.co.nz zone
#   ESPOCRM_API_KEY       if set, uploaded as a Worker secret
#   WORKER_API_SECRET     if set, uploaded as a Worker secret
#   SKIP_ROUTE=1          skip the Worker route step
#   SKIP_DNS_CHECK=1      skip the DNS pre-flight check
#
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

CF_API_TOKEN="${CF_API_TOKEN:?Set CF_API_TOKEN to a Cloudflare token with Workers Scripts:Edit and Workers Routes:Edit}"
ACCOUNT_ID="${CF_ACCOUNT_ID:-69f23579a2e315b9b353aea97637d975}"   # Waxeye
ZONE_ID="${CF_ZONE_ID:-ba108fc5d7493f166d2ca4b329197de1}"          # waxeye.co.nz

SCRIPT_NAME="waxeye-forms"
ROUTE_PATTERN="forms.waxeye.co.nz/f/*"
ORIGIN_HOST="forms.waxeye.co.nz"

API="https://api.cloudflare.com/client/v4"

# Pretty-print an API response; exit non-zero on failure.
check() {
  python3 -c '
import json, sys
raw = sys.stdin.read()
try:
    d = json.loads(raw)
except Exception:
    print("Unexpected response:", raw[:400], file=sys.stderr)
    sys.exit(1)
if not d.get("success"):
    print("API error:", json.dumps(d.get("errors") or d.get("messages") or d), file=sys.stderr)
    sys.exit(1)
result = d.get("result")
print(json.dumps(result, indent=2)[:1200])
'
}

echo "==> Checking DNS record for $ORIGIN_HOST"
DNS_JSON="$(curl -sS "$API/zones/$ZONE_ID/dns_records?type=CNAME&name=$ORIGIN_HOST" \
  -H "Authorization: Bearer $CF_API_TOKEN" || true)"
printf '%s' "$DNS_JSON" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
records = d.get("result") or []
if records:
    r = records[0]
    print("    %s %s -> %s (proxied=%s)" % (r["type"], r["name"], r["content"], r["proxied"]))
else:
    print("    WARNING: no proxied CNAME found for this hostname;")
    print("             add one in the Cloudflare dashboard before traffic will reach the worker.")
'

echo "==> Uploading worker script \"$SCRIPT_NAME\""
META="$(mktemp)"
trap 'rm -f "$META"' EXIT
python3 - "$META" <<'PY'
import json, sys
metadata = {
    "main_module": "index.js",
    "compatibility_date": "2025-06-01",
    "bindings": [
        {"type": "plain_text", "name": "ESPOCRM_API_URL", "text": "https://forms.waxeye.co.nz/api/v1"},
        {"type": "plain_text", "name": "ESPOCRM_ENTITY", "text": "Lead"},
        {"type": "plain_text", "name": "ESPOCRM_SOURCE", "text": "Web Site"},
        {"type": "plain_text", "name": "ALLOWED_ORIGINS", "text": "*"},
    ],
}
with open(sys.argv[1], "w") as fh:
    json.dump(metadata, fh)
PY

curl -sS -X PUT "$API/accounts/$ACCOUNT_ID/workers/scripts/$SCRIPT_NAME" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -F "metadata=@$META;type=application/json" \
  -F "index.js=@src/index.js;type=application/javascript+module" | check

set_secret() {
  local name="$1" value="$2"
  echo "==> Setting secret $name"
  curl -sS -X PUT "$API/accounts/$ACCOUNT_ID/workers/scripts/$SCRIPT_NAME/secrets" \
    -H "Authorization: Bearer $CF_API_TOKEN" \
    -H "Content-Type: application/json" \
    --data "$(python3 -c 'import json,sys; print(json.dumps({"name": sys.argv[1], "text": sys.argv[2], "type": "secret_text"}))' "$name" "$value")" | check
}

if [ -n "${ESPOCRM_API_KEY:-}" ]; then
  set_secret ESPOCRM_API_KEY "$ESPOCRM_API_KEY"
else
  echo "==> Skipping ESPOCRM_API_KEY (not provided; submissions will return 503 until it is set)"
fi

if [ -n "${WORKER_API_SECRET:-}" ]; then
  set_secret WORKER_API_SECRET "$WORKER_API_SECRET"
fi

if [ "${SKIP_ROUTE:-0}" != "1" ]; then
  echo "==> Configuring route $ROUTE_PATTERN"
  ROUTE_ID="$(curl -sS "$API/zones/$ZONE_ID/workers/routes" \
    -H "Authorization: Bearer $CF_API_TOKEN" | python3 -c '
import json, sys
d = json.load(sys.stdin)
pattern = sys.argv[1]
if d.get("success"):
    for r in d.get("result") or []:
        if r.get("pattern") == pattern:
            print(r["id"])
            break
' "$ROUTE_PATTERN")"

  if [ -n "$ROUTE_ID" ]; then
    curl -sS -X PUT "$API/zones/$ZONE_ID/workers/routes/$ROUTE_ID" \
      -H "Authorization: Bearer $CF_API_TOKEN" -H "Content-Type: application/json" \
      --data "{\"pattern\":\"$ROUTE_PATTERN\",\"script\":\"$SCRIPT_NAME\"}" | check
  else
    curl -sS -X POST "$API/zones/$ZONE_ID/workers/routes" \
      -H "Authorization: Bearer $CF_API_TOKEN" -H "Content-Type: application/json" \
      --data "{\"pattern\":\"$ROUTE_PATTERN\",\"script\":\"$SCRIPT_NAME\"}" | check
  fi
fi

echo "==> Done"
