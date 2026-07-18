<?php

if (!defined('ABSPATH')) {
    exit;
}

class DZFS_WooCommerce {
    private $api;
    private $delivery_meta_hydrated = array();
    // In-memory price resolved during the current PHP request's extensionCartUpdate
    // callback. The woocommerce_package_rates filter reads this first so it never
    // depends on a session-backend round-trip within the same request.
    private $dzfs_live_price = 0;
    const DECISION_SYNC_HOOK = 'dzfs_sync_merchant_decisions';

    public function __construct() {
        $this->api = new DZFS_API_Client();

        add_action('woocommerce_new_order', array($this, 'scan_from_new_order'), 20, 1);
        add_action('woocommerce_checkout_order_processed', array($this, 'check_order_risk'), 20, 3);
        add_action('woocommerce_thankyou', array($this, 'scan_from_thankyou'), 20, 1);
        add_action('woocommerce_order_status_pending', array($this, 'scan_from_status_pending'), 20, 1);
        add_action('woocommerce_order_status_processing', array($this, 'scan_from_status_processing'), 20, 1);
        add_action('woocommerce_order_status_completed', array($this, 'report_delivered'));
        add_action('woocommerce_order_status_cancelled', array($this, 'report_cancelled'));
        add_action('woocommerce_order_status_refunded', array($this, 'report_refused'));
        add_action('init', array($this, 'register_fraud_blocked_status'));
        add_filter('wc_order_statuses', array($this, 'add_fraud_blocked_to_statuses'));
        add_action('admin_head', array($this, 'render_fraud_blocked_status_color'));
        add_action('woocommerce_after_order_notes', array($this, 'render_delivery_checkout_fields'));
        add_filter('woocommerce_checkout_fields', array($this, 'adjust_native_address_fields_for_delivery_mode'));
        add_action('woocommerce_checkout_process', array($this, 'validate_delivery_checkout_fields'));
        add_action('woocommerce_checkout_create_order', array($this, 'save_delivery_checkout_fields'), 20, 2);
        add_action('woocommerce_store_api_checkout_order_processed', array($this, 'persist_delivery_fields_for_store_api'), 20, 1);
        add_action('woocommerce_cart_calculate_fees', array($this, 'apply_cached_delivery_fee'), 30, 1);
        add_filter('woocommerce_package_rates', array($this, 'filter_shipping_rates_when_cached_delivery_active'), 50, 2);
        add_action('wp_enqueue_scripts', array($this, 'enqueue_delivery_checkout_script'));
        add_action('wp_enqueue_scripts', array($this, 'dequeue_conflicting_checkout_tracking_scripts'), 999);
        add_action('wp_head', array($this, 'print_checkout_crypto_polyfill'), 1);
        add_action('wp_ajax_dzfs_delivery_cache', array($this, 'ajax_delivery_cache'));
        add_action('wp_ajax_nopriv_dzfs_delivery_cache', array($this, 'ajax_delivery_cache'));
        add_action('wp_ajax_dzfs_save_delivery', array($this, 'ajax_save_delivery'));
        add_action('wp_ajax_nopriv_dzfs_save_delivery', array($this, 'ajax_save_delivery'));
        add_action('woocommerce_checkout_update_order_review', array($this, 'sync_delivery_from_review_post'), 20);
        add_action('init', array($this, 'register_checkout_block_update_callback'));
        add_action(self::DECISION_SYNC_HOOK, array($this, 'sync_merchant_decision_actions'));

        if (!wp_next_scheduled(self::DECISION_SYNC_HOOK)) {
            wp_schedule_event(time() + 30, 'minute', self::DECISION_SYNC_HOOK);
        }
    }

    private function get_checkout_page_content() {
        if (!function_exists('wc_get_page_id')) {
            return '';
        }

        $checkout_page_id = (int) wc_get_page_id('checkout');
        if ($checkout_page_id <= 0) {
            return '';
        }

        $checkout_post = get_post($checkout_page_id);
        if (!$checkout_post || empty($checkout_post->post_content)) {
            return '';
        }

        return (string) $checkout_post->post_content;
    }

    private function is_checkout_block_mode() {
        if (!function_exists('is_checkout') || !is_checkout()) {
            return false;
        }

        $content = $this->get_checkout_page_content();
        if ($content === '') {
            return false;
        }

        if (function_exists('has_block')) {
            $checkout_page_id = (int) wc_get_page_id('checkout');
            if ($checkout_page_id > 0 && has_block('woocommerce/checkout', get_post($checkout_page_id))) {
                return true;
            }
        }

        return strpos($content, 'wp:woocommerce/checkout') !== false;
    }

    private function is_checkout_classic_mode() {
        if (!function_exists('is_checkout') || !is_checkout()) {
            return false;
        }

        if ($this->is_checkout_block_mode()) {
            return false;
        }

        $content = $this->get_checkout_page_content();
        if ($content === '') {
            return true;
        }

        return function_exists('has_shortcode')
            ? has_shortcode($content, 'woocommerce_checkout')
            : true;
    }

    private function set_delivery_session_values($delivery_type, $wilaya_id, $commune_id, $office_id, $shipping_price) {
        if (!function_exists('WC') || !WC() || !WC()->session) {
            return;
        }

        $clean_type = $delivery_type === 'stopdesk' ? 'stopdesk' : 'home';
        $clean_wilaya = sanitize_text_field((string) $wilaya_id);
        $clean_commune = sanitize_text_field((string) $commune_id);
        $clean_office = sanitize_text_field((string) $office_id);
        $departure_center_id = $this->resolve_selected_departure_center_id();
        $departure_center_name = $this->resolve_selected_departure_center_name($departure_center_id);
        $is_ready = $this->is_delivery_selection_complete($clean_type, $clean_wilaya, $clean_commune, $clean_office);
        $resolved_price = $is_ready ? max(0, (float) $shipping_price) : 0;

        // Clear cached native methods first, then force DZFS as the chosen shipping method.
        $this->clear_native_shipping_session_cache();

        WC()->session->set('dzfs_shipping_price', $resolved_price);
        WC()->session->set('dzfs_delivery_price', $resolved_price);
        WC()->session->set('dzfs_shipping_type', $clean_type);
        WC()->session->set('dzfs_shipping_wilaya_id', $clean_wilaya);
        WC()->session->set('dzfs_shipping_commune_id', $clean_commune);
        WC()->session->set('dzfs_shipping_office_id', $clean_office);
        WC()->session->set('dzfs_shipping_departure_center_id', $departure_center_id);
        WC()->session->set('dzfs_shipping_departure_center_name', $departure_center_name);
        WC()->session->set('dzfs_shipping_price_ready', $is_ready ? '1' : '0');
        WC()->session->set('dzfs_shipping_price_stale', '0');
        WC()->session->set('chosen_shipping_methods', array('dzfs_delivery'));

    }

    private function resolve_selected_departure_center_id() {
        if (function_exists('WC') && WC() && WC()->session) {
            $session_value = sanitize_text_field((string) WC()->session->get('dzfs_shipping_departure_center_id'));
            if ($session_value !== '') {
                return $session_value;
            }
        }

        return DZFS_Helpers::yalidine_departure_center_id();
    }

    private function resolve_selected_departure_center_name($center_id = '') {
        if (function_exists('WC') && WC() && WC()->session) {
            $session_value = sanitize_text_field((string) WC()->session->get('dzfs_shipping_departure_center_name'));
            if ($session_value !== '') {
                return $session_value;
            }
        }

        $candidate_id = sanitize_text_field((string) $center_id);
        if ($candidate_id !== '') {
            $centers = DZFS_Helpers::yalidine_departure_centers();
            if (is_array($centers)) {
                foreach ($centers as $center) {
                    $center_id = isset($center['id']) ? (string) $center['id'] : (isset($center['center_id']) ? (string) $center['center_id'] : '');
                    if ($center_id === $candidate_id) {
                        return isset($center['name']) ? sanitize_text_field((string) $center['name']) : (isset($center['center_name']) ? sanitize_text_field((string) $center['center_name']) : '');
                    }
                }
            }
        }

        return DZFS_Helpers::yalidine_departure_center_name();
    }

    private function mark_delivery_price_unavailable($delivery_type, $wilaya_id, $commune_id, $office_id) {
        if (!function_exists('WC') || !WC() || !WC()->session) {
            return;
        }

        $clean_type = $delivery_type === 'stopdesk' ? 'stopdesk' : 'home';
        $clean_wilaya = sanitize_text_field((string) $wilaya_id);
        $clean_commune = sanitize_text_field((string) $commune_id);
        $clean_office = sanitize_text_field((string) $office_id);

        $existing_type = sanitize_text_field((string) WC()->session->get('dzfs_shipping_type'));
        $existing_wilaya = sanitize_text_field((string) WC()->session->get('dzfs_shipping_wilaya_id'));
        $existing_commune = sanitize_text_field((string) WC()->session->get('dzfs_shipping_commune_id'));
        $existing_office = sanitize_text_field((string) WC()->session->get('dzfs_shipping_office_id'));
        $existing_price = max(0, (float) WC()->session->get('dzfs_shipping_price'));
        $existing_ready = (string) WC()->session->get('dzfs_shipping_price_ready') === '1';

        $same_selection = $existing_type === $clean_type
            && $existing_wilaya === $clean_wilaya
            && $existing_commune === $clean_commune
            && $existing_office === $clean_office;

        if ($same_selection && $existing_ready && $existing_price > 0) {
            // Keep last known-good amount for this exact selection while marking stale.
            WC()->session->set('dzfs_shipping_price_stale', '1');
            WC()->session->set('chosen_shipping_methods', array('dzfs_delivery'));
            return;
        }

        $this->set_delivery_session_values($delivery_type, $wilaya_id, $commune_id, $office_id, 0);
        WC()->session->set('dzfs_delivery_price', 0);
        WC()->session->set('dzfs_shipping_price_ready', '0');
        WC()->session->set('dzfs_shipping_price_stale', '1');
        WC()->session->set('dzfs_shipping_price', 0);
    }

    private function is_delivery_selection_complete($delivery_type, $wilaya_id, $commune_id, $office_id) {
        if ($wilaya_id === '') {
            return false;
        }
        if ($delivery_type === 'stopdesk') {
            return $office_id !== '';
        }
        // home delivery: commune is optional but wilaya is enough to price
        return true;
    }

    // Pricing and geo data now come from the SaaS global delivery cache via the
    // ajax_save_delivery and ajax_delivery_cache AJAX handlers. These stubs let
    // the PHP code paths that ran before the JS AJAX complete return gracefully.

    private function resolve_local_delivery_price($delivery_type, $wilaya_id, $commune_id = '', $office_id = '') {
        // EMERGENCY FALLBACK ONLY.
        // Primary checkout pricing comes from the SaaS delivery_prices table via the
        // /api/v1/plugin/delivery-price endpoint. This method is only called when that
        // endpoint returns null — i.e. when the merchant has not yet run the Merchant
        // Delivery Sync from the SaaS dashboard, or the SaaS is unreachable.
        // wp_dzfs_fees exists for the plugin's local sync feature and must not become
        // the primary checkout pricing source.
        global $wpdb;

        $fees_table    = $wpdb->prefix . 'dzfs_fees';
        $centers_table = $wpdb->prefix . 'dzfs_departure_centers';

        $departure_center_id = $this->resolve_selected_departure_center_id();
        $origin_wilaya_id    = 0;

        if ($departure_center_id !== '') {
            $origin_wilaya_id = (int) $wpdb->get_var(
                $wpdb->prepare("SELECT wilaya_id FROM {$centers_table} WHERE center_id = %s LIMIT 1", $departure_center_id)
            );
        }

        $dest_wilaya_id   = (int) $wilaya_id;
        $clean_type       = $delivery_type === 'stopdesk' ? 'stopdesk' : 'home';
        $dest_commune_int = (int) $commune_id;

        error_log('DZFS [EMERGENCY-LOCAL-PRICE] type=' . $clean_type . ' dest_wilaya=' . $dest_wilaya_id . ' commune=' . $commune_id . ' office=' . $office_id . ' center=' . $departure_center_id . ' origin_wilaya=' . $origin_wilaya_id);

        $commune_ids_to_try = array();
        if ($commune_id !== '' && $dest_commune_int > 0) {
            $commune_ids_to_try[] = $dest_commune_int;
        }
        $commune_ids_to_try[] = 0;

        $price = null;

        foreach ($commune_ids_to_try as $dest_commune_id) {
            if ($clean_type === 'stopdesk') {
                if ($origin_wilaya_id > 0) {
                    $sql = $wpdb->prepare(
                        "SELECT express_desk, economic_desk FROM {$fees_table} WHERE origin_wilaya_id = %d AND destination_wilaya_id = %d AND destination_commune_id = %d LIMIT 1",
                        $origin_wilaya_id, $dest_wilaya_id, $dest_commune_id
                    );
                } else {
                    $sql = $wpdb->prepare(
                        "SELECT express_desk, economic_desk FROM {$fees_table} WHERE destination_wilaya_id = %d AND destination_commune_id = %d LIMIT 1",
                        $dest_wilaya_id, $dest_commune_id
                    );
                }
                error_log('DZFS [EMERGENCY-LOCAL-SQL] ' . $sql);
                $row = $wpdb->get_row($sql, ARRAY_A);
                error_log('DZFS [EMERGENCY-LOCAL-ROW] ' . json_encode($row));
                if ($row) {
                    $val = (float) ($row['express_desk'] ?? 0);
                    if ($val <= 0) {
                        $val = (float) ($row['economic_desk'] ?? 0);
                    }
                    if ($val > 0) {
                        $price = $val;
                        break;
                    }
                }
            } else {
                if ($origin_wilaya_id > 0) {
                    $sql = $wpdb->prepare(
                        "SELECT express_home, economic_home FROM {$fees_table} WHERE origin_wilaya_id = %d AND destination_wilaya_id = %d AND destination_commune_id = %d LIMIT 1",
                        $origin_wilaya_id, $dest_wilaya_id, $dest_commune_id
                    );
                } else {
                    $sql = $wpdb->prepare(
                        "SELECT express_home, economic_home FROM {$fees_table} WHERE destination_wilaya_id = %d AND destination_commune_id = %d LIMIT 1",
                        $dest_wilaya_id, $dest_commune_id
                    );
                }
                error_log('DZFS [EMERGENCY-LOCAL-SQL] ' . $sql);
                $row = $wpdb->get_row($sql, ARRAY_A);
                error_log('DZFS [EMERGENCY-LOCAL-ROW] ' . json_encode($row));
                if ($row) {
                    $val = (float) ($row['express_home'] ?? 0);
                    if ($val <= 0) {
                        $val = (float) ($row['economic_home'] ?? 0);
                    }
                    if ($val > 0) {
                        $price = $val;
                        break;
                    }
                }
            }
        }

        error_log('DZFS [EMERGENCY-LOCAL-PRICE-FINAL] origin=' . $origin_wilaya_id . ' dest=' . $dest_wilaya_id . ' type=' . $clean_type . ' fee_returned=' . var_export($price, true));
        return $price;
    }

