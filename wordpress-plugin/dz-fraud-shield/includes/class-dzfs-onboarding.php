<?php

if (!defined('ABSPATH')) {
    exit;
}

class DZFS_Onboarding {
    const PAGE_SLUG = 'dz-fraud-shield';
    const SETTINGS_SLUG = 'dz-fraud-shield-settings';

    private $settings;

    public function __construct($settings = null) {
        $this->settings = $settings;
        add_action('admin_menu', array($this, 'register_menu'));
        add_action('admin_init', array($this, 'enforce_onboarding_redirect'));
        add_action('admin_init', array($this, 'migrate_provider_base_url_option'));
        add_action('admin_post_dzfs_save_store_info', array($this, 'handle_save_store_info'));
        add_action('admin_post_dzfs_save_provider_type', array($this, 'handle_save_provider_type'));
        add_action('admin_post_dzfs_save_provider_credentials', array($this, 'handle_save_provider_credentials'));
        add_action('admin_post_dzfs_connect_account', array($this, 'handle_connect_account'));
        add_action('admin_post_dzfs_save_departure_center', array($this, 'handle_save_departure_center'));
        add_action('admin_post_dzfs_reset_onboarding', array($this, 'handle_reset_onboarding'));
    }

    public function register_menu() {
        add_menu_page(
            'DZ Fraud Shield',
            'DZ Fraud Shield',
            'manage_woocommerce',
            self::PAGE_SLUG,
            array($this, 'render_page'),
            'dashicons-shield-alt',
            56
        );

        add_submenu_page(
            self::PAGE_SLUG,
            'Dashboard',
            'Dashboard',
            'manage_woocommerce',
            self::PAGE_SLUG,
            array($this, 'render_page')
        );

        add_submenu_page(
            self::PAGE_SLUG,
            'Settings',
            'Settings',
            'manage_woocommerce',
            self::SETTINGS_SLUG,
            array($this, 'render_settings_page')
        );
    }

    public function render_settings_page() {
        if ($this->settings && method_exists($this->settings, 'render_page')) {
            $this->settings->render_page();
        }
    }

    private function get_settings() {
        $settings = get_option('dzfs_settings', array());
        return is_array($settings) ? $settings : array();
    }

    private function store_option($key, $value) {
        update_option($key, $value);
    }

    private function redirect_with_notice($notice, $message, $step = null) {
        $args = array(
            'page' => self::PAGE_SLUG,
            'dzfs_notice' => $notice,
            'dzfs_message' => rawurlencode($message),
        );

        if ($step !== null) {
            $args['step'] = (int) $step;
        }

        wp_safe_redirect(add_query_arg($args, admin_url('admin.php')));
        exit;
    }

    private function current_step() {
        return isset($_GET['step']) ? max(1, (int) $_GET['step']) : 1;
    }

    private function has_required_onboarding_fields() {
        $required = DZFS_Helpers::store_name() !== ''
            && DZFS_Helpers::store_phone() !== ''
            && DZFS_Helpers::store_category() !== ''
            && DZFS_Helpers::delivery_provider() !== '';

        if (!$required) {
            return false;
        }

        if (DZFS_Helpers::delivery_provider() === 'yalidine') {
            if (DZFS_Helpers::yalidine_departure_center_requires_attention()) {
                return false;
            }

            return DZFS_Helpers::yalidine_departure_center_id() !== '';
        }

        return true;
    }

    private function onboarding_complete() {
        return DZFS_Helpers::onboarding_completed() && $this->has_required_onboarding_fields();
    }

    private function should_show_wizard() {
        return DZFS_Helpers::onboarding_forced() || !$this->onboarding_complete();
    }

    public function enforce_onboarding_redirect() {
        if (!is_admin() || !current_user_can('manage_woocommerce')) {
            return;
        }

        $page = isset($_GET['page']) ? sanitize_text_field(wp_unslash($_GET['page'])) : '';
        if (!in_array($page, array(self::PAGE_SLUG, self::SETTINGS_SLUG), true)) {
            return;
        }

        if ($this->onboarding_complete()) {
            return;
        }

        $step = isset($_GET['step']) ? max(1, (int) $_GET['step']) : 0;
        if ($page === self::PAGE_SLUG && $step > 0) {
            return;
        }

        wp_safe_redirect(add_query_arg(array(
            'page' => self::PAGE_SLUG,
            'step' => 1,
        ), admin_url('admin.php')));
        exit;
    }

    private function provider_label($provider) {
        if ($provider === 'zr_express') {
            return 'ZR Express';
        }

        if ($provider === 'yalidine') {
            return 'Yalidine';
        }

        return 'Delivery Provider';
    }

    private function provider_credentials_for_request($provider, $input) {
        $credentials = array();

        if ($provider === 'zr_express' || $provider === 'yalidine') {
            $credentials['tenantId'] = sanitize_text_field($input['tenantId'] ?? '');
            $credentials['apiKey'] = sanitize_text_field($input['apiKey'] ?? '');
        }

        return $credentials;
    }

    private function connect_response_value($decoded, $key) {
        if (!is_array($decoded)) {
            return '';
        }

        if (isset($decoded[$key]) && is_scalar($decoded[$key])) {
            return (string) $decoded[$key];
        }

        if (isset($decoded['data']) && is_array($decoded['data']) && isset($decoded['data'][$key]) && is_scalar($decoded['data'][$key])) {
            return (string) $decoded['data'][$key];
        }

        return '';
    }

