# Waxeye Forms — Cloudflare Worker

Public form-submission endpoint for client websites:

```
POST https://forms.waxeye.co.nz/f/{client-slug}
```

The worker looks the slug up in its KV config (default-deny: unknown slugs are
rejected), applies that client's rate limit and origin allowlist, validates the
submission, and creates a record in EspoCRM through its REST API. Everything
else on `forms.waxeye.co.nz` — the EspoCRM UI and EspoCRM's own `/api/v1` —
passes straight through to the origin (Laravel Forge → Docker).

```
client website form  →  Cloudflare Worker (/f/*)  →  EspoCRM REST API  →  CRM record
EspoCRM admin UI     →  (worker not involved)     →  Forge origin
```

## Files

| File | Purpose |
|---|---|
| `src/index.js` | The worker (plain ES module + JSDoc; no build step) |
| `clients.json` | Client config, synced to KV by `deploy.sh` |
| `deploy.sh` | Deploys via the Cloudflare REST API (curl + python3) |
| `wrangler.toml` | Routes, vars, and bindings for a normal `wrangler deploy` |
| `examples/form-example.html` | Copy-paste client form that posts to the endpoint |
| `.dev.vars.example` | Template for local development secrets |

## Onboarding a client

1. Add an entry to `clients.json`:

   ```json
   {
     "acme": {
       "origins": ["https://acme.co.nz", "https://www.acme.co.nz"],
       "enabled": true
     }
   }
   ```

2. Run `CF_API_TOKEN=... ./deploy.sh` — it syncs `clients.json` into the
   `waxeye-forms-config` KV namespace.

3. Point the client's form at `https://forms.waxeye.co.nz/f/acme`, using
   `examples/form-example.html` as the template.

Config keys per client:

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Set `false` to reject the client's submissions (403) without deleting config |
| `origins` | falls back to the worker's `ALLOWED_ORIGINS` | Browser origins allowed to post. `["*"]` allows any. |
| `entity` | falls back to `ESPOCRM_ENTITY` | EspoCRM entity for records |
| `source` | falls back to `ESPOCRM_SOURCE` | Value of the record's `source` field |

Notes: config changes propagate within ~60 s (KV edge cache). `deploy.sh` only
upserts — removing an entry from `clients.json` does not delete it from KV; set
`enabled: false` or delete the key. `testclient` in `clients.json` is a
smoke-test slug with `origins: ["*"]`.

## Deploying

### Option A — API deploy (no toolchain required)

```bash
cd worker
CF_API_TOKEN=... ./deploy.sh
```

The token needs, for the Waxeye account and the `waxeye.co.nz` zone:

- **Account → Workers Scripts → Edit**
- **Account → Workers KV Storage → Edit**
- **Zone → Workers Routes → Edit**
- **Zone → DNS → Read** (pre-flight check only)

The script ensures the KV namespace, syncs `clients.json`, uploads
`src/index.js` with its bindings (KV + rate limiter), optionally uploads
`ESPOCRM_API_KEY` / `WORKER_API_SECRET` secrets, and creates/updates the route
`forms.waxeye.co.nz/f/*`. If the rate-limiter binding is rejected by the API it
retries without it and the worker runs without rate limiting.

### Option B — wrangler (once a dev environment with Node is available)

```bash
cd worker
npx wrangler deploy
npx wrangler secret put ESPOCRM_API_KEY
```

## Cloudflare edge setup

1. **DNS** — a proxied `CNAME forms.waxeye.co.nz -> waxeye.co.nz` (or an `A`
   record to the Forge server IP) must exist. It is in place.
2. **Worker route** — `forms.waxeye.co.nz/f/*` → `waxeye-forms`. Created by
   `deploy.sh`. Other paths on the hostname go to the Forge origin.
3. **KV namespace** — `waxeye-forms-config`, created by `deploy.sh`.
4. **Rate limiting** — built into the worker (10 requests / 60 s per client per
   IP, applied to public callers only; server callers with a valid
   `X-Worker-Secret` are exempt). A Cloudflare WAF rate-limiting rule on `/f/`
   is still worth adding as a second layer.
5. **Origin certificate** — the Forge site for `forms.waxeye.co.nz` needs a
   Let's Encrypt certificate so Cloudflare can reach the origin over HTTPS.

## EspoCRM setup

1. **API user** — in EspoCRM go to *Administration → API Users → Create API
   User*. Set the authentication method to **API Key** and give it a key.
2. **Role** — create a role with `Lead` → *create: yes* and assign it to the
   API user.