    private function get_local_delivery_cache_payload($wilaya_id = '') {
        // Geo data is loaded client-side via ajax_delivery_cache → SaaS global cache.
        // Return an empty payload so server-side rendering gracefully produces blank
        // dropdowns that JS then populates on DOMContentLoaded.
        return array(
            'provider' => 'yalidine',
            'wilayas'  => array(),
            'communes' => array(),
            'offices'  => array(),
            'stale'    => false,
            'staleReason' => '',
        );
    }

    private function clear_native_shipping_session_cache() {
        if (!function_exists('WC') || !WC() || !WC()->session) {
            return;
        }
        WC()->session->set('shipping_for_package_0', null);
        WC()->session->set('shipping_for_package', null);
        // Do NOT call calculate_shipping() here. This runs before set_delivery_session_values()
        // writes the new price to the session, so calculate_shipping() would call
        // filter_shipping_rates_when_cached_delivery_active() with the stale price and
        // store it in WC's shipping cache. calculate_totals() in the callback then reads
        // that stale cache and never re-invokes the filter with the correct price.
    }

    public function print_checkout_crypto_polyfill() {
        if (!function_exists('is_checkout') || !is_checkout()) {
            return;
        }

        echo '<script id="dzfs-checkout-crypto-polyfill">';
        echo '(function(){';
        echo 'try {';
        echo 'if (!window.crypto) { window.crypto = {}; }';
        echo 'if (typeof window.crypto.randomUUID !== "function") {';
        echo 'window.crypto.randomUUID = function(){';
        echo 'var d = Date.now();';
        echo 'if (typeof performance !== "undefined" && typeof performance.now === "function") { d += performance.now(); }';
        echo 'return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function(c){';
        echo 'var r = (d + Math.random() * 16) % 16 | 0; d = Math.floor(d / 16);';
        echo 'return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);';
        echo '});';
        echo '};';
        echo '}';
        echo '} catch(e) {}';
        echo '})();';
        echo '</script>';
    }

    public function dequeue_conflicting_checkout_tracking_scripts() {
        if (!function_exists('is_checkout') || !is_checkout()) {
            return;
        }

        global $wp_scripts;
        if (!($wp_scripts instanceof WP_Scripts)) {
            return;
        }

        $blocked_markers = array(
            'snapchat-for-woocommerce',
            'scw-tracking',
            'snap_pixel',
            'snapchat',
            'reddit-for-woocommerce',
            'rdt',
            'pinterest-for-woocommerce',
            'pinterest',
        );
        $handles = array_unique(array_merge((array) $wp_scripts->queue, (array) array_keys((array) $wp_scripts->registered)));

        foreach ($handles as $handle) {
            $registered = isset($wp_scripts->registered[$handle]) ? $wp_scripts->registered[$handle] : null;
            if (!$registered) {
                continue;
            }

            $src = isset($registered->src) ? (string) $registered->src : '';
            $haystack = strtolower($handle . ' ' . $src);
            $should_block = false;
            foreach ($blocked_markers as $marker) {
                if (strpos($haystack, $marker) !== false) {
                    $should_block = true;
                    break;
                }
            }

            if (!$should_block) {
                continue;
            }

            wp_dequeue_script($handle);
            wp_deregister_script($handle);
        }
    }

    private function normalize_geo_name($value) {
        $value = strtolower(trim((string) $value));
        $value = remove_accents($value);
        $value = preg_replace('/[^a-z0-9]+/', '', $value);
        return is_string($value) ? $value : '';
    }

    private function order_has_created_shipment($order) {
        if (!is_object($order) || !method_exists($order, 'get_meta')) {
            return false;
        }

        $shipment_id = trim((string) $order->get_meta('dzfs_shipment_id'));
        $tracking_number = trim((string) $order->get_meta('dzfs_tracking_number'));

        return $shipment_id !== '' || $tracking_number !== '';
    }

    private function read_order_delivery_meta_value($order, $key, $session_key = '', $default = '') {
        $value = '';
        if (is_object($order) && method_exists($order, 'get_meta')) {
            $value = (string) $order->get_meta($key);
        }

        if ($value === '' && $session_key !== '' && function_exists('WC') && WC() && WC()->session) {
            $value = (string) WC()->session->get($session_key);
        }

        if ($value === '') {
            $value = (string) $default;
        }

        return sanitize_text_field($value);
    }

    private function sync_native_order_address_from_delivery_meta($order, $delivery_type, $wilaya_name, $commune_name, $office_name, $address) {
        if (!is_object($order)) {
            return;
        }

        $resolved_state = sanitize_text_field((string) $wilaya_name);
        $resolved_city = $delivery_type === 'stopdesk'
            ? sanitize_text_field((string) ($office_name !== '' ? $office_name : $commune_name))
            : sanitize_text_field((string) $commune_name);
        $resolved_address = sanitize_text_field((string) $address);

        if ($resolved_state !== '') {
            if (method_exists($order, 'set_shipping_state')) {
                $order->set_shipping_state($resolved_state);
            }
            if (method_exists($order, 'set_billing_state')) {
                $order->set_billing_state($resolved_state);
            }
        }

        if ($resolved_city !== '') {
            if (method_exists($order, 'set_shipping_city')) {
                $order->set_shipping_city($resolved_city);
            }
            if (method_exists($order, 'set_billing_city')) {
                $order->set_billing_city($resolved_city);
            }
        }

        if ($resolved_address !== '') {
            if (method_exists($order, 'set_shipping_address_1')) {
                $order->set_shipping_address_1($resolved_address);
            }
            if (method_exists($order, 'set_billing_address_1')) {
                $order->set_billing_address_1($resolved_address);
            }
        }
    }

    private function hydrate_delivery_meta_from_session($order) {
        if (!is_object($order) || !method_exists($order, 'update_meta_data')) {
            return;
        }

        // Guard: prevent duplicate meta writes in the same PHP request.
        $order_id = $order->get_id();
        if ($order_id && isset($this->delivery_meta_hydrated[$order_id])) {
            return;
        }
        if ($order_id) {
            $this->delivery_meta_hydrated[$order_id] = true;
        }

        // Guard: if classic checkout already persisted all meta via save_delivery_checkout_fields,
        // skip hydration to prevent duplicate meta rows.
        $existing_wilaya_id = (string) $this->read_order_delivery_meta_value($order, 'dzfs_shipping_wilaya_id', 'dzfs_shipping_wilaya_id');
        $existing_price = (float) $order->get_meta('dzfs_shipping_price');
        if ($existing_wilaya_id !== '' && $existing_price > 0) {
            return;
        }

        $delivery_type = $this->read_order_delivery_meta_value($order, 'dzfs_shipping_type', 'dzfs_shipping_type', 'home');
        if ($delivery_type !== 'stopdesk') {
            $delivery_type = 'home';
        }

        $wilaya_id = $this->read_order_delivery_meta_value($order, 'dzfs_shipping_wilaya_id', 'dzfs_shipping_wilaya_id');
        $commune_id = $this->read_order_delivery_meta_value($order, 'dzfs_shipping_commune_id', 'dzfs_shipping_commune_id');
        $office_id = $this->read_order_delivery_meta_value($order, 'dzfs_shipping_office_id', 'dzfs_shipping_office_id');
        $departure_center_id = '';
        $departure_center_name = '';

        if (is_object($order) && method_exists($order, 'get_meta')) {
            $departure_center_id = trim((string) $order->get_meta('dzfs_shipping_departure_center_id'));
            $departure_center_name = trim((string) $order->get_meta('dzfs_shipping_departure_center_name'));
        }

        if (!$this->order_has_created_shipment($order)) {
            if ($departure_center_id === '') {
                $departure_center_id = $this->read_order_delivery_meta_value($order, 'dzfs_shipping_departure_center_id', 'dzfs_shipping_departure_center_id');
            }
            if ($departure_center_id === '') {
                $departure_center_id = $this->resolve_selected_departure_center_id();
            }

            if ($departure_center_name === '') {
                $departure_center_name = $this->read_order_delivery_meta_value($order, 'dzfs_shipping_departure_center_name', 'dzfs_shipping_departure_center_name');
            }
            if ($departure_center_name === '') {
                $departure_center_name = $this->resolve_selected_departure_center_name($departure_center_id);
            }
        }
        $shipping_price = (float) $order->get_meta('dzfs_shipping_price');
        $all_cache = $this->get_cached_delivery_data('');

        if ($wilaya_id === '') {
            $native_state = trim((string) $order->get_shipping_state());
            if ($native_state === '') {
                $native_state = trim((string) $order->get_billing_state());
            }
            $wilaya_id = $this->infer_wilaya_id_from_native_state($all_cache, $native_state);
        }
        $wilaya_id = $this->normalize_wilaya_id_prefer_non_seed($all_cache, $wilaya_id);

        if ($commune_id === '') {
            $native_city = trim((string) $order->get_shipping_city());
            if ($native_city === '') {
                $native_city = trim((string) $order->get_billing_city());
            }
            $commune_id = $this->infer_commune_id_from_city($all_cache, $wilaya_id, $native_city);
        }

        if ($shipping_price <= 0 && function_exists('WC') && WC() && WC()->session) {
            $shipping_price = max(0, (float) WC()->session->get('dzfs_shipping_price'));
        }

        if ($shipping_price <= 0 && $wilaya_id !== '') {
            $local_price = $this->resolve_local_delivery_price($delivery_type, $wilaya_id, $commune_id, $office_id);
            if ($local_price !== null) {
                $shipping_price = max(0, (float) $local_price);
            }
        }

        // Final fallback: use the actual WooCommerce shipping total on the order.
        // For block checkout (Store API), the cart totals are calculated before
        // woocommerce_new_order fires, so this value is already populated and
        // reflects exactly what the customer was charged — it is the ground truth
        // when the session price is unavailable.
        if ($shipping_price <= 0 && method_exists($order, 'get_shipping_total')) {
            $wc_shipping_total = (float) $order->get_shipping_total();
            if ($wc_shipping_total > 0) {
                $shipping_price = $wc_shipping_total;
            }
        }

        $cache = $this->get_cached_delivery_data($wilaya_id);
        $wilaya_name = $this->read_order_delivery_meta_value($order, 'dzfs_shipping_wilaya');
        $commune_name = $this->read_order_delivery_meta_value($order, 'dzfs_shipping_commune');
        $office_name = $this->read_order_delivery_meta_value($order, 'dzfs_shipping_stopdesk');

        if ($wilaya_name === '' && !empty($cache['wilayas']) && is_array($cache['wilayas'])) {
            foreach ($cache['wilayas'] as $row) {
                if ((string) ($row['wilaya_id'] ?? '') === $wilaya_id) {
                    $wilaya_name = (string) ($row['wilaya_name'] ?? '');
                    break;
                }
            }
        }

        if ($commune_name === '' && !empty($cache['communes']) && is_array($cache['communes'])) {
            foreach ($cache['communes'] as $row) {
                if ((string) ($row['commune_id'] ?? '') === $commune_id) {
                    $commune_name = (string) ($row['commune_name'] ?? '');
                    break;
                }
            }
        }

        if ($office_name === '' && !empty($cache['offices']) && is_array($cache['offices'])) {
            foreach ($cache['offices'] as $row) {
                if ((string) ($row['office_id'] ?? '') === $office_id) {
                    $office_name = (string) ($row['office_name'] ?? '');
                    break;
                }
            }
        }

        $provider = isset($cache['provider']) ? sanitize_text_field((string) $cache['provider']) : 'yalidine';
        $address = $this->read_order_delivery_meta_value($order, 'dzfs_shipping_address', 'dzfs_shipping_address');
        if ($address === '') {
            $address = trim((string) $order->get_shipping_address_1());
            if ($address === '') {
                $address = trim((string) $order->get_billing_address_1());
            }
        }
        $customer_first_name = trim((string) $order->get_billing_first_name());
        if ($customer_first_name === '') {
            $customer_first_name = trim((string) $order->get_shipping_first_name());
        }
        $customer_last_name = trim((string) $order->get_billing_last_name());
        if ($customer_last_name === '') {
            $customer_last_name = trim((string) $order->get_shipping_last_name());
        }
        $customer_phone = trim((string) $order->get_billing_phone());

        $order->update_meta_data('dzfs_shipping_provider', $provider);
        $order->update_meta_data('dzfs_shipping_type', $delivery_type);
        $order->update_meta_data('dzfs_shipping_price', $shipping_price);
        $order->update_meta_data('dzfs_shipping_wilaya_id', $wilaya_id);
        $order->update_meta_data('dzfs_shipping_wilaya', $wilaya_name);
        $order->update_meta_data('dzfs_shipping_commune_id', $commune_id);
        $order->update_meta_data('dzfs_shipping_commune', $commune_name);
        $order->update_meta_data('dzfs_shipping_stopdesk', $office_name);
        $order->update_meta_data('dzfs_shipping_office_id', $office_id);
        if (!$this->order_has_created_shipment($order)) {
            $order->update_meta_data('dzfs_shipping_departure_center_id', $departure_center_id);
            $order->update_meta_data('dzfs_shipping_departure_center_name', $departure_center_name);
        }
        $order->update_meta_data('dzfs_shipping_address', $address);
        $order->update_meta_data('dzfs_customer_first_name', sanitize_text_field($customer_first_name));
        $order->update_meta_data('dzfs_customer_last_name', sanitize_text_field($customer_last_name));
        $order->update_meta_data('dzfs_customer_phone', sanitize_text_field($customer_phone));
        $order->update_meta_data('dzfs_customer_address_source', 'woocommerce_native');
        $this->sync_native_order_address_from_delivery_meta($order, $delivery_type, $wilaya_name, $commune_name, $office_name, $address);
        if (method_exists($order, 'save')) {
            $order->save();
        }
    }

