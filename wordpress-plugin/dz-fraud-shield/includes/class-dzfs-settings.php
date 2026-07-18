<?php

if (!defined('ABSPATH')) {
    exit;
}

class DZFS_Settings {
    const PAGE_SLUG = 'dz-fraud-shield-settings';

    public function __construct() {
        add_action('admin_menu', array($this, 'register_menu'));
        add_action('admin_init', array($this, 'register_settings'));
        add_action('admin_post_dzfs_test_connection', array($this, 'handle_test_connection'));
        // Legacy form-POST sync handler kept for environments that block loopback requests.
        add_action('admin_post_dzfs_run_yalidine_sync', array($this, 'handle_run_yalidine_sync'));

        // AJAX-based live sync handlers.
        add_action('wp_ajax_dzfs_sync_start',  array($this, 'ajax_sync_start'));
        add_action('wp_ajax_dzfs_sync_stop',   array($this, 'ajax_sync_stop'));
        add_action('wp_ajax_dzfs_sync_status', array($this, 'ajax_sync_status'));
        // Background worker called via server loopback (no session, token-authenticated).
        add_action('wp_ajax_nopriv_dzfs_sync_run_bg', array($this, 'ajax_sync_run_background'));
        add_action('wp_ajax_dzfs_sync_run_bg',        array($this, 'ajax_sync_run_background'));
    }

    public function register_menu() {
        return;
    }

    public function register_settings() {
        register_setting('dzfs_settings_group', 'dzfs_settings', array($this, 'sanitize'));

        add_settings_section('dzfs_main', 'Main settings', '__return_false', 'dz-fraud-shield');
        add_settings_section('dzfs_decision_actions', 'Merchant Decision Actions', '__return_false', 'dz-fraud-shield');

        $fields = array(
            'api_base_url' => 'API Base URL',
            'api_key' => 'API Key',
            'enabled' => 'Enable fraud check',
            'auto_block' => 'Auto block high risk',
        );

        foreach ($fields as $key => $label) {
            add_settings_field($key, $label, array($this, 'render_field'), 'dz-fraud-shield', 'dzfs_main', array('key' => $key));
        }

        $decision_fields = array(
            'accept_decision_status' => 'Accept Decision Status',
            'verify_decision_status' => 'Verify Decision Status',
            'block_decision_status' => 'Block Decision Status',
            'enable_fraud_blocked_status' => 'Enable fraud_blocked Status',
        );

        foreach ($decision_fields as $key => $label) {
            add_settings_field($key, $label, array($this, 'render_field'), 'dz-fraud-shield', 'dzfs_decision_actions', array('key' => $key));
        }
    }