3. **Secret** — store the API key as the worker secret `ESPOCRM_API_KEY`:

   ```bash
   CF_API_TOKEN=... ESPOCRM_API_KEY=<key> ./deploy.sh
   # or
   npx wrangler secret put ESPOCRM_API_KEY
   ```

4. **Per-client field (optional)** — add a custom field to the Lead entity
   (*Administration → Entity Manager → Lead → Add Field*, e.g. `cClient`) and
   set `ESPOCRM_CLIENT_FIELD = "cClient"` so records carry the client slug as a
   field. Without it, the slug still appears in the record description.

## Configuration reference

Worker vars (set by `deploy.sh` / `wrangler.toml`):

| Var | Default | Purpose |
|---|---|---|
| `ESPOCRM_API_URL` | `https://forms.waxeye.co.nz/api/v1` | EspoCRM REST API base |
| `ESPOCRM_ENTITY` | `Lead` | Fallback entity to create |
| `ESPOCRM_SOURCE` | `Web Site` | Fallback value for the `source` field |
| `ALLOWED_ORIGINS` | `*` | Fallback origin allowlist for clients without `origins` |
| `ESPOCRM_CLIENT_FIELD` | *(unset)* | Custom field receiving the client slug |
| `REQUIRE_SECRET` | `false` | `true` requires `X-Worker-Secret` on every request |

Bindings:

| Binding | Purpose |
|---|---|
| `FORMS_CONFIG` (KV) | Client config, key `client:{slug}` |
| `RATE_LIMITER` | Per (client, IP) rate limiting, 10 requests / 60 s |

Secrets:

| Secret | Purpose |
|---|---|
| `ESPOCRM_API_KEY` | EspoCRM API user key. Required. |
| `WORKER_API_SECRET` | Optional shared secret for server-to-server callers. |

## Calling the endpoint

`POST /f/{client}` accepts JSON, urlencoded, or multipart bodies. Recognised
fields (all optional, but a submission with none of them is rejected):

`name` (or `first_name` + `last_name`), `email`, `phone`, `message`,
`company`, `website`, `subject`, `form` (form name, recorded in the
description).

Unknown fields are preserved in the record description under "Extra fields".

Responses:

| Status | Body | Meaning |
|---|---|---|
| 200 | `{"ok":true,"id":"..."}` | Stored in EspoCRM |
| 200 | `{"ok":true}` | Honeypot filled — silently dropped |
| 400 | `{"ok":false,"error":"invalid_body"}` | Body was not JSON/urlencoded/multipart |
| 401 | `{"ok":false,"error":"unauthorized"}` | `REQUIRE_SECRET` is on and the secret is wrong/missing |
| 403 | `{"ok":false,"error":"client_disabled"}` | Client exists but `enabled: false` |
| 403 | `{"ok":false,"error":"origin_not_allowed"}` | Browser Origin not in the allowlist |
| 404 | `{"ok":false,"error":"unknown_client"}` | Slug not in KV config |
| 405 | `{"ok":false,"error":"method_not_allowed"}` | Not GET/POST/OPTIONS |
| 413 | `{"ok":false,"error":"payload_too_large"}` | Body over 64 KB |
| 422 | `{"ok":false,"error":"invalid_email"}` / `empty_submission` | Validation failed |
| 429 | `{"ok":false,"error":"rate_limited"}` | Over 10 requests / 60 s |
| 502 | `{"ok":false,"error":"upstream_rejected"}` | EspoCRM refused the record |
| 503 | `{"ok":false,"error":"service_not_configured"}` | `ESPOCRM_API_KEY` secret (or KV binding) missing |
| 503 | `{"ok":false,"error":"service_unavailable"}` | KV/config read failed |

`GET /f/{client}` returns
`{"ok":true,"service":"waxeye-forms","client":"...","enabled":true}` — handy as
a per-client liveness check. It returns 404 for unknown slugs.

### Testing with curl

```bash
curl -s https://forms.waxeye.co.nz/f/testclient

curl -s -X POST https://forms.waxeye.co.nz/f/testclient \
  -H 'Content-Type: application/json' \
  -d '{"name":"Test Person","email":"test@example.com","message":"Hello from curl"}'

curl -s https://forms.waxeye.co.nz/f/not-a-real-client   # -> 404 unknown_client
```

## Local development

```bash
cd worker
cp .dev.vars.example .dev.vars   # add a real ESPOCRM_API_KEY
npx wrangler dev
```

For local KV, create a preview namespace (`npx wrangler kv namespace create
FORMS_CONFIG --preview`) or point `FORMS_CONFIG` at the remote namespace and
add a `client:test` key. `wrangler dev` serves on `localhost:8787`; POST to
`http://localhost:8787/f/test`.
