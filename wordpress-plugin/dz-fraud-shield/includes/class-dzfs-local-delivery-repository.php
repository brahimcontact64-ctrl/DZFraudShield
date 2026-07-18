<?php

if (!defined('ABSPATH')) {
    exit;
}

class DZFS_Local_Delivery_Repository {
    /** @var wpdb */
    private $wpdb;

    public function __construct($wpdb_instance = null) {
        global $wpdb;
        $this->wpdb = $wpdb_instance ?: $wpdb;
    }

    public function table_wilayas() {
        return $this->wpdb->prefix . 'dzfs_wilayas';
    }

    public function table_communes() {
        return $this->wpdb->prefix . 'dzfs_communes';
    }

    public function table_offices() {
        return $this->wpdb->prefix . 'dzfs_yalidine_offices';
    }

    public function table_departure_centers() {
        return $this->wpdb->prefix . 'dzfs_departure_centers';
    }

    public function table_fees() {
        return $this->wpdb->prefix . 'dzfs_fees';
    }

    public function upsert_wilayas($wilayas) {
        if (!is_array($wilayas) || empty($wilayas)) {
            return 0;
        }

        $table = $this->table_wilayas();
        $updated_at = current_time('mysql');
        $count = 0;

        foreach ($wilayas as $wilaya) {
            if (!is_array($wilaya)) {
                continue;
            }

            $id = isset($wilaya['id']) ? (int) $wilaya['id'] : (isset($wilaya['wilaya_id']) ? (int) $wilaya['wilaya_id'] : 0);
            $name = isset($wilaya['name']) ? sanitize_text_field((string) $wilaya['name']) : (isset($wilaya['wilaya_name']) ? sanitize_text_field((string) $wilaya['wilaya_name']) : '');

            if ($id <= 0 || $name === '') {
                continue;
            }

            $zone = isset($wilaya['zone']) ? sanitize_text_field((string) $wilaya['zone']) : null;

            $result = $this->wpdb->query($this->wpdb->prepare(
                "INSERT INTO {$table} (id, name, zone, home_price, stopdesk_price, updated_at)
                 VALUES (%d, %s, %s, 0, 0, %s)
                 ON DUPLICATE KEY UPDATE
                    name = VALUES(name),
                    zone = VALUES(zone),
                    updated_at = VALUES(updated_at)",
                $id,
                $name,
                $zone,
                $updated_at
            ));

            if ($result !== false) {
                $count++;
            }
        }

        return $count;
    }

    public function upsert_communes($communes) {
        if (!is_array($communes) || empty($communes)) {
            return 0;
        }

        $table = $this->table_communes();
        $updated_at = current_time('mysql');
        $count = 0;

        foreach ($communes as $commune) {
            if (!is_array($commune)) {
                continue;
            }

            $id = isset($commune['id']) ? (int) $commune['id'] : (isset($commune['commune_id']) ? (int) $commune['commune_id'] : 0);
            $wilaya_id = isset($commune['wilaya_id']) ? (int) $commune['wilaya_id'] : (isset($commune['wilayaId']) ? (int) $commune['wilayaId'] : 0);
            $name = isset($commune['name']) ? sanitize_text_field((string) $commune['name']) : (isset($commune['commune_name']) ? sanitize_text_field((string) $commune['commune_name']) : '');

            if ($id <= 0 || $wilaya_id <= 0 || $name === '') {
                continue;
            }

            $has_stop_desk = isset($commune['has_stop_desk']) ? (int) (bool) $commune['has_stop_desk'] : 0;
            $is_deliverable = isset($commune['is_deliverable']) ? (int) (bool) $commune['is_deliverable'] : 1;
            $delivery_time_parcel = isset($commune['delivery_time_parcel']) && is_numeric($commune['delivery_time_parcel']) ? (int) $commune['delivery_time_parcel'] : null;
            $delivery_time_payment = isset($commune['delivery_time_payment']) && is_numeric($commune['delivery_time_payment']) ? (int) $commune['delivery_time_payment'] : null;

            $result = $this->wpdb->query($this->wpdb->prepare(
                "INSERT INTO {$table} (id, wilaya_id, name, has_stop_desk, is_deliverable, delivery_time_parcel, delivery_time_payment, updated_at)
                 VALUES (%d, %d, %s, %d, %d, NULLIF(%s,''), NULLIF(%s,''), %s)
                 ON DUPLICATE KEY UPDATE
                    wilaya_id = VALUES(wilaya_id),
                    name = VALUES(name),
                    has_stop_desk = VALUES(has_stop_desk),
                    is_deliverable = VALUES(is_deliverable),
                    delivery_time_parcel = VALUES(delivery_time_parcel),
                    delivery_time_payment = VALUES(delivery_time_payment),
                    updated_at = VALUES(updated_at)",
                $id,
                $wilaya_id,
                $name,
                $has_stop_desk,
                $is_deliverable,
                $delivery_time_parcel === null ? '' : (string) $delivery_time_parcel,
                $delivery_time_payment === null ? '' : (string) $delivery_time_payment,
                $updated_at
            ));

            if ($result !== false) {
                $count++;
            }
        }

        return $count;
    }

