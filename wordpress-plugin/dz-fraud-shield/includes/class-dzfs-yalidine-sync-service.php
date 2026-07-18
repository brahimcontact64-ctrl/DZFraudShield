<?php

if (!defined('ABSPATH')) {
    exit;
}

class DZFS_Yalidine_Sync_Service {
    const CRON_HOOK = 'dzfs_yalidine_daily_sync';

    // Minimum completeness thresholds for Phase 2 validation.
    // If downloaded counts fall below these values the entire sync is aborted
    // and the existing local database is preserved unchanged.
    const MIN_WILAYAS          = 50; // Algeria has 58; tolerate a few missing
    const MIN_COMMUNES         = 500; // Algeria has ~1541; catch catastrophically short responses
    const MIN_FEE_DESTINATIONS = 40; // 58 destinations; tolerate up to 18 failures

    private $api;
    private $repository;

    // Live-progress mode: set true before calling run_sync() via run_sync_live().
    private $progress_mode = false;
    private $live_cache    = null; // in-memory mirror of dzfs_sync_live option

    public function __construct($api = null, $repository = null) {
        $this->api        = $api        ?: new DZFS_API_Client();
        $this->repository = $repository ?: new DZFS_Local_Delivery_Repository();
    }

    /**
     * Runs Yalidine synchronization in three strict phases:
     *
     *  PHASE 1 — COLLECT: downloads everything into PHP memory. Nothing is
     *  written to the database. Any critical download failure returns early
     *  and the DB is left completely untouched.
     *
     *  PHASE 2 — VALIDATE: checks every dataset against minimum thresholds.
     *  If any check fails the sync aborts; the DB remains untouched.
     *
     *  PHASE 3 — COMMIT: writes all collected, validated data to the DB.
     *  Geo tables use non-destructive upserts. Fees use replace_fees_atomic()
     *  which wraps DELETE+INSERT in a MySQL transaction, so either all new
     *  rows are written or the previous rows are preserved unchanged.
     *
     * Row-count options reflect the LAST SUCCESSFUL sync throughout. They are
     * never reset to 0 at the start of a new attempt, so the admin panel always
     * shows real data even when the most recent sync attempt failed.
     */
    public function run_sync($source = 'manual', $force = false) {
        $started_at = current_time('mysql');
        $is_force   = (bool) $force;

        $result = array(
            'source'      => sanitize_text_field((string) $source),
            'startedAt'   => $started_at,
            'completedAt' => '',
            'status'      => 'failed',
            'error'       => '',
            'rowsWilayas' => 0,
            'rowsCommunes'=> 0,
            'rowsOffices' => 0,
            'rowsCenters' => 0,
            'rowsFees'    => 0,
            'feesStats'   => array(),
        );

        // Mark as running — intentionally DOES NOT touch the row-count options.
        // Those hold the last-successful-sync counts and must stay visible on the
        // admin panel while a new attempt is in progress.
        $this->set_metadata(array(
            'dzfs_yalidine_sync_last_started_at' => $started_at,
            'dzfs_yalidine_sync_last_status'     => 'running',
            'dzfs_yalidine_sync_last_error'      => '',
        ));

        // Initialise live progress option when running in background mode.
        if ($this->progress_mode) {
            $this->init_live_status();
        }

        // ═══════════════════════════════════════════════════════════════
        //  PHASE 1 — COLLECT: download everything into PHP memory.
        //  Zero DB writes happen in this phase.
        // ═══════════════════════════════════════════════════════════════

        // 1a. Base delivery cache — provides the wilaya list.
        $base_cache = $this->api->get_delivery_cache('', $is_force);

        if (is_wp_error($base_cache) || !is_array($base_cache)) {
            $message = is_wp_error($base_cache) ? $base_cache->get_error_message() : 'Invalid base delivery cache response.';
            return $this->finalize_failed_sync($result, $message);
        }

        $normalized_wilayas = $this->normalize_wilayas(isset($base_cache['wilayas']) ? $base_cache['wilayas'] : array());

        if (empty($normalized_wilayas)) {
            if (!$is_force) {
                return $this->finalize_failed_sync($result, 'No cached Yalidine data found. Please click Synchronize.');
            }
            return $this->finalize_failed_sync($result, 'No wilaya data returned from Yalidine cache.');
        }

        // Signal geo phase with total count.
        if ($this->progress_mode) {
            $this->update_live_status(array(
                'stage'        => 'syncing_geo',
                'geo_total'    => count($normalized_wilayas),
                'heartbeat_ts' => time(),
            ));
        }

        // 1b. Per-wilaya caches — communes, offices, departure centers.
        $normalized_communes = array();
        $normalized_offices  = array();
        $normalized_centers  = array();
        $geo_step            = 0;

        foreach ($normalized_wilayas as $wilaya) {
            $wilaya_id = isset($wilaya['id']) ? (int) $wilaya['id'] : 0;
            if ($wilaya_id <= 0) {
                continue;
            }

            $wilaya_cache = $this->api->get_delivery_cache((string) $wilaya_id, $is_force);
            if (is_wp_error($wilaya_cache) || !is_array($wilaya_cache)) {
                // Tolerate per-wilaya failures; validation in Phase 2 will
                // reject the dataset if too many are missing.
                $geo_step++;
                if ($this->progress_mode) {
                    $this->update_live_status(array('geo_step' => $geo_step, 'heartbeat_ts' => time()));
                }
                continue;
            }

            foreach ($this->normalize_communes(isset($wilaya_cache['communes']) ? $wilaya_cache['communes'] : array(), $wilaya_id) as $c) {
                $normalized_communes[$c['id']] = $c;
            }
            foreach ($this->normalize_offices(isset($wilaya_cache['offices']) ? $wilaya_cache['offices'] : array(), $wilaya_id) as $o) {
                $normalized_offices[$o['office_id']] = $o;
            }
            foreach ($this->normalize_departure_centers(isset($wilaya_cache['offices']) ? $wilaya_cache['offices'] : array(), $wilaya_id) as $ctr) {
                $normalized_centers[$ctr['id']] = $ctr;
            }

            $geo_step++;
            if ($this->progress_mode) {
                // Check for cancellation request between geo wilaya calls.
                if ($this->is_cancelled()) {
                    return $this->finalize_cancelled_sync($result);
                }
                $this->update_live_status(array('geo_step' => $geo_step, 'heartbeat_ts' => time()));
            }
        }

        // 1c. Fees for the configured departure center (if any).
        $selected_center_id     = trim((string) DZFS_Helpers::yalidine_departure_center_id());
        $selected_center_exists = $selected_center_id === '' || isset($normalized_centers[$selected_center_id]);

        $normalized_fees  = array();
        $fees_stats       = array();
        $fees_error       = '';
        $origin_wilaya_id = 0;
        $fees_required    = false;

        // Check for cancellation before the fees call (which may block for 30-120 s).
        if ($this->progress_mode) {
            if ($this->is_cancelled()) {
                return $this->finalize_cancelled_sync($result);
            }
            $this->update_live_status(array('stage' => 'syncing_fees', 'heartbeat_ts' => time()));
        }

        if ($selected_center_id !== '' && $selected_center_exists && isset($normalized_centers[$selected_center_id])) {
            $center_meta      = $normalized_centers[$selected_center_id];
            $origin_wilaya_id = isset($center_meta['wilaya_id']) ? (int) $center_meta['wilaya_id'] : 0;

            error_log(sprintf(
                '[DZFS fees_sync] center_id=%s origin_wilaya_id=%d center_name=%s',
                $selected_center_id,
                $origin_wilaya_id,
                isset($center_meta['name']) ? $center_meta['name'] : '(none)'
            ));

            if ($origin_wilaya_id > 0) {
                $fees_required = true;
                $fees_payload  = array(
                    'originWilayaId'    => (string) $origin_wilaya_id,
                    'departureCenterId' => $selected_center_id,
                    'centerName'        => isset($center_meta['name']) ? (string) $center_meta['name'] : null,
                );
                $fees_url = DZFS_Helpers::api_base_url() . '/api/v1/plugin/sync-fees';

                error_log(sprintf(
                    '[DZFS fees_sync] POST %s payload=%s',
                    $fees_url,
                    wp_json_encode($fees_payload)
                ));

                $fees_response = $this->api->sync_fees($fees_payload);

                // Log HTTP-level outcome.
                if (is_wp_error($fees_response)) {
                    error_log(sprintf(
                        '[DZFS fees_sync] WP_Error code=%s message=%s',
                        $fees_response->get_error_code(),
                        $fees_response->get_error_message()
                    ));
                } else {
                    $http_status  = isset($fees_response['_http_status']) ? (int) $fees_response['_http_status'] : 200;
                    $fees_ok_flag = !empty($fees_response['ok']);
                    $fee_rows_raw = (isset($fees_response['fees']) && is_array($fees_response['fees'])) ? $fees_response['fees'] : array();
                    $stats_raw    = (isset($fees_response['stats']) && is_array($fees_response['stats'])) ? $fees_response['stats'] : array();

                    error_log(sprintf(
                        '[DZFS fees_sync] HTTP %d ok=%s fee_rows_count=%d stats=%s',
                        $http_status,
                        $fees_ok_flag ? 'true' : 'false',
                        count($fee_rows_raw),
                        wp_json_encode($stats_raw)
                    ));

                    // Log the structure of the first row so we can see the field names.
                    if (!empty($fee_rows_raw)) {
                        $first_row = $fee_rows_raw[0];
                        error_log(sprintf(
                            '[DZFS fees_sync] first_row keys=%s sample=%s',
                            implode(',', array_keys($first_row)),
                            wp_json_encode($first_row)
                        ));

                        // Count wilaya-level rows (destination_commune_id null/0) vs commune-level rows.
                        $wilaya_level_count  = 0;
                        $commune_level_count = 0;
                        foreach ($fee_rows_raw as $r) {
                            if (!is_array($r)) { continue; }
                            $cid = isset($r['destination_commune_id']) ? $r['destination_commune_id'] : null;
                            if ($cid === null || $cid === '' || (int) $cid === 0) {
                                $wilaya_level_count++;
                            } else {
                                $commune_level_count++;
                            }
                        }
                        error_log(sprintf(
                            '[DZFS fees_sync] row breakdown: wilaya_level=%d commune_level=%d',
                            $wilaya_level_count,
                            $commune_level_count
                        ));
                    }
                }

                if (is_array($fees_response) && isset($fees_response['stats']) && is_array($fees_response['stats'])) {
                    $fees_stats = $fees_response['stats'];
                }

                $fees_ok = !is_wp_error($fees_response)
                    && is_array($fees_response)
                    && !empty($fees_response['ok'])
                    && isset($fees_response['fees'])
                    && is_array($fees_response['fees'])
                    && count($fees_response['fees']) > 0;

                if ($fees_ok) {
                    $normalized_fees = $fees_response['fees'];

                    // Persist rate-limit stats from the fees response into live status.
                    if ($this->progress_mode && !empty($fees_stats)) {
                        $qr = isset($fees_stats['quota_remaining']) && is_array($fees_stats['quota_remaining'])
                            ? $fees_stats['quota_remaining'] : array();
                        $this->update_live_status(array(
                            'pauses'    => isset($fees_stats['rate_limit_pauses'])         ? (int) $fees_stats['rate_limit_pauses']         : 0,
                            'pause_ms'  => isset($fees_stats['rate_limit_pause_total_ms']) ? (int) $fees_stats['rate_limit_pause_total_ms'] : 0,
                            'retries'   => isset($fees_stats['retried_requests'])          ? (int) $fees_stats['retried_requests']          : 0,
                            'quota_sec' => isset($qr['second']) && $qr['second'] !== null  ? (int) $qr['second'] : null,
                            'quota_min' => isset($qr['minute']) && $qr['minute'] !== null  ? (int) $qr['minute'] : null,
                            'quota_hr'  => isset($qr['hour'])   && $qr['hour']   !== null  ? (int) $qr['hour']   : null,
                            'quota_day' => isset($qr['day'])    && $qr['day']    !== null  ? (int) $qr['day']    : null,
                            'heartbeat_ts' => time(),
                        ));
                    }

                    $failed_count = isset($fees_stats['failed_requests']) ? (int) $fees_stats['failed_requests'] : 0;
                    if ($failed_count > 0) {
                        $fees_error = sprintf(
                            'Fees partially synced: %d of %d destinations failed. Checkout pricing may be incomplete for affected wilayas.',
                            $failed_count,
                            isset($fees_stats['total_requests']) ? (int) $fees_stats['total_requests'] : 58
                        );
                        error_log('DZFS yalidine_fees_partial_sync: ' . $fees_error);
                    }
                } else {
                    $error_msg = is_wp_error($fees_response)
                        ? $fees_response->get_error_message()
                        : (is_array($fees_response) && !empty($fees_response['error'])
                            ? (string) $fees_response['error']
                            : 'Fees sync returned an unexpected response.');
                    error_log('DZFS yalidine_fees_download_failed: ' . $error_msg);
                    // Fees are required when a center is configured. Abort the
                    // entire sync — geo data is also NOT written.
                    return $this->finalize_failed_sync($result, 'Fees download failed: ' . $error_msg);
                }
            }
        }

        // ═══════════════════════════════════════════════════════════════
        //  PHASE 2 — VALIDATE: check every dataset against thresholds.
        //  Any failure aborts the sync; the DB is still untouched.
        // ═══════════════════════════════════════════════════════════════

        // The sync-fees endpoint reads from the SaaS DB cache and always returns
        // successful_requests=0 in its stats (it is not a live Yalidine API poller).
        // Using that field would make the destination count always 0 and fail
        // validation. Count the actual distinct destination wilayas from the
        // received fee rows instead.
        $successful_destinations = $this->count_distinct_destination_wilayas($normalized_fees);

        error_log(sprintf(
            '[DZFS fees_validation] fees_required=%s normalized_fees_count=%d ' .
            'stats_successful_requests=%s distinct_destination_wilayas=%d ' .
            'min_required=%d',
            $fees_required ? 'true' : 'false',
            count($normalized_fees),
            isset($fees_stats['successful_requests']) ? (string) $fees_stats['successful_requests'] : '(not set)',
            $successful_destinations,
            self::MIN_FEE_DESTINATIONS
        ));

        $validation_error = $this->validate_collected_data(
            $normalized_wilayas,
            $normalized_communes,
            $fees_required,
            count($normalized_fees),
            $successful_destinations
        );
        if ($validation_error !== '') {
            error_log('[DZFS fees_validation] FAILED: ' . $validation_error);
            return $this->finalize_failed_sync($result, $validation_error);
        }

        error_log('[DZFS fees_validation] PASSED');

        // ═══════════════════════════════════════════════════════════════
        //  PHASE 3 — COMMIT: write all validated data to the database.
        //
        //  Geo tables use INSERT ON DUPLICATE KEY UPDATE — non-destructive;
        //  any previous rows that are not in the new dataset remain intact.
        //  Fees use replace_fees_atomic() which wraps DELETE+INSERT in a
        //  MySQL transaction so either all new rows are written or the old
        //  rows survive unchanged.
        // ═══════════════════════════════════════════════════════════════

        if ($this->progress_mode) {
            $this->update_live_status(array('stage' => 'committing', 'heartbeat_ts' => time()));
        }

        $rows_wilayas  = $this->repository->upsert_wilayas(array_values($normalized_wilayas));
        $rows_communes = $this->repository->upsert_communes(array_values($normalized_communes));
        $rows_offices  = $this->repository->upsert_offices(array_values($normalized_offices));
        $rows_centers  = $this->persist_departure_centers($normalized_centers);

        // Center attention check (only touches WP options, never fee/geo rows).
        if ($selected_center_id !== '' && !$selected_center_exists) {
            $this->mark_departure_center_attention(
                $selected_center_id,
                'The selected Yalidine departure center is no longer available. Please choose a new departure center.'
            );
            $result['attentionRequired'] = true;
            $result['attentionMessage']  = 'The selected Yalidine departure center is no longer available. Please choose a new departure center.';
        } else {
            $this->clear_departure_center_attention();
            $result['attentionRequired'] = false;
            $result['attentionMessage']  = '';
        }

        // Atomic fee replacement.
        $rows_fees = 0;
        if (!empty($normalized_fees) && $origin_wilaya_id > 0) {
            error_log(sprintf(
                '[DZFS fees_db_write] replace_fees_atomic: origin_wilaya_id=%d rows_to_write=%d',
                $origin_wilaya_id,
                count($normalized_fees)
            ));
            $fees_write = $this->repository->replace_fees_atomic($normalized_fees, $origin_wilaya_id);
            if ($fees_write === false) {
                // Transaction rolled back — old fee rows are preserved.
                $fees_error = 'Fees database write failed (transaction rolled back). Previous fee data retained.';
                error_log('[DZFS fees_db_write] replace_fees_atomic ROLLED BACK for origin=' . $origin_wilaya_id);
            } else {
                $rows_fees = (int) $fees_write;
                error_log(sprintf('[DZFS fees_db_write] replace_fees_atomic OK: rows_written=%d', $rows_fees));
                if (!empty($fees_stats)) {
                    $fees_stats['fees_rows_stored'] = $rows_fees;
                }
            }
        } else {
            error_log(sprintf(
                '[DZFS fees_db_write] skipped: normalized_fees_empty=%s origin_wilaya_id=%d',
                empty($normalized_fees) ? 'true' : 'false',
                $origin_wilaya_id
            ));
        }

        // ═══════════════════════════════════════════════════════════════
        //  FINALIZE
        // ═══════════════════════════════════════════════════════════════

        $completed_at = current_time('mysql');

        // fees_sync_failed: center configured, we had fees from API, but the DB
        // write failed (transaction rolled back). Geo commit succeeded.
        $fees_write_failed = ($fees_error !== '' && $rows_fees === 0 && $selected_center_id !== '' && !empty($normalized_fees));
        $final_status      = $fees_write_failed ? 'fees_sync_failed' : 'success';

        if (!empty($fees_stats)) {
            update_option('dzfs_yalidine_last_fees_stats', $fees_stats, false);
        } else {
            delete_option('dzfs_yalidine_last_fees_stats');
        }

        $result['completedAt']  = $completed_at;
        $result['status']       = $final_status;
        $result['rowsWilayas']  = (int) $rows_wilayas;
        $result['rowsCommunes'] = (int) $rows_communes;
        $result['rowsOffices']  = (int) $rows_offices;
        $result['rowsCenters']  = (int) $rows_centers;
        $result['rowsFees']     = (int) $rows_fees;
        $result['feesStats']    = $fees_stats;
        if ($fees_error !== '') {
            $result['feesError'] = $fees_error;
        }

        // Persist sync outcome and update "last success" snapshot.
        // Row-count options are ONLY written here on success — never at sync start.
        $this->set_metadata(array(
            'dzfs_yalidine_sync_last_completed_at' => $completed_at,
            'dzfs_yalidine_sync_last_success_at'   => $completed_at,
            'dzfs_yalidine_sync_last_status'        => $final_status,
            'dzfs_yalidine_sync_last_error'         => $fees_error,
            'dzfs_yalidine_sync_rows_wilayas'       => (int) $rows_wilayas,
            'dzfs_yalidine_sync_rows_communes'      => (int) $rows_communes,
            'dzfs_yalidine_sync_rows_offices'       => (int) $rows_offices,
            'dzfs_yalidine_sync_rows_centers'       => (int) $rows_centers,
            'dzfs_yalidine_sync_rows_fees'          => (int) $rows_fees,
        ));

        if ($this->progress_mode) {
            $this->update_live_status(array(
                'status'       => $final_status,
                'stage'        => 'done',
                'heartbeat_ts' => time(),
            ));
        }

        return $result;
    }

