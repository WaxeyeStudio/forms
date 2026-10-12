#!/bin/bash
set -e

cd /home/forge/forms.waxeye.co.nz

# Pull latest code
git pull --ff origin main

# Ensure .env exists
if [ ! -f .env ]; then
    cp .env.example .env
fi

# Pull latest images and rebuild if needed
docker compose pull
docker compose build
docker compose up -d

# Clear EspoCRM cache
docker compose exec -T espocrm php command.php cache-clear 2>/dev/null || true

echo "Deploy complete: $(date)"