    public function sanitize($input) {
        $is_reset_action = isset($_POST['action'])
            && sanitize_text_field(wp_unslash($_POST['action'])) === 'dzfs_reset_onboarding';

        $existing = DZFS_Helpers::get_option('api_key', '');
        $existing_base_url = DZFS_Helpers::get_option('api_base_url', '');
        $existing_departure_center = DZFS_Helpers::yalidine_departure_center_id();
        $existing_departure_center_name = DZFS_Helpers::yalidine_departure_center_name();
        $existing_departure_centers = DZFS_Helpers::yalidine_departure_centers();
        $existing_departure_center_prices = DZFS_Helpers::yalidine_departure_center_prices();

        if ($is_reset_action) {
            return array(
                'api_base_url' => '',
                'api_key' => '',
                'yalidine_departure_center' => '',
                'yalidine_departure_center_name' => '',
                'yalidine_departure_centers' => array(),
                'yalidine_departure_center_prices' => array(),
                'enabled' => DZFS_Helpers::get_option('enabled', 'yes'),
                'auto_block' => DZFS_Helpers::get_option('auto_block', 'no'),
                'accept_decision_status' => DZFS_Helpers::get_option('accept_decision_status', 'processing'),
                'verify_decision_status' => 'on-hold',
                'block_decision_status' => DZFS_Helpers::get_option('block_decision_status', 'cancelled'),
                'enable_fraud_blocked_status' => DZFS_Helpers::get_option('enable_fraud_blocked_status', 'no'),
            );
        }

        return array(
            'api_base_url' => !empty($input['api_base_url']) ? esc_url_raw($input['api_base_url']) : $existing_base_url,
            'api_key' => !empty($input['api_key']) ? sanitize_text_field($input['api_key']) : $existing,
            'yalidine_departure_center' => isset($input['yalidine_departure_center']) ? sanitize_text_field((string) $input['yalidine_departure_center']) : $existing_departure_center,
            'yalidine_departure_center_name' => isset($input['yalidine_departure_center_name']) ? sanitize_text_field((string) $input['yalidine_departure_center_name']) : $existing_departure_center_name,
            'yalidine_departure_centers' => isset($input['yalidine_departure_centers']) && is_array($input['yalidine_departure_centers']) ? $input['yalidine_departure_centers'] : $existing_departure_centers,
            'yalidine_departure_center_prices' => isset($input['yalidine_departure_center_prices']) && is_array($input['yalidine_departure_center_prices']) ? $input['yalidine_departure_center_prices'] : $existing_departure_center_prices,
            'enabled' => !empty($input['enabled']) ? 'yes' : 'no',
            'auto_block' => !empty($input['auto_block']) ? 'yes' : 'no',
            'accept_decision_status' => in_array(($input['accept_decision_status'] ?? 'processing'), array('processing', 'on-hold'), true) ? $input['accept_decision_status'] : 'processing',
            'verify_decision_status' => 'on-hold',
            'block_decision_status' => in_array(($input['block_decision_status'] ?? 'cancelled'), array('cancelled', 'fraud_blocked'), true) ? $input['block_decision_status'] : 'cancelled',
            'enable_fraud_blocked_status' => !empty($input['enable_fraud_blocked_status']) ? 'yes' : 'no',
        );
    }

    public function handle_test_connection() {
        if (!current_user_can('manage_woocommerce')) {
            wp_die('Unauthorized');
        }

        check_admin_referer('dzfs_test_connection_action', 'dzfs_test_connection_nonce');

        $api = new DZFS_API_Client();
        $result = $api->ping();

        $notice = 'failed';
        $message = 'Connection failed.';

        if (!is_wp_error($result) && !empty($result['valid'])) {
            $notice = 'connected';
            $message = 'Connected successfully.';
        } elseif (is_wp_error($result)) {
            $message = sprintf('Connection failed: %s', $result->get_error_message());
        }

        $redirect = add_query_arg(
            array(
                'page' => self::PAGE_SLUG,
                'dzfs_notice' => $notice,
                'dzfs_message' => rawurlencode($message),
            ),
            admin_url('admin.php')
        );

        wp_safe_redirect($redirect);
        exit;
    }