    private function persist_plugin_api_configuration($decoded) {
        $api_base_url = trim((string) $this->connect_response_value($decoded, 'api_base_url'));
        if ($api_base_url === '') {
            $api_base_url = trim((string) $this->connect_response_value($decoded, 'apiBaseUrl'));
        }

        $api_key = trim((string) $this->connect_response_value($decoded, 'api_key'));
        if ($api_key === '') {
            $api_key = trim((string) $this->connect_response_value($decoded, 'apiKey'));
        }

        $api_base_url = untrailingslashit(esc_url_raw($api_base_url));
        $api_key = sanitize_text_field($api_key);

        if ($api_base_url === '' || $api_key === '') {
            return new WP_Error('dzfs_missing_api_credentials', 'The SaaS did not return plugin API credentials.');
        }

        $settings = $this->get_settings();
        $settings['api_base_url'] = $api_base_url;
        $settings['api_key'] = $api_key;
        $settings['enabled'] = 'yes';
        $settings['auto_block'] = 'no';
        update_option('dzfs_settings', $settings, false);

        $persisted = $this->get_settings();
        $persisted_base_url = isset($persisted['api_base_url']) ? untrailingslashit(trim((string) $persisted['api_base_url'])) : '';
        $persisted_api_key = isset($persisted['api_key']) ? trim((string) $persisted['api_key']) : '';

        if ($persisted_base_url === '' || $persisted_api_key === '') {
            return new WP_Error('dzfs_persist_api_credentials_failed', 'Failed to persist plugin API credentials to dzfs_settings.');
        }

        return array(
            'api_base_url' => $persisted_base_url,
            'api_key' => $persisted_api_key,
        );
    }

    private function sync_yalidine_center_catalog() {
        $cached_centers = DZFS_Helpers::yalidine_departure_centers();
        if (is_array($cached_centers) && !empty($cached_centers)) {
            $this->store_option('dzfs_yalidine_center_sync_error', '');
            return true;
        }

        $service = new DZFS_Yalidine_Sync_Service();
        $result = $service->run_sync('onboarding_connect', false);

        $sync_status = is_array($result) && !empty($result['status']) ? $result['status'] : '';
        if ($sync_status !== 'success' && $sync_status !== 'fees_sync_failed') {
            $message = is_array($result) && !empty($result['error']) ? sanitize_text_field((string) $result['error']) : 'Departure centers could not be loaded.';
            $this->store_option('dzfs_yalidine_center_sync_error', $message);
            return false;
        }

        $this->store_option('dzfs_yalidine_center_sync_error', '');
        return true;
    }

    private function persist_departure_center_selection($center_id, $center_name = '') {
        $center_id = sanitize_text_field((string) $center_id);
        $center_name = sanitize_text_field((string) $center_name);
        $centers = DZFS_Helpers::yalidine_departure_centers();
        $selected_center = array();

        if (is_array($centers)) {
            foreach ($centers as $center) {
                $candidate_id = isset($center['id']) ? (string) $center['id'] : (isset($center['center_id']) ? (string) $center['center_id'] : '');
                if ($candidate_id === $center_id) {
                    $selected_center = $center;
                    break;
                }
            }
        }

        if ($center_name === '' && isset($selected_center['name'])) {
            $center_name = sanitize_text_field((string) $selected_center['name']);
        }

        $settings = $this->get_settings();
        $settings['yalidine_departure_center'] = $center_id;
        $settings['yalidine_departure_center_name'] = $center_name;
        $settings['yalidine_departure_centers'] = is_array($centers) ? $centers : array();
        $settings['yalidine_departure_center_prices'] = DZFS_Helpers::yalidine_departure_center_prices();
        update_option('dzfs_settings', $settings);

        $this->store_option('dzfs_provider_connection_status', 'connected');
        $this->store_option('dzfs_provider_connected', 'yes');
        $this->store_option('dzfs_onboarding_completed', 'yes');
        $this->store_option('dzfs_force_onboarding', 'no');
        $this->store_option('dzfs_departure_center_selected_at', current_time('mysql'));
        $this->store_option('dzfs_yalidine_center_requires_attention', 'no');
        $this->store_option('dzfs_yalidine_center_attention_message', '');
        $this->store_option('dzfs_yalidine_center_sync_error', '');
        $this->store_option('dzfs_yalidine_center_requires_attention', 'no');
        $this->store_option('dzfs_yalidine_center_attention_message', '');

        return $selected_center;
    }

    public function migrate_provider_base_url_option() {
        $provider = DZFS_Helpers::delivery_provider();
        if (!in_array($provider, array('zr_express', 'yalidine'), true)) {
            return;
        }

        $default_base_url = DZFS_Helpers::provider_default_base_url($provider);
        if ($default_base_url === '') {
            return;
        }

        $current_base_url = untrailingslashit(trim((string) get_option('dzfs_provider_base_url', '')));
        if ($current_base_url !== $default_base_url) {
            update_option('dzfs_provider_base_url', $default_base_url);
        }
    }

    private function store_categories() {
        return array(
            'Fashion & Clothing',
            'Shoes',
            'Beauty & Cosmetics',
            'Perfume',
            'Jewelry & Watches',
            'Electronics',
            'Phones & Accessories',
            'Computers & Gaming',
            'Home & Kitchen',
            'Furniture',
            'Food & Grocery',
            'Restaurant',
            'Pet Supplies',
            'Baby & Kids',
            'Sports & Fitness',
            'Automotive',
            'Tools & Hardware',
            'Books & Stationery',
            'Health & Medical',
            'Agriculture',
            'Industrial Supplies',
            'Digital Products',
            'Multi Category Store',
            'Other',
        );
    }

