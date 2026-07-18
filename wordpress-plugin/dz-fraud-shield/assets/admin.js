(function ($) {
  $(document).ready(function () {
    var $providerInputs = $('input[name="dzfs_provider"]');
    var $providerPanels = $('.dzfs-provider-panel');
    var $categorySelect = $('select[name="dzfs_store_category"]');
    var $customCategoryRow = $('[data-custom-category-row]');
    var $customCategoryInput = $('input[name="dzfs_store_category_custom"]');

    function syncProviderPanels() {
      if (!$providerInputs.length || !$providerPanels.length) {
        return;
      }

      var selected = $providerInputs.filter(':checked').val();

      $providerPanels.each(function () {
        var $panel = $(this);
        var matches = $panel.data('provider') === selected;
        $panel.toggle(matches);
        $panel.find('input, select, textarea, button').prop('disabled', !matches);
      });
    }

    $(document).on('change', 'input[name="dzfs_provider"]', syncProviderPanels);
    syncProviderPanels();

    function syncCustomCategoryField() {
      if (!$categorySelect.length || !$customCategoryRow.length || !$customCategoryInput.length) {
        return;
      }

      var isOther = $categorySelect.val() === 'Other';
      $customCategoryRow.toggle(isOther);
      $customCategoryInput.prop('required', isOther);

      if (!isOther) {
        $customCategoryInput.val('');
      }
    }

    $(document).on('change', 'select[name="dzfs_store_category"]', syncCustomCategoryField);
    syncCustomCategoryField();
  });
})(jQuery);

