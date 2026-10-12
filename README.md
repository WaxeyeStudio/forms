# Waxeye Forms

Forms infrastructure for Waxeye. Hosts a Waxeye-branded EspoCRM instance and provides form submission handling via Cloudflare Workers.

## Architecture

```
Client websites → forms.waxeye.co.nz/f/{client} → Cloudflare Worker → EspoCRM API → MariaDB
```

## Components

- **EspoCRM** — CRM for managing form submissions (Docker)
- **Cloudflare Worker** — Edge function for form submission handling
- **MariaDB** — Database for EspoCRM (Docker)
- **Caddy** — Reverse proxy (Docker)

## Deployment

Deployed via Forge webhook. Push to `main` to deploy.

## Development

```bash
# Copy environment
cp .env.example .env

# Start locally
docker compose up -d

# View logs
docker compose logs -f
```