    private function reset_onboarding_configuration() {
        $settings = $this->get_settings();
        $settings['api_base_url'] = '';
        $settings['api_key'] = '';
        $settings['yalidine_departure_center'] = '';
        $settings['yalidine_departure_center_name'] = '';
        $settings['yalidine_departure_centers'] = array();
        $settings['yalidine_departure_center_prices'] = array();
        update_option('dzfs_settings', $settings);

        $persisted_settings_raw = get_option('dzfs_settings', null);
        $persisted_settings = is_array($persisted_settings_raw) ? $persisted_settings_raw : array();

        $persisted_api_base_url = isset($persisted_settings['api_base_url'])
            ? trim((string) $persisted_settings['api_base_url'])
            : '';
        $persisted_api_key = isset($persisted_settings['api_key'])
            ? trim((string) $persisted_settings['api_key'])
            : '';

        // Valid reset states:
        // - dzfs_settings missing
        // - dzfs_settings present but non-array
        // - dzfs_settings present with empty api_base_url/api_key
        // Fail only when a non-empty value remains after reset.
        if ($persisted_api_base_url !== '') {
            return new WP_Error('dzfs_reset_failed', 'Failed clearing dzfs_settings.api_base_url');
        }

        if ($persisted_api_key !== '') {
            return new WP_Error('dzfs_reset_failed', 'Failed clearing dzfs_settings.api_key');
        }

        $option_keys = array(
            'dzfs_onboarding_completed',
            'dzfs_onboarding_step',
            'dzfs_onboarding_progress',
            'dzfs_onboarding_status',
            'dzfs_store_name',
            'dzfs_store_phone',
            'dzfs_store_category',
            'dzfs_store_category_custom',
            'dzfs_delivery_provider',
            'dzfs_provider_base_url',
            'dzfs_provider_credentials',
            'dzfs_provider_connection_status',
            'dzfs_provider_connected',
            'dzfs_departure_center_selected_at',
            'dzfs_saas_base_url',
            'dzfs_merchant_id',
            'dzfs_store_id',
            'dzfs_dashboard_url',
        );

        $missing_marker = '__DZFS_MISSING__';

        foreach ($option_keys as $key) {
            $before_value = get_option($key, $missing_marker);
            $exists_before = $before_value !== $missing_marker;

            $exists_before ? delete_option($key) : true;

            $after_value = get_option($key, $missing_marker);
            $exists_after = $after_value !== $missing_marker;

            // Valid states:
            // 1) key existed and is now removed
            // 2) key did not exist before reset
            if ($exists_after) {
                return new WP_Error('dzfs_reset_failed', 'Failed deleting ' . $key);
            }
        }
        return true;
    }

    public function handle_save_store_info() {
        if (!current_user_can('manage_woocommerce')) {
            wp_die('Unauthorized');
        }

        check_admin_referer('dzfs_save_store_info_action', 'dzfs_save_store_info_nonce');

        $store_name = sanitize_text_field(wp_unslash($_POST['dzfs_store_name'] ?? ''));
        $store_phone = sanitize_text_field(wp_unslash($_POST['dzfs_store_phone'] ?? ''));
        $store_category = sanitize_text_field(wp_unslash($_POST['dzfs_store_category'] ?? ''));
        $store_category_custom = sanitize_text_field(wp_unslash($_POST['dzfs_store_category_custom'] ?? ''));

        if ($store_name === '' || $store_phone === '' || $store_category === '') {
            $this->redirect_with_notice('error', 'Store name, phone, and category are required.', 1);
        }

        $available_categories = $this->store_categories();
        if (!in_array($store_category, $available_categories, true)) {
            $this->redirect_with_notice('error', 'Choose a valid store category.', 1);
        }

        if ($store_category === 'Other') {
            if ($store_category_custom === '') {
                $this->redirect_with_notice('error', 'Custom category name is required when selecting Other.', 1);
            }
            $store_category = $store_category_custom;
        }

        $this->store_option('dzfs_store_name', $store_name);
        $this->store_option('dzfs_store_phone', $store_phone);
        $this->store_option('dzfs_store_category', $store_category);

        $this->redirect_with_notice('success', 'Store details saved.', 2);
    }

    public function handle_save_provider_type() {
        if (!current_user_can('manage_woocommerce')) {
            wp_die('Unauthorized');
        }

        check_admin_referer('dzfs_save_provider_type_action', 'dzfs_save_provider_type_nonce');

        $provider = sanitize_text_field(wp_unslash($_POST['dzfs_provider'] ?? ''));

        if (!in_array($provider, array('zr_express', 'yalidine'), true)) {
            $this->redirect_with_notice('error', 'Choose a provider before continuing.', 2);
        }

        $this->store_option('dzfs_delivery_provider', $provider);
        $this->store_option('dzfs_provider_base_url', DZFS_Helpers::provider_default_base_url($provider));
        $this->store_option('dzfs_provider_connection_status', 'pending');
        $this->store_option('dzfs_provider_connected', 'no');

        $this->redirect_with_notice('success', 'Provider selected.', 3);
    }

