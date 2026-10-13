# Waxeye Forms — Cloudflare Worker

Public form-submission endpoint for client websites:

```
POST https://forms.waxeye.co.nz/f/{client-slug}
```

The worker validates the submission, then creates a record in EspoCRM through
its REST API. Everything else on `forms.waxeye.co.nz` — the EspoCRM UI and
EspoCRM's own `/api/v1` — passes straight through to the origin (Laravel Forge
→ Docker).

```
client website form  →  Cloudflare Worker (/f/*)  →  EspoCRM REST API  →  CRM record
EspoCRM admin UI     →  (worker not involved)     →  Forge origin
```

## Files

| File | Purpose |
|---|---|
| `src/index.js` | The worker (plain ES module + JSDoc; no build step) |
| `wrangler.toml` | Routes, vars, and bindings for a normal `wrangler deploy` |
| `deploy.sh` | Deploys via the Cloudflare REST API (curl + python3) |
| `examples/form-example.html` | Copy-paste client form that posts to the endpoint |
| `.dev.vars.example` | Template for local development secrets |

## Deploying

### Option A — API deploy (no toolchain required)

```bash
cd worker
CF_API_TOKEN=... ./deploy.sh
```

The token needs, for the Waxeye account and the `waxeye.co.nz` zone:

- **Account → Workers Scripts → Edit**
- **Zone → Workers Routes → Edit**
- **Zone → DNS → Read** (used only for a pre-flight check)

The script uploads `src/index.js`, sets the plain-text vars, optionally
uploads `ESPOCRM_API_KEY` / `WORKER_API_SECRET` secrets if those environment
variables are set, and creates/updates the route:

```
forms.waxeye.co.nz/f/*  ->  waxeye-forms
```

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
   `deploy.sh`. Requests to any other path on the hostname are untouched and
   go to the Forge origin.
3. **Origin certificate** — the Forge site for `forms.waxeye.co.nz` needs a
   Let's Encrypt certificate so Cloudflare can talk to the origin over HTTPS
   (Full (strict) mode).
4. **Rate limiting (recommended)** — add a Cloudflare WAF rate-limiting rule
   for `http.request.uri.path matches "/f/"` (e.g. 20 requests/minute per IP,
   mitigate). The worker also drops anything that fills a honeypot field.

## EspoCRM setup

1. **API user** — in EspoCRM go to *Administration → API Users → Create API
   User*. Set the authentication method to **API Key** and give it a key
   (generate a long random value).
2. **Role** — create a role with `Lead` → *create: yes* (read is optional) and
   assign it to the API user. Without a role the API user cannot create
   records.
3. **Secret** — store the API key as the worker secret `ESPOCRM_API_KEY`:

   ```bash
   CF_API_TOKEN=... ESPOCRM_API_KEY=<key> ./deploy.sh
   # or
   npx wrangler secret put ESPOCRM_API_KEY
   ```

4. **Per-client tracking (optional)** — add a custom field to the Lead entity
   (*Administration → Entity Manager → Lead → Add Field*, e.g. `cClient`) and
   set `ESPOCRM_CLIENT_FIELD = "cClient"` so each record carries the client
   slug. Without it, the client slug still appears in the record description.

Submissions land as **Leads** by default. To write to a different entity
(e.g. a custom `FormSubmission` entity created in Entity Manager), set
`ESPOCRM_ENTITY`.

## Configuration reference

Plain-text vars (set in `wrangler.toml` `[vars]` or `deploy.sh`):

| Var | Default | Purpose |
|---|---|---|
| `ESPOCRM_API_URL` | `https://forms.waxeye.co.nz/api/v1` | EspoCRM REST API base |
| `ESPOCRM_ENTITY` | `Lead` | Entity to create |
| `ESPOCRM_SOURCE` | `Web Site` | Value for the record's `source` field |
| `ALLOWED_ORIGINS` | `*` | Comma-separated browser origin allowlist, or `*` |
| `ESPOCRM_CLIENT_FIELD` | *(unset)* | Custom field receiving the client slug |
| `REQUIRE_SECRET` | `false` | `true` requires `X-Worker-Secret` on every request |

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
| 403 | `{"ok":false,"error":"origin_not_allowed"}` | Browser Origin not in `ALLOWED_ORIGINS` |
| 405 | `{"ok":false,"error":"method_not_allowed"}` | Not GET/POST/OPTIONS |
| 413 | `{"ok":false,"error":"payload_too_large"}` | Body over 64 KB |
| 422 | `{"ok":false,"error":"invalid_email"}` / `empty_submission` | Validation failed |
| 502 | `{"ok":false,"error":"upstream_rejected"}` | EspoCRM refused the record |
| 503 | `{"ok":false,"error":"service_not_configured"}` | `ESPOCRM_API_KEY` secret not set yet |

`GET /f/{client}` returns `{"ok":true,"service":"waxeye-forms","client":"..."}`
— handy as a liveness check.

### Testing with curl

```bash
curl -s https://forms.waxeye.co.nz/f/CLIENT_SLUG

curl -s -X POST https://forms.waxeye.co.nz/f/CLIENT_SLUG \
  -H 'Content-Type: application/json' \
  -d '{"name":"Test Person","email":"test@example.com","message":"Hello from curl"}'
```

## Local development

```bash
cd worker
cp .dev.vars.example .dev.vars   # add a real ESPOCRM_API_KEY
npx wrangler dev
```

`wrangler dev` serves the worker on `localhost:8787`; POST to
`http://localhost:8787/f/test`.