    // ── Live-progress public entry point ──────────────────────────────────────

    /**
     * Identical to run_sync() but writes per-step progress to the
     * dzfs_sync_live WP option so the admin UI can poll for live updates.
     * Called by the AJAX background handler.
     */
    public function run_sync_live() {
        $this->progress_mode = true;
        $this->live_cache    = null;
        return $this->run_sync('manual_admin', true);
    }

    // ── Live-progress helpers (no-ops when progress_mode is false) ─────────────

    private function init_live_status() {
        $status = array(
            'status'           => 'running',
            'stage'            => 'starting',
            'started_ts'       => time(),   // UTC Unix timestamp for JS elapsed calculation
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
        );
        $this->live_cache = $status;
        update_option('dzfs_sync_live', $status, false);
    }

    private function update_live_status(array $delta) {
        if (!$this->progress_mode) {
            return;
        }
        if ($this->live_cache === null) {
            $this->live_cache = (array) get_option('dzfs_sync_live', array());
        }
        $merged = array_merge($this->live_cache, $delta);
        $this->live_cache = $merged;
        update_option('dzfs_sync_live', $merged, false);
    }

    // Re-reads from DB so the cancel flag set by the AJAX stop handler is seen.
    private function is_cancelled() {
        $live = (array) get_option('dzfs_sync_live', array());
        return !empty($live['cancel_requested']);
    }