    public function handle_run_yalidine_sync() {
        if (!current_user_can('manage_woocommerce')) {
            wp_die('Unauthorized');
        }

        check_admin_referer('dzfs_run_yalidine_sync_action', 'dzfs_run_yalidine_sync_nonce');

        $service = new DZFS_Yalidine_Sync_Service();
        $result = $service->run_sync('manual_admin', true);

        $notice = 'failed';
        $message = 'Yalidine sync failed.';

        $status = is_array($result) && isset($result['status']) ? $result['status'] : '';
        if ($status === 'success' || $status === 'fees_sync_failed') {
            $notice     = 'connected';
            $fees_stats = isset($result['feesStats']) && is_array($result['feesStats']) ? $result['feesStats'] : array();
            $message    = sprintf(
                'Yalidine sync completed. Wilayas: %d, Communes: %d, Offices: %d, Centers: %d, Fees: %d.',
                isset($result['rowsWilayas'])  ? (int) $result['rowsWilayas']  : 0,
                isset($result['rowsCommunes']) ? (int) $result['rowsCommunes'] : 0,
                isset($result['rowsOffices'])  ? (int) $result['rowsOffices']  : 0,
                isset($result['rowsCenters'])  ? (int) $result['rowsCenters']  : 0,
                isset($result['rowsFees'])     ? (int) $result['rowsFees']     : 0
            );
            if (!empty($fees_stats)) {
                $message .= sprintf(
                    ' API: %d/%d destinations, %d retries, %d rate-limit pauses, %ds.',
                    isset($fees_stats['successful_requests']) ? (int) $fees_stats['successful_requests'] : 0,
                    isset($fees_stats['total_requests'])      ? (int) $fees_stats['total_requests']      : 58,
                    isset($fees_stats['retried_requests'])    ? (int) $fees_stats['retried_requests']    : 0,
                    isset($fees_stats['rate_limit_pauses'])   ? (int) $fees_stats['rate_limit_pauses']   : 0,
                    isset($fees_stats['duration_ms'])         ? (int) round($fees_stats['duration_ms'] / 1000) : 0
                );
            }
            if ($status === 'fees_sync_failed' && !empty($result['feesError'])) {
                $message .= ' Warning — fees sync failed: ' . sanitize_text_field((string) $result['feesError']);
            } elseif (!empty($result['feesError'])) {
                $message .= ' Note: ' . sanitize_text_field((string) $result['feesError']);
            }
        } elseif (is_array($result) && !empty($result['error'])) {
            $error_text = sanitize_text_field((string) $result['error']);
            $message    = sprintf('Yalidine sync failed: %s', $error_text);
            $last_success = isset($result['lastSuccessAt']) ? (string) $result['lastSuccessAt'] : '';
            if ($last_success !== '') {
                $message .= sprintf(' Your store continues to use the local database from %s.', $last_success);
            } else {
                $message .= ' No previous sync data found — checkout delivery options may be unavailable until a successful sync completes.';
            }
        }

        $redirect = add_query_arg(
            array(
                'page' => self::PAGE_SLUG,
                'dzfs_notice' => $notice,
                'dzfs_message' => rawurlencode($message),
            ),
            admin_url('admin.php')
        );

        wp_safe_redirect($redirect);
        exit;
    }

    // ── AJAX: start background sync ────────────────────────────────────────────

    public function ajax_sync_start() {
        if (!check_ajax_referer('dzfs_sync_nonce', 'nonce', false)) {
            wp_send_json_error('Invalid nonce.', 403);
        }
        if (!current_user_can('manage_woocommerce')) {
            wp_send_json_error('Unauthorized.', 403);
        }

        // Reject if a fresh sync is still running (stale after 5 minutes).
        $live = (array) get_option('dzfs_sync_live', array());
        if (!empty($live['status']) && $live['status'] === 'running') {
            $hb    = !empty($live['heartbeat_ts']) ? (int) $live['heartbeat_ts'] : 0;
            $stale = !$hb || (time() - $hb) > 300;
            if (!$stale) {
                wp_send_json_error('A sync is already in progress.', 409);
            }
        }

        // Write the initial "running/starting" state immediately so the UI
        // updates before the loopback worker has been accepted by the server.
        update_option('dzfs_sync_live', array(
            'status'           => 'running',
            'stage'            => 'starting',
            'started_ts'       => time(),
            'heartbeat_ts'     => time(),
            'geo_step'         => 0,
            'geo_total'        => 0,
            'cancel_requested' => false,
            'pauses'           => 0,
            'pause_ms'         => 0,
            'retries'          => 0,
            'quota_sec'        => null,
            'quota_min'        => null,
            'quota_hr'         => null,
            'quota_day'        => null,
            'error'            => '',
        ), false);

        // Fire background loopback (non-blocking, no session cookies).
        // Secured by a one-time random token stored in a 5-minute transient.
        $token = wp_generate_password(32, false);
        set_transient('dzfs_sync_bg_token', $token, 300);

        wp_remote_post(admin_url('admin-ajax.php'), array(
            'timeout'   => 0.01,
            'blocking'  => false,
            'sslverify' => apply_filters('https_local_ssl_verify', false),
            'cookies'   => array(),
            'body'      => array(
                'action' => 'dzfs_sync_run_bg',
                'token'  => $token,
            ),
        ));

        wp_send_json_success(array('status' => 'running'));
    }

    // ── AJAX: stop (request cancellation) ─────────────────────────────────────

    public function ajax_sync_stop() {
        if (!check_ajax_referer('dzfs_sync_nonce', 'nonce', false)) {
            wp_send_json_error('Invalid nonce.', 403);
        }
        if (!current_user_can('manage_woocommerce')) {
            wp_send_json_error('Unauthorized.', 403);
        }

        $live = (array) get_option('dzfs_sync_live', array());
        $live['cancel_requested'] = true;
        update_option('dzfs_sync_live', $live, false);

        wp_send_json_success(array('ok' => true));
    }