/* ── Yalidine Live Sync Panel ─────────────────────────────────────────────── */
(function () {
    'use strict';

    var ajaxUrl   = (typeof dzfsData !== 'undefined' && dzfsData.ajaxUrl)   ? dzfsData.ajaxUrl   : '';
    var syncNonce = (typeof dzfsData !== 'undefined' && dzfsData.syncNonce) ? dzfsData.syncNonce : '';

    if (!ajaxUrl || !document.getElementById('dzfs-sync-panel')) {
        return;
    }

    // ── DOM refs ──────────────────────────────────────────────────────────────
    var panel        = document.getElementById('dzfs-sync-panel');
    var btnStart     = document.getElementById('dzfs-btn-start');
    var btnStop      = document.getElementById('dzfs-btn-stop');
    var btnStopping  = document.getElementById('dzfs-btn-stopping');
    var startError   = document.getElementById('dzfs-start-error');
    var progressCard = document.getElementById('dzfs-sync-progress');
    var badge        = document.getElementById('dzfs-sync-badge');
    var stageLabel   = document.getElementById('dzfs-stage-label');
    var timingEl     = document.getElementById('dzfs-timing');
    var waitBanner   = document.getElementById('dzfs-wait-banner');
    var waitText     = document.getElementById('dzfs-wait-text');
    var progressWrap = document.getElementById('dzfs-progress-wrap');
    var geoDone      = document.getElementById('dzfs-geo-done');
    var geoTotal     = document.getElementById('dzfs-geo-total');
    var progressPct  = document.getElementById('dzfs-progress-pct');
    var progressFill = document.getElementById('dzfs-progress-fill');
    var geoSpinner   = document.getElementById('dzfs-geo-spinner');
    var spinnerLabel = document.getElementById('dzfs-spinner-label');
    var mWilayas     = document.getElementById('dzfs-m-wilayas');
    var mCommunes    = document.getElementById('dzfs-m-communes');
    var mOffices     = document.getElementById('dzfs-m-offices');
    var mCenters     = document.getElementById('dzfs-m-centers');
    var mFees        = document.getElementById('dzfs-m-fees');
    var apPauses     = document.getElementById('dzfs-ap-pauses');
    var apWait       = document.getElementById('dzfs-ap-wait');
    var apRetries    = document.getElementById('dzfs-ap-retries');
    var qpSec        = document.getElementById('dzfs-qp-sec');
    var qpMin        = document.getElementById('dzfs-qp-min');
    var qpHr         = document.getElementById('dzfs-qp-hr');
    var qpDay        = document.getElementById('dzfs-qp-day');
    var errDetail    = document.getElementById('dzfs-err-detail');
    var idleHint     = document.getElementById('dzfs-idle-hint');

    // ── State ─────────────────────────────────────────────────────────────────
    var pollTimer    = null;
    var tickTimer    = null;
    var startedMs    = 0;
    var stopping     = false;

    // Badge label + class map.
    var badgeMap = {
        idle:      { label: 'Idle',      cls: 'dzfs-badge--idle'      },
        running:   { label: 'Running',   cls: 'dzfs-badge--running'   },
        waiting:   { label: 'Waiting',   cls: 'dzfs-badge--waiting'   },
        success:   { label: 'Success',   cls: 'dzfs-badge--success'   },
        failed:    { label: 'Failed',    cls: 'dzfs-badge--failed'    },
        cancelled: { label: 'Cancelled', cls: 'dzfs-badge--cancelled' },
    };

    function setBadge(key) {
        var info = badgeMap[key] || badgeMap['idle'];
        badge.textContent = info.label;
        badge.className = 'dzfs-sync-badge ' + info.cls;
    }

    function show(el)  { if (el) el.style.display = ''; }
    function hide(el)  { if (el) el.style.display = 'none'; }
    function setHtml(el, html) { if (el) el.innerHTML = html; }
    function setText(el, txt)  { if (el) el.textContent = txt; }

    // ── Activity pill helper ───────────────────────────────────────────────────
    function renderActivityPill(pill, label, valText, isActive) {
        if (!pill) return;
        var span = pill.querySelectorAll('span');
        if (span[0]) span[0].textContent = label;
        if (span[1]) span[1].textContent = valText;
        if (isActive) {
            pill.classList.add('is-active');
        } else {
            pill.classList.remove('is-active');
        }
    }

    // Max quota values (Yalidine defaults).
    var QUOTA_MAX = { sec: 10, min: 300, hr: 5000, day: 50000 };

    function renderQuotaPill(pill, label, val, maxVal) {
        if (!pill) return;
        var spans = pill.querySelectorAll('span');
        var bar   = pill.querySelector('.dzfs-quota-fill');
        if (spans[0]) spans[0].textContent = label;
        if (val === null || val === undefined) {
            if (spans[1]) spans[1].textContent = '—';
            if (bar)      bar.style.width = '0%';
            pill.classList.remove('is-exhausted', 'is-low');
            return;
        }
        var n = parseInt(val, 10);
        if (spans[1]) spans[1].textContent = String(n);
        var pct = maxVal > 0 ? Math.max(0, Math.min(100, (n / maxVal) * 100)) : 0;
        if (bar) bar.style.width = pct.toFixed(1) + '%';
        pill.classList.toggle('is-exhausted', n === 0);
        pill.classList.toggle('is-low',       n > 0 && pct < 20);
    }

    function fmtMs(ms) {
        var s = Math.round(ms / 1000);
        if (s < 60)  return s + 's';
        var m = Math.floor(s / 60); s = s % 60;
        return m + 'm ' + s + 's';
    }

    function stageText(live) {
        var stage   = live.stage  || 'starting';
        var step    = live.geo_step  || 0;
        var total   = live.geo_total || 58;
        switch (stage) {
            case 'starting':     return 'Starting sync…';
            case 'syncing_geo':  return step > 0
                ? 'Syncing geography — wilaya ' + step + ' of ' + total
                : 'Syncing geography…';
            case 'syncing_fees': return 'Downloading fee tables…';
            case 'committing':   return 'Committing to local database…';
            case 'done':
                if (live.status === 'success')   return 'Sync completed successfully.';
                if (live.status === 'failed')     return 'Sync failed.';
                if (live.status === 'cancelled')  return 'Sync cancelled.';
                return 'Done.';
            default:             return stage.replace(/_/g, ' ');
        }
    }

    // ── Tick (elapsed / ETA) ──────────────────────────────────────────────────
    function tick() {
        if (!startedMs) return;
        var elapsedMs  = Date.now() - startedMs;
        var elapsedStr = fmtMs(elapsedMs);
        if (timingEl) timingEl.textContent = 'Elapsed: ' + elapsedStr;
    }

    function startTick(ts) {
        startedMs = ts ? ts * 1000 : Date.now();
        clearInterval(tickTimer);
        tickTimer = setInterval(tick, 1000);
        tick();
    }

    function stopTick() {
        clearInterval(tickTimer);
        tickTimer = null;
    }

    // ── Render ────────────────────────────────────────────────────────────────
    function render(data) {
        var live       = data.live        || {};
        var rows       = data.rows        || {};
        var status     = live.status      || 'idle';
        var isRunning  = status === 'running';
        var isDone     = status === 'success' || status === 'failed' || status === 'cancelled';
        var isWaiting  = isRunning && !stopping &&
                         (live.quota_sec === 0 || live.quota_min === 0 || live.quota_hr === 0);

        // Badge.
        if      (isWaiting)         setBadge('waiting');
        else if (isRunning)         setBadge('running');
        else if (status === 'success')   setBadge('success');
        else if (status === 'failed')    setBadge('failed');
        else if (status === 'cancelled') setBadge('cancelled');
        else                             setBadge('idle');

        // Buttons.
        var showStop     = isRunning && !stopping;
        var showStopping = isRunning && stopping;
        btnStart.style.display    = (!isRunning) ? '' : 'none';
        btnStop.style.display     = showStop     ? '' : 'none';
        btnStopping.style.display = showStopping ? '' : 'none';
        btnStart.disabled         = false;

        // Show progress card if running or done (not idle/never).
        var showCard = isRunning || isDone;
        if (showCard) {
            show(progressCard);
            hide(idleHint);
        }

        if (!showCard) return;

        // Stage label.
        setText(stageLabel, stageText(live));

        // Started timestamp (set once on first running poll).
        if (isRunning && live.started_ts && !startedMs) {
            startTick(live.started_ts);
        }
        if (isDone && tickTimer) {
            stopTick();
            if (timingEl && live.started_ts) {
                timingEl.textContent = 'Total: ' + fmtMs(Date.now() - live.started_ts * 1000);
            }
        }

        // Quota-wait banner.
        if (isWaiting) {
            show(waitBanner);
            var whichQuota = '';
            if (live.quota_sec === 0) whichQuota = '/second';
            else if (live.quota_min === 0) whichQuota = '/minute';
            else if (live.quota_hr === 0) whichQuota = '/hour';
            setText(waitText, 'Waiting for quota reset (' + whichQuota + ') — sync will resume automatically');
        } else {
            hide(waitBanner);
        }

        // Progress bar vs indeterminate spinner.
        var stage    = live.stage || 'starting';
        var geoStep  = live.geo_step  || 0;
        var geoTot   = live.geo_total || 58;
        var showBar  = (stage === 'syncing_geo') && geoStep > 0;
        var showSpin = (stage === 'starting' || stage === 'syncing_fees' || stage === 'committing') ||
                       (stage === 'syncing_geo' && geoStep === 0);

        if (showBar) {
            show(progressWrap);
            hide(geoSpinner);
            setText(geoDone, String(geoStep));
            setText(geoTotal, String(geoTot));
            var pct = geoTot > 0 ? Math.min(100, (geoStep / geoTot) * 100) : 0;
            setText(progressPct, Math.round(pct) + '%');
            if (progressFill) progressFill.style.width = pct.toFixed(1) + '%';
        } else if (showSpin && isRunning) {
            hide(progressWrap);
            show(geoSpinner);
            var spinMsg = stage === 'syncing_fees' ? 'Downloading fee tables via SaaS sync engine…'
                        : stage === 'committing'   ? 'Committing data to local database…'
                        : 'Fetching geo data via SaaS sync engine…';
            setText(spinnerLabel, spinMsg);
        } else {
            hide(progressWrap);
            hide(geoSpinner);
        }

        // Data count pills (live rows or persistent rows on done).
        var displayRows = (isDone || stage === 'done') ? rows : {
            wilayas:  0, communes: 0, offices: 0, centers: 0, fees: 0
        };
        if (isRunning && stage === 'done') displayRows = rows;
        setText(mWilayas,  rows.wilayas  ? String(rows.wilayas)  : '—');
        setText(mCommunes, rows.communes ? String(rows.communes) : '—');
        setText(mOffices,  rows.offices  ? String(rows.offices)  : '—');
        setText(mCenters,  rows.centers  ? String(rows.centers)  : '—');
        setText(mFees,     rows.fees     ? String(rows.fees)     : '—');

        // Rate-limit activity pills.
        var pauses  = live.pauses   || 0;
        var pauseMs = live.pause_ms || 0;
        var retries = live.retries  || 0;
        renderActivityPill(apPauses,  'Pauses',     String(pauses),      pauses  > 0);
        renderActivityPill(apWait,    'Total wait',  fmtMs(pauseMs),     pauseMs > 0);
        renderActivityPill(apRetries, '429 Retries', String(retries),    retries > 0);

        // Quota pills.
        renderQuotaPill(qpSec, '/ sec', live.quota_sec, QUOTA_MAX.sec);
        renderQuotaPill(qpMin, '/ min', live.quota_min, QUOTA_MAX.min);
        renderQuotaPill(qpHr,  '/ hr',  live.quota_hr,  QUOTA_MAX.hr);
        renderQuotaPill(qpDay, '/ day', live.quota_day, QUOTA_MAX.day);

        // Error detail.
        if (live.error && (status === 'failed' || status === 'cancelled')) {
            setText(errDetail, live.error);
            show(errDetail);
        } else {
            hide(errDetail);
        }
    }

    // ── Polling ───────────────────────────────────────────────────────────────
    function postAjax(action, extraBody, callback) {
        var body = new FormData();
        body.append('action', action);
        body.append('nonce', syncNonce);
        if (extraBody) {
            Object.keys(extraBody).forEach(function (k) { body.append(k, extraBody[k]); });
        }
        fetch(ajaxUrl, { method: 'POST', body: body })
            .then(function (r) { return r.json(); })
            .then(function (j) { callback(null, j); })
            .catch(function (e) { callback(e, null); });
    }

    function schedulePoll(delay) {
        clearTimeout(pollTimer);
        pollTimer = setTimeout(poll, delay || 2000);
    }

    function poll() {
        postAjax('dzfs_sync_status', {}, function (err, json) {
            if (err || !json || !json.success) {
                schedulePoll(5000);
                return;
            }
            var data   = json.data;
            var live   = data.live || {};
            var status = live.status || 'idle';
            render(data);
            if (status === 'running') {
                schedulePoll(2000);
            } else {
                // Done — stop polling, persist last-sync summary refresh.
                if (status === 'success' || status === 'failed' || status === 'cancelled') {
                    stopping = false;
                    // Refresh rows immediately from the done state.
                    if (idleHint) idleHint.style.display = 'none';
                }
            }
        });
    }

    // ── Handlers ──────────────────────────────────────────────────────────────
    function handleStart() {
        if (btnStart) btnStart.disabled = true;
        hide(startError);
        stopping  = false;
        startedMs = 0;

        postAjax('dzfs_sync_start', {}, function (err, json) {
            if (err || !json || !json.success) {
                var msg = (json && json.data) ? String(json.data) : 'Could not start sync. Please try again.';
                setText(startError, msg);
                show(startError);
                if (btnStart) btnStart.disabled = false;
                return;
            }
            // Immediately show running state, start tick + polling.
            startTick(Math.floor(Date.now() / 1000));
            render({
                live: { status: 'running', stage: 'starting', started_ts: Math.floor(Date.now() / 1000) },
                rows: {},
            });
            schedulePoll(800);
        });
    }

    function handleStop() {
        stopping = true;
        // Immediately swap buttons.
        hide(btnStop);
        show(btnStopping);
        postAjax('dzfs_sync_stop', {}, function () {
            // Keep polling — the background worker checks cancel_requested and will finish.
            schedulePoll(2000);
        });
    }

    // ── Init ──────────────────────────────────────────────────────────────────
    if (btnStart)    btnStart.addEventListener('click',   handleStart);
    if (btnStop)     btnStop.addEventListener('click',    handleStop);

    // Kick off an initial status poll to restore UI on page load if sync is running.
    poll();
})();
