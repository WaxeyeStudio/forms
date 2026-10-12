FROM espocrm/espocrm:latest

# Copy Waxeye branding extension into EspoCRM's custom directory
COPY espocrm/branding/ /var/www/html/custom/EspoCRM/CustomExtensions/WaxeyeBranding/

# Copy custom config overrides
COPY espocrm/config-custom.php /var/www/html/custom/EspoCRM/CustomExtensions/WaxeyeBranding/config-custom.php