    // ── AJAX: poll current status ──────────────────────────────────────────────

    public function ajax_sync_status() {
        if (!check_ajax_referer('dzfs_sync_nonce', 'nonce', false)) {
            wp_send_json_error('Invalid nonce.', 403);
        }
        if (!current_user_can('manage_woocommerce')) {
            wp_send_json_error('Unauthorized.', 403);
        }

        $live       = (array) get_option('dzfs_sync_live', array());
        $fees_stats = (array) get_option('dzfs_yalidine_last_fees_stats', array());

        wp_send_json_success(array(
            'live'           => $live,
            'rows'           => array(
                'wilayas'  => (int) get_option('dzfs_yalidine_sync_rows_wilayas',  0),
                'communes' => (int) get_option('dzfs_yalidine_sync_rows_communes', 0),
                'offices'  => (int) get_option('dzfs_yalidine_sync_rows_offices',  0),
                'centers'  => (int) get_option('dzfs_yalidine_sync_rows_centers',  0),
                'fees'     => (int) get_option('dzfs_yalidine_sync_rows_fees',     0),
            ),
            'last_success_at' => (string) get_option('dzfs_yalidine_sync_last_success_at', ''),
            'last_status'     => (string) get_option('dzfs_yalidine_sync_last_status', 'never'),
            'last_error'      => (string) get_option('dzfs_yalidine_sync_last_error', ''),
            'fees_stats'      => $fees_stats,
        ));
    }

    // ── AJAX: background worker (server loopback, token-auth, no session) ──────

    public function ajax_sync_run_background() {
        $token  = isset($_POST['token']) ? sanitize_text_field(wp_unslash($_POST['token'])) : '';
        $stored = (string) get_transient('dzfs_sync_bg_token');

        // Timing-safe comparison; reject empty or mismatched tokens.
        if ($token === '' || $stored === '' || !hash_equals($stored, $token)) {
            status_header(403);
            exit;
        }
        delete_transient('dzfs_sync_bg_token');

        // Allow the sync to run past the default max_execution_time.
        @ignore_user_abort(true);
        @set_time_limit(0);

        $service = new DZFS_Yalidine_Sync_Service();
        $service->run_sync_live();

        exit;
    }

    // ── Field renderer ─────────────────────────────────────────────────────────

    private function render_notice() {
        if (empty($_GET['dzfs_notice'])) {
            return;
        }

        $notice_type = sanitize_text_field(wp_unslash($_GET['dzfs_notice']));
        $message = !empty($_GET['dzfs_message']) ? sanitize_text_field(rawurldecode(wp_unslash($_GET['dzfs_message']))) : '';

        if (empty($message)) {
            return;
        }

        $class = $notice_type === 'connected' ? 'notice-success' : 'notice-error';
        echo '<div class="notice ' . esc_attr($class) . ' is-dismissible"><p>' . esc_html($message) . '</p></div>';
    }