    public function upsert_offices($offices) {
        if (!is_array($offices) || empty($offices)) {
            return 0;
        }

        $table = $this->table_offices();
        $updated_at = current_time('mysql');
        $count = 0;

        foreach ($offices as $office) {
            if (!is_array($office)) {
                continue;
            }

            $office_id = isset($office['office_id']) ? (int) $office['office_id'] : (isset($office['id']) ? (int) $office['id'] : 0);
            $wilaya_id = isset($office['wilaya_id']) ? (int) $office['wilaya_id'] : (isset($office['wilayaId']) ? (int) $office['wilayaId'] : 0);
            $commune_id = isset($office['commune_id']) ? (int) $office['commune_id'] : (isset($office['communeId']) ? (int) $office['communeId'] : 0);
            $office_name = isset($office['office_name']) ? sanitize_text_field((string) $office['office_name']) : (isset($office['office_name_en']) ? sanitize_text_field((string) $office['office_name_en']) : '');
            $address = isset($office['address']) ? sanitize_text_field((string) $office['address']) : null;

            if ($office_id <= 0 || $wilaya_id <= 0 || $commune_id <= 0 || $office_name === '') {
                continue;
            }

            $result = $this->wpdb->query($this->wpdb->prepare(
                "INSERT INTO {$table} (office_id, wilaya_id, commune_id, office_name, address, updated_at)
                 VALUES (%d, %d, %d, %s, %s, %s)
                 ON DUPLICATE KEY UPDATE
                    wilaya_id = VALUES(wilaya_id),
                    commune_id = VALUES(commune_id),
                    office_name = VALUES(office_name),
                    address = VALUES(address),
                    updated_at = VALUES(updated_at)",
                $office_id,
                $wilaya_id,
                $commune_id,
                $office_name,
                $address,
                $updated_at
            ));

            if ($result !== false) {
                $count++;
            }
        }

        return $count;
    }

    public function upsert_departure_centers($centers) {
        if (!is_array($centers) || empty($centers)) {
            return 0;
        }

        $table = $this->table_departure_centers();
        $updated_at = current_time('mysql');
        $count = 0;

        foreach ($centers as $center) {
            if (!is_array($center)) {
                continue;
            }

            $center_id = isset($center['id']) ? sanitize_text_field((string) $center['id']) : (isset($center['center_id']) ? sanitize_text_field((string) $center['center_id']) : '');
            $wilaya_id = isset($center['wilaya_id']) ? (int) $center['wilaya_id'] : (isset($center['wilayaId']) ? (int) $center['wilayaId'] : 0);
            $commune_id = isset($center['commune_id']) ? (int) $center['commune_id'] : (isset($center['communeId']) ? (int) $center['communeId'] : 0);
            $center_name = isset($center['name']) ? sanitize_text_field((string) $center['name']) : (isset($center['center_name']) ? sanitize_text_field((string) $center['center_name']) : '');
            $address = isset($center['address']) ? sanitize_text_field((string) $center['address']) : null;

            if ($center_id === '' || $wilaya_id <= 0 || $center_name === '') {
                continue;
            }

            $result = $this->wpdb->query($this->wpdb->prepare(
                "INSERT INTO {$table} (center_id, wilaya_id, commune_id, center_name, address, home_price, stopdesk_price, updated_at)
                 VALUES (%s, %d, %d, %s, %s, 0, 0, %s)
                 ON DUPLICATE KEY UPDATE
                    wilaya_id = VALUES(wilaya_id),
                    commune_id = VALUES(commune_id),
                    center_name = VALUES(center_name),
                    address = VALUES(address),
                    updated_at = VALUES(updated_at)",
                $center_id,
                $wilaya_id,
                $commune_id,
                $center_name,
                $address,
                $updated_at
            ));

            if ($result !== false) {
                $count++;
            }
        }

        return $count;
    }