    private function finalize_cancelled_sync($result) {
        $completed_at     = current_time('mysql');
        $result['status'] = 'cancelled';
        $result['error']  = 'Sync cancelled by user.';
        $this->set_metadata(array(
            'dzfs_yalidine_sync_last_status'       => 'cancelled',
            'dzfs_yalidine_sync_last_error'        => '',
            'dzfs_yalidine_sync_last_completed_at' => $completed_at,
        ));
        $this->update_live_status(array(
            'status'       => 'cancelled',
            'stage'        => 'done',
            'heartbeat_ts' => time(),
        ));
        return $result;
    }

    // ── Validation ────────────────────────────────────────────────────────────

    /**
     * Validates that every collected dataset meets minimum completeness thresholds.
     *
     * Returns a non-empty error string if validation fails (caller aborts the sync),
     * or '' if all checks pass (caller proceeds to Phase 3 commit).
     */
    private function validate_collected_data($wilayas, $communes, $fees_required, $fees_row_count, $fees_destination_count) {
        $wilaya_count  = count($wilayas);
        $commune_count = count($communes);

        if ($wilaya_count < self::MIN_WILAYAS) {
            return sprintf(
                'Data validation failed: only %d wilayas downloaded (minimum %d required). Keeping previous local database.',
                $wilaya_count,
                self::MIN_WILAYAS
            );
        }

        if ($commune_count < self::MIN_COMMUNES) {
            return sprintf(
                'Data validation failed: only %d communes downloaded (minimum %d required). Keeping previous local database.',
                $commune_count,
                self::MIN_COMMUNES
            );
        }

        if ($fees_required && $fees_row_count === 0) {
            return 'Data validation failed: no fee rows received for the configured departure center. Keeping previous local database.';
        }

        if ($fees_required && $fees_destination_count < self::MIN_FEE_DESTINATIONS) {
            return sprintf(
                'Data validation failed: fees received for only %d of 58 destination wilayas (minimum %d required). Keeping previous local database.',
                $fees_destination_count,
                self::MIN_FEE_DESTINATIONS
            );
        }

        return '';
    }

