#!/usr/bin/env bash
#
# Deploy the Waxeye Forms worker to Cloudflare via the REST API.
# No wrangler/node required — only curl and python3.
#
#   CF_API_TOKEN=... ./deploy.sh
#
# What it does:
#   1. Ensures the `waxeye-forms-config` KV namespace exists
#   2. Syncs clients.json into that namespace (key `client:{slug}`, upsert only)
#   3. Uploads the worker script with its vars and bindings
#   4. Uploads ESPOCRM_API_KEY / WORKER_API_SECRET secrets when provided
#   5. Creates (or updates) the route forms.waxeye.co.nz/f/*
#
# The token needs, for the Waxeye account and the waxeye.co.nz zone:
#   Account → Workers Scripts      → Edit
#   Account → Workers KV Storage   → Edit
#   Zone    → Workers Routes       → Edit
#   Zone    → DNS                  → Read   (pre-flight check only)
#
# Optional environment:
#   CF_ACCOUNT_ID         defaults to the Waxeye account
#   CF_ZONE_ID            defaults to the waxeye.co.nz zone
#   ESPOCRM_API_KEY       if set, uploaded as a Worker secret
#   WORKER_API_SECRET     if set, uploaded as a Worker secret
#   SKIP_KV_SYNC=1        skip step 2 (keep the current KV contents)
#   SKIP_ROUTE=1          skip step 5
#   SKIP_DNS_CHECK=1      skip the DNS pre-flight check
#
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

CF_API_TOKEN="${CF_API_TOKEN:?Set CF_API_TOKEN to a Cloudflare token with Workers Scripts:Edit, Workers KV Storage:Edit and Workers Routes:Edit}"
export CF_API_TOKEN
ACCOUNT_ID="${CF_ACCOUNT_ID:-69f23579a2e315b9b353aea97637d975}"   # Waxeye
ZONE_ID="${CF_ZONE_ID:-ba108fc5d7493f166d2ca4b329197de1}"          # waxeye.co.nz

SCRIPT_NAME="waxeye-forms"
KV_TITLE="waxeye-forms-config"
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

if [ "${SKIP_DNS_CHECK:-0}" != "1" ]; then
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
fi

echo "==> Ensuring KV namespace \"$KV_TITLE\" and syncing clients.json"
if [ "${SKIP_KV_SYNC:-0}" = "1" ]; then
  NS_ID="$(python3 - "$ACCOUNT_ID" <<'PY'
import json, os, sys, urllib.error, urllib.request

account = sys.argv[1]
token = os.environ["CF_API_TOKEN"]
api = "https://api.cloudflare.com/client/v4"

req = urllib.request.Request(
    f"{api}/accounts/{account}/storage/kv/namespaces?per_page=100",
    headers={"Authorization": f"Bearer {token}"},
)
with urllib.request.urlopen(req) as resp:
    listing = json.load(resp)
for ns in listing.get("result") or []:
    if ns.get("title") == "waxeye-forms-config":
        print(ns["id"])
        break
PY
)"
  [ -n "$NS_ID" ] || { echo "ERROR: KV namespace not found (needed when SKIP_KV_SYNC=1)" >&2; exit 1; }
else
  NS_ID="$(python3 - "$ACCOUNT_ID" <<'PY'
import json, os, sys, urllib.error, urllib.request

account = sys.argv[1]
token = os.environ["CF_API_TOKEN"]
api = "https://api.cloudflare.com/client/v4"
title = "waxeye-forms-config"

def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        api + path, data=data, method=method,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as e:
        print(f"HTTP {e.code} on {method} {path}: {e.read().decode()[:400]}", file=sys.stderr)
        sys.exit(1)

ns_id = ""
listing = call("GET", f"/accounts/{account}/storage/kv/namespaces?per_page=100")
for ns in listing.get("result") or []:
    if ns.get("title") == title:
        ns_id = ns["id"]
        break

if not ns_id:
    created = call("POST", f"/accounts/{account}/storage/kv/namespaces", {"title": title})
    if not created.get("success"):
        print("ERROR creating namespace: " + json.dumps(created.get("errors")), file=sys.stderr)
        sys.exit(1)
    ns_id = created["result"]["id"]
    print(f"    created namespace {ns_id}", file=sys.stderr)
else:
    print(f"    using namespace {ns_id}", file=sys.stderr)

with open("clients.json") as fh:
    clients = json.load(fh)

pairs = [{"key": f"client:{slug}", "value": json.dumps(cfg)} for slug, cfg in clients.items()]
if pairs:
    written = call("PUT", f"/accounts/{account}/storage/kv/namespaces/{ns_id}/bulk", pairs)
    if not written.get("success"):
        print("ERROR syncing clients.json: " + json.dumps(written.get("errors")), file=sys.stderr)
        sys.exit(1)
    failed = (written.get("result") or {}).get("unsuccessful_keys") or []
    if failed:
        print("ERROR syncing keys: " + json.dumps(failed), file=sys.stderr)
        sys.exit(1)
    print(f"    synced {len(pairs)} client(s): {', '.join(clients.keys())}", file=sys.stderr)
else:
    print("    clients.json is empty — no client slugs will be accepted", file=sys.stderr)

print(ns_id)
PY
)"
fi
echo "    namespace id: $NS_ID"

write_metadata() { # $1 = output file, $2 = namespace id, $3 = include rate limiter (1/0)
  python3 - "$1" "$2" "$3" <<'PY'
import json, sys

out, ns_id, include_rl = sys.argv[1], sys.argv[2], sys.argv[3] == "1"
bindings = [
    {"type": "plain_text", "name": "ESPOCRM_API_URL", "text": "https://forms.waxeye.co.nz/api/v1"},
    {"type": "plain_text", "name": "ESPOCRM_ENTITY", "text": "Lead"},
    {"type": "plain_text", "name": "ESPOCRM_SOURCE", "text": "Web Site"},
    {"type": "plain_text", "name": "ALLOWED_ORIGINS", "text": "*"},
    {"type": "kv_namespace", "name": "FORMS_CONFIG", "namespace_id": ns_id},
]
if include_rl:
    bindings.append({
        "type": "ratelimit",
        "name": "RATE_LIMITER",
        "namespace_id": "1001",
        "simple": {"limit": 10, "period": 60},
    })

with open(out, "w") as fh:
    json.dump({
        "main_module": "index.js",
        "compatibility_date": "2025-06-01",
        "bindings": bindings,
    }, fh)
PY
}

upload_worker() { # $1 = metadata file
  curl -sS -X PUT "$API/accounts/$ACCOUNT_ID/workers/scripts/$SCRIPT_NAME" \
    -H "Authorization: Bearer $CF_API_TOKEN" \
    -F "metadata=@$1;type=application/json" \
    -F "index.js=@src/index.js;type=application/javascript+module"
}

echo "==> Uploading worker script \"$SCRIPT_NAME\""
META="$(mktemp)"
trap 'rm -f "$META"' EXIT

write_metadata "$META" "$NS_ID" 1
if ! upload_worker "$META" | check; then
  echo "WARNING: upload with the RATE_LIMITER binding failed; retrying without it" >&2
  write_metadata "$META" "$NS_ID" 0
  upload_worker "$META" | check
fi

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