    public function persist_delivery_fields_for_store_api($order) {
        $this->hydrate_delivery_meta_from_session($order);
    }

    private function resolve_delivery_type_from_request_or_session() {
        $posted_type = isset($_POST['dzfs_delivery_type']) ? sanitize_text_field(wp_unslash($_POST['dzfs_delivery_type'])) : '';
        if ($posted_type !== '') {
            return $posted_type;
        }

        if (function_exists('WC') && WC() && WC()->session) {
            return sanitize_text_field((string) WC()->session->get('dzfs_shipping_type'));
        }

        return '';
    }

    private function extract_wilaya_code($value) {
        $raw = trim((string) $value);
        if ($raw === '') {
            return '';
        }

        if (preg_match('/^DZ[-_\s]?(\d{1,2})$/i', $raw, $matches)) {
            return (string) intval($matches[1]);
        }

        if (preg_match('/^\d{1,2}$/', $raw)) {
            return (string) intval($raw);
        }

        return '';
    }

    private function normalize_wilaya_id_prefer_non_seed($cache, $wilaya_id) {
        $wilaya_id = sanitize_text_field((string) $wilaya_id);
        if ($wilaya_id === '' || !isset($cache['wilayas']) || !is_array($cache['wilayas'])) {
            return $wilaya_id;
        }

        if (stripos($wilaya_id, '_seed_') === false) {
            return $wilaya_id;
        }

        $selected_name = '';
        foreach ($cache['wilayas'] as $row) {
            if ((string) ($row['wilaya_id'] ?? '') === $wilaya_id) {
                $selected_name = (string) ($row['wilaya_name'] ?? '');
                break;
            }
        }
        if ($selected_name === '') {
            return $wilaya_id;
        }

        $target_name = $this->normalize_geo_name($selected_name);
        foreach ($cache['wilayas'] as $row) {
            $candidate_id = isset($row['wilaya_id']) ? (string) $row['wilaya_id'] : '';
            $candidate_name = isset($row['wilaya_name']) ? (string) $row['wilaya_name'] : '';
            if ($candidate_id === '' || $candidate_name === '') {
                continue;
            }
            if (stripos($candidate_id, '_seed_') !== false) {
                continue;
            }
            if ($this->normalize_geo_name($candidate_name) === $target_name) {
                return $candidate_id;
            }
        }

        return $wilaya_id;
    }

    private function infer_commune_id_from_city($cache, $wilaya_id, $city_name) {
        $target_wilaya = sanitize_text_field((string) $wilaya_id);
        $target_city = $this->normalize_geo_name($city_name);
        if ($target_wilaya === '' || $target_city === '' || !isset($cache['communes']) || !is_array($cache['communes'])) {
            return '';
        }

        foreach ($cache['communes'] as $row) {
            $row_wilaya = isset($row['wilaya_id']) ? (string) $row['wilaya_id'] : '';
            $row_commune_id = isset($row['commune_id']) ? (string) $row['commune_id'] : '';
            $row_commune_name = isset($row['commune_name']) ? (string) $row['commune_name'] : '';
            if ($row_wilaya !== $target_wilaya || $row_commune_id === '' || $row_commune_name === '') {
                continue;
            }

            if ($this->normalize_geo_name($row_commune_name) === $target_city) {
                return $row_commune_id;
            }
        }

        return '';
    }

    private function infer_wilaya_id_from_native_state($cache, $native_state) {
        $state = $this->normalize_geo_name($native_state);
        if (!isset($cache['wilayas']) || !is_array($cache['wilayas'])) {
            return '';
        }

        $code = $this->extract_wilaya_code($native_state);
        if ($code !== '') {
            foreach ($cache['wilayas'] as $row) {
                $candidate_id = isset($row['wilaya_id']) ? (string) $row['wilaya_id'] : '';
                if ($candidate_id === '') {
                    continue;
                }
                if ($candidate_id === $code || preg_match('/(?:_|-)'.preg_quote($code, '/').'$/', $candidate_id)) {
                    return $this->normalize_wilaya_id_prefer_non_seed($cache, $candidate_id);
                }
            }
        }

        if ($state === '') {
            return '';
        }

        foreach ($cache['wilayas'] as $row) {
            $candidate_id = isset($row['wilaya_id']) ? (string) $row['wilaya_id'] : '';
            $candidate_name = isset($row['wilaya_name']) ? (string) $row['wilaya_name'] : '';
            if ($candidate_id === '' || $candidate_name === '') {
                continue;
            }

            if ($this->normalize_geo_name($candidate_name) === $state) {
                return $this->normalize_wilaya_id_prefer_non_seed($cache, $candidate_id);
            }
        }

        return '';
    }

    private function read_native_shipping_address_line() {
        $shipping_address = isset($_POST['shipping_address_1']) ? sanitize_text_field(wp_unslash($_POST['shipping_address_1'])) : '';
        $billing_address = isset($_POST['billing_address_1']) ? sanitize_text_field(wp_unslash($_POST['billing_address_1'])) : '';

        if ($shipping_address !== '') {
            return $shipping_address;
        }
        if ($billing_address !== '') {
            return $billing_address;
        }

        if (function_exists('WC') && WC() && WC()->session) {
            return sanitize_text_field((string) WC()->session->get('dzfs_shipping_address'));
        }

        return '';
    }

    public function adjust_native_address_fields_for_delivery_mode($fields) {
        $delivery_type = $this->resolve_delivery_type_from_request_or_session();
        if ($delivery_type !== 'stopdesk') {
            return $fields;
        }

        if (isset($fields['shipping']['shipping_address_1'])) {
            $fields['shipping']['shipping_address_1']['required'] = false;
        }
        if (isset($fields['shipping']['shipping_city'])) {
            $fields['shipping']['shipping_city']['required'] = false;
        }

        return $fields;
    }

    public function register_checkout_block_update_callback() {
        error_log('DZFS [ECU-REG] woocommerce_store_api_register_update_callback=' . (function_exists('woocommerce_store_api_register_update_callback') ? 'yes' : 'no'));
        if (!function_exists('woocommerce_store_api_register_update_callback')) {
            return;
        }

        woocommerce_store_api_register_update_callback(array(
            'namespace' => 'dzfs-delivery',
            'callback' => function($data) {
                error_log('DZFS [ECU-ENTER] data=' . json_encode($data));
                $payload = is_array($data) ? $data : array();
                $delivery_type = isset($payload['deliveryType']) ? sanitize_text_field((string) $payload['deliveryType']) : '';
                $wilaya_id = isset($payload['wilayaId']) ? sanitize_text_field((string) $payload['wilayaId']) : '';
                $commune_id = isset($payload['communeId']) ? sanitize_text_field((string) $payload['communeId']) : '';
                $office_id = isset($payload['officeId']) ? sanitize_text_field((string) $payload['officeId']) : '';

                $cache = $this->get_cached_delivery_data('');
                $wilaya_id = $this->normalize_wilaya_id_prefer_non_seed($cache, $wilaya_id);

                $validation_error = '';
                $clean_type = $delivery_type === 'stopdesk' ? 'stopdesk' : 'home';

                if ($wilaya_id === '') {
                    $validation_error = 'Please select a wilaya.';
                } elseif ($clean_type === 'stopdesk') {
                    if ($office_id === '') {
                        $validation_error = 'Please select a stopdesk office';
                    }
                }

                if ($validation_error !== '') {
                    error_log('DZFS [ECU-VALIDATION-FAIL] wilaya=' . $wilaya_id . ' type=' . $clean_type . ' office=' . $office_id . ' error=' . $validation_error);
                    $this->mark_delivery_price_unavailable($clean_type, $wilaya_id, $commune_id, $office_id);
                    return array(
                        'success' => false,
                        'validationError' => $validation_error,
                        'resolvedPrice' => null,
                    );
                }

                // Fetch price from the SaaS global delivery cache.
                $departure_center_id = $this->resolve_selected_departure_center_id();
                $response = $this->api->get_delivery_price(array(
                    'deliveryType'      => $clean_type,
                    'wilayaId'          => $wilaya_id,
                    'communeId'         => $commune_id !== '' ? $commune_id : null,
                    'officeId'          => ($clean_type === 'stopdesk' && $office_id !== '') ? $office_id : null,
                    'departureCenterId' => $departure_center_id !== '' ? $departure_center_id : null,
                ));

                if (is_wp_error($response)) {
                    error_log('DZFS [ECU-API-FAIL] wp_error=' . $response->get_error_message());
                    $this->mark_delivery_price_unavailable($clean_type, $wilaya_id, $commune_id, $office_id);
                    return array(
                        'success' => false,
                        'validationError' => 'Delivery price is unavailable for the selected location.',
                        'resolvedPrice' => null,
                    );
                }

                $price = isset($response['price']) ? (float) $response['price'] : null;

                if ($price === null || $price <= 0) {
                    // PRIMARY PATH RETURNED NULL: delivery_prices (SaaS) has no row for
                    // this wilaya/center. Fix: run Merchant Delivery Sync in SaaS dashboard.
                    error_log('DZFS [ECU-DELIVERY-PRICE-NULL] delivery_prices returned null for wilaya=' . $wilaya_id . ' type=' . $clean_type . ' response=' . json_encode($response) . ' — using emergency local fallback (wp_dzfs_fees).');
                    $price = $this->resolve_local_delivery_price($clean_type, $wilaya_id, $commune_id, $office_id);
                    if ($price === null || $price <= 0) {
                        $this->mark_delivery_price_unavailable($clean_type, $wilaya_id, $commune_id, $office_id);
                        return array(
                            'success' => false,
                            'validationError' => 'Delivery price is unavailable for the selected location.',
                            'resolvedPrice' => null,
                        );
                    }
                    error_log('DZFS [ECU-EMERGENCY-OK] fee_returned=' . $price . ' final_shipping_cost=' . $price . ' source=wp_dzfs_fees');
                }

                // Pin the resolved price in memory so filter_shipping_rates_when_cached_delivery_active
                // can inject it into every calculate_shipping() call within this request without
                // depending on the session backend being flushed first.
                $this->dzfs_live_price = (float) $price;
                error_log('DZFS [ECU-PRICE] api_price=' . $price . ' dzfs_live_price=' . $this->dzfs_live_price);

                if ($clean_type === 'home') {
                    $commune_id = '';
                    $office_id = '';
                }
                $this->set_delivery_session_values($clean_type, $wilaya_id, $commune_id, $office_id, $price);
                error_log('DZFS [ECU-SESSION] price_ready=' . (string) WC()->session->get('dzfs_shipping_price_ready') . ' price=' . (string) WC()->session->get('dzfs_shipping_price') . ' chosen=' . json_encode(WC()->session->get('chosen_shipping_methods')));

                if (function_exists('WC') && WC() && WC()->session) {
                    WC()->session->set('dzfs_customer_address_source', 'woocommerce_native');
                }

                if (function_exists('WC') && WC() && WC()->cart) {
                    WC()->cart->calculate_shipping();
                    error_log('DZFS [ECU-AFTER-CALC-SHIPPING] shipping_total=' . (string) WC()->cart->get_shipping_total());
                    WC()->cart->calculate_totals();
                    error_log('DZFS [ECU-AFTER-CALC-TOTALS] shipping_total=' . (string) WC()->cart->get_shipping_total() . ' cart_total=' . (string) WC()->cart->get_total('edit'));
                }

                return array(
                    'success' => true,
                    'resolvedPrice' => max(0, (float) $price),
                );
            }
        ));
    }

    public function ajax_delivery_cache() {
        if (!DZFS_Helpers::is_enabled()) {
            wp_send_json_error(array('message' => 'disabled'), 403);
        }

        $wilaya_id = isset($_REQUEST['wilayaId']) ? sanitize_text_field(wp_unslash($_REQUEST['wilayaId'])) : '';

        // Fetch wilayas/communes/offices from the SaaS global delivery cache.
        // Falls back to an empty payload when the API is unreachable.
        $cache = $this->api->get_delivery_cache($wilaya_id);

        if (is_wp_error($cache)) {
            wp_send_json_success(array(
                'provider' => 'yalidine',
                'wilayas' => array(),
                'communes' => array(),
                'offices' => array(),
                'stale' => true,
                'staleReason' => 'api_unavailable',
                'staleMessage' => 'Delivery data temporarily unavailable. Please try again.',
            ));
            return;
        }

        wp_send_json_success(array(
            'provider' => isset($cache['provider']) ? (string) $cache['provider'] : 'yalidine',
            'wilayas' => isset($cache['wilayas']) && is_array($cache['wilayas']) ? $cache['wilayas'] : array(),
            'communes' => isset($cache['communes']) && is_array($cache['communes']) ? $cache['communes'] : array(),
            'offices' => isset($cache['offices']) && is_array($cache['offices']) ? $cache['offices'] : array(),
            'stale' => (bool) ($cache['stale'] ?? false),
            'staleReason' => isset($cache['staleReason']) ? (string) $cache['staleReason'] : '',
            'staleMessage' => isset($cache['staleMessage']) ? (string) $cache['staleMessage'] : '',
        ));
    }