    /**
     * Counts the number of distinct destination wilayas covered by a fee row set.
     *
     * Counts every row that has a valid destination_wilaya_id — both wilaya-level
     * rows (destination_commune_id null/""/0) and commune-level rows count equally.
     * The validation question is "how many wilayas do we have fee coverage for",
     * not "how many have a wilaya-level aggregate row", so commune-only coverage
     * is valid.
     *
     * The previous version only counted wilaya-level rows (commune null/0).
     * That was wrong in the fallback path (merchant delivery_prices) which stores
     * only commune-level rows (commune_id non-null), making the count always 0.
     */
    private function count_distinct_destination_wilayas($fee_rows) {
        $wilayas = array();
        foreach ($fee_rows as $row) {
            if (!is_array($row)) {
                continue;
            }
            $wilaya = isset($row['destination_wilaya_id']) ? (int) $row['destination_wilaya_id'] : 0;
            if ($wilaya > 0) {
                $wilayas[$wilaya] = true;
            }
        }
        return count($wilayas);
    }

    /**
     * Records a sync failure without touching any data rows.
     *
     * Row-count options are intentionally left unchanged so the admin panel
     * keeps showing the last successful sync's counts even after a failure.
     * Includes lastSuccessAt in the result so callers can surface it in
     * admin notices.
     */
    private function finalize_failed_sync($result, $message) {
        $message             = sanitize_text_field((string) $message);
        $result['status']    = 'failed';
        $result['error']     = $message;
        $result['feesStats'] = array();
        $result['lastSuccessAt'] = (string) get_option('dzfs_yalidine_sync_last_success_at', '');

        // Intentionally leave dzfs_yalidine_last_fees_stats untouched so the
        // admin panel continues displaying the last successful fees statistics.

        $this->set_metadata(array(
            'dzfs_yalidine_sync_last_status'       => 'failed',
            'dzfs_yalidine_sync_last_error'        => $message,
            'dzfs_yalidine_sync_last_completed_at' => current_time('mysql'),
        ));

        $this->update_live_status(array(
            'status'       => 'failed',
            'stage'        => 'done',
            'error'        => $message,
            'heartbeat_ts' => time(),
        ));

        return $result;
    }