    /**
     * Upserts fee rows into wp_dzfs_fees.
     *
     * Deletes all existing rows for origin_wilaya_id before inserting so
     * the table always reflects the latest sync. This method is NOT atomic:
     * if the INSERT loop fails midway, previously deleted rows are lost.
     * Use replace_fees_atomic() for production sync operations.
     *
     * @param array $fee_rows         Fee arrays from the SaaS sync-fees response.
     * @param int   $origin_wilaya_id The merchant's origin wilaya.
     * @return int  Number of rows written.
     */
    public function upsert_fees($fee_rows, $origin_wilaya_id) {
        $origin = (int) $origin_wilaya_id;
        if (!is_array($fee_rows) || empty($fee_rows) || $origin <= 0) {
            return 0;
        }

        $table     = $this->table_fees();
        $synced_at = current_time('mysql');

        $this->wpdb->delete($table, array('origin_wilaya_id' => $origin), array('%d'));

        $count = 0;
        foreach ($fee_rows as $row) {
            if (!is_array($row)) {
                continue;
            }

            $dest_wilaya = isset($row['destination_wilaya_id']) ? (int) $row['destination_wilaya_id'] : 0;
            if ($dest_wilaya <= 0) {
                continue;
            }

            $dest_commune = 0;
            if (isset($row['destination_commune_id']) && $row['destination_commune_id'] !== null && $row['destination_commune_id'] !== '') {
                $dest_commune = (int) $row['destination_commune_id'];
            }

            $n  = function ($key) use ($row) {
                return (isset($row[$key]) && is_numeric($row[$key]) && (float) $row[$key] > 0)
                    ? number_format((float) $row[$key], 2, '.', '')
                    : '';
            };
            $nz = function ($key) use ($row) {
                return (isset($row[$key]) && is_numeric($row[$key]))
                    ? number_format((float) $row[$key], 4, '.', '')
                    : '';
            };

            $result = $this->wpdb->query($this->wpdb->prepare(
                "INSERT INTO {$table}
                    (origin_wilaya_id, destination_wilaya_id, destination_commune_id,
                     express_home, express_desk, economic_home, economic_desk,
                     retour_fee, cod_percentage, insurance_percentage, oversize_fee,
                     last_synced_at)
                 VALUES (%d, %d, %d,
                     NULLIF(%s,''), NULLIF(%s,''), NULLIF(%s,''), NULLIF(%s,''),
                     NULLIF(%s,''), NULLIF(%s,''), NULLIF(%s,''), NULLIF(%s,''),
                     %s)
                 ON DUPLICATE KEY UPDATE
                    express_home = VALUES(express_home),
                    express_desk = VALUES(express_desk),
                    economic_home = VALUES(economic_home),
                    economic_desk = VALUES(economic_desk),
                    retour_fee = VALUES(retour_fee),
                    cod_percentage = VALUES(cod_percentage),
                    insurance_percentage = VALUES(insurance_percentage),
                    oversize_fee = VALUES(oversize_fee),
                    last_synced_at = VALUES(last_synced_at)",
                $origin,
                $dest_wilaya,
                $dest_commune,
                $n('express_home'),
                $n('express_desk'),
                $n('economic_home'),
                $n('economic_desk'),
                $nz('retour_fee'),
                $nz('cod_percentage'),
                $nz('insurance_percentage'),
                $n('oversize_fee'),
                $synced_at
            ));

            if ($result !== false) {
                $count++;
            }
        }

        return $count;
    }