    public function ajax_save_delivery() {
        if (!DZFS_Helpers::is_enabled()) {
            wp_send_json_error(array('message' => 'disabled'), 403);
        }

        $delivery_type = isset($_POST['deliveryType']) ? sanitize_text_field(wp_unslash($_POST['deliveryType'])) : 'home';
        $wilaya_id = isset($_POST['wilayaId']) ? sanitize_text_field(wp_unslash($_POST['wilayaId'])) : '';
        $commune_id = isset($_POST['communeId']) ? sanitize_text_field(wp_unslash($_POST['communeId'])) : '';
        $office_id = isset($_POST['officeId']) ? sanitize_text_field(wp_unslash($_POST['officeId'])) : '';

        if ($wilaya_id === '') {
            $this->mark_delivery_price_unavailable($delivery_type ?: 'home', '', '', '');
            wp_send_json_success(array('resolvedPrice' => null));
            return;
        }

        // Try SaaS API first; fall back to local wp_dzfs_fees when it returns null.
        $departure_center_id = $this->resolve_selected_departure_center_id();
        error_log('DZFS [SAVE-DELIVERY] type=' . $delivery_type . ' dest_wilaya=' . $wilaya_id . ' commune=' . $commune_id . ' office_id=' . $office_id . ' center_id=' . $departure_center_id);

        $response = $this->api->get_delivery_price(array(
            'deliveryType'      => $delivery_type ?: 'home',
            'wilayaId'          => $wilaya_id,
            'communeId'         => $commune_id !== '' ? $commune_id : null,
            'officeId'          => ($delivery_type === 'stopdesk' && $office_id !== '') ? $office_id : null,
            'departureCenterId' => $departure_center_id !== '' ? $departure_center_id : null,
        ));

        if (is_wp_error($response)) {
            // PRIMARY PATH FAILED: SaaS delivery-price endpoint unreachable.
            // delivery_prices (SaaS) is the intended pricing source. Run Merchant Delivery
            // Sync in the SaaS dashboard to populate it. Using emergency local fallback.
            error_log('DZFS [DELIVERY-PRICE-PRIMARY-FAIL] SaaS API error: ' . $response->get_error_message() . ' wilaya=' . $wilaya_id . ' type=' . $delivery_type . ' center=' . $departure_center_id . ' — using emergency local fallback (wp_dzfs_fees). Fix: run Merchant Delivery Sync in SaaS dashboard.');
            $price = $this->resolve_local_delivery_price($delivery_type ?: 'home', $wilaya_id, $commune_id, $office_id);
            if ($price === null || $price <= 0) {
                $this->mark_delivery_price_unavailable($delivery_type ?: 'home', $wilaya_id, $commune_id, $office_id);
                wp_send_json_success(array('resolvedPrice' => null));
                return;
            }
            error_log('DZFS [DELIVERY-PRICE-EMERGENCY-OK] fee_returned=' . $price . ' final_shipping_cost=' . $price . ' source=wp_dzfs_fees');
            $this->set_delivery_session_values($delivery_type, $wilaya_id, $commune_id, $office_id, $price);
            wp_send_json_success(array('resolvedPrice' => $price));
            return;
        }

        $price = isset($response['price']) ? (float) $response['price'] : null;
        $stale = isset($response['stale']) ? ($response['stale'] ? '1' : '0') : 'n/a';
        $meta  = isset($response['meta']) ? json_encode($response['meta']) : '{}';
        error_log('DZFS [DELIVERY-PRICE-PRIMARY] api_price=' . var_export($price, true) . ' stale=' . $stale . ' meta=' . $meta);

        if ($price === null || $price <= 0) {
            // PRIMARY PATH RETURNED NULL: delivery_prices (SaaS) has no row for this
            // wilaya/center combination. Most likely the merchant has not yet run the
            // Merchant Delivery Sync in the SaaS dashboard. Using emergency local fallback.
            error_log('DZFS [DELIVERY-PRICE-PRIMARY-NULL] delivery_prices returned null for wilaya=' . $wilaya_id . ' type=' . $delivery_type . ' center=' . $departure_center_id . ' — using emergency local fallback (wp_dzfs_fees). Fix: run Merchant Delivery Sync in SaaS dashboard.');
            $price = $this->resolve_local_delivery_price($delivery_type ?: 'home', $wilaya_id, $commune_id, $office_id);
            if ($price === null || $price <= 0) {
                $this->mark_delivery_price_unavailable($delivery_type ?: 'home', $wilaya_id, $commune_id, $office_id);
                wp_send_json_success(array('resolvedPrice' => null));
                return;
            }
            error_log('DZFS [DELIVERY-PRICE-EMERGENCY-OK] fee_returned=' . $price . ' final_shipping_cost=' . $price . ' source=wp_dzfs_fees');
        }

        $this->set_delivery_session_values($delivery_type, $wilaya_id, $commune_id, $office_id, $price);
        error_log('DZFS [SAVE-DELIVERY-DONE] final_shipping_cost=' . $price);
        wp_send_json_success(array('resolvedPrice' => $price));
    }

    public function sync_delivery_from_review_post($post_data_raw) {
        if (!DZFS_Helpers::is_enabled() || empty($post_data_raw)) {
            return;
        }

        $posted = array();
        wp_parse_str($post_data_raw, $posted);

        $delivery_type = isset($posted['dzfs_delivery_type']) ? sanitize_text_field((string) $posted['dzfs_delivery_type']) : '';
        $wilaya_id = isset($posted['dzfs_delivery_wilaya']) ? sanitize_text_field((string) $posted['dzfs_delivery_wilaya']) : '';
        $commune_id = isset($posted['dzfs_delivery_commune']) ? sanitize_text_field((string) $posted['dzfs_delivery_commune']) : '';
        $office_id = isset($posted['dzfs_delivery_stopdesk']) ? sanitize_text_field((string) $posted['dzfs_delivery_stopdesk']) : '';
        $shipping_price = isset($posted['dzfs_shipping_price']) ? max(0, (float) $posted['dzfs_shipping_price']) : 0;

        if ($wilaya_id === '' || !function_exists('WC') || !WC() || !WC()->session) {
            return;
        }

        error_log('DZFS [REVIEW-POST] type=' . ($delivery_type ?: 'home') . ' dest_wilaya=' . $wilaya_id . ' commune=' . $commune_id . ' office_id=' . $office_id . ' dzfs_shipping_price_from_post=' . $shipping_price);

        // Guard: if the hidden field was 0/empty (JS hadn't set it yet), preserve an
        // already-valid session price for the same wilaya rather than overwriting with 0.
        if ($shipping_price <= 0) {
            $existing_price = max(0, (float) WC()->session->get('dzfs_shipping_price'));
            $existing_wilaya = sanitize_text_field((string) WC()->session->get('dzfs_shipping_wilaya_id'));
            $existing_ready  = (string) WC()->session->get('dzfs_shipping_price_ready') === '1';
            if ($existing_ready && $existing_price > 0 && $existing_wilaya === $wilaya_id) {
                $shipping_price = $existing_price;
                error_log('DZFS [REVIEW-POST-PRESERVE] reusing session price=' . $shipping_price . ' for wilaya=' . $wilaya_id);
            }
        }

        $this->set_delivery_session_values(
            $delivery_type ?: 'home',
            $wilaya_id,
            $commune_id,
            $office_id,
            $shipping_price
        );
    }

    public function register_fraud_blocked_status() {
        if (!DZFS_Helpers::fraud_blocked_status_enabled()) {
            return;
        }

        register_post_status('wc-fraud_blocked', array(
            'label'                     => 'Fraud Blocked',
            'public'                    => true,
            'exclude_from_search'       => false,
            'show_in_admin_all_list'    => true,
            'show_in_admin_status_list' => true,
            'label_count'               => _n_noop('Fraud Blocked <span class="count">(%s)</span>', 'Fraud Blocked <span class="count">(%s)</span>')
        ));
    }

    public function add_fraud_blocked_to_statuses($statuses) {
        if (!DZFS_Helpers::fraud_blocked_status_enabled()) {
            return $statuses;
        }

        $updated = array();
        foreach ($statuses as $key => $label) {
            $updated[$key] = $label;
            if ($key === 'wc-cancelled') {
                $updated['wc-fraud_blocked'] = 'Fraud Blocked';
            }
        }

        if (!isset($updated['wc-fraud_blocked'])) {
            $updated['wc-fraud_blocked'] = 'Fraud Blocked';
        }

        return $updated;
    }

    public function render_fraud_blocked_status_color() {
        if (!DZFS_Helpers::fraud_blocked_status_enabled()) {
            return;
        }

        echo '<style>.status-fraud_blocked{background:#b91c1c !important;color:#fff !important;}</style>';
    }

    public function sync_merchant_decision_actions() {
        if (!DZFS_Helpers::is_enabled()) {
            return;
        }

        $response = $this->api->get_pending_merchant_decision_actions(30);
        if (is_wp_error($response)) {
            error_log('[DZFS] decision sync fetch failed: ' . $response->get_error_message());
            return;
        }

        $actions = isset($response['actions']) && is_array($response['actions']) ? $response['actions'] : array();
        if (empty($actions)) {
            return;
        }

        foreach ($actions as $action) {
            $this->apply_merchant_decision_action($action);
        }
    }

    private function apply_merchant_decision_action($action) {
        $decision_id = isset($action['decisionId']) ? sanitize_text_field((string) $action['decisionId']) : '';
        $check_id = isset($action['orderCheckId']) ? sanitize_text_field((string) $action['orderCheckId']) : '';
        $decision = isset($action['decision']) ? sanitize_text_field((string) $action['decision']) : '';
        $shipment_id = isset($action['shipmentId']) ? sanitize_text_field((string) $action['shipmentId']) : '';
        $tracking_number = isset($action['trackingNumber']) ? sanitize_text_field((string) $action['trackingNumber']) : '';
        $order_id = isset($action['orderId']) ? absint($action['orderId']) : 0;

        if ($order_id <= 0 && !empty($action['externalOrderId'])) {
            $order_id = absint($action['externalOrderId']);
        }

        if ($order_id <= 0 || empty($decision_id) || empty($check_id) || empty($decision)) {
            return;
        }

        $order = wc_get_order($order_id);
        if (!$order) {
            $this->api->sync_merchant_decision(array(
                'decisionId' => $decision_id,
                'orderCheckId' => $check_id,
                'syncError' => 'woocommerce_order_not_found',
            ));
            return;
        }

        $previous_status = $order->get_status();
        $target_status = $this->target_status_for_decision($decision);
        $note = $this->note_for_decision($decision);

        $status_to_apply = $target_status;
        if ($status_to_apply === 'fraud_blocked' && !DZFS_Helpers::fraud_blocked_status_enabled()) {
            $status_to_apply = 'cancelled';
        }

        if ($previous_status !== $status_to_apply) {
            $order->update_status($status_to_apply, $note, true);
        }

        $order->add_order_note($note);
        if ($shipment_id !== '') {
            $order->update_meta_data('dzfs_shipment_id', $shipment_id);
        }
        if ($tracking_number !== '') {
            $order->update_meta_data('dzfs_tracking_number', $tracking_number);
            $order->add_order_note('DZ Fraud Shield tracking number: ' . $tracking_number);
        }
        if (method_exists($order, 'save')) {
            $order->save();
        }
        update_post_meta($order_id, 'dzfs_merchant_decision_id', $decision_id);
        update_post_meta($order_id, 'dzfs_merchant_decision', $decision);
        update_post_meta($order_id, 'dzfs_merchant_decision_synced_at', current_time('mysql'));

        $sync_result = $this->api->sync_merchant_decision(array(
            'decisionId' => $decision_id,
            'orderCheckId' => $check_id,
            'previousWooStatus' => $previous_status,
            'newWooStatus' => $status_to_apply,
        ));

        if (is_wp_error($sync_result)) {
            error_log('[DZFS] decision sync callback failed decision=' . $decision_id . ' error=' . $sync_result->get_error_message());
        }
    }

    private function target_status_for_decision($decision) {
        switch (strtoupper((string) $decision)) {
            case 'ACCEPTED':
                return DZFS_Helpers::accept_decision_status();
            case 'VERIFY_FIRST':
                return DZFS_Helpers::verify_decision_status();
            case 'BLOCKED':
                return DZFS_Helpers::block_decision_status();
            default:
                return 'on-hold';
        }
    }

    private function note_for_decision($decision) {
        switch (strtoupper((string) $decision)) {
            case 'ACCEPTED':
                return 'DZ Fraud Shield: Merchant accepted order.';
            case 'VERIFY_FIRST':
                return 'Customer verification requested by DZ Fraud Shield';
            case 'BLOCKED':
                return 'Order blocked by DZ Fraud Shield risk engine';
            default:
                return 'DZ Fraud Shield: Merchant decision applied.';
        }
    }

    public function scan_from_new_order($order_id) {
        $this->scan_order_by_id($order_id, 'woocommerce_new_order');
    }

    public function scan_from_thankyou($order_id) {
        $this->scan_order_by_id($order_id, 'woocommerce_thankyou');
    }

    public function scan_from_status_pending($order_id) {
        $this->scan_order_by_id($order_id, 'woocommerce_order_status_pending');
    }

    public function scan_from_status_processing($order_id) {
        $this->scan_order_by_id($order_id, 'woocommerce_order_status_processing');
    }

    private function scan_order_by_id($order_id, $source_hook) {
        $order_id = absint($order_id);
        if ($order_id <= 0) {
            return;
        }

        error_log('[DZFS] Order hook fired: ' . $order_id . ' via ' . $source_hook);

        $order = wc_get_order($order_id);
        if (!$order) {
            error_log('[DZFS] Order not found for hook: ' . $source_hook . ' order_id=' . $order_id);
            return;
        }

        $this->scan_order($order_id, $order, $source_hook);
    }

    public function check_order_risk($order_id, $posted_data, $order) {
        error_log('[DZFS] Order hook fired: ' . $order_id . ' via woocommerce_checkout_order_processed');
        $this->hydrate_delivery_meta_from_session($order);
        $this->scan_order($order_id, $order, 'woocommerce_checkout_order_processed');
    }