    private function set_metadata($pairs) {
        if (!is_array($pairs)) {
            return;
        }
        foreach ($pairs as $key => $value) {
            update_option(sanitize_key((string) $key), $value, false);
        }
    }

    private function normalize_wilayas($raw_wilayas) {
        $normalized = array();
        if (!is_array($raw_wilayas)) {
            return $normalized;
        }

        foreach ($raw_wilayas as $row) {
            if (!is_array($row)) {
                continue;
            }

            $id = isset($row['wilaya_id']) ? (int) $row['wilaya_id'] : (isset($row['id']) ? (int) $row['id'] : 0);
            $name = isset($row['wilaya_name']) ? sanitize_text_field((string) $row['wilaya_name']) : (isset($row['name']) ? sanitize_text_field((string) $row['name']) : '');

            if ($id <= 0 || $name === '') {
                continue;
            }

            $normalized[$id] = array(
                'id' => $id,
                'name' => $name,
                'zone' => isset($row['zone']) ? sanitize_text_field((string) $row['zone']) : null,
            );
        }

        return $normalized;
    }

    private function normalize_communes($raw_communes, $fallback_wilaya_id = 0) {
        $normalized = array();
        if (!is_array($raw_communes)) {
            return $normalized;
        }

        foreach ($raw_communes as $row) {
            if (!is_array($row)) {
                continue;
            }

            $id = isset($row['commune_id']) ? (int) $row['commune_id'] : (isset($row['id']) ? (int) $row['id'] : 0);
            $wilaya_id = isset($row['wilaya_id']) ? (int) $row['wilaya_id'] : (isset($row['wilayaId']) ? (int) $row['wilayaId'] : (int) $fallback_wilaya_id);
            $name = isset($row['commune_name']) ? sanitize_text_field((string) $row['commune_name']) : (isset($row['name']) ? sanitize_text_field((string) $row['name']) : '');

            if ($id <= 0 || $wilaya_id <= 0 || $name === '') {
                continue;
            }

            $normalized[$id] = array(
                'id' => $id,
                'wilaya_id' => $wilaya_id,
                'name' => $name,
                'has_stop_desk' => isset($row['has_stop_desk']) ? (bool) $row['has_stop_desk'] : false,
                'is_deliverable' => isset($row['is_deliverable']) ? (bool) $row['is_deliverable'] : true,
                'delivery_time_parcel' => isset($row['delivery_time_parcel']) && is_numeric($row['delivery_time_parcel']) ? (int) $row['delivery_time_parcel'] : null,
                'delivery_time_payment' => isset($row['delivery_time_payment']) && is_numeric($row['delivery_time_payment']) ? (int) $row['delivery_time_payment'] : null,
            );
        }

        return $normalized;
    }

