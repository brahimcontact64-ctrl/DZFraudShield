<?php

if (!defined('ABSPATH')) {
    exit;
}

class DZFS_API_Client {
    private function status_snapshot_ttl_seconds() {
        $ttl = (int) apply_filters('dzfs_status_snapshot_ttl_seconds', 120);
        if ($ttl < 30) {
            $ttl = 30;
        }
        if ($ttl > 3600) {
            $ttl = 3600;
        }

        return $ttl;
    }

    private function should_refresh_status_snapshot($last_sync_at) {
        $last_sync_at = trim((string) $last_sync_at);
        if ($last_sync_at === '') {
            return true;
        }

        $last_sync_ts = strtotime($last_sync_at);
        if ($last_sync_ts === false || $last_sync_ts <= 0) {
            return true;
        }

        $now_ts = current_time('timestamp');
        if (!is_int($now_ts) || $now_ts <= 0) {
            $now_ts = time();
        }

        return ($now_ts - $last_sync_ts) >= $this->status_snapshot_ttl_seconds();
    }

    private function request_timeout_seconds() {
        $timeout = (int) apply_filters('dzfs_api_timeout_seconds', 2);
        if ($timeout < 1) {
            $timeout = 1;
        }
        if ($timeout > 8) {
            $timeout = 8;
        }

        return $timeout;
    }

    private function delivery_timeout_seconds() {
        $timeout = (int) apply_filters('dzfs_delivery_api_timeout_seconds', 8);
        if ($timeout < 1) {
            $timeout = 1;
        }
        if ($timeout > 30) {
            $timeout = 30;
        }

        return $timeout;
    }

    private function is_timeout_error($error) {
        if (!is_wp_error($error)) {
            return false;
        }

        $code = sanitize_key((string) $error->get_error_code());
        $message = strtolower((string) $error->get_error_message());

        if ($code === 'http_request_timeout') {
            return true;
        }

        if (strpos($message, 'timed out') !== false) {
            return true;
        }

        return false;
    }

    private function first_issue_message($body) {
        if (!is_array($body) || !isset($body['issues']) || !is_array($body['issues']) || empty($body['issues'][0])) {
            return '';
        }

        $first = $body['issues'][0];
        if (!is_array($first)) {
            return '';
        }

        $message = isset($first['message']) ? sanitize_text_field((string) $first['message']) : '';
        $path = '';
        if (isset($first['path']) && is_array($first['path']) && !empty($first['path'][0])) {
            $path = sanitize_text_field((string) $first['path'][0]);
        }

        if ($message === '') {
            return '';
        }

        return $path !== '' ? ('Issue at ' . $path . ': ' . $message) : $message;
    }

    private function default_status_snapshot() {
        return array(
            'valid' => false,
            'subscriptionStatus' => 'pending_payment',
            'plan' => 'none',
            'trialActive' => false,
            'trialDaysRemaining' => 0,
            'trialExpiresAt' => null,
            'subscriptionExpiresAt' => null,
            'pendingActivationCode' => null,
            'paymentPortalUrl' => DZFS_Helpers::dashboard_url() !== '' ? trailingslashit(DZFS_Helpers::dashboard_url()) . 'payments' : '',
            'hasConnectedDeliveryProvider' => false,
            'timestamp' => current_time('mysql'),
        );
    }

    private function cache_status_snapshot($payload) {
        if (!is_array($payload)) {
            return;
        }

        $snapshot = array_merge($this->default_status_snapshot(), $payload);
        update_option('dzfs_status_snapshot', $snapshot);
        update_option('dzfs_last_status_sync_at', current_time('mysql'));
    }

    public function ping() {
        $url = DZFS_Helpers::api_base_url() . '/api/v1/plugin/ping';
        $response = $this->post($url, array(
            'source' => 'woocommerce-plugin',
            'site_url' => home_url(),
            'plugin_version' => defined('DZFS_VERSION') ? DZFS_VERSION : 'unknown',
        ));

        if (!is_wp_error($response) && is_array($response)) {
            $this->cache_status_snapshot($response);
        }

        return $response;
    }

    public function get_status_snapshot($force_refresh = false) {
        $cached = get_option('dzfs_status_snapshot', array());
        $has_cached = is_array($cached) && !empty($cached);

        if ($has_cached && !$force_refresh) {
            $last_sync_at = (string) get_option('dzfs_last_status_sync_at', '');
            if (!$this->should_refresh_status_snapshot($last_sync_at)) {
                return array_merge($this->default_status_snapshot(), $cached);
            }
        }

        $ping = $this->ping();
        if (is_wp_error($ping) || !is_array($ping)) {
            if ($has_cached) {
                return array_merge($this->default_status_snapshot(), $cached);
            }
            return $this->default_status_snapshot();
        }

        return array_merge($this->default_status_snapshot(), $ping);
    }

    public function check_order($payload) {
        $url = DZFS_Helpers::api_base_url() . '/api/v1/check-order';
        return $this->post($url, $payload);
    }