    private function scan_order($order_id, $order, $source_hook) {
        if (!DZFS_Helpers::is_enabled()) {
            error_log('[DZFS] Scan skipped (plugin disabled) order_id=' . $order_id);
            return;
        }

        $existing_check_id = get_post_meta($order_id, 'dzfs_check_id', true);
        if (!empty($existing_check_id)) {
            error_log('[DZFS] Scan skipped (already scanned) order_id=' . $order_id . ' check_id=' . $existing_check_id);
            return;
        }

        $existing_scan_lock = get_post_meta($order_id, 'dzfs_check_lock', true);
        if (!empty($existing_scan_lock)) {
            error_log('[DZFS] Scan skipped (already in progress) order_id=' . $order_id . ' lock=' . $existing_scan_lock);
            return;
        }

        $scan_lock = sprintf('%s|%s', current_time('mysql'), $source_hook);
        if (!add_post_meta($order_id, 'dzfs_check_lock', $scan_lock, true)) {
            error_log('[DZFS] Scan skipped (lock acquisition failed) order_id=' . $order_id . ' hook=' . $source_hook);
            return;
        }

        $this->hydrate_delivery_meta_from_session($order);

        $billing_phone = trim((string) $order->get_billing_phone());
        $normalized_phone = DZFS_Helpers::normalize_phone($billing_phone);
        $product_names = array();
        $product_items = array();

        foreach ($order->get_items() as $item) {
            $name = trim((string) $item->get_name());
            if (!empty($name)) {
                $product_names[] = $name;
                $product_items[] = array(
                    'productName' => $name,
                    'quantity' => (float) $item->get_quantity(),
                    'itemTotal' => (float) $item->get_total(),
                );
            }
        }

        $shipping_provider = trim((string) $order->get_meta('dzfs_shipping_provider'));
        $shipping_type = trim((string) $order->get_meta('dzfs_shipping_type'));
        $shipping_wilaya_id = trim((string) $order->get_meta('dzfs_shipping_wilaya_id'));
        $cache_for_payload = $this->get_cached_delivery_data($shipping_wilaya_id);
        $shipping_wilaya_id = $this->normalize_wilaya_id_prefer_non_seed($cache_for_payload, $shipping_wilaya_id);
        $shipping_wilaya = trim((string) $order->get_meta('dzfs_shipping_wilaya'));
        if ($shipping_wilaya === '' && $shipping_wilaya_id !== '' && !empty($cache_for_payload['wilayas']) && is_array($cache_for_payload['wilayas'])) {
            foreach ($cache_for_payload['wilayas'] as $row) {
                if ((string) ($row['wilaya_id'] ?? '') === $shipping_wilaya_id) {
                    $shipping_wilaya = trim((string) ($row['wilaya_name'] ?? ''));
                    break;
                }
            }
        }
        if ($shipping_wilaya === '') {
            $shipping_wilaya = DZFS_Helpers::get_wilaya_from_address($order->get_shipping_state());
        }
        if ($shipping_wilaya === '') {
            $shipping_wilaya = DZFS_Helpers::get_wilaya_from_address($order->get_billing_state());
        }

        $shipping_commune = trim((string) $order->get_meta('dzfs_shipping_commune'));
        // For stopdesk orders the native WC shipping_city was overwritten with the
        // office name by sync_native_order_address_from_delivery_meta — skip that
        // fallback so the office name never leaks into shippingCommune.
        if ($shipping_commune === '' && $shipping_type !== 'stopdesk') {
            $shipping_commune = trim((string) $order->get_shipping_city());
        }
        if ($shipping_commune === '' && $shipping_type !== 'stopdesk') {
            $shipping_commune = trim((string) $order->get_billing_city());
        }
        if ($shipping_commune === '' && $shipping_wilaya_id !== '') {
            $shipping_commune_id = trim((string) $order->get_meta('dzfs_shipping_commune_id'));
            if ($shipping_commune_id !== '' && !empty($cache_for_payload['communes']) && is_array($cache_for_payload['communes'])) {
                foreach ($cache_for_payload['communes'] as $row) {
                    if ((string) ($row['commune_id'] ?? '') === $shipping_commune_id) {
                        $shipping_commune = trim((string) ($row['commune_name'] ?? ''));
                        break;
                    }
                }
            }
        }
        $shipping_stopdesk = trim((string) $order->get_meta('dzfs_shipping_stopdesk'));
        $shipping_office_id = trim((string) $order->get_meta('dzfs_shipping_office_id'));
        $shipping_price = (float) $order->get_meta('dzfs_shipping_price');
        if ($shipping_price <= 0 && method_exists($order, 'get_shipping_total')) {
            $shipping_price = max(0, (float) $order->get_shipping_total());
        }

        if ($shipping_type !== 'home' && $shipping_type !== 'stopdesk') {
            $shipping_type = '';
        }

        $payload = array(
            'orderId' => (string) $order_id,
            'customerName' => trim($order->get_billing_first_name() . ' ' . $order->get_billing_last_name()),
            'customerPhone' => !empty($billing_phone) ? $billing_phone : null,
            'customerAddress' => trim($order->get_billing_address_1() . ' ' . $order->get_billing_address_2()),
            'city' => $order->get_billing_city(),
            'commune' => $order->get_billing_city(),
            'wilaya' => DZFS_Helpers::get_wilaya_from_address($order->get_billing_state()),
            'addressHash' => DZFS_Helpers::hash_value($order->get_billing_address_1() . ' ' . $order->get_billing_address_2()),
            'productNames' => $product_names,
            'productItems' => $product_items,
            'ip' => WC_Geolocation::get_ip_address(),
            'userAgent' => isset($_SERVER['HTTP_USER_AGENT']) ? sanitize_text_field(wp_unslash($_SERVER['HTTP_USER_AGENT'])) : '',
            'cartTotal' => (float) $order->get_total(),
            'totalAmount' => (float) $order->get_total(),
            'productCount' => (int) $order->get_item_count(),
            'paymentMethod' => $order->get_payment_method(),
            'shippingProvider' => $shipping_provider !== '' ? $shipping_provider : null,
            'shippingPrice' => max(0, $shipping_price),
            'shippingDepartureCenterId' => $order->get_meta('dzfs_shipping_departure_center_id') !== '' ? $order->get_meta('dzfs_shipping_departure_center_id') : null,
            'shippingDepartureCenterName' => $order->get_meta('dzfs_shipping_departure_center_name') !== '' ? $order->get_meta('dzfs_shipping_departure_center_name') : null,
            'shippingWilaya' => $shipping_wilaya !== '' ? $shipping_wilaya : null,
            'shippingCommune' => $shipping_commune !== '' ? $shipping_commune : null,
            'shippingStopdesk' => $shipping_stopdesk !== '' ? $shipping_stopdesk : null,
            'shippingOfficeId' => $shipping_office_id !== '' ? $shipping_office_id : null,
            'isCod' => $order->get_payment_method() === 'cod',
        );

        if ($shipping_type !== '') {
            $payload['shippingType'] = $shipping_type;
        }

        foreach (array('shippingProvider', 'shippingWilaya', 'shippingCommune', 'shippingStopdesk', 'shippingOfficeId') as $optional_key) {
            if (!isset($payload[$optional_key]) || $payload[$optional_key] === null || $payload[$optional_key] === '') {
                unset($payload[$optional_key]);
            }
        }

        if (!empty($billing_phone)) {
            $payload['phone'] = $billing_phone;
        }

        if (!empty($normalized_phone)) {
            $payload['phoneHash'] = DZFS_Helpers::hash_value($normalized_phone);
        }

        error_log('[DZFS] Sending /check-order order_id=' . $order_id . ' hook=' . $source_hook . ' is_cod=' . ($payload['isCod'] ? 'yes' : 'no'));

        $result = $this->api->check_order($payload);

        if (is_wp_error($result)) {
            error_log('[DZFS] /check-order failed order_id=' . $order_id . ' error=' . $result->get_error_message());
            $order->add_order_note('DZ Fraud Shield API error: ' . $result->get_error_message());
            $order->add_order_note('DZ Fraud Shield: Risk check deferred because SaaS is temporarily unavailable. Continue fulfillment only after manual verification.');
            delete_post_meta($order_id, 'dzfs_check_lock');
            return;
        }

        error_log('[DZFS] /check-order success order_id=' . $order_id . ' check_id=' . (isset($result['checkId']) ? $result['checkId'] : 'none'));

        $risk_score = isset($result['score']) ? (int) $result['score'] : 0;
        $risk_level = isset($result['level']) ? sanitize_text_field($result['level']) : 'LOW';
        $risk_reasons = isset($result['reasons']) ? wp_json_encode($result['reasons']) : '[]';

        update_post_meta($order_id, 'dzfs_check_id', isset($result['checkId']) ? sanitize_text_field($result['checkId']) : '');
        update_post_meta($order_id, 'dzfs_risk_score', $risk_score);
        update_post_meta($order_id, 'dzfs_risk_level', $risk_level);
        update_post_meta($order_id, 'dzfs_risk_reasons', $risk_reasons);
        update_post_meta($order_id, 'dzfs_checked_at', current_time('mysql'));
        $this->persist_check_order_intelligence_meta($order_id, $result);
        delete_post_meta($order_id, 'dzfs_check_lock');

        // Fire-and-forget product intelligence — never blocks the order scan.
        $this->collect_product_intelligence($order_id, $order);

        if ($risk_level === 'BLOCK') {
            $order->add_order_note('DZ Fraud Shield: BLOCK risk detected. Merchant decision is required before shipping.');

            if (DZFS_Helpers::auto_block_enabled()) {
                $order->update_status('failed', 'DZ Fraud Shield blocked this order (high fraud risk).');
                return;
            }

            $order->update_status('on-hold', 'DZ Fraud Shield marked this order BLOCK risk. Manual merchant decision required.');
            return;
        }

        if ($risk_level === 'HIGH') {
            $order->update_status('on-hold', 'DZ Fraud Shield marked this order HIGH risk. Manual verification required.');
        }
    }

        private function get_cached_delivery_data($wilaya_id = '') {
            return $this->get_local_delivery_cache_payload($wilaya_id);
        }

        public function render_delivery_checkout_fields($checkout) {
                if (!DZFS_Helpers::is_enabled()) {
                        return;
                }

            if (!$this->is_checkout_classic_mode()) {
                return;
            }

                $cache = $this->get_cached_delivery_data('');
                $wilaya_options = array('' => __('Select wilaya', 'dz-fraud-shield'));
                if (!empty($cache['wilayas']) && is_array($cache['wilayas'])) {
                        foreach ($cache['wilayas'] as $wilaya) {
                                $wilaya_id = isset($wilaya['wilaya_id']) ? (string) $wilaya['wilaya_id'] : '';
                                $wilaya_name = isset($wilaya['wilaya_name']) ? (string) $wilaya['wilaya_name'] : '';
                                if ($wilaya_id === '' || $wilaya_name === '') {
                                        continue;
                                }
                                $wilaya_options[$wilaya_id] = $wilaya_name;
                        }
                }

                echo '<div id="dzfs-delivery-checkout" style="margin-top:20px;padding:16px;border:1px solid #e5e7eb;border-radius:8px;background:#fff">';
                echo '<h3 style="margin-top:0">' . esc_html__('Delivery Options', 'dz-fraud-shield') . '</h3>';

                woocommerce_form_field('dzfs_delivery_type', array(
                        'type' => 'select',
                        'class' => array('form-row-wide'),
                        'required' => true,
                        'label' => __('Delivery Type', 'dz-fraud-shield'),
                        'options' => array(
                                'home' => __('Home Delivery', 'dz-fraud-shield'),
                                'stopdesk' => __('Stop Desk', 'dz-fraud-shield'),
                        ),
                        'default' => 'home',
                ), $checkout->get_value('dzfs_delivery_type'));

                woocommerce_form_field('dzfs_delivery_wilaya', array(
                        'type' => 'select',
                        'class' => array('form-row-first'),
                        'required' => true,
                        'label' => __('Wilaya', 'dz-fraud-shield'),
                        'options' => $wilaya_options,
                ), $checkout->get_value('dzfs_delivery_wilaya'));

                woocommerce_form_field('dzfs_delivery_commune', array(
                        'type' => 'select',
                        'class' => array('form-row-last dzfs-home-only'),
                        'required' => false,
                        'label' => __('Commune', 'dz-fraud-shield'),
                        'options' => array('' => __('Select commune', 'dz-fraud-shield')),
                ), $checkout->get_value('dzfs_delivery_commune'));

                woocommerce_form_field('dzfs_delivery_stopdesk', array(
                        'type' => 'select',
                        'class' => array('form-row-last dzfs-stopdesk-only'),
                        'required' => false,
                        'label' => __('Stop Desk Office', 'dz-fraud-shield'),
                        'options' => array('' => __('Select office', 'dz-fraud-shield')),
                ), $checkout->get_value('dzfs_delivery_stopdesk'));

                woocommerce_form_field('dzfs_customer_first_name', array(
                    'type' => 'text',
                    'class' => array('form-row-first'),
                    'required' => true,
                    'label' => __('First Name', 'dz-fraud-shield'),
                ), $checkout->get_value('dzfs_customer_first_name'));

                woocommerce_form_field('dzfs_customer_last_name', array(
                    'type' => 'text',
                    'class' => array('form-row-last'),
                    'required' => true,
                    'label' => __('Last Name', 'dz-fraud-shield'),
                ), $checkout->get_value('dzfs_customer_last_name'));

                woocommerce_form_field('dzfs_customer_phone', array(
                    'type' => 'tel',
                    'class' => array('form-row-wide'),
                    'required' => true,
                    'label' => __('Phone', 'dz-fraud-shield'),
                ), $checkout->get_value('dzfs_customer_phone'));

                woocommerce_form_field('dzfs_delivery_address', array(
                    'type' => 'text',
                    'class' => array('form-row-wide dzfs-home-only'),
                    'required' => false,
                    'label' => __('Address', 'dz-fraud-shield'),
                ), $checkout->get_value('dzfs_delivery_address'));

                // Hidden fields carry the calculated shipping price and the selected departure center
                // through form submit so save_delivery_checkout_fields() can persist them without a second API call.
                $selected_center_id = DZFS_Helpers::yalidine_departure_center_id();
                $selected_center_name = DZFS_Helpers::yalidine_departure_center_name();
                echo '<input type="hidden" id="dzfs_shipping_price" name="dzfs_shipping_price" value="0">';
                echo '<input type="hidden" id="dzfs_departure_center_id" name="dzfs_departure_center_id" value="' . esc_attr($selected_center_id) . '">';
                echo '<input type="hidden" id="dzfs_departure_center_name" name="dzfs_departure_center_name" value="' . esc_attr($selected_center_name) . '">';
                echo '<div id="dzfs-shipping-preview" style="margin:8px 0 0;color:#111827;font-weight:600"></div>';
                echo '</div>';
                echo '<!-- DZFS_CHECKOUT_MODE:CLASSIC -->';
        }