    public function handle_save_provider_credentials() {
        if (!current_user_can('manage_woocommerce')) {
            wp_die('Unauthorized');
        }

        check_admin_referer('dzfs_save_provider_credentials_action', 'dzfs_save_provider_credentials_nonce');

        $provider = DZFS_Helpers::delivery_provider();
        if (!in_array($provider, array('zr_express', 'yalidine'), true)) {
            $this->redirect_with_notice('error', 'Choose a provider first.', 2);
        }

        $provider_base_url = DZFS_Helpers::provider_default_base_url($provider);
        $raw_credentials = wp_unslash($_POST['dzfs_provider_credentials'] ?? array());
        $provider_credentials = $this->provider_credentials_for_request($provider, is_array($raw_credentials) ? $raw_credentials : array());
        $existing_credentials = DZFS_Helpers::provider_credentials();

        if (empty($provider_credentials['tenantId']) && !empty($existing_credentials['tenantId'])) {
            $provider_credentials['tenantId'] = sanitize_text_field($existing_credentials['tenantId']);
        }

        if (empty($provider_credentials['apiKey']) && !empty($existing_credentials['apiKey'])) {
            $provider_credentials['apiKey'] = sanitize_text_field($existing_credentials['apiKey']);
        }

        if ($provider_base_url === '' || empty($provider_credentials['tenantId']) || empty($provider_credentials['apiKey'])) {
            $this->redirect_with_notice('error', 'API key and API secret are required.', 3);
        }

        $this->store_option('dzfs_provider_base_url', untrailingslashit($provider_base_url));
        $this->store_option('dzfs_provider_credentials', $provider_credentials);
        $this->store_option('dzfs_provider_connection_status', 'pending');
        $this->store_option('dzfs_provider_connected', 'no');

        $this->redirect_with_notice('success', 'Provider details saved.', 4);
    }

    public function handle_save_departure_center() {
        if (!current_user_can('manage_woocommerce')) {
            wp_die('Unauthorized');
        }

        check_admin_referer('dzfs_save_departure_center_action', 'dzfs_save_departure_center_nonce');

        $center_id = sanitize_text_field(wp_unslash($_POST['dzfs_departure_center_id'] ?? ''));
        $center_name = sanitize_text_field(wp_unslash($_POST['dzfs_departure_center_name'] ?? ''));

        if ($center_id === '') {
            $this->redirect_with_notice('error', 'Select a departure center before finishing onboarding.', 5);
        }

        $result = $this->persist_departure_center_selection($center_id, $center_name);
        if ($result === false) {
            $this->redirect_with_notice('error', get_option('dzfs_yalidine_center_sync_error', 'The selected departure center could not be synchronized.'), 5);
        }

        $this->redirect_with_notice('success', 'Your Yalidine departure center is saved and ready to use.', 6);
    }

    public function handle_connect_account() {
        if (!current_user_can('manage_woocommerce')) {
            wp_die('Unauthorized');
        }

        check_admin_referer('dzfs_connect_account_action', 'dzfs_connect_account_nonce');

        $email = sanitize_email(wp_unslash($_POST['dzfs_email'] ?? ''));
        $password = (string) wp_unslash($_POST['dzfs_password'] ?? '');

        if (!is_email($email) || strlen($password) < 6) {
            $this->redirect_with_notice('error', 'Enter a valid account email and password.', 4);
        }

        $provider = DZFS_Helpers::delivery_provider();
        $provider_base_url = DZFS_Helpers::provider_base_url();
        $provider_credentials = DZFS_Helpers::provider_credentials();
        $store_name = DZFS_Helpers::store_name();
        $bootstrap_base_url = esc_url_raw(wp_unslash($_POST['dzfs_saas_base_url'] ?? DZFS_Helpers::bootstrap_base_url()));

        if ($bootstrap_base_url === '') {
            $this->redirect_with_notice('error', 'Enter a valid SaaS base URL.', 4);
        }

        if ($provider === '' || $provider_base_url === '' || empty($provider_credentials)) {
            $this->redirect_with_notice('error', 'Complete the provider step before connecting your account.', 3);
        }

        $payload = array(
            'email' => $email,
            'password' => $password,
            'storeName' => $store_name !== '' ? $store_name : get_bloginfo('name'),
            'storePhone' => DZFS_Helpers::store_phone(),
            'storeCategory' => DZFS_Helpers::store_category() !== '' ? DZFS_Helpers::store_category() : 'WooCommerce',
            'siteUrl' => home_url('/'),
            'provider' => $provider,
            'providerBaseUrl' => $provider_base_url,
            'providerCredentials' => $provider_credentials,
        );

        $this->store_option('dzfs_saas_base_url', $bootstrap_base_url);
        $endpoint = trailingslashit(untrailingslashit($bootstrap_base_url)) . 'api/v1/plugin/onboarding-connect';

        $response = wp_remote_post($endpoint, array(
            'timeout' => 45,
            'headers' => array(
                'Content-Type' => 'application/json',
                'Accept' => 'application/json',
            ),
            'body' => wp_json_encode($payload),
        ));

        if (is_wp_error($response)) {
            $this->redirect_with_notice('error', 'Connection failed: ' . $response->get_error_message(), 4);
        }

        $status_code = (int) wp_remote_retrieve_response_code($response);
        $body = wp_remote_retrieve_body($response);
        $decoded = json_decode($body, true);

        if ($status_code < 200 || $status_code >= 300 || !is_array($decoded) || empty($decoded['ok'])) {
            $message = is_array($decoded) && !empty($decoded['error']) ? $decoded['error'] : 'Bootstrap request failed.';
            $this->redirect_with_notice('error', $message, 4);
        }

        $persist_result = $this->persist_plugin_api_configuration($decoded);
        if (is_wp_error($persist_result)) {
            $this->redirect_with_notice('error', $persist_result->get_error_message(), 4);
        }

        $this->store_option('dzfs_onboarding_completed', 'no');
        $this->store_option('dzfs_force_onboarding', 'no');
        $this->store_option('dzfs_provider_connected', 'no');
        $this->store_option('dzfs_provider_connection_status', sanitize_text_field($decoded['connection_status'] ?? 'pending'));
        $this->store_option('dzfs_merchant_id', sanitize_text_field($decoded['merchant_id'] ?? ''));
        $this->store_option('dzfs_store_id', sanitize_text_field($decoded['store_id'] ?? ''));
        $this->store_option('dzfs_dashboard_url', esc_url_raw($decoded['dashboard_url'] ?? ''));

        if ($provider === 'yalidine') {
            $this->store_option('dzfs_provider_connection_status', 'pending_departure_center');
            $this->store_option('dzfs_provider_connected', 'no');
            if (!$this->sync_yalidine_center_catalog()) {
                $this->redirect_with_notice('error', get_option('dzfs_yalidine_center_sync_error', 'Departure centers could not be loaded. Please retry.'), 4);
            }
            $this->redirect_with_notice('success', 'Connection verified. Choose your Yalidine departure center to finish setup.', 5);
        }

        $this->store_option('dzfs_onboarding_completed', 'yes');
        $this->store_option('dzfs_force_onboarding', 'no');
        $this->store_option('dzfs_provider_connected', 'yes');
        $this->store_option('dzfs_provider_connection_status', 'connected');
        $this->redirect_with_notice('success', 'Your account is connected and the plugin is ready.', 6);
    }

