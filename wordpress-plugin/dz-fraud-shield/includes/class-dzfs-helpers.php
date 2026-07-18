<?php

if (!defined('ABSPATH')) {
    exit;
}

class DZFS_Helpers {
    public static function provider_default_base_url($provider = null) {
        $selected_provider = $provider !== null ? trim((string) $provider) : self::delivery_provider();

        $map = array(
            'yalidine' => 'https://api.yalidine.com/v1',
            'zr_express' => 'https://api.zrexpress.app',
        );

        return isset($map[$selected_provider]) ? untrailingslashit($map[$selected_provider]) : '';
    }

    public static function get_option($key, $default = '') {
        $options = get_option('dzfs_settings', array());
        return isset($options[$key]) ? $options[$key] : $default;
    }

    public static function is_enabled() {
        return self::get_option('enabled', 'yes') === 'yes';
    }

    public static function auto_block_enabled() {
        return self::get_option('auto_block', 'no') === 'yes';
    }

    public static function api_base_url() {
        return untrailingslashit(self::get_option('api_base_url', ''));
    }

    public static function api_key() {
        return trim(self::get_option('api_key', ''));
    }

    public static function store_name() {
        return trim((string) get_option('dzfs_store_name', ''));
    }

    public static function store_phone() {
        return trim((string) get_option('dzfs_store_phone', ''));
    }

    public static function store_category() {
        return trim((string) get_option('dzfs_store_category', ''));
    }

    public static function delivery_provider() {
        return trim((string) get_option('dzfs_delivery_provider', ''));
    }

    public static function provider_base_url() {
        $provider = self::delivery_provider();
        $default_base_url = self::provider_default_base_url($provider);

        if ($default_base_url !== '') {
            return $default_base_url;
        }

        return untrailingslashit(trim((string) get_option('dzfs_provider_base_url', '')));
    }

    public static function provider_credentials() {
        $credentials = get_option('dzfs_provider_credentials', array());
        return is_array($credentials) ? $credentials : array();
    }

    private static function shared_option($key, $default = '') {
        $stored = get_option($key, '__DZFS_OPTION_MISSING__');
        if ($stored !== '__DZFS_OPTION_MISSING__') {
            return $stored;
        }

        return self::get_option($key, $default);
    }

    private static function local_delivery_repository() {
        if (!class_exists('DZFS_Local_Delivery_Repository')) {
            return null;
        }

        return new DZFS_Local_Delivery_Repository();
    }

    public static function yalidine_departure_centers() {
        $repository = self::local_delivery_repository();
        if ($repository) {
            $centers = $repository->get_departure_centers();
            return is_array($centers) ? array_values($centers) : array();
        }

        return array();
    }

    public static function yalidine_departure_center_requires_attention() {
        return get_option('dzfs_yalidine_center_requires_attention', 'no') === 'yes';
    }

    public static function yalidine_departure_center_attention_message() {
        return trim((string) get_option('dzfs_yalidine_center_attention_message', ''));
    }

    public static function yalidine_departure_center_id() {
        if (self::yalidine_departure_center_requires_attention()) {
            return '';
        }

        return trim((string) self::get_option('yalidine_departure_center', ''));
    }

    public static function yalidine_departure_center_name() {
        if (self::yalidine_departure_center_requires_attention()) {
            return '';
        }

        return trim((string) self::get_option('yalidine_departure_center_name', ''));
    }

    public static function yalidine_departure_center_prices() {
        $repository = self::local_delivery_repository();
        if ($repository) {
            $centers = $repository->get_departure_centers();
            if (is_array($centers)) {
                $price_map = array();
                foreach ($centers as $center) {
                    $center_id = isset($center['id']) ? (string) $center['id'] : '';
                    if ($center_id === '') {
                        continue;
                    }

                    $price_map[$center_id] = array(
                        'id' => $center_id,
                        'name' => isset($center['name']) ? sanitize_text_field((string) $center['name']) : '',
                        'wilaya_id' => isset($center['wilaya_id']) ? (string) $center['wilaya_id'] : '',
                        'wilaya_name' => '',
                        'home_price' => isset($center['home_price']) && is_numeric($center['home_price']) ? max(0, (float) $center['home_price']) : null,
                        'stopdesk_price' => isset($center['stopdesk_price']) && is_numeric($center['stopdesk_price']) ? max(0, (float) $center['stopdesk_price']) : null,
                        'prices' => array(
                            'home' => isset($center['home_price']) && is_numeric($center['home_price']) ? max(0, (float) $center['home_price']) : null,
                            'stopdesk' => isset($center['stopdesk_price']) && is_numeric($center['stopdesk_price']) ? max(0, (float) $center['stopdesk_price']) : null,
                        ),
                    );
                }

                return $price_map;
            }
        }

        return array();
    }