        public function validate_delivery_checkout_fields() {
                if (!DZFS_Helpers::is_enabled()) {
                        return;
                }

                $delivery_type = isset($_POST['dzfs_delivery_type']) ? sanitize_text_field(wp_unslash($_POST['dzfs_delivery_type'])) : '';
                $wilaya = isset($_POST['dzfs_delivery_wilaya']) ? sanitize_text_field(wp_unslash($_POST['dzfs_delivery_wilaya'])) : '';
                $commune = isset($_POST['dzfs_delivery_commune']) ? sanitize_text_field(wp_unslash($_POST['dzfs_delivery_commune'])) : '';
                $stopdesk = isset($_POST['dzfs_delivery_stopdesk']) ? sanitize_text_field(wp_unslash($_POST['dzfs_delivery_stopdesk'])) : '';
                $address = isset($_POST['dzfs_delivery_address']) ? sanitize_text_field(wp_unslash($_POST['dzfs_delivery_address'])) : '';
                if ($address === '') {
                    $address = $this->read_native_shipping_address_line();
                }
                $native_city = isset($_POST['shipping_city']) ? sanitize_text_field(wp_unslash($_POST['shipping_city'])) : '';
                $first_name = isset($_POST['dzfs_customer_first_name']) ? sanitize_text_field(wp_unslash($_POST['dzfs_customer_first_name'])) : '';
                $last_name = isset($_POST['dzfs_customer_last_name']) ? sanitize_text_field(wp_unslash($_POST['dzfs_customer_last_name'])) : '';
                $phone = isset($_POST['dzfs_customer_phone']) ? sanitize_text_field(wp_unslash($_POST['dzfs_customer_phone'])) : '';

                if ($first_name === '' || $last_name === '' || $phone === '') {
                    wc_add_notice(__('Please enter first name, last name, and phone.', 'dz-fraud-shield'), 'error');
                }

                if (empty($delivery_type) || empty($wilaya)) {
                        wc_add_notice(__('Please select delivery type and wilaya.', 'dz-fraud-shield'), 'error');
                        return;
                }

                if (function_exists('WC') && WC() && WC()->session) {
                    $price_ready = (string) WC()->session->get('dzfs_shipping_price_ready');
                    if ($price_ready !== '1') {
                        wc_add_notice(__('Delivery price is being refreshed. Please try again.', 'dz-fraud-shield'), 'error');
                    }
                }

                if ($delivery_type === 'home') {
                        if (empty($commune) && empty($native_city)) {
                                wc_add_notice(__('Please select a commune for home delivery.', 'dz-fraud-shield'), 'error');
                        }
                        if (empty($address)) {
                                wc_add_notice(__('Please provide the shipping street address in WooCommerce address fields.', 'dz-fraud-shield'), 'error');
                        }
                }

                if ($delivery_type === 'stopdesk' && empty($stopdesk)) {
                    wc_add_notice(__('Please select a stopdesk office', 'dz-fraud-shield'), 'error');
                }

                if ($delivery_type === 'stopdesk') {
                    if (isset($_POST['shipping_address_1']) && trim((string) $_POST['shipping_address_1']) === '') {
                        $_POST['shipping_address_1'] = 'Stop Desk Pickup';
                    }
                    if (isset($_POST['billing_address_1']) && trim((string) $_POST['billing_address_1']) === '') {
                        $_POST['billing_address_1'] = 'Stop Desk Pickup';
                    }
                }
        }

        public function save_delivery_checkout_fields($order, $data) {
                // Guard: prevent duplicate meta writes if already processed in this request
                $order_id = $order->get_id();
                if ($order_id && isset($this->delivery_meta_hydrated[$order_id])) {
                    return;
                }
                if ($order_id) {
                    $this->delivery_meta_hydrated[$order_id] = true;
                }

                $delivery_type = isset($_POST['dzfs_delivery_type']) ? sanitize_text_field(wp_unslash($_POST['dzfs_delivery_type'])) : 'home';
                $wilaya_id = isset($_POST['dzfs_delivery_wilaya']) ? sanitize_text_field(wp_unslash($_POST['dzfs_delivery_wilaya'])) : '';
                $commune_id = isset($_POST['dzfs_delivery_commune']) ? sanitize_text_field(wp_unslash($_POST['dzfs_delivery_commune'])) : '';
                $office_id = isset($_POST['dzfs_delivery_stopdesk']) ? sanitize_text_field(wp_unslash($_POST['dzfs_delivery_stopdesk'])) : '';
                $address = $this->read_native_shipping_address_line();
                $customer_first_name = isset($_POST['dzfs_customer_first_name']) ? sanitize_text_field(wp_unslash($_POST['dzfs_customer_first_name'])) : '';
                if ($customer_first_name === '') {
                    $customer_first_name = isset($_POST['billing_first_name']) ? sanitize_text_field(wp_unslash($_POST['billing_first_name'])) : '';
                }
                $customer_last_name = isset($_POST['dzfs_customer_last_name']) ? sanitize_text_field(wp_unslash($_POST['dzfs_customer_last_name'])) : '';
                if ($customer_last_name === '') {
                    $customer_last_name = isset($_POST['billing_last_name']) ? sanitize_text_field(wp_unslash($_POST['billing_last_name'])) : '';
                }
                $customer_phone = isset($_POST['dzfs_customer_phone']) ? sanitize_text_field(wp_unslash($_POST['dzfs_customer_phone'])) : '';
                if ($customer_phone === '') {
                    $customer_phone = isset($_POST['billing_phone']) ? sanitize_text_field(wp_unslash($_POST['billing_phone'])) : '';
                }
                $departure_center_id = isset($_POST['dzfs_departure_center_id']) ? sanitize_text_field(wp_unslash($_POST['dzfs_departure_center_id'])) : '';
                if ($departure_center_id === '' && function_exists('WC') && WC() && WC()->session) {
                    $departure_center_id = sanitize_text_field((string) WC()->session->get('dzfs_shipping_departure_center_id'));
                }
                if ($departure_center_id === '') {
                    $departure_center_id = $this->resolve_selected_departure_center_id();
                }
                $departure_center_name = isset($_POST['dzfs_departure_center_name']) ? sanitize_text_field(wp_unslash($_POST['dzfs_departure_center_name'])) : '';
                if ($departure_center_name === '' && function_exists('WC') && WC() && WC()->session) {
                    $departure_center_name = sanitize_text_field((string) WC()->session->get('dzfs_shipping_departure_center_name'));
                }
                if ($departure_center_name === '') {
                    $departure_center_name = $this->resolve_selected_departure_center_name($departure_center_id);
                }
                $shipping_price = isset($_POST['dzfs_shipping_price']) ? (float) $_POST['dzfs_shipping_price'] : 0;

                if (function_exists('WC') && WC() && WC()->session) {
                    if ($delivery_type === 'home') {
                        $delivery_type = sanitize_text_field((string) WC()->session->get('dzfs_shipping_type')) ?: 'home';
                    }
                    $wilaya_id = $wilaya_id !== '' ? $wilaya_id : sanitize_text_field((string) WC()->session->get('dzfs_shipping_wilaya_id'));
                    $commune_id = $commune_id !== '' ? $commune_id : sanitize_text_field((string) WC()->session->get('dzfs_shipping_commune_id'));
                    $office_id = $office_id !== '' ? $office_id : sanitize_text_field((string) WC()->session->get('dzfs_shipping_office_id'));
                    if ($shipping_price <= 0) {
                        $shipping_price = max(0, (float) WC()->session->get('dzfs_shipping_price'));
                    }
                }

                if ($wilaya_id === '') {
                    $native_state = isset($_POST['shipping_state']) ? sanitize_text_field(wp_unslash($_POST['shipping_state'])) : '';
                    $all_cache = $this->get_cached_delivery_data('');
                    $wilaya_id = $this->infer_wilaya_id_from_native_state($all_cache, $native_state);
                }

                $all_cache = $this->get_cached_delivery_data('');
                $wilaya_id = $this->normalize_wilaya_id_prefer_non_seed($all_cache, $wilaya_id);
                if ($commune_id === '') {
                    $native_city = isset($_POST['shipping_city']) ? sanitize_text_field(wp_unslash($_POST['shipping_city'])) : '';
                    if ($native_city === '') {
                        $native_city = isset($_POST['billing_city']) ? sanitize_text_field(wp_unslash($_POST['billing_city'])) : '';
                    }
                    $commune_id = $this->infer_commune_id_from_city($all_cache, $wilaya_id, $native_city);
                }

                $cache = $this->get_cached_delivery_data($wilaya_id);
                $wilaya_name = '';
                $commune_name = '';
                $office_name = '';

                if (!empty($cache['wilayas']) && is_array($cache['wilayas'])) {
                        foreach ($cache['wilayas'] as $row) {
                                if ((string) ($row['wilaya_id'] ?? '') === $wilaya_id) {
                                        $wilaya_name = (string) ($row['wilaya_name'] ?? '');
                                        break;
                                }
                        }
                }

                if (!empty($cache['communes']) && is_array($cache['communes'])) {
                        foreach ($cache['communes'] as $row) {
                                if ((string) ($row['commune_id'] ?? '') === $commune_id) {
                                        $commune_name = (string) ($row['commune_name'] ?? '');
                                        break;
                                }
                        }
                }

                if (!empty($cache['offices']) && is_array($cache['offices'])) {
                        foreach ($cache['offices'] as $row) {
                                if ((string) ($row['office_id'] ?? '') === $office_id) {
                                        $office_name = (string) ($row['office_name'] ?? '');
                                        break;
                                }
                        }
                }

                $provider = isset($cache['provider']) ? sanitize_text_field((string) $cache['provider']) : 'yalidine';
                
                // Update order meta data exactly once
                // Note: WooCommerce meta is idempotent - update_meta_data replaces existing values
                $order->update_meta_data('dzfs_shipping_provider', $provider);
                $order->update_meta_data('dzfs_shipping_type', $delivery_type);
                $order->update_meta_data('dzfs_shipping_price', max(0, $shipping_price));
                $order->update_meta_data('dzfs_shipping_wilaya_id', $wilaya_id);
                $order->update_meta_data('dzfs_shipping_wilaya', $wilaya_name);
                $order->update_meta_data('dzfs_shipping_commune_id', $commune_id);
                $order->update_meta_data('dzfs_shipping_commune', $commune_name);
                $order->update_meta_data('dzfs_shipping_stopdesk', $office_name);
                $order->update_meta_data('dzfs_shipping_office_id', $office_id);
                if (!$this->order_has_created_shipment($order)) {
                    $order->update_meta_data('dzfs_shipping_departure_center_id', $departure_center_id);
                    $order->update_meta_data('dzfs_shipping_departure_center_name', $departure_center_name);
                }
                $order->update_meta_data('dzfs_shipping_address', $address);
                $order->update_meta_data('dzfs_customer_first_name', sanitize_text_field($customer_first_name));
                $order->update_meta_data('dzfs_customer_last_name', sanitize_text_field($customer_last_name));
                $order->update_meta_data('dzfs_customer_phone', sanitize_text_field($customer_phone));
                $order->update_meta_data('dzfs_customer_address_source', 'woocommerce_native');
                $this->sync_native_order_address_from_delivery_meta($order, $delivery_type, $wilaya_name, $commune_name, $office_name, $address);
        }

        public function apply_cached_delivery_fee($cart) {
                // Delivery cost is injected as a real shipping rate via filter_shipping_rates_when_cached_delivery_active.
                // This method intentionally does nothing to avoid double-counting fees.
                // The shipping rate filter handles everything.
                return;
        }

        public function filter_shipping_rates_when_cached_delivery_active($rates, $package) {
            // Primary: in-memory price set during this request's extensionCartUpdate callback.
            // This avoids any session-backend flush timing issue within the same PHP request.
            // Fallback: session value persisted from a previous request.
            if ($this->dzfs_live_price > 0) {
                $dzfs_price  = $this->dzfs_live_price;
                $price_ready = '1';
                $price_source = 'live';
            } else {
                if (!function_exists('WC') || !WC() || !WC()->session) {
                    error_log('DZFS [FILTER-SKIP] no WC session live_price=0');
                    return $rates;
                }
                $price_ready = (string) WC()->session->get('dzfs_shipping_price_ready');
                $dzfs_price  = max(0, (float) WC()->session->get('dzfs_shipping_price'));
                $price_source = 'session';
            }

            $rate_ids_before = array();
            foreach ($rates as $rid => $rate) {
                $rate_ids_before[$rid] = ($rate instanceof WC_Shipping_Rate) ? (float) $rate->get_cost() : 'n/a';
            }
            error_log('DZFS [FILTER-IN] source=' . $price_source . ' price_ready=' . $price_ready . ' dzfs_price=' . $dzfs_price . ' rates_before=' . json_encode($rate_ids_before));

            if ($price_ready !== '1' || $dzfs_price <= 0 || empty($rates)) {
                error_log('DZFS [FILTER-SKIP] not_ready_or_zero price_ready=' . $price_ready . ' dzfs_price=' . $dzfs_price . ' empty=' . (empty($rates) ? '1' : '0'));
                return $rates;
            }

            foreach ($rates as $rate) {
                if ($rate instanceof WC_Shipping_Rate) {
                    $rate->set_cost($dzfs_price);
                    $rate->set_taxes(array());
                }
            }

            $rate_ids_after = array();
            foreach ($rates as $rid => $rate) {
                $rate_ids_after[$rid] = ($rate instanceof WC_Shipping_Rate) ? (float) $rate->get_cost() : 'n/a';
            }

            // Align chosen_shipping_methods with the rate that's actually present so
            // WC uses its (now-updated) cost when computing the cart shipping total.
            reset($rates);
            $chosen_key = key($rates);
            if (function_exists('WC') && WC() && WC()->session) {
                WC()->session->set('chosen_shipping_methods', array($chosen_key));
            }
            error_log('DZFS [FILTER-DONE] chosen=' . $chosen_key . ' rates_after=' . json_encode($rate_ids_after));

            return $rates;
        }