    public function handle_reset_onboarding() {
        if (!current_user_can('manage_woocommerce')) {
            wp_die('Unauthorized');
        }

        check_admin_referer('dzfs_reset_onboarding_action', 'dzfs_reset_onboarding_nonce');

        $result = $this->reset_onboarding_configuration();
        if (is_wp_error($result)) {
            $this->redirect_with_notice('error', $result->get_error_message(), 1);
        }

        update_option('dzfs_force_onboarding', 'yes');
        $force_value = get_option('dzfs_force_onboarding', 'no');

        if ($force_value !== 'yes') {
            $this->redirect_with_notice('error', 'Failed setting dzfs_force_onboarding', 1);
        }

        $this->redirect_with_notice('success', 'Onboarding has been reset successfully.', 1);
    }

    private function render_notice() {
        if (empty($_GET['dzfs_notice'])) {
            return;
        }

        $notice_type = sanitize_text_field(wp_unslash($_GET['dzfs_notice']));
        $message = !empty($_GET['dzfs_message']) ? sanitize_text_field(rawurldecode(wp_unslash($_GET['dzfs_message']))) : '';

        if ($message === '') {
            return;
        }

        $class = $notice_type === 'success' ? 'notice-success' : 'notice-error';
        echo '<div class="notice ' . esc_attr($class) . ' is-dismissible"><p>' . esc_html($message) . '</p></div>';
    }

    private function render_stepper($active_step) {
        $steps = array(
            1 => 'Store',
            2 => 'Provider',
            3 => 'Credentials',
            4 => 'Connect',
            5 => 'Departure Center',
            6 => 'Success',
        );

        echo '<div class="dzfs-stepper">';
        foreach ($steps as $step => $label) {
            $class = $step === (int) $active_step ? ' is-active' : '';
            echo '<span class="dzfs-step' . esc_attr($class) . '">' . esc_html($step) . '. ' . esc_html($label) . '</span>';
        }
        echo '</div>';
    }

    private function render_shell_start($title, $subtitle) {
        echo '<div class="wrap dzfs-shell">';
        echo '<div class="dzfs-hero">';
        echo '<p class="dzfs-kicker">DZ Fraud Shield</p>';
        echo '<h1>' . esc_html($title) . '</h1>';
        echo '<p>' . esc_html($subtitle) . '</p>';
        echo '</div>';
    }

    private function render_shell_end() {
        echo '</div>';
    }

    private function render_summary_card($title, $items) {
        echo '<div class="dzfs-card">';
        echo '<h2>' . esc_html($title) . '</h2>';
        echo '<dl class="dzfs-summary-list">';
        foreach ($items as $label => $value) {
            echo '<dt>' . esc_html($label) . '</dt><dd>' . esc_html($value !== '' ? $value : 'Not configured') . '</dd>';
        }
        echo '</dl></div>';
    }

    private function render_provider_fields() {
        $provider = DZFS_Helpers::delivery_provider() !== '' ? DZFS_Helpers::delivery_provider() : 'zr_express';
        $label = $this->provider_label($provider);

        echo '<p><strong>Selected provider:</strong> ' . esc_html($label) . '</p>';

        echo '<div class="dzfs-provider-panels">';
        echo '<section class="dzfs-provider-panel" data-provider="' . esc_attr($provider) . '">';
        echo '<h3>' . esc_html($label) . '</h3>';
        echo '<div class="dzfs-field-grid">';
        echo '<label><span>' . esc_html($label . ' API Key / ID') . '</span><input type="text" name="dzfs_provider_credentials[tenantId]" value="" placeholder="Leave blank to keep saved value"></label>';
        echo '<label><span>' . esc_html($label . ' API Secret / Token') . '</span><input type="password" name="dzfs_provider_credentials[apiKey]" value="" placeholder="Leave blank to keep saved value"></label>';
        echo '</div></section>';
        echo '</div>';
    }

    private function render_finish_panel() {
        $provider = DZFS_Helpers::delivery_provider();
        $provider_name = $this->provider_label($provider);
        $status = DZFS_Helpers::provider_connection_status();
        $dashboard_url = DZFS_Helpers::dashboard_url();

        echo '<div class="dzfs-card dzfs-finish-card">';
        echo '<h2>Setup complete</h2>';
        echo '<p>Your WooCommerce store is linked to DZ Fraud Shield.</p>';
        echo '<div class="dzfs-checklist">';
        echo '<div><strong>Store:</strong> ' . esc_html(DZFS_Helpers::store_name()) . '</div>';
        echo '<div><strong>Provider:</strong> ' . esc_html($provider_name) . '</div>';
        echo '<div><strong>Connection:</strong> ' . esc_html($status) . '</div>';
        echo '</div>';

        echo '<div class="dzfs-actions">';
        if ($dashboard_url !== '') {
            echo '<a class="button button-primary" href="' . esc_url($dashboard_url) . '" target="_blank" rel="noreferrer">Open SaaS Dashboard</a>';
        }
        echo '<a class="button" href="' . esc_url(admin_url('admin.php?page=' . self::SETTINGS_SLUG)) . '">Open Settings</a>';
        echo '</div></div>';
    }