    /**
     * Atomically replaces ALL fees for an origin wilaya inside a MySQL transaction.
     *
     * The DELETE and the entire INSERT batch run as a single unit. If any INSERT
     * fails, the transaction is rolled back and the previous fee rows are
     * preserved exactly as they were — the local database is never left empty
     * or partially written.
     *
     * Requires InnoDB (the WordPress default since MySQL 5.5). On MyISAM,
     * the DELETE commits immediately regardless of what follows.
     *
     * @param array $fee_rows         Fee arrays from the SaaS sync-fees response.
     * @param int   $origin_wilaya_id The merchant's origin wilaya.
     * @return int|false              Row count on success; false if the transaction
     *                                was rolled back (old data still intact).
     */
    public function replace_fees_atomic($fee_rows, $origin_wilaya_id) {
        $origin = (int) $origin_wilaya_id;
        if (!is_array($fee_rows) || empty($fee_rows) || $origin <= 0) {
            return false;
        }

        $table     = $this->table_fees();
        $synced_at = current_time('mysql');

        $this->wpdb->query('START TRANSACTION');

        // Remove previous fees for this origin — inside the transaction,
        // so this DELETE is automatically undone if any INSERT below fails.
        $deleted = $this->wpdb->delete($table, array('origin_wilaya_id' => $origin), array('%d'));
        if ($deleted === false) {
            $this->wpdb->query('ROLLBACK');
            return false;
        }

        $count = 0;
        foreach ($fee_rows as $row) {
            if (!is_array($row)) {
                continue;
            }

            $dest_wilaya = isset($row['destination_wilaya_id']) ? (int) $row['destination_wilaya_id'] : 0;
            if ($dest_wilaya <= 0) {
                continue;
            }

            $dest_commune = 0;
            if (isset($row['destination_commune_id']) && $row['destination_commune_id'] !== null && $row['destination_commune_id'] !== '') {
                $dest_commune = (int) $row['destination_commune_id'];
            }

            $n  = function ($key) use ($row) {
                return (isset($row[$key]) && is_numeric($row[$key]) && (float) $row[$key] > 0)
                    ? number_format((float) $row[$key], 2, '.', '')
                    : '';
            };
            $nz = function ($key) use ($row) {
                return (isset($row[$key]) && is_numeric($row[$key]))
                    ? number_format((float) $row[$key], 4, '.', '')
                    : '';
            };

            // Pure INSERT — no ON DUPLICATE KEY because the DELETE above cleared
            // all rows for this origin; duplicates within the same batch are a
            // data error from the SaaS and we roll back rather than silently skip.
            $result = $this->wpdb->query($this->wpdb->prepare(
                "INSERT INTO {$table}
                    (origin_wilaya_id, destination_wilaya_id, destination_commune_id,
                     express_home, express_desk, economic_home, economic_desk,
                     retour_fee, cod_percentage, insurance_percentage, oversize_fee,
                     last_synced_at)
                 VALUES (%d, %d, %d,
                     NULLIF(%s,''), NULLIF(%s,''), NULLIF(%s,''), NULLIF(%s,''),
                     NULLIF(%s,''), NULLIF(%s,''), NULLIF(%s,''), NULLIF(%s,''),
                     %s)",
                $origin,
                $dest_wilaya,
                $dest_commune,
                $n('express_home'),
                $n('express_desk'),
                $n('economic_home'),
                $n('economic_desk'),
                $nz('retour_fee'),
                $nz('cod_percentage'),
                $nz('insurance_percentage'),
                $n('oversize_fee'),
                $synced_at
            ));

            if ($result === false) {
                $this->wpdb->query('ROLLBACK');
                return false;
            }

            $count++;
        }

        $this->wpdb->query('COMMIT');
        return $count;
    }