        public function enqueue_delivery_checkout_script() {
                if (!is_checkout()) {
                        return;
                }

                $cache = $this->get_cached_delivery_data('');

            if ($this->is_checkout_block_mode()) {
                wp_enqueue_style(
                    'dzfs-checkout-theme-adapter',
                    DZFS_PLUGIN_URL . 'assets/checkout-theme-adapter.css',
                    array(),
                    defined('DZFS_VERSION') ? DZFS_VERSION : '1.0.0'
                );

                wp_deregister_script('dzfs-delivery-checkout-block');
                wp_register_script(
                    'dzfs-delivery-checkout-block',
                    DZFS_PLUGIN_URL . 'assets/checkout-block.js',
                    array('wp-element', 'wp-plugins', 'wp-data', 'wc-blocks-checkout', 'wc-blocks-data-store'),
                    defined('DZFS_VERSION') ? DZFS_VERSION : '1.0.0',
                    true
                );

                wp_enqueue_script('dzfs-delivery-checkout-block');
                wp_localize_script('dzfs-delivery-checkout-block', 'dzfsBlockCheckoutData', array(
                    'ajaxUrl' => admin_url('admin-ajax.php'),
                    'currencySymbol' => html_entity_decode(get_woocommerce_currency_symbol()),
                    'wilayas' => isset($cache['wilayas']) && is_array($cache['wilayas']) ? $cache['wilayas'] : array(),
                    'labels' => array(
                        'deliveryOptions' => __('Delivery Options', 'dz-fraud-shield'),
                        'deliveryType' => __('Delivery Type', 'dz-fraud-shield'),
                        'homeDelivery' => __('Home Delivery', 'dz-fraud-shield'),
                        'homeDescription' => __('Delivered to your customer address.', 'dz-fraud-shield'),
                        'stopDesk' => __('Stop Desk', 'dz-fraud-shield'),
                        'stopDeskDescription' => __('Pickup from the selected office.', 'dz-fraud-shield'),
                        'deliverySubtitle' => __('Choose a delivery method and location.', 'dz-fraud-shield'),
                        'wilaya' => __('Wilaya', 'dz-fraud-shield'),
                        'commune' => __('Commune', 'dz-fraud-shield'),
                        'stopDeskOffice' => __('Stop Desk Office', 'dz-fraud-shield'),
                        'selectWilaya' => __('Select wilaya', 'dz-fraud-shield'),
                        'selectCommune' => __('Select commune', 'dz-fraud-shield'),
                        'selectOffice' => __('Select office', 'dz-fraud-shield'),
                        'subtotal' => __('Subtotal', 'dz-fraud-shield'),
                        'shipping' => __('Shipping', 'dz-fraud-shield'),
                        'total' => __('Total', 'dz-fraud-shield'),
                    ),
                ));

                return;
            }

            if (!$this->is_checkout_classic_mode()) {
                return;
            }

                $data = array(
                        'provider' => isset($cache['provider']) ? (string) $cache['provider'] : 'yalidine',
                        'wilayas' => isset($cache['wilayas']) && is_array($cache['wilayas']) ? $cache['wilayas'] : array(),
                        'currencySymbol' => html_entity_decode(get_woocommerce_currency_symbol()),
                );

                wp_register_script('dzfs-delivery-checkout', '', array('jquery', 'wc-checkout'), defined('DZFS_VERSION') ? DZFS_VERSION : '1.0.0', true);
                wp_enqueue_script('dzfs-delivery-checkout');
                wp_localize_script('dzfs-delivery-checkout', 'dzfsDeliveryCache', $data);

                $inline = <<<'JS'
(function($){
    var dzfsActiveWilayaId = '';

    function setCheckoutLocked(locked, message) {
        var $placeOrder = $('#place_order');
        if ($placeOrder.length) {
            $placeOrder.prop('disabled', !!locked);
            $placeOrder.attr('aria-disabled', locked ? 'true' : 'false');
        }
        if (locked && message) {
            $('#dzfs-shipping-preview').text(message);
        }
    }

    function parseAmount(raw) {
        if (typeof raw !== 'string') {
            return 0;
        }

        var normalized = raw.replace(/[^0-9,.-]/g, '');
        if (!normalized) {
            return 0;
        }

        if (normalized.indexOf(',') > -1 && normalized.indexOf('.') > -1) {
            normalized = normalized.replace(/,/g, '');
        } else if (normalized.indexOf(',') > -1) {
            normalized = normalized.replace(',', '.');
        }

        var parsed = parseFloat(normalized);
        return isNaN(parsed) ? 0 : parsed;
    }

    function readProductTotal() {
        var subtotalText = $('.cart-subtotal .woocommerce-Price-amount').first().text() || $('.cart-subtotal .amount').first().text() || '';
        return parseAmount(subtotalText);
    }

    function renderTotals(shippingPrice) {
        var productTotal = readProductTotal();
        var shipping = Number(shippingPrice || 0);
        var grandTotal = productTotal + shipping;
        var currency = dzfsDeliveryCache.currencySymbol || '';

        var html = ''
            + '<div>'
            + '<div>Product Total: ' + productTotal.toFixed(2) + ' ' + currency + '</div>'
            + '<div>Shipping: ' + shipping.toFixed(2) + ' ' + currency + '</div>'
            + '<div>Grand Total: ' + grandTotal.toFixed(2) + ' ' + currency + '</div>'
            + '</div>';
        $('#dzfs-shipping-preview').html(html);
        // Keep the hidden field in sync so the PHP handler always has the price.
        $('#dzfs_shipping_price').val(shipping.toFixed(2));
    }

    function readSelections() {
        var nativeWilaya = $('#shipping_state').val() || $('#billing_state').val() || '';
        var nativeAddress = $('#shipping_address_1').val() || $('#billing_address_1').val() || '';
        var dzfsAddress = $('#dzfs_delivery_address').val() || '';
        return {
            deliveryType: $('#dzfs_delivery_type').val() || 'home',
            wilayaId: $('#dzfs_delivery_wilaya').val() || nativeWilaya,
            communeId: $('#dzfs_delivery_commune').val() || $('#shipping_city').val() || $('#billing_city').val() || '',
            officeId: $('#dzfs_delivery_stopdesk').val() || '',
            address: dzfsAddress || nativeAddress
        };
    }

    function syncIdentityFieldsToNative() {
        var firstName = ($('#dzfs_customer_first_name').val() || '').trim();
        var lastName = ($('#dzfs_customer_last_name').val() || '').trim();
        var phone = ($('#dzfs_customer_phone').val() || '').trim();
        var type = ($('#dzfs_delivery_type').val() || 'home');
        var address = ($('#dzfs_delivery_address').val() || '').trim();

        if (firstName) {
            $('#billing_first_name, #shipping_first_name').val(firstName).trigger('change');
        }
        if (lastName) {
            $('#billing_last_name, #shipping_last_name').val(lastName).trigger('change');
        }
        if (phone) {
            $('#billing_phone, #shipping_phone').val(phone).trigger('change');
        }

        if (type === 'home' && address) {
            $('#shipping_address_1, #billing_address_1').val(address).trigger('change');
        }
        if (type === 'stopdesk') {
            if (!$('#shipping_address_1').val()) {
                $('#shipping_address_1').val('Stop Desk Pickup').trigger('change');
            }
            if (!$('#billing_address_1').val()) {
                $('#billing_address_1').val('Stop Desk Pickup').trigger('change');
            }
        }
    }

    function setVisibility() {
        var type = ($('#dzfs_delivery_type').val() || 'home');
        $('.dzfs-home-only').toggle(type === 'home');
        $('.dzfs-stopdesk-only').toggle(type === 'stopdesk');
        syncIdentityFieldsToNative();
        if (type === 'stopdesk') {
            if (!$('#shipping_address_1').val()) {
                $('#shipping_address_1').val('Stop Desk Pickup');
            }
            if (!$('#billing_address_1').val()) {
                $('#billing_address_1').val('Stop Desk Pickup');
            }
        }
    }

    function repopulateSelect($el, items, valueKey, labelKey, placeholder) {
        var current = $el.val();
        $el.empty();
        $el.append($('<option/>').attr('value', '').text(placeholder));
        (items || []).forEach(function(item){
            var value = item[valueKey] || '';
            var label = item[labelKey] || '';
            if (!value || !label) return;
            $el.append($('<option/>').attr('value', value).text(label));
        });
        if (current) {
            $el.val(current);
        }
    }

    function fetchCacheByWilaya(wilayaId) {
        if (!wilayaId) {
            repopulateSelect($('#dzfs_delivery_commune'), [], 'commune_id', 'commune_name', 'Select commune');
            repopulateSelect($('#dzfs_delivery_stopdesk'), [], 'office_id', 'office_name', 'Select office');
            return Promise.resolve();
        }

        return $.post((window.ajaxurl || '/wp-admin/admin-ajax.php'), {
            action: 'dzfs_delivery_cache',
            wilayaId: wilayaId
        }).then(function(json){
            var payload = json && json.success ? (json.data || {}) : {};
            repopulateSelect($('#dzfs_delivery_commune'), payload.communes || [], 'commune_id', 'commune_name', 'Select commune');
            repopulateSelect($('#dzfs_delivery_stopdesk'), payload.offices || [], 'office_id', 'office_name', 'Select office');
        }).catch(function(){
            repopulateSelect($('#dzfs_delivery_commune'), [], 'commune_id', 'commune_name', 'Select commune');
            repopulateSelect($('#dzfs_delivery_stopdesk'), [], 'office_id', 'office_name', 'Select office');
        });
    }

    function resolveLocalPrice(deliveryType, wilayaId) {
        var rows = Array.isArray(dzfsDeliveryCache.wilayas) ? dzfsDeliveryCache.wilayas : [];
        var normalizedType = deliveryType === 'stopdesk' ? 'stopdesk' : 'home';
        var target = String(wilayaId || '');
        for (var i = 0; i < rows.length; i += 1) {
            var row = rows[i] || {};
            if (String(row.wilaya_id || '') !== target) {
                continue;
            }
            var raw = normalizedType === 'stopdesk' ? row.stopdesk_price : row.home_price;
            var price = Number(raw || 0);
            return isNaN(price) ? null : Math.max(0, price);
        }
        return null;
    }

    function dzfsSaveDelivery(selected, callback) {
        $.post((window.ajaxurl || '/wp-admin/admin-ajax.php'), {
            action: 'dzfs_save_delivery',
            deliveryType: selected.deliveryType || 'home',
            wilayaId: selected.wilayaId || '',
            communeId: selected.communeId || '',
            officeId: selected.officeId || ''
        }, function(response) {
            var price = response && response.success && response.data && response.data.resolvedPrice != null
                ? Number(response.data.resolvedPrice)
                : null;
            callback(isNaN(price) ? null : price);
        }).fail(function() {
            callback(null);
        });
    }

    function fetchPriceAndRefresh() {
        var selected = readSelections();
        if (!selected.wilayaId) {
            $('#dzfs-shipping-preview').text('');
            setCheckoutLocked(true, 'Please select delivery type and wilaya.');
            $('body').trigger('update_checkout');
            return;
        }

        if (selected.deliveryType === 'stopdesk' && !selected.officeId) {
            setCheckoutLocked(true, 'Please select a stopdesk office');
            $('#dzfs_shipping_price').val('');
            $('body').trigger('update_checkout');
            return;
        }

        dzfsSaveDelivery(selected, function(price) {
            if (price === null || !(price > 0)) {
                setCheckoutLocked(true, 'Delivery price is unavailable for the selected wilaya.');
                $('#dzfs_shipping_price').val('');
                $('body').trigger('update_checkout');
                return;
            }

            if (dzfsActiveWilayaId && $('#dzfs_delivery_wilaya').val() !== dzfsActiveWilayaId) {
                $('#dzfs_delivery_wilaya').val(dzfsActiveWilayaId);
            }

            renderTotals(price);
            var hidden = $('#dzfs_shipping_price');
            if (!hidden.length) {
                $('<input/>', { type: 'hidden', id: 'dzfs_shipping_price', name: 'dzfs_shipping_price' }).appendTo('form.checkout');
                hidden = $('#dzfs_shipping_price');
            }
            hidden.val(price.toFixed(2));
            setCheckoutLocked(false, '');
            $('body').trigger('update_checkout');
        });
    }

    $(document.body).on('updated_checkout', function() {
        if (dzfsActiveWilayaId && $('#dzfs_delivery_wilaya').val() !== dzfsActiveWilayaId) {
            $('#dzfs_delivery_wilaya').val(dzfsActiveWilayaId);
        }
    });

    $(document.body).on('change', '#dzfs_delivery_type', function(){
        setVisibility();
        fetchPriceAndRefresh();
    });

    $(document.body).on('change', '#dzfs_delivery_wilaya', function(){
        var wilayaId = $(this).val() || '';
        dzfsActiveWilayaId = wilayaId;
        fetchCacheByWilaya(wilayaId).then(fetchPriceAndRefresh);
    });

    $(document.body).on('change', '#dzfs_delivery_commune, #dzfs_delivery_stopdesk, #shipping_state, #shipping_city, #shipping_address_1', function(){
        fetchPriceAndRefresh();
    });

    $(document.body).on('input change', '#dzfs_customer_first_name, #dzfs_customer_last_name, #dzfs_customer_phone, #dzfs_delivery_address', function(){
        syncIdentityFieldsToNative();
    });

    function hideClassicAddressFields() {
        // Hide the WooCommerce "ship to a different address" toggle and shipping section.
        // DZFS fields handle location; native state/city duplicates are hidden.
        var toHide = [
            '.shipping_address',
            '#ship-to-different-address',
            '.form-row.shipping_state_field',
            '.form-row.billing_state_field',
            '.form-row.shipping_city_field',
            '.form-row.billing_city_field',
            '.form-row.shipping_postcode_field',
            '.form-row.shipping_address_1_field',
            '.form-row.shipping_address_2_field',
            '.form-row.shipping_first_name_field',
            '.form-row.shipping_last_name_field',
            '.form-row.shipping_company_field',
            '.form-row.shipping_country_field',
            '.form-row.shipping_phone_field'
        ];
        toHide.forEach(function(selector) {
            $(selector).hide();
        });
    }

    $(function(){
        setVisibility();
        hideClassicAddressFields();
        syncIdentityFieldsToNative();
        fetchPriceAndRefresh();
    });
})(jQuery);
JS;
                wp_add_inline_script('dzfs-delivery-checkout', $inline);
        }

