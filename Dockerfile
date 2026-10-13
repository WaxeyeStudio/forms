FROM docker.io/espocrm/espocrm:latest

# Copy Waxeye branding extension (includes config-custom.php) into EspoCRM's custom directory.
# Mounted as a named volume at runtime; Docker seeds it from this image content on first start.
COPY espocrm/branding/ /var/www/html/custom/EspoCRM/CustomExtensions/WaxeyeBranding/
