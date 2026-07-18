<?php

if (!defined('ABSPATH')) {
    exit;
}

class DZFS_Risk_Display {
    public function __construct() {
        add_action('manage_shop_order_posts_custom_column', array($this, 'render_order_list_column'), 20, 2);
        add_filter('manage_edit-shop_order_columns', array($this, 'add_order_list_column'));
        add_action('woocommerce_admin_order_data_after_order_details', array($this, 'render_order_admin_meta'));
    }

    public function add_order_list_column($columns) {
        $columns['dzfs_risk'] = 'DZFS Risk';
        return $columns;
    }

    public function render_order_list_column($column, $post_id) {
        if ('dzfs_risk' !== $column) {
            return;
        }

        $decision = get_post_meta($post_id, 'dzfs_order_decision', true);
        $trust_score = get_post_meta($post_id, 'dzfs_order_trust_score', true);
        $recommendation = get_post_meta($post_id, 'dzfs_order_recommendation', true);
        $global_level = get_post_meta($post_id, 'dzfs_global_level', true);

        if (!empty($decision)) {
            $decision_label = $this->decision_label($decision);
            $color = $this->decision_color($decision);
            $parts = array(
                $decision_label . ' (' . (int) $trust_score . ')',
            );

            if (!empty($global_level)) {
                $parts[] = 'Network ' . sanitize_text_field((string) $global_level);
            }

            if (!empty($recommendation)) {
                $parts[] = $this->recommendation_label((string) $recommendation);
            }

            echo '<span class="dzfs-badge" style="background:' . esc_attr($color) . '">' . esc_html(implode(' | ', $parts)) . '</span>';
            return;
        }

        $level = get_post_meta($post_id, 'dzfs_risk_level', true);
        $score = get_post_meta($post_id, 'dzfs_risk_score', true);

        if (empty($level)) {
            echo '<span>-</span>';
            return;
        }

        $color = $this->badge_color($level);
        echo '<span class="dzfs-badge" style="background:' . esc_attr($color) . '">' . esc_html($level . ' (' . $score . ')') . '</span>';
    }

    public function render_order_admin_meta($order) {
        $order_id = $order->get_id();
        $score = get_post_meta($order_id, 'dzfs_risk_score', true);
        $level = get_post_meta($order_id, 'dzfs_risk_level', true);
        $reasons = get_post_meta($order_id, 'dzfs_risk_reasons', true);
        $checked_at = get_post_meta($order_id, 'dzfs_checked_at', true);
        $recommended_action = get_post_meta($order_id, 'dzfs_recommended_action', true);
        $normalized_phone = get_post_meta($order_id, 'dzfs_normalized_phone', true);
        $decision = get_post_meta($order_id, 'dzfs_order_decision', true);
        $trust_score = get_post_meta($order_id, 'dzfs_order_trust_score', true);
        $customer_type = get_post_meta($order_id, 'dzfs_order_customer_type', true);
        $success_rate = get_post_meta($order_id, 'dzfs_order_success_rate', true);
        $merchant_count = get_post_meta($order_id, 'dzfs_order_merchant_count', true);
        $recommendation = get_post_meta($order_id, 'dzfs_order_recommendation', true);
        $risk_factors = get_post_meta($order_id, 'dzfs_order_risk_factors', true);
        $extensions_raw = get_post_meta($order_id, 'dzfs_order_extensions', true);
        $estimated_loss = get_post_meta($order_id, 'dzfs_order_estimated_loss', true);
        $fraud_probability = get_post_meta($order_id, 'dzfs_order_fraud_probability', true);
        $network_reputation_score = get_post_meta($order_id, 'dzfs_order_network_reputation_score', true);
        $ai_recommendation = get_post_meta($order_id, 'dzfs_order_ai_recommendation', true);
        $decision_checked_at = get_post_meta($order_id, 'dzfs_order_decision_checked_at', true);
        $global_score = get_post_meta($order_id, 'dzfs_global_reputation_score', true);
        $global_total_orders = get_post_meta($order_id, 'dzfs_global_total_orders', true);
        $global_delivered_orders = get_post_meta($order_id, 'dzfs_global_delivered_orders', true);
        $global_returned_orders = get_post_meta($order_id, 'dzfs_global_returned_orders', true);
        $global_refused_orders = get_post_meta($order_id, 'dzfs_global_refused_orders', true);
        $global_merchant_count = get_post_meta($order_id, 'dzfs_global_merchant_count', true);
        $global_recommendation = get_post_meta($order_id, 'dzfs_global_recommendation', true);
        $global_level = get_post_meta($order_id, 'dzfs_global_level', true);
        $global_reasons = get_post_meta($order_id, 'dzfs_global_reasons', true);

        $extensions = json_decode((string) $extensions_raw, true);

        echo '<div class="order_data_column">';
        echo '<h3>DZ Fraud Shield</h3>';
        echo '<p><strong>Risk score:</strong> ' . esc_html($score ?: '-') . '</p>';
        echo '<p><strong>Risk level:</strong> ' . esc_html($level ?: '-') . '</p>';
        echo '<p><strong>Checked at:</strong> ' . esc_html($checked_at ?: '-') . '</p>';
        echo '<p><strong>Reasons:</strong> ' . esc_html($this->format_list($reasons)) . '</p>';
        echo '<p><strong>Recommended Action:</strong> ' . esc_html($recommended_action ?: '-') . '</p>';
        echo '<p><strong>Normalized Phone:</strong> ' . esc_html($normalized_phone ?: '-') . '</p>';

        echo '<hr />';
        echo '<h3>DZ Fraud Shield Analysis</h3>';
        echo '<p><strong>Decision:</strong> ' . esc_html($this->decision_label($decision ?: '')) . '</p>';
        echo '<p><strong>Trust Score:</strong> ' . esc_html($trust_score !== '' ? $trust_score . ' / 100' : '-') . '</p>';
        echo '<p><strong>Customer Type:</strong> ' . esc_html($customer_type ?: '-') . '</p>';
        echo '<p><strong>Success Rate:</strong> ' . esc_html($success_rate !== '' ? $success_rate . '%' : '-') . '</p>';
        echo '<p><strong>Known By Merchants:</strong> ' . esc_html($merchant_count !== '' ? $merchant_count : '-') . '</p>';
        echo '<p><strong>Risk Factors:</strong> ' . esc_html($this->format_risk_factors($risk_factors)) . '</p>';
        echo '<p><strong>Recommendation:</strong> ' . esc_html($this->recommendation_label((string) $recommendation)) . '</p>';
        echo '<p><strong>Decision Checked At:</strong> ' . esc_html($decision_checked_at ?: '-') . '</p>';

        echo '<hr />';
        echo '<h3>Network Reputation</h3>';
        echo '<p><strong>Network Level:</strong> ' . esc_html($global_level ?: '-') . '</p>';
        echo '<p><strong>Network Score:</strong> ' . esc_html($global_score !== '' ? $global_score : '-') . '</p>';
        echo '<p><strong>Total Orders:</strong> ' . esc_html($global_total_orders !== '' ? $global_total_orders : '-') . '</p>';
        echo '<p><strong>Delivered:</strong> ' . esc_html($global_delivered_orders !== '' ? $global_delivered_orders : '-') . '</p>';
        echo '<p><strong>Returned:</strong> ' . esc_html($global_returned_orders !== '' ? $global_returned_orders : '-') . '</p>';
        echo '<p><strong>Refused:</strong> ' . esc_html($global_refused_orders !== '' ? $global_refused_orders : '-') . '</p>';
        echo '<p><strong>Merchants:</strong> ' . esc_html($global_merchant_count !== '' ? $global_merchant_count : '-') . '</p>';
        echo '<p><strong>Network Recommendation:</strong> ' . esc_html($global_recommendation ?: '-') . '</p>';
        echo '<p><strong>Network Reasons:</strong> ' . esc_html($this->format_list($global_reasons)) . '</p>';

        echo '<hr />';
        echo '<h3>Fraud Intelligence Extensions</h3>';
        echo '<p><strong>Estimated Loss:</strong> ' . esc_html($this->fallback_extension($estimated_loss, $extensions, 'estimatedLoss')) . '</p>';
        echo '<p><strong>Fraud Probability:</strong> ' . esc_html($this->fallback_extension($fraud_probability, $extensions, 'fraudProbability')) . '</p>';
        echo '<p><strong>Network Reputation Score:</strong> ' . esc_html($this->fallback_extension($network_reputation_score, $extensions, 'networkReputationScore')) . '</p>';
        echo '<p><strong>AI Recommendation:</strong> ' . esc_html($this->fallback_extension($ai_recommendation, $extensions, 'aiRecommendation')) . '</p>';
        echo '</div>';
    }