    /**
     * Returns the delivery price for a given origin→destination route.
     *
     * Priority: commune-specific row > wilaya-level row > null.
     * Price columns tried in order: express → economic (first positive wins).
     *
     * @param int    $origin_wilaya_id
     * @param int    $destination_wilaya_id
     * @param int    $destination_commune_id  0 = no commune selected
     * @param string $delivery_type           'home' or 'stopdesk'
     * @return float|null Price in DZD, or null if unavailable.
     */
    public function get_fee_price($origin_wilaya_id, $destination_wilaya_id, $destination_commune_id = 0, $delivery_type = 'home') {
        $origin = (int) $origin_wilaya_id;
        $dest = (int) $destination_wilaya_id;
        $commune = (int) $destination_commune_id;
        $is_desk = $delivery_type === 'stopdesk';

        if ($origin <= 0 || $dest <= 0) {
            return null;
        }

        $table = $this->table_fees();
        $home_col = $is_desk ? 'express_desk' : 'express_home';
        $eco_col = $is_desk ? 'economic_desk' : 'economic_home';

        // Try commune-specific row first.
        if ($commune > 0) {
            $row = $this->wpdb->get_row($this->wpdb->prepare(
                "SELECT {$home_col} AS express_price, {$eco_col} AS economic_price
                 FROM {$table}
                 WHERE origin_wilaya_id = %d
                   AND destination_wilaya_id = %d
                   AND destination_commune_id = %d
                 LIMIT 1",
                $origin, $dest, $commune
            ), ARRAY_A);

            if (is_array($row)) {
                $price = $this->first_positive_price($row['express_price'], $row['economic_price']);
                if ($price !== null) {
                    return $price;
                }
            }
        }

        // Wilaya-level fallback.
        $row = $this->wpdb->get_row($this->wpdb->prepare(
            "SELECT {$home_col} AS express_price, {$eco_col} AS economic_price
             FROM {$table}
             WHERE origin_wilaya_id = %d
               AND destination_wilaya_id = %d
               AND destination_commune_id = 0
             LIMIT 1",
            $origin, $dest
        ), ARRAY_A);

        if (!is_array($row)) {
            return null;
        }

        return $this->first_positive_price($row['express_price'], $row['economic_price']);
    }

    private function first_positive_price($express, $economic) {
        if (is_numeric($express) && (float) $express > 0) {
            return (float) $express;
        }
        if (is_numeric($economic) && (float) $economic > 0) {
            return (float) $economic;
        }
        return null;
    }

    public function get_departure_centers() {
        $table = $this->table_departure_centers();
        $rows = $this->wpdb->get_results(
            "SELECT center_id AS id, wilaya_id, commune_id, center_name AS name, address
             FROM {$table}
             ORDER BY center_name ASC",
            ARRAY_A
        );

        return is_array($rows) ? $rows : array();
    }

    public function get_departure_center_by_id($center_id) {
        $center_id = sanitize_text_field((string) $center_id);
        if ($center_id === '') {
            return null;
        }

        $table = $this->table_departure_centers();
        $row = $this->wpdb->get_row($this->wpdb->prepare(
            "SELECT center_id AS id, wilaya_id, commune_id, center_name AS name, address
             FROM {$table}
             WHERE center_id = %s
             LIMIT 1",
            $center_id
        ), ARRAY_A);

        return is_array($row) ? $row : null;
    }

    public function get_all_wilayas() {
        $table = $this->table_wilayas();
        $rows = $this->wpdb->get_results(
            "SELECT id AS wilaya_id, name AS wilaya_name
             FROM {$table}
             ORDER BY wilaya_name ASC",
            ARRAY_A
        );

        return is_array($rows) ? $rows : array();
    }

    public function get_communes_by_wilaya($wilaya_id) {
        $wilaya_id = (int) $wilaya_id;
        if ($wilaya_id <= 0) {
            return array();
        }

        $table = $this->table_communes();
        $rows = $this->wpdb->get_results($this->wpdb->prepare(
            "SELECT id AS commune_id, wilaya_id, name AS commune_name,
                    has_stop_desk, is_deliverable, delivery_time_parcel, delivery_time_payment
             FROM {$table}
             WHERE wilaya_id = %d
             ORDER BY commune_name ASC",
            $wilaya_id
        ), ARRAY_A);

        return is_array($rows) ? $rows : array();
    }

    public function get_offices_by_commune($commune_id) {
        $commune_id = (int) $commune_id;
        if ($commune_id <= 0) {
            return array();
        }

        $table = $this->table_offices();
        $rows = $this->wpdb->get_results($this->wpdb->prepare(
            "SELECT office_id, wilaya_id, commune_id, office_name, address
             FROM {$table}
             WHERE commune_id = %d
             ORDER BY office_name ASC",
            $commune_id
        ), ARRAY_A);

        return is_array($rows) ? $rows : array();
    }

    public function get_offices_by_wilaya($wilaya_id) {
        $wilaya_id = (int) $wilaya_id;
        if ($wilaya_id <= 0) {
            return array();
        }

        $table = $this->table_offices();
        $rows = $this->wpdb->get_results($this->wpdb->prepare(
            "SELECT office_id, wilaya_id, commune_id, office_name, address
             FROM {$table}
             WHERE wilaya_id = %d
             ORDER BY office_name ASC",
            $wilaya_id
        ), ARRAY_A);

        return is_array($rows) ? $rows : array();
    }
}
