<?php
/**
 * Plugin Name: DZ Fraud Shield
 * Plugin URI: https://example.com/dz-fraud-shield
 * Description: Fraud prevention for Algerian WooCommerce stores with SaaS risk scoring.
 * Version: 1.8.0
 * Author: DZ Fraud Shield
 * Requires Plugins: woocommerce
 * Text Domain: dz-fraud-shield
 */

if (!defined('ABSPATH')) {
    exit;
}

define('DZFS_VERSION', '1.8.0');
define('DZFS_DB_VERSION', '2.0.0');
define('DZFS_PLUGIN_FILE', __FILE__);
define('DZFS_PLUGIN_DIR', plugin_dir_path(__FILE__));
define('DZFS_PLUGIN_URL', plugin_dir_url(__FILE__));

require_once DZFS_PLUGIN_DIR . 'includes/class-dzfs-helpers.php';
require_once DZFS_PLUGIN_DIR . 'includes/class-dzfs-api-client.php';
require_once DZFS_PLUGIN_DIR . 'includes/class-dzfs-onboarding.php';
require_once DZFS_PLUGIN_DIR . 'includes/class-dzfs-settings.php';
require_once DZFS_PLUGIN_DIR . 'includes/class-dzfs-risk-display.php';
require_once DZFS_PLUGIN_DIR . 'includes/class-dzfs-local-delivery-repository.php';
require_once DZFS_PLUGIN_DIR . 'includes/class-dzfs-yalidine-sync-service.php';
require_once DZFS_PLUGIN_DIR . 'includes/class-dzfs-woocommerce.php';

final class DZ_Fraud_Shield {
    private static $instance = null;

    public static function instance() {
        if (null === self::$instance) {
            self::$instance = new self();
        }
        return self::$instance;
    }

    private function __construct() {
        add_action('plugins_loaded', array($this, 'maybe_run_db_migrations'), 1);
        add_action('plugins_loaded', array($this, 'init'));
        add_filter('cron_schedules', array($this, 'add_cron_schedule'));

        // Delivery pricing and geo data now come from the SaaS global delivery cache.
        // Clear any legacy per-plugin Yalidine sync cron that may be scheduled from v1.6.
        if (class_exists('DZFS_Yalidine_Sync_Service') && wp_next_scheduled(DZFS_Yalidine_Sync_Service::CRON_HOOK)) {
            wp_clear_scheduled_hook(DZFS_Yalidine_Sync_Service::CRON_HOOK);
        }
    }

    public static function activate() {
        self::run_db_migrations();
    }

    public function maybe_run_db_migrations() {
        self::run_db_migrations();
    }

    private static function run_db_migrations() {
        $installed_db_version = (string) get_option('dzfs_db_version', '');
        if ($installed_db_version === DZFS_DB_VERSION) {
            return;
        }

        global $wpdb;

        require_once ABSPATH . 'wp-admin/includes/upgrade.php';

        $charset_collate = $wpdb->get_charset_collate();
        $wilayas_table = $wpdb->prefix . 'dzfs_wilayas';
        $communes_table = $wpdb->prefix . 'dzfs_communes';
        $offices_table = $wpdb->prefix . 'dzfs_yalidine_offices';
        $departure_centers_table = $wpdb->prefix . 'dzfs_departure_centers';
        $fees_table = $wpdb->prefix . 'dzfs_fees';

        // Wilayas: name/zone only — no longer stores prices.
        $sql_wilayas = "CREATE TABLE {$wilayas_table} (
            id int(10) unsigned NOT NULL,
            name varchar(120) NOT NULL,
            zone varchar(40) DEFAULT NULL,
            home_price decimal(10,2) NOT NULL DEFAULT 0.00,
            stopdesk_price decimal(10,2) NOT NULL DEFAULT 0.00,
            updated_at datetime NOT NULL,
            PRIMARY KEY  (id),
            KEY idx_updated_at (updated_at),
            KEY idx_zone (zone)
        ) {$charset_collate};";