    public function report_outcome($payload) {
        $url = DZFS_Helpers::api_base_url() . '/api/v1/report-outcome';
        return $this->post($url, $payload);
    }

    public function get_pending_merchant_decision_actions($limit = 30) {
        $url = DZFS_Helpers::api_base_url() . '/api/v1/plugin/merchant-decision-actions?limit=' . absint($limit);
        return $this->get($url);
    }

    public function sync_merchant_decision($payload) {
        $url = DZFS_Helpers::api_base_url() . '/api/v1/plugin/merchant-decision-sync';
        return $this->post($url, $payload);
    }

    public function get_delivery_cache($wilaya_id = '', $force_sync = false) {
        $query = array();
        if (!empty($wilaya_id)) {
            $query['wilayaId'] = sanitize_text_field((string) $wilaya_id);
        }
        if ($force_sync) {
            $query['forceSync'] = '1';
        }

        $url = DZFS_Helpers::api_base_url() . '/api/v1/plugin/delivery-cache';
        if (!empty($query)) {
            $url = add_query_arg($query, $url);
        }

        $timeout = $this->delivery_timeout_seconds();
        $response = $this->get($url, $timeout);
        if ($this->is_timeout_error($response)) {
            usleep(300000);
            return $this->get($url, $timeout);
        }

        return $response;
    }

    public function get_delivery_price($payload) {
        $url = DZFS_Helpers::api_base_url() . '/api/v1/plugin/delivery-price';
        return $this->post($url, $payload, $this->delivery_timeout_seconds());
    }

    public function sync_fees($payload) {
        $url = DZFS_Helpers::api_base_url() . '/api/v1/plugin/sync-fees';
        // sync-fees fetches Yalidine prices for all 58 wilayas at Yalidine's
        // 5 req/s rate limit — the operation takes 12–30 s. Use a dedicated
        // timeout that reflects the operation's actual duration.
        $timeout = (int) apply_filters('dzfs_fees_sync_timeout_seconds', 120);
        if ($timeout < 30) {
            $timeout = 30;
        }
        if ($timeout > 180) {
            $timeout = 180;
        }
        return $this->post($url, $payload, $timeout);
    }

    private function build_headers() {
        $api_key = DZFS_Helpers::api_key();

        return array(
            'Content-Type' => 'application/json',
            'Accept' => 'application/json',
            // Send both auth styles; SaaS accepts either Bearer or X-API-Key.
            'Authorization' => 'Bearer ' . $api_key,
            'X-API-Key' => $api_key,
        );
    }

    private function post($url, $payload, $timeout = null) {
        if (empty($url) || empty(DZFS_Helpers::api_key())) {
            return new WP_Error('dzfs_missing_config', 'DZFS API is not configured');
        }

        if ($timeout === null) {
            $timeout = $this->request_timeout_seconds();
        }

        $response = wp_remote_post($url, array(
            'headers' => $this->build_headers(),
            'timeout' => (int) $timeout,
            'body' => wp_json_encode($payload),
        ));

        if (is_wp_error($response)) {
            return $response;
        }

        $code = wp_remote_retrieve_response_code($response);
        $raw_body = wp_remote_retrieve_body($response);
        $body = json_decode($raw_body, true);
        if (!is_array($body)) {
            $body = array();
        }

        if ($code >= 400) {
            $message = isset($body['error']) ? $body['error'] : (isset($body['message']) ? $body['message'] : ('API error (' . $code . ')'));
            $issue_message = $this->first_issue_message($body);
            if ($issue_message !== '') {
                $message .= ': ' . $issue_message;
            }
            $body['_http_status'] = $code;
            return new WP_Error('dzfs_api_error', sanitize_text_field((string) $message), $body);
        }

        return $body;
    }

    private function get($url, $timeout = null) {
        if (empty($url) || empty(DZFS_Helpers::api_key())) {
            return new WP_Error('dzfs_missing_config', 'DZFS API is not configured');
        }

        if ($timeout === null) {
            $timeout = $this->request_timeout_seconds();
        }

        $response = wp_remote_get($url, array(
            'headers' => $this->build_headers(),
            'timeout' => (int) $timeout,
        ));

        if (is_wp_error($response)) {
            return $response;
        }

        $code = wp_remote_retrieve_response_code($response);
        $raw_body = wp_remote_retrieve_body($response);
        $body = json_decode($raw_body, true);
        if (!is_array($body)) {
            $body = array();
        }

        if ($code >= 400) {
            $message = isset($body['error']) ? $body['error'] : (isset($body['message']) ? $body['message'] : ('API error (' . $code . ')'));
            $issue_message = $this->first_issue_message($body);
            if ($issue_message !== '') {
                $message .= ': ' . $issue_message;
            }
            $body['_http_status'] = $code;
            return new WP_Error('dzfs_api_error', sanitize_text_field((string) $message), $body);
        }

        return $body;
    }
}
