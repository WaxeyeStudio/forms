<?php

namespace Espo\CustomExtensions\WaxeyeBranding;

use Espo\Core\InjectableFactory;
use Espo\Core\Utils\Metadata;

class Extension
{
    public function __construct(
        private Metadata $metadata
    ) {}

    public function getLogoPath(): string
    {
        return 'custom/EspoCRM/CustomExtensions/WaxeyeBranding/assets/logo.png';
    }

    public function getStylesPath(): string
    {
        return 'custom/EspoCRM/CustomExtensions/WaxeyeBranding/assets/styles.css';
    }
}