        // Communes: extended with deliverability flags from Yalidine API.
        $sql_communes = "CREATE TABLE {$communes_table} (
            id int(10) unsigned NOT NULL,
            wilaya_id int(10) unsigned NOT NULL,
            name varchar(150) NOT NULL,
            has_stop_desk tinyint(1) NOT NULL DEFAULT 0,
            is_deliverable tinyint(1) NOT NULL DEFAULT 1,
            delivery_time_parcel smallint unsigned DEFAULT NULL,
            delivery_time_payment smallint unsigned DEFAULT NULL,
            updated_at datetime NOT NULL,
            PRIMARY KEY  (id),
            KEY idx_wilaya_id (wilaya_id),
            KEY idx_wilaya_name (wilaya_id, name)
        ) {$charset_collate};";

        $sql_offices = "CREATE TABLE {$offices_table} (
            office_id int(10) unsigned NOT NULL,
            wilaya_id int(10) unsigned NOT NULL,
            commune_id int(10) unsigned NOT NULL,
            office_name varchar(190) NOT NULL,
            address varchar(255) DEFAULT NULL,
            updated_at datetime NOT NULL,
            PRIMARY KEY  (office_id),
            KEY idx_wilaya_id (wilaya_id),
            KEY idx_commune_id (commune_id),
            KEY idx_wilaya_commune (wilaya_id, commune_id)
        ) {$charset_collate};";

        // Departure centers: identity only — no longer stores prices.
        $sql_departure_centers = "CREATE TABLE {$departure_centers_table} (
            center_id varchar(80) NOT NULL,
            wilaya_id int(10) unsigned NOT NULL,
            commune_id int(10) unsigned DEFAULT 0,
            center_name varchar(190) NOT NULL,
            address varchar(255) DEFAULT NULL,
            home_price decimal(10,2) NOT NULL DEFAULT 0.00,
            stopdesk_price decimal(10,2) NOT NULL DEFAULT 0.00,
            updated_at datetime NOT NULL,
            PRIMARY KEY  (center_id),
            KEY idx_wilaya_id (wilaya_id),
            KEY idx_commune_id (commune_id),
            KEY idx_center_name (center_name)
        ) {$charset_collate};";

        // Fees: single source of truth for all shipping prices.
        // Keyed by (origin_wilaya_id, destination_wilaya_id, destination_commune_id).
        // destination_commune_id = 0 means wilaya-level; >0 means commune-specific override.
        $sql_fees = "CREATE TABLE {$fees_table} (
            origin_wilaya_id smallint unsigned NOT NULL,
            destination_wilaya_id smallint unsigned NOT NULL,
            destination_commune_id int unsigned NOT NULL DEFAULT 0,
            express_home decimal(10,2) DEFAULT NULL,
            express_desk decimal(10,2) DEFAULT NULL,
            economic_home decimal(10,2) DEFAULT NULL,
            economic_desk decimal(10,2) DEFAULT NULL,
            retour_fee decimal(10,2) DEFAULT NULL,
            cod_percentage decimal(6,4) DEFAULT NULL,
            insurance_percentage decimal(6,4) DEFAULT NULL,
            oversize_fee decimal(10,2) DEFAULT NULL,
            last_synced_at datetime NOT NULL,
            PRIMARY KEY  (origin_wilaya_id, destination_wilaya_id, destination_commune_id),
            KEY idx_origin_dest (origin_wilaya_id, destination_wilaya_id)
        ) {$charset_collate};";

        dbDelta($sql_wilayas);
        dbDelta($sql_communes);
        dbDelta($sql_offices);
        dbDelta($sql_departure_centers);
        dbDelta($sql_fees);

        $sync_default_options = array(
            'dzfs_yalidine_sync_last_started_at' => '',
            'dzfs_yalidine_sync_last_completed_at' => '',
            'dzfs_yalidine_sync_last_success_at' => '',
            'dzfs_yalidine_sync_last_status' => 'never',
            'dzfs_yalidine_sync_last_error' => '',
            'dzfs_yalidine_sync_rows_wilayas' => 0,
            'dzfs_yalidine_sync_rows_communes' => 0,
            'dzfs_yalidine_sync_rows_offices' => 0,
            'dzfs_yalidine_sync_rows_centers' => 0,
            'dzfs_yalidine_sync_rows_fees' => 0,
        );

        foreach ($sync_default_options as $option_key => $default_value) {
            if (get_option($option_key, null) === null) {
                add_option($option_key, $default_value, '', false);
            }
        }

        update_option('dzfs_db_version', DZFS_DB_VERSION, false);
    }

    public function add_cron_schedule($schedules) {
        if (!isset($schedules['minute'])) {
            $schedules['minute'] = array(
                'interval' => 60,
                'display' => 'Every Minute',
            );
        }

        return $schedules;
    }

    public function init() {
        if (!class_exists('WooCommerce')) {
            add_action('admin_notices', function () {
                echo '<div class="notice notice-error"><p>DZ Fraud Shield requires WooCommerce.</p></div>';
            });
            return;
        }

        $settings = new DZFS_Settings();
        new DZFS_Onboarding($settings);
        new DZFS_Risk_Display();
        new DZFS_WooCommerce();

        add_action('admin_enqueue_scripts', array($this, 'enqueue_admin_assets'));
        add_action('wp_dashboard_setup', array($this, 'register_dashboard_widget'));
    }

    public function register_dashboard_widget() {
        if (!current_user_can('manage_woocommerce')) {
            return;
        }

        wp_add_dashboard_widget(
            'dzfs_status_widget',
            'DZ Fraud Shield Status',
            array($this, 'render_dashboard_widget')
        );
    }

    public function render_dashboard_widget() {
        $api = new DZFS_API_Client();
        $snapshot = $api->get_status_snapshot(false);

        $merchant_status = isset($snapshot['subscriptionStatus']) ? (string) $snapshot['subscriptionStatus'] : 'pending_payment';
        $plan = isset($snapshot['plan']) ? (string) $snapshot['plan'] : 'none';
        $trial_status = !empty($snapshot['trialActive']) ? 'Active' : 'Inactive';
        $expiry = !empty($snapshot['subscriptionExpiresAt']) ? (string) $snapshot['subscriptionExpiresAt'] : (!empty($snapshot['trialExpiresAt']) ? (string) $snapshot['trialExpiresAt'] : '-');
        $api_connection = !empty($snapshot['valid']) ? 'Connected' : 'Disconnected';
        $last_sync = (string) get_option('dzfs_last_status_sync_at', '-');

        echo '<div class="dzfs-status-widget">';
        echo '<p><strong>Merchant Status:</strong> ' . esc_html($merchant_status) . '</p>';
        echo '<p><strong>Plan:</strong> ' . esc_html($plan) . '</p>';
        echo '<p><strong>Trial Status:</strong> ' . esc_html($trial_status) . '</p>';
        echo '<p><strong>Expiration Date:</strong> ' . esc_html($expiry) . '</p>';
        echo '<p><strong>API Connection Status:</strong> ' . esc_html($api_connection) . '</p>';
        echo '<p><strong>Last Sync:</strong> ' . esc_html($last_sync) . '</p>';
        echo '</div>';
    }

    public function enqueue_admin_assets() {
        wp_enqueue_style('dzfs-admin', DZFS_PLUGIN_URL . 'assets/admin.css', array(), DZFS_VERSION);
        wp_enqueue_script('dzfs-admin', DZFS_PLUGIN_URL . 'assets/admin.js', array('jquery'), DZFS_VERSION, true);
        wp_localize_script('dzfs-admin', 'dzfsData', array(
            'ajaxUrl'   => admin_url('admin-ajax.php'),
            'syncNonce' => wp_create_nonce('dzfs_sync_nonce'),
        ));
    }
}

if (defined('WP_CLI') && WP_CLI && class_exists('DZFS_Yalidine_Sync_Service') && method_exists('DZFS_Yalidine_Sync_Service', 'register_wp_cli_command')) {
    DZFS_Yalidine_Sync_Service::register_wp_cli_command();
}

DZ_Fraud_Shield::instance();

register_activation_hook(DZFS_PLUGIN_FILE, array('DZ_Fraud_Shield', 'activate'));

register_deactivation_hook(DZFS_PLUGIN_FILE, function () {
    wp_clear_scheduled_hook(DZFS_WooCommerce::DECISION_SYNC_HOOK);
    wp_clear_scheduled_hook(DZFS_Yalidine_Sync_Service::CRON_HOOK);
});