    private function normalize_offices($raw_offices, $fallback_wilaya_id = 0) {
        $normalized = array();
        if (!is_array($raw_offices)) {
            return $normalized;
        }

        foreach ($raw_offices as $row) {
            if (!is_array($row)) {
                continue;
            }

            $office_id = isset($row['office_id']) ? (int) $row['office_id'] : (isset($row['id']) ? (int) $row['id'] : 0);
            $wilaya_id = isset($row['wilaya_id']) ? (int) $row['wilaya_id'] : (isset($row['wilayaId']) ? (int) $row['wilayaId'] : (int) $fallback_wilaya_id);
            $commune_id = isset($row['commune_id']) ? (int) $row['commune_id'] : (isset($row['communeId']) ? (int) $row['communeId'] : 0);
            $office_name = isset($row['office_name']) ? sanitize_text_field((string) $row['office_name']) : (isset($row['name']) ? sanitize_text_field((string) $row['name']) : '');

            if ($office_id <= 0 || $wilaya_id <= 0 || $commune_id <= 0 || $office_name === '') {
                continue;
            }

            $normalized[$office_id] = array(
                'office_id' => $office_id,
                'wilaya_id' => $wilaya_id,
                'commune_id' => $commune_id,
                'office_name' => $office_name,
                'address' => isset($row['address']) ? sanitize_text_field((string) $row['address']) : null,
            );
        }

        return $normalized;
    }

