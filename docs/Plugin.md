# Zaki — WordPress Plugin Guide

## Overview

The WordPress plugin (`wordpress-plugin/dz-fraud-shield/`) integrates WooCommerce with the Zaki SaaS platform.

**Plugin slug:** `dz-fraud-shield`
**Tested with:** WooCommerce 7.x+, WordPress 6.x+, PHP 8.0+

---

## What the plugin does

1. **Order risk evaluation** — Calls `POST /api/v1/check-order` before each order is placed. High-risk orders can be blocked or flagged for review.
2. **Dynamic delivery pricing** — Fetches delivery fees from `POST /api/v1/plugin/delivery-price` so checkout shows accurate COD shipping costs.
3. **Product category sync** — Syncs WooCommerce product categories to the SaaS via `POST /api/v1/category/sync`.
4. **Decision sync** — Pulls merchant decisions (approve/block/call-first) back to the plugin so WooCommerce order notes are kept in sync.

---

## Plugin structure

```
wordpress-plugin/dz-fraud-shield/
├── dz-fraud-shield.php                 Plugin entry point, hooks registration
├── admin/
│   └── index.php                       Admin settings page
├── assets/
│   ├── admin.css                       Admin UI styles
│   ├── admin.js                        Admin UI scripts
│   ├── checkout-block.js               WooCommerce Blocks integration
│   └── checkout-theme-adapter.css      Theme compatibility styles
├── includes/
│   ├── class-dzfs-api-client.php       SaaS HTTP client (check-order, delivery-price, etc.)
│   ├── class-dzfs-helpers.php          Utility functions
│   ├── class-dzfs-local-delivery-repository.php  Cached delivery data storage
│   ├── class-dzfs-onboarding.php       Plugin activation + merchant registration
│   ├── class-dzfs-risk-display.php     Order risk badge in WooCommerce admin
│   ├── class-dzfs-settings.php         Settings management
│   ├── class-dzfs-woocommerce.php      WooCommerce hooks (checkout, orders)
│   └── class-dzfs-yalidine-sync-service.php  Yalidine delivery cache sync
├── languages/
│   └── index.php                       i18n placeholder
├── readme.txt                          WordPress.org readme
└── uninstall.php                       Cleanup on plugin removal
```

---

## Installation

### From zip (production)

```bash
# Build the plugin zip
bash scripts/package-plugin.sh 1.8.0

# Upload via WordPress Admin → Plugins → Add New → Upload Plugin
# Select: wordpress-plugin/releases/dz-fraud-shield-1.8.0.zip
# Activate the plugin
```

### For local development

```bash
# Symlink directly into a local WordPress installation
ln -s "$(pwd)/wordpress-plugin/dz-fraud-shield" /path/to/wordpress/wp-content/plugins/dz-fraud-shield
```

---

## Configuration

After activation, navigate to:
**WooCommerce → DZ Fraud Shield → Settings**

| Setting | Description |
|---------|-------------|
| SaaS API URL | Full URL of the deployed Zaki app (e.g. `https://app.zaki.dz`) |
| API Key | Merchant API key generated from the Zaki dashboard |
| Risk action | What to do with high-risk orders: `block`, `hold`, or `flag` |
| Delivery provider | Which provider to use for fee calculation |

### Testing the connection

In the settings page, click **Test Connection**. This calls `POST /api/v1/plugin/ping` and shows a success/failure badge.

---

## API endpoints used by the plugin

| Endpoint | When called |
|----------|-------------|
| `POST /api/v1/plugin/ping` | Connection test |
| `POST /api/v1/plugin/activate` | First activation / registration |
| `POST /api/v1/check-order` | Before each order is placed |
| `POST /api/v1/plugin/delivery-price` | On checkout (to show delivery fees) |
| `POST /api/v1/plugin/delivery-cache` | On checkout (local cache check first) |
| `POST /api/v1/category/sync` | On product save / bulk action |
| `POST /api/v1/plugin/merchant-decision-sync` | Periodic pull of decisions |

---

## Packaging a release

```bash
bash scripts/package-plugin.sh <version>
# Output: wordpress-plugin/releases/dz-fraud-shield-<version>.zip
```

The zip is ready for upload to WordPress. Never commit zips to version control.

---

## Uninstalling

The plugin's `uninstall.php` removes all custom DB tables and options created by the plugin when it is deleted from WordPress admin. Deactivation alone does not remove data.
