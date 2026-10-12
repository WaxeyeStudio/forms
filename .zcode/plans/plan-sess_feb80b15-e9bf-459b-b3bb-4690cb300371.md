## Plan: Set up forms.waxeye.co.nz in Laravel Forge

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│  Client websites embed forms                                 │
│  Form submits to: forms.waxeye.co.nz/f/{client}              │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  Cloudflare Edge                                            │
│  • DNS: forms.waxeye.co.nz → Cloudflare (proxy enabled)    │
│  • Worker intercepts /f/{client} → validates → forwards     │
│  • All other traffic → origin (Forge server)               │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  Forge Server (waxeye-prod, 170.187.240.235)               │
│  • Site: forms.waxeye.co.nz                                 │
│  • nginx terminates SSL → proxies to Docker network        │
│  • Docker Compose:                                         │
│    ┌─────────────┐  ┌──────────┐  ┌──────────┐            │
│    │  Caddy      │→│ EspoCRM  │  │ MariaDB  │            │
│    │  (reverse   │  │ (Apache  │  │ 10.11    │            │
│    │   proxy)    │  │ + PHP)   │  │          │            │
│    │  :8080      │  │          │  │          │            │
│    └─────────────┘  └──────────┘  └──────────┘            │
│                                                             │
│  EspoCRM API: http://localhost:8080/api/v1/                │
│  EspoCRM UI:  https://forms.waxeye.co.nz/                  │
└─────────────────────────────────────────────────────────────┘
```

---

### Phase 1: Git Repo & Project Structure

**Directory: `/home/veera/Code/Waxeye/forms/`**

```
forms/
├── docker-compose.yml          # EspoCRM + MariaDB + Caddy
├── Caddyfile                   # Reverse proxy config
├── Dockerfile                  # Custom EspoCRM image with Waxeye branding
├── deploy_forge.sh             # Forge deploy webhook script
├── .env.example                # Environment template
├── .gitignore
├── README.md
├── espocrm/
│   ├── branding/               # Custom EspoCRM extension for Waxeye branding
│   │   ├── Extension.php
│   │   ├── logo.png
│   │   └── styles.css
│   └── config-custom.php        # EspoCRM custom config overrides
├── worker/
│   ├── wrangler.toml           # Cloudflare Worker config
│   ├── src/
│   │   └── index.ts            # Worker: intercept /f/{client}, forward to EspoCRM API
│   └── package.json
└── scripts/
    └── backup.sh               # Database backup script
```

**Steps:**
1. `git init` in `/home/veera/Code/Waxeye/forms/`
2. Create all files above with initial content
3. Push to a new GitHub repo `waxeyestudio/forms`

---

### Phase 2: Docker Compose Configuration

**`docker-compose.yml`:**
```yaml
services:
  caddy:
    image: caddy:2-alpine
    ports:
      - "8080:80"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy_data:/data
      - caddy_config:/config
    depends_on:
      - espocrm
    restart: unless-stopped

  espocrm:
    build:
      context: .
      dockerfile: Dockerfile
    environment:
      ESPOCRM_DB_HOST: db
      ESPOCRM_DB_NAME: espocrm
      ESPOCRM_DB_USER: espocrm
      ESPOCRM_DB_PASSWORD: ${DB_PASSWORD}
      ESPOCRM_SITE_URL: https://forms.waxeye.co.nz
    volumes:
      - espocrm_data:/var/www/html
    depends_on:
      db:
        condition: service_healthy
    restart: unless-stopped

  db:
    image: mariadb:10.11
    environment:
      MYSQL_ROOT_PASSWORD: ${DB_ROOT_PASSWORD}
      MYSQL_DATABASE: espocrm
      MYSQL_USER: espocrm
      MYSQL_PASSWORD: ${DB_PASSWORD}
    volumes:
      - db_data:/var/lib/mysql
    healthcheck:
      test: ["CMD", "healthcheck.sh", "--connect", "--innodb_initialized"]
      interval: 5s
      timeout: 5s
      retries: 10
    restart: unless-stopped

  backup:
    image: offen/docker-volume-backup:latest
    environment:
      BACKUP_CRON_EXPRESSION: "0 2 * * *"
      BACKUP_RETENTION_DAYS: "30"
      BACKUP_FILENAME: "espocrm-backup-%Y-%m-%dT%H-%M-%S.tar.gz"
    volumes:
      - espocrm_data:/backup/espocrm:ro
      - db_data:/backup/db:ro
      - /var/run/docker.sock:/var/run/docker.sock:ro
    restart: unless-stopped

