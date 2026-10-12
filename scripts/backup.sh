#!/bin/bash
# Manual backup script - also runs automatically via the backup container
# Usage: ./scripts/backup.sh

set -e

BACKUP_DIR="/home/forge/backups/espocrm"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

mkdir -p "$BACKUP_DIR"

# Backup database
docker exec forms-waxeye-forms-db-1 mysqldump -u espocrm -p"${DB_PASSWORD}" espocrm | gzip > "$BACKUP_DIR/db_$TIMESTAMP.sql.gz"

# Backup EspoCRM files
docker run --rm -v forms-waxeye-forms_espocrm_data:/data -v "$BACKUP_DIR":/backup alpine tar czf "/backup/files_$TIMESTAMP.tar.gz" -C /data .

echo "Backup complete: $TIMESTAMP"