    private function status_label($status) {
        switch ((string) $status) {
            case 'pending_payment':
                return 'Pending Payment';
            case 'active':
                return 'Active';
            case 'expired':
                return 'Expired';
            case 'suspended':
                return 'Suspended';
            case 'rejected':
                return 'Rejected';
            default:
                return 'Unknown';
        }
    }

    private function render_subscription_state_panel($status, $snapshot) {
        $trial_active = !empty($snapshot['trialActive']);
        $trial_days = isset($snapshot['trialDaysRemaining']) ? (int) $snapshot['trialDaysRemaining'] : 0;
        $trial_expires = !empty($snapshot['trialExpiresAt']) ? (string) $snapshot['trialExpiresAt'] : '';
        $subscription_expires = !empty($snapshot['subscriptionExpiresAt']) ? (string) $snapshot['subscriptionExpiresAt'] : '';
        $payment_portal_url = !empty($snapshot['paymentPortalUrl']) ? (string) $snapshot['paymentPortalUrl'] : '';

        echo '<div class="dzfs-card dzfs-status-card">';
        echo '<h2>Subscription state</h2>';

        if ($status === 'pending_payment') {
            echo '<p><strong>Subscription Required</strong></p>';
            if ($payment_portal_url !== '') {
                echo '<p><a class="button button-primary" href="' . esc_url($payment_portal_url) . '" target="_blank" rel="noreferrer">Open Payment Portal</a></p>';
            }
        } elseif ($trial_active) {
            echo '<p><strong>Free Trial Active</strong></p>';
            echo '<p>Days Remaining: ' . esc_html((string) $trial_days) . '</p>';
            echo '<p>Expiration Date: ' . esc_html($trial_expires !== '' ? $trial_expires : '-') . '</p>';
        } elseif ($status === 'active') {
            echo '<p><strong>Subscription Active</strong></p>';
            echo '<p>Expiration Date: ' . esc_html($subscription_expires !== '' ? $subscription_expires : '-') . '</p>';
        } elseif ($status === 'expired') {
            echo '<p><strong>Subscription Expired</strong></p>';
            echo '<p>Renew your subscription to continue using DZ Fraud Shield.</p>';
        } elseif ($status === 'suspended') {
            echo '<p><strong>Subscription Suspended</strong></p>';
            echo '<p>Contact Support</p>';
        } elseif ($status === 'rejected') {
            echo '<p><strong>Account Rejected</strong></p>';
            echo '<p>Contact Support</p>';
        } else {
            echo '<p><strong>Status unavailable</strong></p>';
        }

        echo '</div>';
    }