    public function render_field($args) {
        $key = $args['key'];
        $value = DZFS_Helpers::get_option($key, '');

        if (in_array($key, array('enabled', 'auto_block'), true)) {
            echo '<label><input type="checkbox" name="dzfs_settings[' . esc_attr($key) . ']" value="yes" ' . checked($value, 'yes', false) . '> Enabled</label>';
            return;
        }

        if ($key === 'enable_fraud_blocked_status') {
            echo '<label><input type="checkbox" name="dzfs_settings[' . esc_attr($key) . ']" value="yes" ' . checked($value, 'yes', false) . '> Enabled</label>';
            return;
        }

        if ($key === 'accept_decision_status') {
            echo '<select name="dzfs_settings[' . esc_attr($key) . ']">';
            echo '<option value="processing" ' . selected($value, 'processing', false) . '>processing</option>';
            echo '<option value="on-hold" ' . selected($value, 'on-hold', false) . '>on-hold</option>';
            echo '</select>';
            return;
        }

        if ($key === 'verify_decision_status') {
            echo '<select name="dzfs_settings[' . esc_attr($key) . ']">';
            echo '<option value="on-hold" selected>on-hold</option>';
            echo '</select>';
            echo '<p class="description">Verification decisions always move orders to on-hold.</p>';
            return;
        }

        if ($key === 'block_decision_status') {
            echo '<select name="dzfs_settings[' . esc_attr($key) . ']">';
            echo '<option value="cancelled" ' . selected($value, 'cancelled', false) . '>cancelled</option>';
            echo '<option value="fraud_blocked" ' . selected($value, 'fraud_blocked', false) . '>fraud_blocked</option>';
            echo '</select>';
            return;
        }

        if ($key === 'api_key') {
            echo '<input type="password" class="regular-text" name="dzfs_settings[' . esc_attr($key) . ']" value="" placeholder="Leave blank to keep saved key">';
            return;
        }

        if ($key === 'yalidine_departure_center') {
            $centers = DZFS_Helpers::yalidine_departure_centers();
            $selected_value = DZFS_Helpers::yalidine_departure_center_id();
            echo '<div class="dzfs-departure-center-field">';
            echo '<input type="search" class="regular-text" id="dzfs-departure-center-search" placeholder="Search departure center">';
            echo '<select class="regular-text" id="dzfs-departure-center-select" name="dzfs_settings[' . esc_attr($key) . ']">';
            echo '<option value="" ' . selected($selected_value, '', false) . '>Select a departure center</option>';
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
                    echo '<option value="' . esc_attr($center_id) . '" ' . selected($selected_value, $center_id, false) . '>' . esc_html($label) . '</option>';
                }
            }
            echo '</select>';
            echo '<input type="hidden" name="dzfs_settings[yalidine_departure_center_name]" value="' . esc_attr(DZFS_Helpers::yalidine_departure_center_name()) . '">';
            echo '<p class="description">Run the Yalidine sync to populate available departure centers. The selected center is used for checkout pricing and shipment/bordereau payloads.</p>';
            echo '<script>(function(){var search=document.getElementById("dzfs-departure-center-search");var select=document.getElementById("dzfs-departure-center-select");var hidden=document.querySelector("input[name=\"dzfs_settings[yalidine_departure_center_name]\"]");if(!search||!select||!hidden){return;}var options=Array.prototype.slice.call(select.options);function refresh(){var term=(search.value||"").toLowerCase();options.forEach(function(option){if(!option.value){option.hidden=false;return;}var text=(option.text||"").toLowerCase();option.hidden=term!==""&&!text.includes(term);});var selected=options.find(function(option){return option.value===select.value;});hidden.value=selected?selected.text:"";}{refresh();}search.addEventListener("input",refresh);select.addEventListener("change",refresh);})();</script>';
            echo '</div>';
            return;
        }

        echo '<input type="text" class="regular-text" name="dzfs_settings[' . esc_attr($key) . ']" value="' . esc_attr($value) . '">';
    }

    // ── Page renderer ──────────────────────────────────────────────────────────

    public function render_page() {
        $sync_last_started   = (string) get_option('dzfs_yalidine_sync_last_started_at', '');
        $sync_last_completed = (string) get_option('dzfs_yalidine_sync_last_completed_at', '');
        $sync_last_success   = (string) get_option('dzfs_yalidine_sync_last_success_at', '');
        $sync_last_status    = (string) get_option('dzfs_yalidine_sync_last_status', 'never');
        $sync_last_error     = (string) get_option('dzfs_yalidine_sync_last_error', '');

        $sync_rows_wilayas  = (int) get_option('dzfs_yalidine_sync_rows_wilayas', 0);
        $sync_rows_communes = (int) get_option('dzfs_yalidine_sync_rows_communes', 0);
        $sync_rows_offices  = (int) get_option('dzfs_yalidine_sync_rows_offices', 0);
        $sync_rows_centers  = (int) get_option('dzfs_yalidine_sync_rows_centers', 0);
        $sync_rows_fees     = (int) get_option('dzfs_yalidine_sync_rows_fees', 0);

        $sync_has_failed    = ($sync_last_status === 'failed');
        $has_local_data     = ($sync_last_success !== '' && $sync_rows_wilayas > 0);
        $show_last_summary  = ($has_local_data || ($sync_last_status !== 'never' && $sync_last_status !== ''));

        $this->render_notice();
        if (DZFS_Helpers::yalidine_departure_center_requires_attention()) {
            echo '<div class="notice notice-warning is-dismissible"><p>' . esc_html(DZFS_Helpers::yalidine_departure_center_attention_message() !== '' ? DZFS_Helpers::yalidine_departure_center_attention_message() : 'The selected Yalidine departure center is no longer available. Please choose a new one.') . '</p></div>';
        }
        ?>
        <div class="wrap dzfs-settings-wrap">
            <div class="dzfs-hero dzfs-settings-hero">
                <p class="dzfs-kicker">Advanced settings</p>
                <h1>DZ Fraud Shield settings</h1>
                <p>Fine-tune fraud blocking, manual order decision actions, and the SaaS connection used by check-order and report-outcome.</p>
            </div>

            <div class="dzfs-grid dzfs-settings-grid">
                <div class="dzfs-settings-card dzfs-settings-card--wide">
                    <form method="post" action="options.php">
                        <?php
                        settings_fields('dzfs_settings_group');
                        do_settings_sections('dz-fraud-shield');
                        submit_button('Save advanced settings', 'primary', 'submit', false);
                        ?>
                    </form>
                </div>

                <div class="dzfs-settings-card">
                    <h2>Connection test</h2>
                    <p class="description">Send POST /api/v1/plugin/ping with the current API key and site URL.</p>
                    <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>">
                        <input type="hidden" name="action" value="dzfs_test_connection" />
                        <?php wp_nonce_field('dzfs_test_connection_action', 'dzfs_test_connection_nonce'); ?>
                        <button class="button button-secondary" type="submit">Test connection</button>
                    </form>
                </div>

                <?php /* ── Yalidine Local Sync — live panel ── */ ?>
                <div class="dzfs-settings-card" id="dzfs-sync-panel">

                    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:6px;">
                        <h2 style="margin:0;">Yalidine Local Sync</h2>
                        <span id="dzfs-sync-badge" class="dzfs-sync-badge dzfs-badge--idle">Idle</span>
                    </div>

                    <p class="description" style="margin-bottom:0;">Downloads wilayas, communes, offices, centers, and fee tables via the SaaS synchronization engine — same rate-limiter, quota tracking, and retry logic as the Admin Global Sync. Updates live as it runs.</p>

                    <?php /* Action buttons */ ?>
                    <div style="display:flex;flex-wrap:wrap;gap:8px;margin:14px 0 0;">
                        <button id="dzfs-btn-start" type="button" class="dzfs-sync-btn dzfs-sync-btn--primary">Start Sync</button>
                        <button id="dzfs-btn-stop"  type="button" class="dzfs-sync-btn dzfs-sync-btn--danger" style="display:none;">Stop Sync</button>
                        <button id="dzfs-btn-stopping" type="button" class="dzfs-sync-btn dzfs-sync-btn--muted" style="display:none;" disabled>
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="animation:dzfs-spin 1s linear infinite;flex-shrink:0;"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                            Stopping…
                        </button>
                    </div>
                    <p id="dzfs-start-error" style="display:none;margin:6px 0 0;font-size:12px;color:#dc2626;"></p>

                    <?php /* Dark progress card */ ?>
                    <div id="dzfs-sync-progress" class="dzfs-sync-progress-card" style="display:none;margin-top:14px;">

                        <?php /* Stage label + timing */ ?>
                        <div style="display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:10px;">
                            <span id="dzfs-stage-label" style="font-size:13px;font-weight:500;color:#e2e8f0;flex:1;min-width:0;line-height:1.4;"></span>
                            <span id="dzfs-timing"      style="font-size:11px;font-family:monospace;color:#94a3b8;white-space:nowrap;line-height:1.4;"></span>
                        </div>

                        <?php /* Quota-wait banner */ ?>
                        <div id="dzfs-wait-banner" class="dzfs-sync-wait-banner" style="display:none;margin-bottom:10px;">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fbbf24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;animation:dzfs-spin 1s linear infinite;"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                            <span id="dzfs-wait-text" style="font-size:11px;font-weight:500;color:#fde68a;">Waiting for quota reset — sync will resume automatically</span>
                        </div>

                        <?php /* Geo progress bar */ ?>
                        <div id="dzfs-progress-wrap" style="display:none;margin-bottom:10px;">
                            <div style="display:flex;justify-content:space-between;font-size:11px;color:#94a3b8;margin-bottom:4px;">
                                <span>Wilayas synced: <strong id="dzfs-geo-done" style="color:#fff;">0</strong> / <span id="dzfs-geo-total">58</span></span>
                                <span id="dzfs-progress-pct" style="font-weight:600;color:#D6A74C;">0%</span>
                            </div>
                            <div class="dzfs-progress-track">
                                <div id="dzfs-progress-fill" class="dzfs-progress-fill" style="width:0%;"></div>
                            </div>
                        </div>

                        <?php /* Indeterminate spinner (starting / fees stage) */ ?>
                        <div id="dzfs-geo-spinner" style="display:none;margin-bottom:10px;">
                            <div style="display:flex;align-items:center;gap:6px;font-size:11px;color:#94a3b8;margin-bottom:4px;">
                                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="animation:dzfs-spin 1s linear infinite;flex-shrink:0;"><circle cx="12" cy="12" r="10"/></svg>
                                <span id="dzfs-spinner-label">Fetching from Yalidine via SaaS sync engine…</span>
                            </div>
                            <div class="dzfs-progress-track"><div class="dzfs-geo-indeterminate"></div></div>
                        </div>

                        <?php /* Data counts */ ?>
                        <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:6px;margin-bottom:10px;">
                            <div class="dzfs-metric-pill"><span class="dzfs-metric-label">Wilayas</span><span class="dzfs-metric-val" id="dzfs-m-wilayas">—</span></div>
                            <div class="dzfs-metric-pill"><span class="dzfs-metric-label">Communes</span><span class="dzfs-metric-val" id="dzfs-m-communes">—</span></div>
                            <div class="dzfs-metric-pill"><span class="dzfs-metric-label">Offices</span><span class="dzfs-metric-val" id="dzfs-m-offices">—</span></div>
                            <div class="dzfs-metric-pill"><span class="dzfs-metric-label">Centers</span><span class="dzfs-metric-val" id="dzfs-m-centers">—</span></div>
                            <div class="dzfs-metric-pill"><span class="dzfs-metric-label">Fees</span><span class="dzfs-metric-val" id="dzfs-m-fees">—</span></div>
                        </div>

                        <?php /* Rate-limit activity */ ?>
                        <p class="dzfs-section-hdr">Rate-limit activity</p>
                        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:10px;">
                            <div class="dzfs-activity-pill" id="dzfs-ap-pauses"><span class="dzfs-metric-label">Pauses</span><span class="dzfs-metric-val">0</span></div>
                            <div class="dzfs-activity-pill" id="dzfs-ap-wait"><span class="dzfs-metric-label">Total wait</span><span class="dzfs-metric-val">0s</span></div>
                            <div class="dzfs-activity-pill" id="dzfs-ap-retries"><span class="dzfs-metric-label">429 Retries</span><span class="dzfs-metric-val">0</span></div>
                        </div>

                        <?php /* Quota remaining */ ?>
                        <p class="dzfs-section-hdr">Quota remaining</p>
                        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-bottom:6px;">
                            <div class="dzfs-quota-pill" id="dzfs-qp-sec"><span class="dzfs-metric-label">/ sec</span><span class="dzfs-metric-val">—</span><div class="dzfs-quota-track"><div class="dzfs-quota-fill" style="width:0%;"></div></div></div>
                            <div class="dzfs-quota-pill" id="dzfs-qp-min"><span class="dzfs-metric-label">/ min</span><span class="dzfs-metric-val">—</span><div class="dzfs-quota-track"><div class="dzfs-quota-fill" style="width:0%;"></div></div></div>
                            <div class="dzfs-quota-pill" id="dzfs-qp-hr"><span class="dzfs-metric-label">/ hr</span><span class="dzfs-metric-val">—</span><div class="dzfs-quota-track"><div class="dzfs-quota-fill" style="width:0%;"></div></div></div>
                            <div class="dzfs-quota-pill" id="dzfs-qp-day"><span class="dzfs-metric-label">/ day</span><span class="dzfs-metric-val">—</span><div class="dzfs-quota-track"><div class="dzfs-quota-fill" style="width:0%;"></div></div></div>
                        </div>

                        <?php /* Error detail */ ?>
                        <p id="dzfs-err-detail" style="display:none;margin:8px 0 0;font-size:11px;color:#fca5a5;background:rgba(239,68,68,0.1);border-radius:8px;padding:8px 12px;border:1px solid rgba(239,68,68,0.2);line-height:1.5;"></p>

                    </div><?php /* /.dzfs-sync-progress-card */ ?>

                    <?php /* Idle hint — hidden once a sync has run */ ?>
                    <p id="dzfs-idle-hint" style="margin:12px 0 0;font-size:12px;color:#64748b;<?php echo $show_last_summary ? 'display:none;' : ''; ?>">
                        No sync has run yet. Click <strong>Start Sync</strong> to download geo data and fee tables from Yalidine. Uses your SaaS API credentials and respects Yalidine&rsquo;s rate limits automatically.
                    </p>

                    <?php /* Last-sync summary (PHP-rendered static block) */ ?>
                    <?php if ($show_last_summary) : ?>
                    <div id="dzfs-last-sync" style="margin-top:14px;padding-top:14px;border-top:1px solid #e2e8f0;">
                        <p style="font-size:12px;font-weight:600;color:#475569;margin:0 0 6px;">
                            <?php if ($has_local_data): ?>
                            Last successful sync: <span style="font-weight:400;"><?php echo esc_html($sync_last_success); ?></span>
                            <?php else: ?>
                            No successful sync completed yet.
                            <?php endif; ?>
                        </p>
                        <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:6px;">
                            <div class="dzfs-last-pill"><strong><?php echo esc_html((string) $sync_rows_wilayas); ?></strong><span>Wilayas</span></div>
                            <div class="dzfs-last-pill"><strong><?php echo esc_html((string) $sync_rows_communes); ?></strong><span>Communes</span></div>
                            <div class="dzfs-last-pill"><strong><?php echo esc_html((string) $sync_rows_offices); ?></strong><span>Offices</span></div>
                            <div class="dzfs-last-pill"><strong><?php echo esc_html((string) $sync_rows_centers); ?></strong><span>Centers</span></div>
                            <div class="dzfs-last-pill"><strong><?php echo esc_html((string) $sync_rows_fees); ?></strong><span>Fees</span></div>
                        </div>
                        <?php if ($sync_has_failed && $sync_last_error !== '') : ?>
                        <p style="margin:8px 0 0;font-size:11px;color:#dc2626;">Last error: <?php echo esc_html($sync_last_error); ?></p>
                        <?php endif; ?>
                    </div>
                    <?php endif; ?>

                </div><?php /* /#dzfs-sync-panel */ ?>

                <div class="dzfs-settings-card">
                    <h2>Setup state</h2>
                    <ul class="dzfs-summary-list dzfs-summary-list--stacked">
                        <li><strong>Onboarding:</strong> <?php echo esc_html(DZFS_Helpers::onboarding_completed() ? 'Complete' : 'Pending'); ?></li>
                        <li><strong>Provider:</strong> <?php echo esc_html(DZFS_Helpers::delivery_provider() !== '' ? DZFS_Helpers::delivery_provider() : 'Not set'); ?></li>
                        <li><strong>API key:</strong> <?php echo esc_html(DZFS_Helpers::api_key() !== '' ? 'Stored securely' : 'Missing'); ?></li>
                        <li><strong>Departure center:</strong> <?php echo esc_html(DZFS_Helpers::yalidine_departure_center_name() !== '' ? DZFS_Helpers::yalidine_departure_center_name() : 'Not set'); ?></li>
                    </ul>
                    <p><a class="button" href="<?php echo esc_url(admin_url('admin.php?page=dz-fraud-shield')); ?>">Open wizard dashboard</a></p>
                </div>
            </div>
        </div>
        <?php
    }
}