    public static function yalidine_departure_center_dataset($center_id = '') {
        $center_id = sanitize_text_field((string) $center_id);
        if ($center_id === '') {
            return array();
        }

        $prices = self::yalidine_departure_center_prices();
        if (!is_array($prices) || !isset($prices[$center_id]) || !is_array($prices[$center_id])) {
            return array();
        }

        return $prices[$center_id];
    }

    public static function yalidine_departure_center_price($center_id = '', $delivery_type = 'home', $wilaya_id = '', $commune_id = '', $office_id = '') {
        $center_id = sanitize_text_field((string) $center_id);
        $wilaya_id_int = (int) $wilaya_id;
        if ($center_id === '' || $wilaya_id_int <= 0) {
            return null;
        }

        $delivery_type = $delivery_type === 'stopdesk' ? 'stopdesk' : 'home';

        $repository = self::local_delivery_repository();
        if (!$repository || !method_exists($repository, 'get_fee_price')) {
            return null;
        }

        $center = $repository->get_departure_center_by_id($center_id);
        if (!is_array($center)) {
            return null;
        }

        $origin_wilaya_id = (int) ($center['wilaya_id'] ?? 0);
        if ($origin_wilaya_id <= 0) {
            return null;
        }

        return $repository->get_fee_price($origin_wilaya_id, $wilaya_id_int, (int) $commune_id, $delivery_type);
    }

    public static function provider_connection_status() {
        return trim((string) get_option('dzfs_provider_connection_status', 'pending'));
    }

    public static function provider_connected() {
        return get_option('dzfs_provider_connected', 'no') === 'yes';
    }

    public static function onboarding_completed() {
        return get_option('dzfs_onboarding_completed', 'no') === 'yes';
    }

    public static function onboarding_forced() {
        return get_option('dzfs_force_onboarding', 'no') === 'yes';
    }

    public static function dashboard_url() {
        $base_url = self::api_base_url();
        return empty($base_url) ? '' : untrailingslashit($base_url) . '/dashboard';
    }

    public static function bootstrap_base_url() {
        $base_url = trim((string) get_option('dzfs_saas_base_url', ''));
        if ($base_url !== '') {
            return untrailingslashit($base_url);
        }

        return untrailingslashit(apply_filters('dzfs_saas_base_url', 'http://localhost:3000'));
    }

    public static function accept_decision_status() {
        return self::get_option('accept_decision_status', 'processing');
    }

    public static function verify_decision_status() {
        return self::get_option('verify_decision_status', 'on-hold');
    }

    public static function block_decision_status() {
        $configured = self::get_option('block_decision_status', 'cancelled');
        if ($configured === 'fraud_blocked' && !self::fraud_blocked_status_enabled()) {
            return 'cancelled';
        }
        return $configured;
    }

    public static function fraud_blocked_status_enabled() {
        return self::get_option('enable_fraud_blocked_status', 'yes') === 'yes';
    }

    public static function normalize_phone($phone) {
        $clean = preg_replace('/[^0-9+]/', '', (string) $phone);

        if (strpos($clean, '+213') === 0) {
            $national = substr($clean, 4);
        } elseif (strpos($clean, '00213') === 0) {
            $national = substr($clean, 5);
        } elseif (strpos($clean, '213') === 0) {
            $national = substr($clean, 3);
        } elseif (strpos($clean, '0') === 0) {
            $national = substr($clean, 1);
        } else {
            $national = $clean;
        }

        if (!preg_match('/^[567][0-9]{8}$/', $national)) {
            return '';
        }

        return '+213' . $national;
    }

    public static function hash_value($value) {
        return hash('sha256', wp_salt('auth') . ':' . strtolower(trim((string) $value)));
    }

    public static function get_wilaya_from_address($address_state) {
        return sanitize_text_field($address_state);
    }
}