    private function normalize_departure_centers($raw_offices, $fallback_wilaya_id = 0) {
        $normalized = array();
        if (!is_array($raw_offices)) {
            return $normalized;
        }

        foreach ($raw_offices as $row) {
            if (!is_array($row)) {
                continue;
            }

            $office_id = isset($row['office_id']) ? (int) $row['office_id'] : (isset($row['id']) ? (int) $row['id'] : 0);
            $wilaya_id = isset($row['wilaya_id']) ? (int) $row['wilaya_id'] : (isset($row['wilayaId']) ? (int) $row['wilayaId'] : (int) $fallback_wilaya_id);
            $office_name = isset($row['office_name']) ? sanitize_text_field((string) $row['office_name']) : (isset($row['name']) ? sanitize_text_field((string) $row['name']) : '');

            if ($office_id <= 0 || $wilaya_id <= 0 || $office_name === '') {
                continue;
            }

            $normalized[$office_id] = array(
                'id' => (string) $office_id,
                'name' => $office_name,
                'wilaya_id' => $wilaya_id,
                'wilaya_name' => isset($row['wilaya_name']) ? sanitize_text_field((string) $row['wilaya_name']) : '',
            );
        }

        return $normalized;
    }

    private function clear_departure_center_attention() {
        update_option('dzfs_yalidine_center_requires_attention', 'no', false);
        update_option('dzfs_yalidine_center_attention_message', '', false);
        update_option('dzfs_provider_connection_status', 'connected', false);
        update_option('dzfs_provider_connected', 'yes', false);
    }