    public function report_delivered($order_id) {
        $this->report_outcome($order_id, 'delivered');
    }

    public function report_cancelled($order_id) {
        $this->report_outcome($order_id, 'cancelled');
    }

    public function report_refused($order_id) {
        $this->report_outcome($order_id, 'refused');
    }

    private function report_outcome($order_id, $outcome) {
        $check_id = get_post_meta($order_id, 'dzfs_check_id', true);
        if (empty($check_id)) {
            return;
        }

        $result = $this->api->report_outcome(array(
            'orderCheckId' => $check_id,
            'outcome' => $outcome,
            'notes' => 'Reported by WooCommerce status hook',
        ));

        if (is_wp_error($result)) {
            $order = wc_get_order($order_id);
            if ($order) {
                $order->add_order_note('DZ Fraud Shield outcome report failed: ' . $result->get_error_message());
            }
        }
    }

    private function persist_check_order_intelligence_meta($order_id, $result) {
        update_post_meta($order_id, 'dzfs_normalized_phone', isset($result['normalizedPhone']) ? sanitize_text_field((string) $result['normalizedPhone']) : '');
        update_post_meta($order_id, 'dzfs_recommended_action', isset($result['recommendedAction']) ? sanitize_text_field((string) $result['recommendedAction']) : '');

        $level = isset($result['level']) ? strtoupper((string) $result['level']) : '';
        $score = isset($result['score']) ? (int) $result['score'] : 0;
        $legacy_decision = 'SHIP_WITH_CAUTION';
        if ($level === 'LOW') {
            $legacy_decision = 'SAFE_TO_SHIP';
        } elseif ($level === 'HIGH' || $level === 'CRITICAL' || $level === 'BLOCK') {
            $legacy_decision = 'HIGH_RISK';
        }

        $legacy_recommendation = 'VERIFY_BY_PHONE_BEFORE_SHIPPING';
        if (isset($result['recommendedAction']) && $result['recommendedAction'] === 'accept') {
            $legacy_recommendation = 'PROCEED_WITH_STANDARD_SHIPPING';
        } elseif (isset($result['recommendedAction']) && $result['recommendedAction'] === 'block') {
            $legacy_recommendation = 'DO_NOT_SHIP_HIGH_VALUE_PRODUCTS';
        }

        update_post_meta($order_id, 'dzfs_order_decision', $legacy_decision);
        update_post_meta($order_id, 'dzfs_order_trust_score', max(0, 100 - $score));
        update_post_meta($order_id, 'dzfs_order_customer_type', $level === 'LOW' ? 'Reliable Customer' : ($level === 'MEDIUM' ? 'Needs Verification' : 'High Risk'));
        update_post_meta($order_id, 'dzfs_order_success_rate', 0);
        update_post_meta($order_id, 'dzfs_order_merchant_count', isset($result['globalReputation']['merchantCount']) ? (int) $result['globalReputation']['merchantCount'] : 0);
        update_post_meta($order_id, 'dzfs_order_recommendation', $legacy_recommendation);
        update_post_meta($order_id, 'dzfs_order_risk_factors', isset($result['reasons']) ? wp_json_encode($result['reasons']) : '[]');
        update_post_meta($order_id, 'dzfs_order_extensions', wp_json_encode(array(
            'estimatedLoss' => null,
            'fraudProbability' => null,
            'networkReputationScore' => isset($result['globalReputation']['score']) ? (int) $result['globalReputation']['score'] : null,
            'aiRecommendation' => null,
        )));
        update_post_meta($order_id, 'dzfs_order_network_reputation_score', isset($result['globalReputation']['score']) ? (string) ((int) $result['globalReputation']['score']) : '');
        update_post_meta($order_id, 'dzfs_order_decision_checked_at', current_time('mysql'));

        $global = isset($result['globalReputation']) && is_array($result['globalReputation']) ? $result['globalReputation'] : null;
        if (!$global) {
            return;
        }

        update_post_meta($order_id, 'dzfs_global_reputation_score', isset($global['score']) ? (int) $global['score'] : 0);
        update_post_meta($order_id, 'dzfs_global_total_orders', isset($global['totalOrders']) ? (int) $global['totalOrders'] : 0);
        update_post_meta($order_id, 'dzfs_global_delivered_orders', isset($global['deliveredOrders']) ? (int) $global['deliveredOrders'] : 0);
        update_post_meta($order_id, 'dzfs_global_returned_orders', isset($global['returnedOrders']) ? (int) $global['returnedOrders'] : 0);
        update_post_meta($order_id, 'dzfs_global_refused_orders', isset($global['refusedOrders']) ? (int) $global['refusedOrders'] : 0);
        update_post_meta($order_id, 'dzfs_global_merchant_count', isset($global['merchantCount']) ? (int) $global['merchantCount'] : 0);
        update_post_meta($order_id, 'dzfs_global_recommendation', isset($global['recommendation']) ? sanitize_text_field((string) $global['recommendation']) : '');
        update_post_meta($order_id, 'dzfs_global_level', isset($global['level']) ? sanitize_text_field((string) $global['level']) : '');
        update_post_meta($order_id, 'dzfs_global_reasons', isset($global['reasons']) ? wp_json_encode($global['reasons']) : '[]');
    }

    /**
     * Collect and send enriched product line-item data to the SaaS marketing
     * intelligence endpoint. Fire-and-forget (blocking=false) so it never
     * delays the order scan. All errors are logged and silently discarded.
     */
    private function collect_product_intelligence($order_id, $order) {
        if (!DZFS_Helpers::is_enabled()) {
            return;
        }

        $api_url  = DZFS_Helpers::api_base_url();
        $api_key  = DZFS_Helpers::api_key();
        if (empty($api_url) || empty($api_key)) {
            return;
        }

        $line_items = array();

        foreach ($order->get_items() as $item_id => $item) {
            $product_id   = (int) $item->get_product_id();
            $variation_id = (int) $item->get_variation_id();

            $product = $item->get_product();
            if (!$product) {
                // Minimal fallback when product object is unavailable
                $line_items[] = array(
                    'lineItemId'   => (string) $item_id,
                    'productId'    => $product_id > 0 ? (string) $product_id : null,
                    'variationId'  => $variation_id > 0 ? (string) $variation_id : null,
                    'productName'  => sanitize_text_field((string) $item->get_name()),
                    'quantity'     => (int) $item->get_quantity(),
                    'lineTotal'    => (float) $item->get_total(),
                    'lineSubtotal' => (float) $item->get_subtotal(),
                    'tags'         => array(),
                    'galleryImageUrls' => array(),
                    'attributes'   => array(),
                );
                continue;
            }

            // Category
            $category_id   = null;
            $category_name = null;
            $pid_for_terms = $variation_id > 0 ? $product_id : (int) $product->get_id();
            $categories    = get_the_terms($pid_for_terms, 'product_cat');
            if (is_array($categories) && !empty($categories)) {
                $cat = reset($categories);
                $category_id   = (string) $cat->term_id;
                $category_name = sanitize_text_field($cat->name);
            }

            // Brand
            $brand = null;
            foreach (array('product_brand', 'yith_product_brand', 'pa_brand') as $brand_tax) {
                $brand_terms = get_the_terms($pid_for_terms, $brand_tax);
                if (is_array($brand_terms) && !empty($brand_terms)) {
                    $brand = sanitize_text_field(reset($brand_terms)->name);
                    break;
                }
            }

            // Tags
            $tags      = array();
            $tag_terms = get_the_terms($pid_for_terms, 'product_tag');
            if (is_array($tag_terms)) {
                foreach ($tag_terms as $t) {
                    $tags[] = sanitize_text_field($t->name);
                }
            }

            // Primary image
            $primary_image_url   = null;
            $gallery_image_urls  = array();
            $main_image_id       = (int) $product->get_image_id();
            if ($main_image_id > 0) {
                $src = wp_get_attachment_image_url($main_image_id, 'medium');
                if ($src) {
                    $primary_image_url = esc_url_raw($src);
                }
            }
            $gallery_ids = $product->get_gallery_image_ids();
            if (is_array($gallery_ids)) {
                foreach (array_slice($gallery_ids, 0, 5) as $gid) {
                    $gsrc = wp_get_attachment_image_url((int) $gid, 'medium');
                    if ($gsrc) {
                        $gallery_image_urls[] = esc_url_raw($gsrc);
                    }
                }
            }

            // Prices
            $regular_price = (float) $product->get_regular_price();
            $sale_price    = (float) $product->get_sale_price();

            // Variation attributes
            $attributes     = array();
            $variation_name = null;
            $color          = null;
            $size           = null;
            $material       = null;
            if ($variation_id > 0 && method_exists($item, 'get_meta_data')) {
                $raw_attrs = $item->get_variation_meta();
                if (!is_array($raw_attrs)) {
                    $raw_attrs = array();
                }
                foreach ($raw_attrs as $k => $v) {
                    $key = sanitize_text_field(str_replace('attribute_', '', strtolower($k)));
                    $val = sanitize_text_field((string) $v);
                    $attributes[$key] = $val;
                    if (in_array($key, array('color', 'couleur', 'pa_color'), true)) {
                        $color = $val;
                    }
                    if (in_array($key, array('size', 'taille', 'pa_size'), true)) {
                        $size = $val;
                    }
                    if (in_array($key, array('material', 'matiere', 'pa_material'), true)) {
                        $material = $val;
                    }
                }
                $variation_name = implode(' / ', array_filter(array_values($attributes)));
                if ($variation_name === '') {
                    $variation_name = null;
                }
            }

            $parent_id = ($variation_id > 0 && $product_id > 0) ? (string) $product_id : null;
            $ext_pid   = $variation_id > 0 ? ($variation_id > 0 ? (string) $variation_id : null) : ($product_id > 0 ? (string) $product_id : null);

            $line_items[] = array(
                'lineItemId'        => (string) $item_id,
                'productId'         => $product_id   > 0 ? (string) $product_id   : null,
                'variationId'       => $variation_id > 0 ? (string) $variation_id : null,
                'sku'               => sanitize_text_field((string) $product->get_sku()) ?: null,
                'productName'       => sanitize_text_field((string) $item->get_name()),
                'productSlug'       => sanitize_title((string) $product->get_slug()) ?: null,
                'parentProductId'   => $parent_id,
                'productType'       => sanitize_text_field((string) $product->get_type()) ?: null,
                'categoryId'        => $category_id,
                'categoryName'      => $category_name,
                'brand'             => $brand,
                'tags'              => $tags,
                'primaryImageUrl'   => $primary_image_url,
                'galleryImageUrls'  => $gallery_image_urls,
                'variationName'     => $variation_name,
                'attributes'        => $attributes,
                'color'             => $color,
                'size'              => $size,
                'material'          => $material,
                'regularPrice'      => $regular_price > 0 ? $regular_price : null,
                'salePrice'         => $sale_price > 0 ? $sale_price : null,
                'quantity'          => (int) $item->get_quantity(),
                'lineSubtotal'      => (float) $item->get_subtotal(),
                'lineTotal'         => (float) $item->get_total(),
                'discountAmount'    => null,
                'currency'          => get_woocommerce_currency() ?: null,
            );
        }

        if (empty($line_items)) {
            return;
        }

        $shipping_wilaya  = sanitize_text_field((string) $order->get_meta('dzfs_shipping_wilaya'));
        $shipping_commune = sanitize_text_field((string) $order->get_meta('dzfs_shipping_commune'));
        $shipping_type    = sanitize_text_field((string) $order->get_meta('dzfs_shipping_type'));
        $provider         = sanitize_text_field((string) $order->get_meta('dzfs_shipping_provider'));

        $payload = array(
            'orderId'          => (string) $order_id,
            'orderDate'        => $order->get_date_created() ? $order->get_date_created()->format('c') : null,
            'wilaya'           => $shipping_wilaya  !== '' ? $shipping_wilaya  : null,
            'commune'          => $shipping_commune !== '' ? $shipping_commune : null,
            'deliveryType'     => in_array($shipping_type, array('home', 'stopdesk'), true) ? $shipping_type : null,
            'shippingProvider' => $provider !== '' ? $provider : null,
            'tracking'         => null,
            'lineItems'        => $line_items,
        );

        $endpoint = trailingslashit($api_url) . 'api/v1/plugin/product-intel';

        wp_remote_post($endpoint, array(
            'method'    => 'POST',
            'timeout'   => 5,
            'blocking'  => false,
            'headers'   => array(
                'Content-Type'  => 'application/json',
                'Authorization' => 'Bearer ' . $api_key,
            ),
            'body' => wp_json_encode($payload),
        ));

        error_log('[DZFS] product-intel fired (non-blocking) order_id=' . $order_id . ' items=' . count($line_items));
    }
}
