FROM espocrm/espocrm:latest

# Copy Waxeye branding extension (includes config-custom.php) into EspoCRM's custom directory
COPY espocrm/branding/ /var/www/html/custom/EspoCRM/CustomExtensions/WaxeyeBranding/