    private function mark_departure_center_attention($center_id, $message) {
        $center_id = sanitize_text_field((string) $center_id);
        $message = sanitize_text_field((string) $message);

        update_option('dzfs_yalidine_center_requires_attention', 'yes', false);
        update_option('dzfs_yalidine_center_attention_message', $message !== '' ? $message : 'The selected Yalidine departure center is no longer available. Please choose a new departure center.', false);
        update_option('dzfs_provider_connection_status', 'requires_attention', false);
        update_option('dzfs_provider_connected', 'no', false);

        if ($center_id !== '') {
            update_option('dzfs_yalidine_missing_center_id', $center_id, false);
        }
    }

    private function persist_departure_centers($centers) {
        if (!is_array($centers) || empty($centers)) {
            return 0;
        }

        $sorted = array_values($centers);
        usort($sorted, function ($a, $b) {
            return strcmp((string) ($a['name'] ?? ''), (string) ($b['name'] ?? ''));
        });

        return (int) $this->repository->upsert_departure_centers($sorted);
    }

    public static function register_wp_cli_command() {
        if (!class_exists('WP_CLI')) {
            return;
        }

        if (class_exists('DZFS_WP_CLI_Yalidine_Sync_Command')) {
            WP_CLI::add_command('dzfs yalidine-sync', 'DZFS_WP_CLI_Yalidine_Sync_Command');
        }
    }
}

if (defined('WP_CLI') && WP_CLI) {
    class DZFS_WP_CLI_Yalidine_Sync_Command {
        public function __invoke($args, $assoc_args) {
            $force = !empty($assoc_args['force']);
            $service = new DZFS_Yalidine_Sync_Service();
            $result = $service->run_sync('wp_cli', $force);
            WP_CLI::success('Sync completed. Status: ' . ($result['status'] ?? 'unknown'));
            WP_CLI::line('Wilayas: ' . ($result['rowsWilayas'] ?? 0));
            WP_CLI::line('Communes: ' . ($result['rowsCommunes'] ?? 0));
            WP_CLI::line('Offices: ' . ($result['rowsOffices'] ?? 0));
            WP_CLI::line('Centers: ' . ($result['rowsCenters'] ?? 0));
            WP_CLI::line('Fees: ' . ($result['rowsFees'] ?? 0));
        }
    }
}