    public function render_page() {
        $this->render_notice();

        if ($this->should_show_wizard()) {
            $step = $this->current_step();
            $this->render_shell_start('First-install onboarding', 'Set up your store, choose a provider, and connect your DZ Fraud Shield account.');
            $this->render_stepper($step);

            if ($step === 1) {
                echo '<div class="dzfs-grid">';
                $this->render_summary_card('What this wizard does', array(
                    'Store profile' => 'Captures your shop name, phone, and category.',
                    'Provider link' => 'Stores the delivery provider credentials your sync needs.',
                    'Account bootstrap' => 'Creates your SaaS merchant record and API key securely.',
                ));
                echo '<div class="dzfs-card dzfs-primary-card">';
                echo '<h2>Step 1: Store details</h2>';
                echo '<form method="post" action="' . esc_url(admin_url('admin-post.php')) . '">';
                echo '<input type="hidden" name="action" value="dzfs_save_store_info">';
                wp_nonce_field('dzfs_save_store_info_action', 'dzfs_save_store_info_nonce');
                echo '<div class="dzfs-field-grid">';
                echo '<label><span>Store name</span><input type="text" name="dzfs_store_name" class="regular-text" value="' . esc_attr(DZFS_Helpers::store_name()) . '" required></label>';
                echo '<label><span>Store phone</span><input type="text" name="dzfs_store_phone" class="regular-text" value="' . esc_attr(DZFS_Helpers::store_phone()) . '" placeholder="+213..." required></label>';
                $available_categories = $this->store_categories();
                $saved_category = DZFS_Helpers::store_category();
                $is_saved_predefined = in_array($saved_category, $available_categories, true);
                $selected_category = $is_saved_predefined ? $saved_category : ($saved_category !== '' ? 'Other' : 'Fashion & Clothing');
                $custom_category_value = $is_saved_predefined ? '' : $saved_category;
                echo '<label><span>Store category</span>';
                echo '<select name="dzfs_store_category" class="regular-text" required>';
                foreach ($available_categories as $category) {
                    echo '<option value="' . esc_attr($category) . '" ' . selected($selected_category, $category, false) . '>' . esc_html($category) . '</option>';
                }
                echo '</select></label>';
                echo '<label class="dzfs-custom-category-row" data-custom-category-row><span>Custom Category Name</span><input type="text" name="dzfs_store_category_custom" class="regular-text" value="' . esc_attr($custom_category_value) . '" placeholder="e.g. Fishing Equipment"></label>';
                echo '</div>';
                submit_button('Save and continue', 'primary', 'submit', false);
                echo '</form></div>';
                echo '</div>';
            } elseif ($step === 2) {
                echo '<div class="dzfs-card">';
                echo '<h2>Step 2: Delivery provider</h2>';
                echo '<p class="description">Choose the provider you use for shipping sync.</p>';
                echo '<form method="post" action="' . esc_url(admin_url('admin-post.php')) . '">';
                echo '<input type="hidden" name="action" value="dzfs_save_provider_type">';
                wp_nonce_field('dzfs_save_provider_type_action', 'dzfs_save_provider_type_nonce');
                echo '<div class="dzfs-provider-choice">';
                foreach (array('zr_express' => 'ZR Express', 'yalidine' => 'Yalidine') as $value => $label) {
                    echo '<label class="dzfs-provider-pill"><input type="radio" name="dzfs_provider" value="' . esc_attr($value) . '" ' . checked(DZFS_Helpers::delivery_provider(), $value, false) . '> ' . esc_html($label) . '</label>';
                }
                echo '</div>';
                submit_button('Save provider and continue', 'primary', 'submit', false);
                echo '</form></div>';
            } elseif ($step === 3) {
                echo '<div class="dzfs-card">';
                echo '<h2>Step 3: Provider credentials</h2>';
                echo '<p class="description">Provide credentials for ' . esc_html($this->provider_label(DZFS_Helpers::delivery_provider())) . '. The provider API endpoint is set automatically.</p>';
                echo '<form method="post" action="' . esc_url(admin_url('admin-post.php')) . '">';
                echo '<input type="hidden" name="action" value="dzfs_save_provider_credentials">';
                wp_nonce_field('dzfs_save_provider_credentials_action', 'dzfs_save_provider_credentials_nonce');
                $this->render_provider_fields();
                submit_button('Save provider details', 'primary', 'submit', false);
                echo '</form></div>';
            } elseif ($step === 4) {
                echo '<div class="dzfs-grid">';
                $this->render_summary_card('Stored setup', array(
                    'Store' => DZFS_Helpers::store_name(),
                    'Provider' => $this->provider_label(DZFS_Helpers::delivery_provider()),
                    'Provider status' => DZFS_Helpers::provider_connection_status(),
                ));
                echo '<div class="dzfs-card">';
                echo '<h2>Step 4: Connect your DZ Fraud Shield account</h2>';
                echo '<p class="description">Use your SaaS account email and password to provision the merchant, create the API key, and finish setup.</p>';
                if (DZFS_Helpers::delivery_provider() === 'yalidine' && get_option('dzfs_yalidine_center_sync_error', '') !== '') {
                    echo '<p class="description" style="color:#b32d2e;"><strong>Departure centers could not be loaded. Please retry the connection so a valid Yalidine departure center can be selected.</strong></p>';
                }
                echo '<form method="post" action="' . esc_url(admin_url('admin-post.php')) . '">';
                echo '<input type="hidden" name="action" value="dzfs_connect_account">';
                wp_nonce_field('dzfs_connect_account_action', 'dzfs_connect_account_nonce');
                echo '<div class="dzfs-field-grid">';
                echo '<label><span>Email</span><input type="email" name="dzfs_email" class="regular-text" value="" autocomplete="email" required></label>';
                echo '<label><span>Password</span><input type="password" name="dzfs_password" class="regular-text" value="" autocomplete="current-password" required></label>';
                echo '<label><span>SaaS base URL</span><input type="url" name="dzfs_saas_base_url" class="regular-text" value="' . esc_attr(DZFS_Helpers::bootstrap_base_url()) . '" placeholder="https://app.example.com" required></label>';
                echo '</div>';
                submit_button(DZFS_Helpers::delivery_provider() === 'yalidine' && get_option('dzfs_yalidine_center_sync_error', '') !== '' ? 'Retry connection' : 'Connect account', 'primary', 'submit', false);
                echo '</form></div></div>';
            } elseif ($step === 5 && DZFS_Helpers::delivery_provider() === 'yalidine') {
                $centers = DZFS_Helpers::yalidine_departure_centers();
                if (empty($centers)) {
                    $this->sync_yalidine_center_catalog();
                    $centers = DZFS_Helpers::yalidine_departure_centers();
                }
                echo '<div class="dzfs-card">';
                echo '<h2>Step 5: Select your Yalidine Departure Center</h2>';
                if (DZFS_Helpers::yalidine_departure_center_requires_attention()) {
                    echo '<div class="notice notice-warning" style="margin-bottom:12px;"><p>' . esc_html(DZFS_Helpers::yalidine_departure_center_attention_message() !== '' ? DZFS_Helpers::yalidine_departure_center_attention_message() : 'The selected Yalidine departure center is no longer available. Please choose a new one.') . '</p></div>';
                }
                echo '<p class="description">Choose the single departure center that will be used for future Yalidine pricing, shipment, and bordereau flows.</p>';
                echo '<form method="post" action="' . esc_url(admin_url('admin-post.php')) . '">';
                echo '<input type="hidden" name="action" value="dzfs_save_departure_center">';
                wp_nonce_field('dzfs_save_departure_center_action', 'dzfs_save_departure_center_nonce');
                echo '<div class="dzfs-field-grid">';
                echo '<label><span>Departure Center</span>';
                echo '<input type="search" class="regular-text" id="dzfs-onboarding-center-search" placeholder="Search departure center" style="margin-bottom:8px;">';
                echo '<select name="dzfs_departure_center_id" id="dzfs-onboarding-center-select" class="regular-text" required>';
                echo '<option value="">Select a departure center</option>';
                if (is_array($centers) && !empty($centers)) {
                    foreach ($centers as $center) {
                        $center_id = isset($center['id']) ? (string) $center['id'] : (isset($center['center_id']) ? (string) $center['center_id'] : '');
                        $center_name = isset($center['name']) ? (string) $center['name'] : (isset($center['center_name']) ? (string) $center['center_name'] : '');
                        $wilaya_name = isset($center['wilaya_name']) ? (string) $center['wilaya_name'] : '';
                        if ($center_id === '') {
                            continue;
                        }
                        $label = $center_name !== '' ? $center_name : $center_id;
                        if ($wilaya_name !== '') {
                            $label .= ' — ' . $wilaya_name;
                        }
                        echo '<option value="' . esc_attr($center_id) . '">' . esc_html($label) . '</option>';
                    }
                }
                echo '</select></label>';
                echo '<input type="hidden" name="dzfs_departure_center_name" id="dzfs-onboarding-center-name" value="">';
                echo '</div>';
                submit_button('Save and finish onboarding', 'primary', 'submit', false);
                echo '</form>';
                echo '<script>(function(){var search=document.getElementById("dzfs-onboarding-center-search");var select=document.getElementById("dzfs-onboarding-center-select");var hidden=document.getElementById("dzfs-onboarding-center-name");if(!search||!select||!hidden){return;}var options=Array.prototype.slice.call(select.options);function refresh(){var term=(search.value||"").toLowerCase();options.forEach(function(option){if(!option.value){option.hidden=false;return;}var text=(option.text||"").toLowerCase();option.hidden=term!==""&&!text.includes(term);});var selected=options.find(function(option){return option.value===select.value;});hidden.value=selected?selected.text:"";}refresh();search.addEventListener("input",refresh);select.addEventListener("change",refresh);})();</script>';
                echo '</div>';
            } else {
                echo '<div class="dzfs-card"><h2>Step 6: Success</h2></div>';
                $this->render_finish_panel();
            }

            echo '<div class="dzfs-card dzfs-footer-actions">';
            echo '<form method="post" action="' . esc_url(admin_url('admin-post.php')) . '" class="dzfs-inline-form">';
            echo '<input type="hidden" name="action" value="dzfs_reset_onboarding">';
            wp_nonce_field('dzfs_reset_onboarding_action', 'dzfs_reset_onboarding_nonce');
            echo '<button type="submit" class="button button-secondary">Run setup again</button>';
            echo '</form>';
            echo '</div>';

            $this->render_shell_end();
            return;
        }

        $this->render_shell_start('Dashboard', 'Monitor your DZ Fraud Shield connection and jump into advanced settings when needed.');
        $status_snapshot = (new DZFS_API_Client())->get_status_snapshot(true);
        $subscription_status = isset($status_snapshot['subscriptionStatus']) ? (string) $status_snapshot['subscriptionStatus'] : 'pending_payment';
        echo '<div class="dzfs-grid">';
        $this->render_summary_card('Connection', array(
            'Merchant API key' => DZFS_Helpers::api_key() !== '' ? 'Configured' : 'Missing',
            'SaaS base URL' => DZFS_Helpers::api_base_url(),
            'Onboarding status' => DZFS_Helpers::onboarding_completed() ? 'Complete' : 'Pending',
        ));
        $this->render_summary_card('Store profile', array(
            'Store name' => DZFS_Helpers::store_name(),
            'Phone' => DZFS_Helpers::store_phone(),
            'Category' => DZFS_Helpers::store_category(),
        ));
        $this->render_summary_card('Provider', array(
            'Provider' => $this->provider_label(DZFS_Helpers::delivery_provider()),
            'Base URL' => DZFS_Helpers::provider_base_url(),
            'Connection' => DZFS_Helpers::provider_connection_status(),
        ));
        $this->render_summary_card('Status snapshot', array(
            'Merchant Status' => $this->status_label($subscription_status),
            'Plan' => !empty($status_snapshot['plan']) ? (string) $status_snapshot['plan'] : 'none',
            'Trial Status' => !empty($status_snapshot['trialActive']) ? 'Active' : 'Inactive',
            'Expiration Date' => !empty($status_snapshot['subscriptionExpiresAt']) ? (string) $status_snapshot['subscriptionExpiresAt'] : (!empty($status_snapshot['trialExpiresAt']) ? (string) $status_snapshot['trialExpiresAt'] : '-'),
            'API Connection Status' => !empty($status_snapshot['valid']) ? 'Connected' : 'Disconnected',
            'Last Sync' => (string) get_option('dzfs_last_status_sync_at', '-'),
        ));
        echo '</div>';

        $this->render_subscription_state_panel($subscription_status, $status_snapshot);

        echo '<div class="dzfs-card dzfs-actions-card">';
        echo '<h2>Next actions</h2>';
        echo '<div class="dzfs-actions">';
        echo '<a class="button button-primary" href="' . esc_url(admin_url('admin.php?page=' . self::SETTINGS_SLUG)) . '">Open settings</a>';
        echo '<form method="post" action="' . esc_url(admin_url('admin-post.php')) . '" class="dzfs-inline-form">';
        echo '<input type="hidden" name="action" value="dzfs_reset_onboarding">';
        wp_nonce_field('dzfs_reset_onboarding_action', 'dzfs_reset_onboarding_nonce');
        echo '<button type="submit" class="button">Restart wizard</button>';
        echo '</form>';
        if (DZFS_Helpers::api_base_url() !== '') {
            echo '<a class="button button-secondary" href="' . esc_url(DZFS_Helpers::api_base_url()) . '" target="_blank" rel="noreferrer">Open SaaS</a>';
        }
        echo '</div></div>';

        $this->render_shell_end();
    }
}