volumes:
  espocrm_data:
  db_data:
  caddy_data:
  caddy_config:
```

**`Caddyfile`:**
```
:80 {
    handle /api/* {
        reverse_proxy espocrm:80
    }
    handle {
        reverse_proxy espocrm:80
    }
}
```

**`Dockerfile`:** Based on official `espocrm/espocrm` image, adds:
- Waxeye branding extension installed to EspoCRM's `custom/` directory
- Custom logo and CSS overrides

---

### Phase 3: Forge Site Creation

**API calls:**
1. `POST /orgs/alex-varganov/servers/1001106/sites` — create site `forms.waxeye.co.nz`
   - Set repository to `waxeyestudio/forms`
   - Set branch to `main`
2. Configure deploy script on the site (Forge API: `PUT .../sites/{id}` with `deploy_script` field)
3. Let's Encrypt SSL certificate via Forge API

**Deploy script (`deploy_forge.sh`):** Follows the waxeye-google-mcp pattern:
```bash
#!/bin/bash
set -e
cd /home/forge/forms.waxeye.co.nz
git pull --ff origin main
# Ensure .env exists
if [ ! -f .env ]; then
    cp .env.example .env
fi
docker compose pull
docker compose up -d
docker compose exec espocrm php command.php cache-clear
```

---

### Phase 4: Cloudflare Worker

**`worker/wrangler.toml`:**
```toml
name = "waxeye-forms"
main = "src/index.ts"
compatibility_date = "2024-01-01"
routes = [
    { pattern = "forms.waxeye.co.nz/f/*", zone_name = "waxeye.co.nz" }
]

[env.production]
ESPOCRM_API_URL = "https://forms.waxeye.co.nz/api/v1"
```

**Worker logic (`src/index.ts`):**
1. Intercept requests to `/f/{client}`
2. Validate the submission (required fields, honeypot, rate limiting)
3. Transform the payload into EspoCRM format (map to a custom `FormSubmission` entity)
4. Forward to EspoCRM REST API with API key authentication
5. Return success/error response to the form

---

### Phase 5: DNS & SSL

1. Add `forms.waxeye.co.nz` DNS record in Cloudflare (A record → 170.187.240.235, proxy enabled)
2. Forge provisions Let's Encrypt SSL for `forms.waxeye.co.nz`
3. Cloudflare SSL mode: Full (strict) — Cloudflare → Forge over HTTPS

---

### Phase 6: EspoCRM Branding

Custom EspoCRM extension at `espocrm/branding/`:
- **Extension.php** — registers custom views and metadata
- **Custom logo** — replaces EspoCRM logo in header and login page
- **Custom CSS** — Waxeye brand colors, typography
- **Login page** — custom Waxeye-branded login template

---

### Phase 7: Testing & Verification

1. Verify EspoCRM loads at `https://forms.waxeye.co.nz`
2. Test Cloudflare Worker by submitting a test form at `https://forms.waxeye.co.nz/f/testclient`
3. Verify submission appears in EspoCRM
4. Check SSL certificate is valid
5. Verify backup container is running and creating snapshots

---

### Environment Variables (`.env.example`)

```env
DB_PASSWORD=change_me
DB_ROOT_PASSWORD=change_me
ESPOCRM_API_KEY=change_me
WORKER_API_SECRET=change_me
```

---

### Security Considerations

- EspoCRM API key used by Worker stored as Cloudflare Worker secret (not in code)
- Rate limiting in Worker (per-IP and per-client)
- Honeypot field support in form submissions
- CORS restricted to known client domains
- Database credentials via Forge environment variables
- Regular automated backups with 30-day retention

---

### Estimated Timeline

- Phase 1-2 (project scaffolding): ~1 hour
- Phase 3 (Forge setup): ~30 min
- Phase 4 (Worker): ~1 hour
- Phase 5-6 (DNS, SSL, branding): ~30 min
- Phase 7 (testing): ~30 min

**Total: ~3-4 hours**

---

### What I'll Need From You

1. **GitHub repo**: I'll create `waxeyestudio/forms` — need your confirmation
2. **EspoCRM API key**: Generated after first EspoCRM install (I'll extract it via Forge command)
3. **Client list**: Which clients will be submitting forms? (for Worker routing config)
4. **Form fields**: What fields should forms capture? (for the EspoCRM entity schema)