    private function badge_color($level) {
        switch (strtoupper($level)) {
            case 'LOW':
                return '#16a34a';
            case 'MEDIUM':
                return '#f59e0b';
            case 'HIGH':
                return '#ea580c';
            case 'CRITICAL':
                return '#b91c1c';
            case 'BLOCK':
                return '#dc2626';
            default:
                return '#64748b';
        }
    }

    private function decision_label($decision) {
        switch (strtoupper((string) $decision)) {
            case 'SAFE_TO_SHIP':
                return '🟢 Safe To Ship';
            case 'SHIP_WITH_CAUTION':
                return '🟡 Ship With Caution';
            case 'HIGH_RISK':
                return '🔴 High Risk Customer';
            default:
                return '-';
        }
    }

    private function decision_color($decision) {
        switch (strtoupper((string) $decision)) {
            case 'SAFE_TO_SHIP':
                return '#16a34a';
            case 'SHIP_WITH_CAUTION':
                return '#f59e0b';
            case 'HIGH_RISK':
                return '#dc2626';
            default:
                return '#64748b';
        }
    }

    private function format_risk_factors($raw) {
        $decoded = json_decode((string) $raw, true);
        if (!is_array($decoded) || empty($decoded)) {
            return '-';
        }

        $mapped = array_map(function ($value) {
            return str_replace('_', ' ', strtoupper((string) $value));
        }, $decoded);

        return implode(', ', $mapped);
    }

    private function format_list($raw) {
        $decoded = json_decode((string) $raw, true);
        if (!is_array($decoded) || empty($decoded)) {
            return $raw ? (string) $raw : '-';
        }

        $mapped = array_map(function ($value) {
            return str_replace('_', ' ', strtoupper((string) $value));
        }, $decoded);

        return implode(', ', $mapped);
    }

    private function recommendation_label($recommendation) {
        switch (strtoupper((string) $recommendation)) {
            case 'PROCEED_WITH_STANDARD_SHIPPING':
                return 'Proceed With Standard Shipping';
            case 'VERIFY_BY_PHONE_BEFORE_SHIPPING':
                return 'Verify By Phone Before Shipping';
            case 'DO_NOT_SHIP_HIGH_VALUE_PRODUCTS':
                return 'Do Not Ship High Value Products';
            default:
                return $recommendation ? (string) $recommendation : '-';
        }
    }

    private function fallback_extension($direct, $extensions, $key) {
        if ($direct !== '' && $direct !== null) {
            return (string) $direct;
        }

        if (is_array($extensions) && array_key_exists($key, $extensions) && $extensions[$key] !== null && $extensions[$key] !== '') {
            return (string) $extensions[$key];
        }

        return '-';
    }
}
