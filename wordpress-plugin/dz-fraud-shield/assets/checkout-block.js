(function(window) {
    if (!window || !window.wp || !window.wp.plugins || !window.wp.element) {
        return;
    }

    var data = window.dzfsBlockCheckoutData || {};
    var ajaxUrl = data.ajaxUrl || "";
    var labels = data.labels || {};
    var initialWilayas = Array.isArray(data.wilayas) ? data.wilayas : [];
    var currencySymbol = data.currencySymbol || "";
    // NOTE: access blocksCheckout lazily at call-time, not at script init,
    // because window.wc.blocksCheckout may not be registered yet when this script loads.
    function getBlocksCheckout() {
        return window.wc && window.wc.blocksCheckout ? window.wc.blocksCheckout : null;
    }

    function text(key, fallback) {
        return labels[key] || fallback;
    }

    function detectTheme() {
        var className = (document.body && document.body.className ? document.body.className : "").toLowerCase();
        var htmlClass = (document.documentElement && document.documentElement.className ? document.documentElement.className : "").toLowerCase();
        var combined = className + " " + htmlClass;

        if (combined.indexOf("woodmart") > -1) return "woodmart";
        if (combined.indexOf("flatsome") > -1 || combined.indexOf("ux-") > -1) return "flatsome";
        if (combined.indexOf("astra") > -1) return "astra";
        if (combined.indexOf("kadence") > -1) return "kadence";
        if (combined.indexOf("blocksy") > -1 || combined.indexOf("ct-site") > -1) return "blocksy";
        if (combined.indexOf("storefront") > -1) return "storefront";
        if (combined.indexOf("generatepress") > -1 || combined.indexOf("gp-") > -1) return "generatepress";
        return "woo-default";
    }

    function parseAmount(raw) {
        if (typeof raw !== "string") {
            return 0;
        }

        var normalized = raw.replace(/[^0-9,.-]/g, "");
        if (!normalized) {
            return 0;
        }

        if (normalized.indexOf(",") > -1 && normalized.indexOf(".") > -1) {
            normalized = normalized.replace(/,/g, "");
        } else if (normalized.indexOf(",") > -1) {
            normalized = normalized.replace(",", ".");
        }

        var parsed = parseFloat(normalized);
        return isNaN(parsed) ? 0 : parsed;
    }

    function normalizeCheckoutSummaryLabels() {
        var containers = document.querySelectorAll([
            ".wc-block-components-totals-wrapper",
            ".wc-block-components-order-summary",
            ".wc-block-components-checkout-order-summary",
            ".wc-block-checkout__sidebar",
            ".wc-block-components-sidebar",
            ".wc-block-checkout__shipping-method",
            ".wp-block-woocommerce-checkout-order-summary-totals-block"
        ].join(","));

        var replacements = {
            "Subtotal": text("productTotal", "Product Total"),
            "Home Delivery": text("delivery", "Delivery"),
            "Stop Desk Delivery": text("delivery", "Delivery"),
            "StopDesk Delivery": text("delivery", "Delivery"),
            "Select DZFS delivery option": text("delivery", "Delivery")
        };

        containers.forEach(function(container) {
            var nodes = container.querySelectorAll("*");
            nodes.forEach(function(node) {
                if (node.children && node.children.length > 0) {
                    return;
                }
                var raw = node.textContent || "";
                var label = raw.trim();
                if (!label || !Object.prototype.hasOwnProperty.call(replacements, label)) {
                    return;
                }
                node.textContent = replacements[label];
            });
        });
    }

    var DZFS_CACHE_TTL_MS = 30 * 60 * 1000;
    var DZFS_PREFETCH_LIMIT = 10;
    var DZFS_DOM_THROTTLE_MS = 120;
    var dzfsPendingRequests = {};
    var dzfsLastCartUpdateSignature = "";
    var dzfsAddressHideObserver = null;
    var dzfsAddressHideScheduled = false;
    var dzfsLastHideRunAt = 0;
    var dzfsPriceRefreshInFlight = false;
    var dzfsPendingPriceRefreshReason = "";
    var dzfsLastSuccessfulDeliveryPayload = null;
    var dzfsDeliveryCacheHardError = false;
    var DZFS_STALE_MESSAGE = "Delivery data is being refreshed. Please try again in a moment.";
    var DZFS_UI_SYNC_MAX_ATTEMPTS = 3;
    var DZFS_UI_SYNC_RETRY_DELAYS_MS = [150, 300, 600];
    var dzfsStoreLabelSyncUnsubscribe = null;
    var dzfsStoreLabelSyncSignature = "";
    var DZFS_LAST_SELECTION_KEY = "dzfs_last_selection_v1";
    var dzfsConfirmedShippingByKey = {};
    var dzfsPendingConfirmedRepairKey = "";
    var dzfsActiveRefreshToken = 0;
    var dzfsAuthoritativeSelection = {
        deliveryType: "home",
        wilayaId: "",
        communeId: "",
        officeId: "",
        key: "home|||",
        updatedAt: 0
    };
    var dzfsResolvedCommitState = {
        deliveryType: "home",
        wilayaId: "",
        communeId: "",
        officeId: "",
        resolvedPrice: 0
    };
    var dzfsRuntimeState = {
        getSelection: null,
        syncTotals: null
    };
    var dzfsTraceSeq = 0;
    var STALE_REFRESH_ABORTED = {
        status: "STALE_REFRESH_ABORTED"
    };

    function dzfsStackSource() {
        try {
            var stack = new Error().stack || "";
            var lines = String(stack).split("\n").map(function(line) {
                return String(line || "").trim();
            }).filter(Boolean);
            return lines.length > 2 ? lines[2] : (lines.length > 0 ? lines[lines.length - 1] : "");
        } catch (error) {
            return "";
        }
    }

    function dzfsTrace(eventName, payload) {
        dzfsTraceSeq += 1;
        var message = {
            seq: dzfsTraceSeq,
            ts: Date.now(),
            iso: new Date().toISOString(),
            event: eventName
        };
        Object.keys(payload || {}).forEach(function(key) {
            message[key] = payload[key];
        });
        console.log("DZFS_TRACE", message);
    }

    function amountsMatch(actual, expected) {
        return !isNaN(actual) && !isNaN(expected) && Math.abs(Number(actual) - Number(expected)) < 0.001;
    }

    function isStaleAbort(result) {
        return !!(result && typeof result === "object" && result.status === "STALE_REFRESH_ABORTED");
    }

    function getSessionStorage() {
        try {
            return window.sessionStorage || null;
        } catch (error) {
            return null;
        }
    }

    function readCachedJSON(key) {
        var storage = getSessionStorage();
        if (!storage) {
            return null;
        }

        try {
            var raw = storage.getItem(key);
            if (!raw) {
                return null;
            }

            var payload = JSON.parse(raw);
            if (!payload || typeof payload !== "object") {
                return null;
            }

            if (payload.expiresAt && payload.expiresAt < Date.now()) {
                storage.removeItem(key);
                return null;
            }

            if (Object.prototype.hasOwnProperty.call(payload, "value")) {
                return payload.value;
            }

            return null;
        } catch (error) {
            return null;
        }
    }

    function writeCachedJSON(key, value, ttlMs) {
        var storage = getSessionStorage();
        if (!storage) {
            return;
        }

        try {
            storage.setItem(key, JSON.stringify({
                expiresAt: Date.now() + (ttlMs || DZFS_CACHE_TTL_MS),
                value: value
            }));
        } catch (error) {
        }
    }

    function getCachedDeliveryKey(wilayaId) {
        return "dzfs_geo_delivery_" + String(wilayaId || "");
    }

    function getCachedPriceKey(deliveryType, wilayaId, communeId, officeId) {
        return "dzfs_price_" + String(deliveryType || "home") + "[" + String(wilayaId || "") + "][" + String(communeId || "") + "]_" + String(officeId || "");
    }

    function hasSuccessfulPriceForKey(key) {
        if (!key) {
            return false;
        }

        var cachedPrice = readCachedJSON(key);
        return typeof cachedPrice === "number"
            && !isNaN(cachedPrice)
            && cachedPrice > 0;
    }

    function readLastSelection() {
        var storage = getSessionStorage();
        if (!storage) {
            return null;
        }
        try {
            var raw = storage.getItem(DZFS_LAST_SELECTION_KEY);
            if (!raw) {
                return null;
            }
            var parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== "object") {
                return null;
            }
            return {
                deliveryType: parsed.deliveryType === "stopdesk" ? "stopdesk" : "home",
                wilayaId: parsed.wilayaId ? String(parsed.wilayaId) : "",
                communeId: parsed.communeId ? String(parsed.communeId) : "",
                officeId: parsed.officeId ? String(parsed.officeId) : ""
            };
        } catch (error) {
            return null;
        }
    }

    function writeLastSelection(selection) {
        var storage = getSessionStorage();
        if (!storage) {
            return;
        }
        try {
            var normalized = selection && typeof selection === "object" ? selection : {};
            storage.setItem(DZFS_LAST_SELECTION_KEY, JSON.stringify({
                deliveryType: normalized.deliveryType === "stopdesk" ? "stopdesk" : "home",
                wilayaId: normalized.wilayaId ? String(normalized.wilayaId) : "",
                communeId: normalized.communeId ? String(normalized.communeId) : "",
                officeId: normalized.officeId ? String(normalized.officeId) : "",
                ts: Date.now()
            }));
        } catch (error) {
        }
    }

    function dedupeRequest(key, factory) {
        if (dzfsPendingRequests[key]) {
            dzfsTrace("DEDUPE_REQUEST_REUSE_PENDING", {
                key: key,
                stackSource: dzfsStackSource()
            });
            return dzfsPendingRequests[key];
        }

        var request = Promise.resolve().then(factory).then(function(result) {
            delete dzfsPendingRequests[key];
            return result;
        }, function(error) {
            delete dzfsPendingRequests[key];
            throw error;
        });

        dzfsPendingRequests[key] = request;
        return request;
    }

    function normalizeDeliveryPayload(payload) {
        return {
            provider: payload && payload.provider ? String(payload.provider) : "yalidine",
            communes: payload && Array.isArray(payload.communes) ? payload.communes : [],
            offices: payload && Array.isArray(payload.offices) ? payload.offices : []
        };
    }

    function setGroupLoading(node, loading) {
        if (!node) {
            return;
        }

        node.classList.toggle("is-loading", !!loading);
        node.setAttribute("aria-busy", loading ? "true" : "false");
    }

    function readWilayaLabels(list) {
        return (list || []).slice(0, DZFS_PREFETCH_LIMIT).map(function(item) {
            return item && item.wilaya_id ? String(item.wilaya_id) : "";
        }).filter(function(value) {
            return value !== "";
        });
    }

    // Set a native DOM input/select value in a React-compatible way and dispatch events.
    var dzfsSyncingNativeFields = false;
    var dzfsIgnoreNativeChangesUntil = 0;

    function setNativeFieldValue(selectors, value) {
        var i, el;
        for (i = 0; i < selectors.length; i++) {
            el = document.querySelector(selectors[i]);
            if (!el) continue;
            var nextValue = value == null ? "" : String(value);
            if (String(el.value || "") === nextValue) {
                return;
            }
            var proto = el.tagName === "SELECT"
                ? window.HTMLSelectElement.prototype
                : window.HTMLInputElement.prototype;
            var descriptor = Object.getOwnPropertyDescriptor(proto, "value");
            dzfsSyncingNativeFields = true;
            dzfsIgnoreNativeChangesUntil = Date.now() + 350;
            if (descriptor && descriptor.set) {
                descriptor.set.call(el, nextValue);
            } else {
                el.value = nextValue;
            }
            el.dispatchEvent(new Event("input",  { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            dzfsSyncingNativeFields = false;
            return; // only set first matched field
        }
    }

    // Find the WooCommerce shipping-state select option value (e.g. "DZ-16") that
    // matches the given Algerian wilaya name (e.g. "Alger").
    function findStateCodeForWilayaName(wilayaName) {
        var stateEl = document.querySelector("#shipping-state")
            || document.querySelector("#shipping_state")
            || document.querySelector("select[name='shipping_state']");
        if (!stateEl || !wilayaName || stateEl.tagName !== "SELECT" || !stateEl.options || typeof stateEl.options.length !== "number") {
            return "";
        }
        var norm = wilayaName.toLowerCase().replace(/[^a-z0-9]/g, "");
        var i;
        for (i = 0; i < stateEl.options.length; i++) {
            var optNorm = (stateEl.options[i].textContent || "").toLowerCase().replace(/[^a-z0-9]/g, "");
            if (optNorm && optNorm === norm) return stateEl.options[i].value;
        }
        return "";
    }

    function readProductTotal() {
        var subtotalNode = document.querySelector(".wc-block-components-totals-item.wc-block-components-totals-item__subtotal .wc-block-components-totals-item__value")
            || document.querySelector(".wc-block-components-totals-wrapper .wc-block-components-totals-item__value");
        return subtotalNode ? parseAmount(subtotalNode.textContent || "") : 0;
    }

    function applyThemeTokens(wrapper, target) {
        var source = target || document.body;
        var sourceStyle = window.getComputedStyle(source);
        var buttonNode = document.querySelector(".wc-block-components-button")
            || document.querySelector(".wp-element-button")
            || document.querySelector(".button.checkout-button")
            || document.querySelector(".button");
        var buttonStyle = buttonNode ? window.getComputedStyle(buttonNode) : null;
        var inputNode = document.querySelector(".wc-block-components-text-input input")
            || document.querySelector(".woocommerce-checkout input[type='text']")
            || document.querySelector("input[type='text']");
        var inputStyle = inputNode ? window.getComputedStyle(inputNode) : null;

        // Resolve CSS custom properties from the theme (read from root/body).
        var rootStyle = window.getComputedStyle(document.documentElement);
        function readVar(varName, fallback) {
            var val = rootStyle.getPropertyValue(varName).trim();
            if (!val) val = sourceStyle.getPropertyValue(varName).trim();
            return val || fallback;
        }

        // Primary colour: try theme-specific vars before falling back to button bg.
        var primaryColor = readVar("--ast-color-link", "")
            || readVar("--global-palette1", "")
            || readVar("--theme-link-initial-color", "")
            || readVar("--color-primary", "")
            || readVar("--wd-main-color", "")
            || (buttonStyle && buttonStyle.backgroundColor)
            || sourceStyle.color
            || "currentColor";

        var borderColor = readVar("--ast-border-color", "")
            || readVar("--global-gray-400", "")
            || readVar("--theme-border-color", "")
            || readVar("--wd-border-color", "")
            || (inputStyle && inputStyle.borderColor)
            || "rgba(0,0,0,.12)";

        var borderRadius = readVar("--ast-input-radius", "")
            || readVar("--kbp-global-border-radius", "")
            || readVar("--theme-button-border-radius", "")
            || readVar("--wd-btn-radius", "")
            || (inputStyle && inputStyle.borderRadius)
            || "8px";

        wrapper.style.setProperty("--dzfs-font-family", sourceStyle.fontFamily || "inherit");
        wrapper.style.setProperty("--dzfs-text-color", sourceStyle.color || "inherit");
        wrapper.style.setProperty("--dzfs-muted-color", sourceStyle.color || "#666");
        wrapper.style.setProperty("--dzfs-bg", sourceStyle.backgroundColor || "#fff");
        wrapper.style.setProperty("--dzfs-border", borderColor);
        wrapper.style.setProperty("--dzfs-radius", borderRadius);
        wrapper.style.setProperty("--dzfs-primary", primaryColor);
        wrapper.style.setProperty("--dzfs-shadow", (buttonStyle && buttonStyle.boxShadow) || "none");
    }

    function makeOption(value, labelText) {
        var option = document.createElement("option");
        option.value = value;
        option.textContent = labelText;
        return option;
    }

    function fillSelect(selectEl, items, valueKey, labelKey, placeholder) {
        var current = selectEl.value;
        selectEl.innerHTML = "";
        selectEl.appendChild(makeOption("", placeholder));

        (items || []).forEach(function(item) {
            if (!item || !item[valueKey] || !item[labelKey]) {
                return;
            }
            selectEl.appendChild(makeOption(String(item[valueKey]), String(item[labelKey])));
        });

        if (current) {
            selectEl.value = current;
        }
    }

    function markPlaceholder(selectEl, placeholder) {
        if (!selectEl) {
            return;
        }

        selectEl.innerHTML = "";
        selectEl.appendChild(makeOption("", placeholder));
    }

    function pickFirstValue(selectors) {
        var i;
        for (i = 0; i < selectors.length; i += 1) {
            var el = document.querySelector(selectors[i]);
            if (el && typeof el.value === "string" && el.value.trim() !== "") {
                return el.value.trim();
            }
        }
        return "";
    }

    function pickSelectedText(selectors) {
        var i;
        for (i = 0; i < selectors.length; i += 1) {
            var el = document.querySelector(selectors[i]);
            if (el && el.tagName === "SELECT" && el.selectedIndex >= 0) {
                var opt = el.options[el.selectedIndex];
                if (opt && opt.textContent && opt.textContent.trim() !== "") {
                    return opt.textContent.trim();
                }
            }
        }
        return "";
    }

    function selectedLabel(selectEl) {
        if (!selectEl || selectEl.selectedIndex < 0) {
            return "";
        }

        var option = selectEl.options[selectEl.selectedIndex];
        if (!option || !option.value) {
            return "";
        }

        return (option.textContent || "").trim();
    }

    function setIfEmpty(selectors, value) {
        if (!value) {
            return;
        }

        if (pickFirstValue(selectors)) {
            return;
        }

        setNativeFieldValue(selectors, value);
    }

    function getNativeShippingStateValue() {
        return pickFirstValue([
            "#shipping-state",
            "#shipping_state",
            "select[name='shipping_state']",
            "select[name='shipping-state']",
            "#billing-state",
            "#billing_state",
            "select[name='billing_state']"
        ]);
    }

    function getNativeShippingStateLabel() {
        return pickSelectedText([
            "#shipping-state",
            "#shipping_state",
            "select[name='shipping_state']",
            "select[name='shipping-state']",
            "#billing-state",
            "#billing_state",
            "select[name='billing_state']"
        ]);
    }

    function getNativeShippingCity() {
        return pickFirstValue([
            "#shipping-city",
            "#shipping_city",
            "input[name='shipping_city']",
            "#billing-city",
            "#billing_city",
            "input[name='billing_city']"
        ]);
    }

    function getNativeShippingAddress1() {
        return pickFirstValue([
            "#shipping-address_1",
            "#shipping_address_1",
            "input[name='shipping_address_1']",
            "#billing-address_1",
            "#billing_address_1",
            "input[name='billing_address_1']"
        ]);
    }

    function ensureStopdeskAddressPlaceholder() {
        [
            "#shipping-address_1",
            "#shipping_address_1",
            "input[name='shipping_address_1']",
            "#billing-address_1",
            "#billing_address_1",
            "input[name='billing_address_1']"
        ].forEach(function(selector) {
            var el = document.querySelector(selector);
            if (el && typeof el.value === "string" && el.value.trim() === "") {
                el.value = "Stop Desk Pickup";
                el.dispatchEvent(new Event("change", { bubbles: true }));
                el.dispatchEvent(new Event("input", { bubbles: true }));
            }
        });
    }

    function resolveLocalWilayaPrice(deliveryType, wilayaId) {
        var normalizedType = deliveryType === "stopdesk" ? "stopdesk" : "home";
        var targetWilaya = String(wilayaId || "");
        var rows = readCachedJSON("dzfs_wilayas_all");
        if (!Array.isArray(rows) || !rows.length) {
            rows = Array.isArray(initialWilayas) ? initialWilayas : [];
        }

        var i;
        for (i = 0; i < rows.length; i += 1) {
            var row = rows[i] || {};
            if (String(row.wilaya_id || "") !== targetWilaya) {
                continue;
            }

            var raw = normalizedType === "stopdesk" ? row.stopdesk_price : row.home_price;
            var parsed = Number(raw || 0);
            if (!isFinite(parsed)) {
                return null;
            }
            return Math.max(0, parsed);
        }

        return null;
    }

    function findLocalWilayaRow(wilayaId) {
        var targetWilaya = String(wilayaId || "");
        var rows = readCachedJSON("dzfs_wilayas_all");
        if (!Array.isArray(rows) || !rows.length) {
            rows = Array.isArray(initialWilayas) ? initialWilayas : [];
        }

        var i;
        for (i = 0; i < rows.length; i += 1) {
            if (String((rows[i] || {}).wilaya_id || "") === targetWilaya) {
                return rows[i] || null;
            }
        }

        return null;
    }

    function readLocalDeliveryPayloadByWilaya(wilayaId) {
        var targetWilaya = String(wilayaId || "");
        if (!targetWilaya) {
            return { communes: [], offices: [] };
        }
        var payload = readCachedJSON(getCachedDeliveryKey(targetWilaya));
        if (!payload || typeof payload !== "object") {
            return { communes: [], offices: [] };
        }
        return normalizeDeliveryPayload(payload);
    }

    function findRowById(rows, key, value) {
        var targetValue = String(value || "");
        var i;
        for (i = 0; i < (rows || []).length; i += 1) {
            var row = rows[i] || {};
            if (String(row[key] || "") === targetValue) {
                return row;
            }
        }
        return null;
    }

    function buildLocalSelection() {
        var _wilayaField = (typeof wilaya !== "undefined" && wilaya && wilaya.field)
            ? wilaya.field
            : document.getElementById("dzfs_block_delivery_wilaya");
        var _communeField = (typeof commune !== "undefined" && commune && commune.field)
            ? commune.field
            : document.getElementById("dzfs_block_delivery_commune");
        var _officeField = (typeof office !== "undefined" && office && office.field)
            ? office.field
            : document.getElementById("dzfs_block_delivery_stopdesk");
        var resolvedDeliveryType = (typeof deliveryType !== "undefined")
            ? (deliveryType === "stopdesk" ? "stopdesk" : "home")
            : (dzfsAuthoritativeSelection && dzfsAuthoritativeSelection.deliveryType === "stopdesk" ? "stopdesk" : "home");
        var selection = {
            deliveryType: resolvedDeliveryType,
            wilayaId: _wilayaField && _wilayaField.value ? String(_wilayaField.value) : "",
            communeId: _communeField && _communeField.value ? String(_communeField.value) : "",
            officeId: _officeField && _officeField.value ? String(_officeField.value) : ""
        };
        if (selection.officeId) {
            selection.deliveryType = "stopdesk";
        }
        selection.key = [selection.deliveryType, selection.wilayaId, selection.communeId, selection.officeId].join("|");
        dzfsTrace("DZFS_LOCAL_SELECTION_BUILT", {
            deliveryType: selection.deliveryType,
            wilayaId: selection.wilayaId,
            communeId: selection.communeId,
            officeId: selection.officeId,
            key: selection.key
        });
        return selection;
    }

    function clearInvalidOfficeSelection() {
        if (office.field) {
            office.field.value = "";
        }
        persistCurrentSelection();
        updateAuthoritativeSelection();
    }

    function validateLocalSelection(selection) {
        var currentSelection = selection || buildLocalSelection();
        var wilayaRow = currentSelection.wilayaId ? findLocalWilayaRow(currentSelection.wilayaId) : null;
        var localPayload = currentSelection.wilayaId ? readLocalDeliveryPayloadByWilaya(currentSelection.wilayaId) : { communes: [], offices: [] };
        var communeRow = currentSelection.communeId ? findRowById(localPayload.communes, "commune_id", currentSelection.communeId) : null;
        var officeRow = currentSelection.officeId ? findRowById(localPayload.offices, "office_id", currentSelection.officeId) : null;
        var result = {
            valid: true,
            reason: "",
            selection: currentSelection,
            wilayaRow: wilayaRow,
            communeRow: communeRow,
            officeRow: officeRow,
            payload: localPayload
        };

        if (currentSelection.deliveryType === "home") {
            if (!currentSelection.wilayaId) {
                result.valid = false;
                result.reason = "missing_wilaya";
            }
        } else {
            if (!currentSelection.wilayaId || !currentSelection.officeId) {
                result.valid = false;
                result.reason = !currentSelection.wilayaId ? "missing_wilaya" : "missing_office";
            }
        }

        if (result.valid && currentSelection.officeId) {
            if (!officeRow) {
                result.valid = false;
                result.reason = "office_not_found";
            } else if (String(officeRow.wilaya_id || "") !== currentSelection.wilayaId) {
                result.valid = false;
                result.reason = "office_wilaya_mismatch";
            }
        }

        if (!result.valid) {
            if (currentSelection.officeId) {
                clearInvalidOfficeSelection();
                result.selection.officeId = "";
                result.selection.key = [result.selection.deliveryType, result.selection.wilayaId, result.selection.communeId, result.selection.officeId].join("|");
            }
            dzfsTrace("DZFS_LOCAL_SELECTION_INVALID", {
                reason: result.reason,
                deliveryType: currentSelection.deliveryType,
                wilayaId: currentSelection.wilayaId,
                communeId: currentSelection.communeId,
                officeId: currentSelection.officeId
            });
        }

        return result;
    }

    function postForm(action, payload) {
        if (!ajaxUrl) {
            return Promise.reject(new Error("ajax_url_missing"));
        }

        var body = new URLSearchParams();
        body.set("action", action);
        Object.keys(payload || {}).forEach(function(key) {
            body.set(key, payload[key] == null ? "" : String(payload[key]));
        });

        return fetch(ajaxUrl, {
            method: "POST",
            credentials: "same-origin",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                "Accept": "application/json"
            },
            body: body.toString()
        }).then(function(response) {
            return response.json().catch(function() {
                return {};
            }).then(function(json) {
                return {
                    ok: response.ok,
                    status: response.status,
                    json: json || {}
                };
            });
        });
    }

    function buildMethodCard(type, icon, heading, description, onSelect) {
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "dzfs-method-card";
        btn.setAttribute("data-delivery-type", type);
        btn.setAttribute("aria-pressed", "false");
        btn.innerHTML = ""
            + "<span class=\"dzfs-method-icon\">" + icon + "</span>"
            + "<span><span class=\"dzfs-method-label\">" + heading + "</span><span class=\"dzfs-method-desc\">" + description + "</span></span>";
        btn.addEventListener("click", function() {
            onSelect(type);
        });
        return btn;
    }

    function hideWooCommerceAddressFields() {
        // In DZFS checkout block mode, hide WooCommerce's native shipping address step
        // entirely. DZFS checkout block becomes the single source for delivery location.

        var style = document.getElementById("dzfs-hide-woo-address-styles");
        if (!style) {
            style = document.createElement("style");
            style.id = "dzfs-hide-woo-address-styles";
            style.textContent =
                // Hide the entire WooCommerce shipping address block / fieldset
                "fieldset#shipping-fields," +
                ".wp-block-woocommerce-checkout-shipping-address-block," +
                ".wc-block-checkout__shipping-address," +
                "[data-block-name='woocommerce/checkout-shipping-address-block']," +
                // Hide individual address form fields within WC blocks
                ".wc-block-components-address-form__first_name," +
                ".wc-block-components-address-form__last_name," +
                ".wc-block-components-address-form__company," +
                ".wc-block-components-address-form__address_1," +
                ".wc-block-components-address-form__address_2," +
                ".wc-block-components-address-form__city," +
                ".wc-block-components-address-form__state," +
                ".wc-block-components-address-form__postcode," +
                ".wc-block-components-address-form__phone," +
                ".wc-block-components-address-form__country," +
                ".wc-block-components-state-input," +
                ".wc-block-components-city-input," +
                // Individual field ids
                "#shipping-first_name,#shipping_first_name," +
                "#shipping-last_name,#shipping_last_name," +
                "#shipping-company,#shipping_company," +
                "#shipping-address_1,#shipping_address_1," +
                "#shipping-address_2,#shipping_address_2," +
                "#shipping-city,#shipping_city," +
                "#shipping-state,#shipping_state," +
                "#shipping-postcode,#shipping_postcode," +
                "#shipping-phone,#shipping_phone," +
                "#shipping-country,#shipping_country," +
                "#billing-state,#billing_state," +
                "#billing-city,#billing_city," +
                "input[name='shipping_first_name'],input[name='shipping_last_name']," +
                "input[name='shipping_address_1'],input[name='shipping_address_2']," +
                "input[name='shipping_city'],input[name='shipping_state']," +
                "input[name='shipping_postcode'],input[name='shipping_phone']," +
                "select[name='shipping_state'],select[name='shipping_country']," +
                "select[name='billing_state'],select[name='billing_city']," +
                "input[name='billing_state'],input[name='billing_city'] {" +
                "  display: none !important;" +
                "  visibility: hidden !important;" +
                "  height: 0 !important;" +
                "  overflow: hidden !important;" +
                "  margin: 0 !important;" +
                "  padding: 0 !important;" +
                "  border: 0 !important;" +
                "}";
            document.head.appendChild(style);
        }

        function hideAllAddressFields() {
            var now = Date.now();
            if (now - dzfsLastHideRunAt < DZFS_DOM_THROTTLE_MS) {
                return;
            }
            dzfsLastHideRunAt = now;

            var selectors = [
                "fieldset#shipping-fields",
                ".wp-block-woocommerce-checkout-shipping-address-block",
                ".wc-block-checkout__shipping-address",
                "[data-block-name='woocommerce/checkout-shipping-address-block']",
                ".wc-block-components-address-form__first_name",
                ".wc-block-components-address-form__last_name",
                ".wc-block-components-address-form__company",
                ".wc-block-components-address-form__address_1",
                ".wc-block-components-address-form__address_2",
                ".wc-block-components-address-form__city",
                ".wc-block-components-address-form__state",
                ".wc-block-components-address-form__postcode",
                ".wc-block-components-address-form__phone",
                ".wc-block-components-address-form__country",
                ".wc-block-components-state-input",
                ".wc-block-components-city-input",
                "#shipping-first_name", "#shipping_first_name",
                "#shipping-last_name", "#shipping_last_name",
                "#shipping-company", "#shipping_company",
                "#shipping-address_1", "#shipping_address_1",
                "#shipping-address_2", "#shipping_address_2",
                "#shipping-city", "#shipping_city",
                "#shipping-state", "#shipping_state",
                "#shipping-postcode", "#shipping_postcode",
                "#shipping-phone", "#shipping_phone",
                "#shipping-country", "#shipping_country",
                "#billing-state", "#billing_state",
                "#billing-city", "#billing_city"
            ];

            selectors.forEach(function(selector) {
                var els = document.querySelectorAll(selector);
                els.forEach(function(el) {
                    if (!el.dataset || !el.dataset.dzfsHiddenFieldApplied) {
                        el.style.cssText += ";display:none!important;visibility:hidden!important;height:0!important;overflow:hidden!important;margin:0!important;padding:0!important;border:0!important;";
                        if (el.dataset) {
                            el.dataset.dzfsHiddenFieldApplied = "1";
                        }
                    }
                    // Also hide form-row parent wrappers
                    var parent = el.parentElement;
                    if (parent && (
                        parent.classList.contains("form-row") ||
                        parent.classList.contains("wc-block-components-form-row") ||
                        parent.classList.contains("wc-block-components-address-form__field")
                    )) {
                        if (!parent.dataset || !parent.dataset.dzfsHiddenFieldApplied) {
                            parent.style.cssText += ";display:none!important;visibility:hidden!important;height:0!important;overflow:hidden!important;margin:0!important;padding:0!important;";
                            if (parent.dataset) {
                                parent.dataset.dzfsHiddenFieldApplied = "1";
                            }
                        }
                    }
                });
            });
        }

        // Hide immediately and at intervals to catch React-rendered fields
        hideAllAddressFields();
        [50, 150, 300, 600, 1200, 2000].forEach(function(ms) {
            setTimeout(hideAllAddressFields, ms);
        });

        // Watch for ANY new DOM nodes and re-apply hiding
        if (window.MutationObserver && !dzfsAddressHideObserver) {
            dzfsAddressHideObserver = new MutationObserver(function() {
                if (dzfsAddressHideScheduled) {
                    return;
                }
                dzfsAddressHideScheduled = true;
                setTimeout(function() {
                    dzfsAddressHideScheduled = false;
                    hideAllAddressFields();
                }, DZFS_DOM_THROTTLE_MS);
            });
            dzfsAddressHideObserver.observe(document.body, { childList: true, subtree: true });
        }
    }

    function mountBlockFields() {
        var currentOfficeEl = document.getElementById("dzfs_block_delivery_stopdesk");
        var currentOffice = currentOfficeEl && currentOfficeEl.value ? String(currentOfficeEl.value) : "";
        var activeCard = document.querySelector(".dzfs-method-card[aria-pressed='true'][data-delivery-type]");
        var inferredType = activeCard ? String(activeCard.getAttribute("data-delivery-type") || "") : "";
        var persistedSelection = readLastSelection();
        dzfsTrace("MOUNT_BLOCK_FIELDS_CALL", {
            currentDeliveryType: inferredType,
            currentOfficeId: currentOffice,
            stackSource: dzfsStackSource()
        });

        var target = document.querySelector(".wc-block-checkout__form")
            || document.querySelector(".wc-block-components-main");

        if (!target) {
            return;
        }

        // Always hide WooCommerce address fields whenever this function is called
        hideWooCommerceAddressFields();

        if (document.getElementById("dzfs-delivery-checkout-block")) {
            return;
        }

        var wrapper = document.createElement("section");
        wrapper.id = "dzfs-delivery-checkout-block";
        wrapper.className = "dzfs-delivery-checkout wc-block-components-checkout-step";
        wrapper.setAttribute("data-dzfs-theme", detectTheme());
        applyThemeTokens(wrapper, target);

        var title = document.createElement("h3");
        title.className = "dzfs-title";
        title.textContent = text("deliveryOptions", "Delivery Options");
        wrapper.appendChild(title);

        var subtitle = document.createElement("p");
        subtitle.className = "dzfs-subtitle";
        subtitle.textContent = text("deliverySubtitle", "Choose a delivery method and location.");
        wrapper.appendChild(subtitle);

        var statusMessage = document.createElement("p");
        statusMessage.className = "dzfs-subtitle";
        statusMessage.style.display = "none";
        statusMessage.style.color = "#b45309";
        statusMessage.style.fontWeight = "600";
        wrapper.appendChild(statusMessage);

        var hydratedDeliveryType = "home";
        var hydratedOfficeId = currentOffice || (persistedSelection && persistedSelection.officeId ? persistedSelection.officeId : "");
        if (inferredType === "stopdesk") {
            hydratedDeliveryType = "stopdesk";
        } else if (inferredType === "home") {
            hydratedDeliveryType = "home";
        } else if (hydratedOfficeId) {
            hydratedDeliveryType = "stopdesk";
        } else if (persistedSelection && persistedSelection.deliveryType === "stopdesk") {
            hydratedDeliveryType = "stopdesk";
        }

        var deliveryType = hydratedDeliveryType;
        dzfsTrace("DELIVERY_TYPE_INITIALIZED", {
            deliveryType: deliveryType,
            officeId: hydratedOfficeId
        });
        var cards = document.createElement("div");
        cards.className = "dzfs-method-cards";
        wrapper.appendChild(cards);

        var formGrid = document.createElement("div");
        formGrid.className = "dzfs-form-grid";
        wrapper.appendChild(formGrid);

        var customerGrid = document.createElement("div");
        customerGrid.className = "dzfs-form-grid dzfs-customer-grid";
        wrapper.appendChild(customerGrid);

        function createField(id, labelText, tag) {
            var row = document.createElement("div");
            row.className = "form-row";
            var label = document.createElement("label");
            label.setAttribute("for", id);
            label.textContent = labelText;
            var field = document.createElement(tag || "select");
            field.id = id;
            field.className = "input-text";
            row.appendChild(label);
            row.appendChild(field);
            return { row: row, field: field };
        }

        var wilaya = createField("dzfs_block_delivery_wilaya", text("wilaya", "Wilaya"), "select");
        wilaya.field.className = "wc-block-components-select__select";
        formGrid.appendChild(wilaya.row);

        var firstName = createField("dzfs_block_first_name", "First Name", "input");
        firstName.field.type = "text";
        firstName.field.className = "wc-block-components-text-input__input";
        customerGrid.appendChild(firstName.row);

        var lastName = createField("dzfs_block_last_name", "Last Name", "input");
        lastName.field.type = "text";
        lastName.field.className = "wc-block-components-text-input__input";
        customerGrid.appendChild(lastName.row);

        var phone = createField("dzfs_block_phone", "Phone", "input");
        phone.field.type = "tel";
        phone.field.className = "wc-block-components-text-input__input";
        phone.row.classList.add("is-full");
        customerGrid.appendChild(phone.row);

        var homeAddressGroup = document.createElement("div");
        homeAddressGroup.className = "dzfs-field-group";
        homeAddressGroup.classList.add("is-full");
        var homeAddress = createField("dzfs_block_address", "Address", "input");
        homeAddress.field.type = "text";
        homeAddress.field.className = "wc-block-components-text-input__input";
        homeAddressGroup.appendChild(homeAddress.row);
        customerGrid.appendChild(homeAddressGroup);

        var homeGroup = document.createElement("div");
        homeGroup.className = "dzfs-field-group";
        var commune = createField("dzfs_block_delivery_commune", text("commune", "Commune"), "select");
        commune.field.className = "wc-block-components-select__select";
        homeGroup.appendChild(commune.row);
        formGrid.appendChild(homeGroup);

        var stopdeskGroup = document.createElement("div");
        stopdeskGroup.className = "dzfs-field-group is-hidden";
        var office = createField("dzfs_block_delivery_stopdesk", text("stopDeskOffice", "Stop Desk Office"), "select");
        office.field.className = "wc-block-components-select__select";
        stopdeskGroup.appendChild(office.row);
        formGrid.appendChild(stopdeskGroup);

        // Hidden marker so server-side code can detect block mode.
        var marker = document.createElement("div");
        marker.id = "dzfs-checkout-block-marker";
        marker.setAttribute("data-dzfs-checkout-mode", "BLOCK");
        formGrid.appendChild(marker);

        var methodCards = {
            home: buildMethodCard(
                "home",
                "🏠",
                text("homeDelivery", "Home Delivery"),
                text("homeDescription", "Delivered to your customer address."),
                onSelectDeliveryType
            ),
            stopdesk: buildMethodCard(
                "stopdesk",
                "📦",
                text("stopDesk", "Stop Desk"),
                text("stopDeskDescription", "Pickup from the selected office."),
                onSelectDeliveryType
            )
        };

        cards.appendChild(methodCards.home);
        cards.appendChild(methodCards.stopdesk);
        target.insertBefore(wrapper, target.firstChild);

        var cachedWilayas = readCachedJSON("dzfs_wilayas_all");
        if (cachedWilayas && Array.isArray(cachedWilayas)) {
            initialWilayas = cachedWilayas;
        } else {
            writeCachedJSON("dzfs_wilayas_all", initialWilayas, DZFS_CACHE_TTL_MS);
        }

        fillSelect(wilaya.field, initialWilayas, "wilaya_id", "wilaya_name", text("selectWilaya", "Select wilaya"));
        fillSelect(commune.field, [], "commune_id", "commune_name", text("selectCommune", "Select commune"));
        fillSelect(office.field, [], "office_id", "office_name", text("selectOffice", "Select office"));

        if (persistedSelection && persistedSelection.wilayaId) {
            wilaya.field.value = String(persistedSelection.wilayaId);
        }

        function persistCurrentSelection() {
            var nextSelection = {
                deliveryType: deliveryType,
                wilayaId: wilaya.field && wilaya.field.value ? String(wilaya.field.value) : "",
                communeId: commune.field && commune.field.value ? String(commune.field.value) : "",
                officeId: office.field && office.field.value ? String(office.field.value) : ""
            };

            writeLastSelection(nextSelection);
        }

        function ensureStableStopdeskState(reason) {
            var selection = dzfsRuntimeState.getSelection ? dzfsRuntimeState.getSelection() : null;
            if (!selection) {
                return Promise.resolve(null);
            }

            var isCompleteStopdesk = selection.deliveryType === "stopdesk"
                && !!selection.wilayaId
                && !!selection.officeId;

            if (!isCompleteStopdesk) {
                return Promise.resolve(null);
            }

            var key = getCachedPriceKey(selection.deliveryType, selection.wilayaId, selection.communeId, selection.officeId);
            if (hasSuccessfulPriceForKey(key)) {
                return Promise.resolve(null);
            }

            var stableReason = reason || "stable_state_verify";
            dzfsTrace("STABLE_STOPDESK_FORCE_REFRESH", {
                reason: stableReason,
                deliveryType: selection.deliveryType,
                wilayaId: selection.wilayaId,
                communeId: selection.communeId,
                officeId: selection.officeId,
                key: key
            });
            return schedulePriceRefresh(stableReason);
        }

        function applyPersistedSelectionToFields() {
            var persisted = readLastSelection();
            if (!persisted) {
                return;
            }

            if (persisted.wilayaId && wilaya.field && wilaya.field.value !== persisted.wilayaId) {
                var hasWilaya = Array.prototype.some.call(wilaya.field.options || [], function(opt) {
                    return String(opt.value || "") === persisted.wilayaId;
                });
                if (hasWilaya) {
                    wilaya.field.value = persisted.wilayaId;
                }
            }

            if (persisted.communeId && commune.field && !commune.field.value) {
                var hasCommune = Array.prototype.some.call(commune.field.options || [], function(opt) {
                    return String(opt.value || "") === persisted.communeId;
                });
                if (hasCommune) {
                    commune.field.value = persisted.communeId;
                }
            }

            if (persisted.officeId && office.field && !office.field.value) {
                var hasOffice = Array.prototype.some.call(office.field.options || [], function(opt) {
                    return String(opt.value || "") === persisted.officeId;
                });
                if (hasOffice) {
                    office.field.value = persisted.officeId;
                    deliveryType = "stopdesk";
                    setTimeout(function() {
                        ensureStableStopdeskState("rehydrate_office_stable_verify");
                    }, 80);
                }
            }
        }

        dzfsRuntimeState.getSelection = function() {
            return {
                deliveryType: deliveryType,
                wilayaId: wilaya.field && wilaya.field.value ? String(wilaya.field.value) : "",
                communeId: commune.field && commune.field.value ? String(commune.field.value) : "",
                officeId: office.field && office.field.value ? String(office.field.value) : ""
            };
        };

        function setStaleStatusMessage(message) {
            var textValue = String(message || "").trim();
            if (!textValue) {
                if (dzfsDeliveryCacheHardError) {
                    return;
                }
                statusMessage.textContent = "";
                statusMessage.style.display = "none";
                statusMessage.style.color = "#b45309";
                return;
            }

            statusMessage.textContent = textValue;
            statusMessage.style.display = "block";
            statusMessage.style.color = "#b45309";
        }

        function setCacheErrorMessage(message) {
            var textValue = String(message || "").trim();
            if (!textValue) {
                dzfsDeliveryCacheHardError = false;
                statusMessage.textContent = "";
                statusMessage.style.display = "none";
                statusMessage.style.color = "#b45309";
                return;
            }

            dzfsDeliveryCacheHardError = true;
            statusMessage.textContent = textValue;
            statusMessage.style.display = "block";
            statusMessage.style.color = "#b91c1c";
        }

        function setCheckoutSubmitDisabled(disabled) {
            var buttons = document.querySelectorAll([
                ".wc-block-components-checkout-place-order-button",
                ".wc-block-components-checkout-place-order-button button",
                "button.wc-block-components-checkout-place-order-button",
                "form.wc-block-checkout__form button[type='submit']",
                "form[name='checkout'] button[type='submit']"
            ].join(","));

            buttons.forEach(function(button) {
                if (!button) {
                    return;
                }
                button.disabled = !!disabled;
                button.setAttribute("aria-disabled", disabled ? "true" : "false");
            });
        }

        function updateSummary() {
            normalizeCheckoutSummaryLabels();
        }

        function setLoadingVisualState(loading) {
            setGroupLoading(homeGroup, loading && deliveryType === "home");
            setGroupLoading(stopdeskGroup, loading && deliveryType === "stopdesk");
        }

        function setCacheLoadingLabels(loading) {
            if (loading) {
                markPlaceholder(commune.field, text("loadingCommunes", "Loading communes…"));
                markPlaceholder(office.field, text("loadingOffices", "Loading offices…"));
            }
        }

        function trySyncWilayaFromNativeState() {
            if (wilaya.field.value) {
                return;
            }

            var stateValue = (getNativeShippingStateValue() || "").toLowerCase();
            var stateLabel = (getNativeShippingStateLabel() || "").toLowerCase();

            var options = wilaya.field.options;
            var idx;
            for (idx = 0; idx < options.length; idx += 1) {
                var option = options[idx];
                var label = (option.textContent || "").toLowerCase();
                if (!option.value) {
                    continue;
                }
                if ((stateLabel && label === stateLabel) || (stateValue && label === stateLabel) || (stateValue && option.value.toLowerCase() === stateValue)) {
                    wilaya.field.value = option.value;
                    break;
                }
            }
        }

        function refreshMethodCardState() {
            methodCards.home.setAttribute("aria-pressed", deliveryType === "home" ? "true" : "false");
            methodCards.stopdesk.setAttribute("aria-pressed", deliveryType === "stopdesk" ? "true" : "false");
            if (deliveryType === "stopdesk") {
                homeGroup.classList.add("is-hidden");
                stopdeskGroup.classList.remove("is-hidden");
                homeAddressGroup.classList.add("is-hidden");
                homeAddressGroup.style.display = "none";
                ensureStopdeskAddressPlaceholder();
            } else {
                stopdeskGroup.classList.add("is-hidden");
                homeGroup.classList.remove("is-hidden");
                homeAddressGroup.classList.remove("is-hidden");
                homeAddressGroup.style.display = "";
            }
        }

        function onSelectDeliveryType(type) {
            deliveryType = type === "stopdesk" ? "stopdesk" : "home";
            if (deliveryType === "home") {
                if (commune.field) {
                    commune.field.value = "";
                }
                if (office.field) {
                    office.field.value = "";
                }
            }
            updateAuthoritativeSelection();
            dzfsPriceRefreshInFlight = false;
            refreshMethodCardState();
            syncHiddenNativeAddressFields();
            persistCurrentSelection();
            schedulePriceRefresh("delivery_type_change");
        }

        function syncHiddenNativeAddressFields() {
            var wilayaLabel = selectedLabel(wilaya.field);
            var communeLabel = selectedLabel(commune.field);
            var officeLabel = selectedLabel(office.field);
            var stateCode = wilayaLabel ? findStateCodeForWilayaName(wilayaLabel) : "";
            var cityLabel = deliveryType === "stopdesk" ? officeLabel : communeLabel;
            var enteredAddress = (homeAddress.field && homeAddress.field.value ? String(homeAddress.field.value).trim() : "");
            var addressLine = deliveryType === "stopdesk"
                ? "Stop Desk Pickup"
                : (enteredAddress || getNativeShippingAddress1() || "DZFS Address");
            var enteredFirstName = firstName.field && firstName.field.value ? String(firstName.field.value).trim() : "";
            var enteredLastName = lastName.field && lastName.field.value ? String(lastName.field.value).trim() : "";
            var enteredPhone = phone.field && phone.field.value ? String(phone.field.value).trim() : "";

            // Hidden fields must be populated for Woo validation even when shipping step is hidden.
            if (enteredFirstName) {
                setNativeFieldValue(["#shipping-first_name", "#shipping_first_name", "input[name='shipping_first_name']"], enteredFirstName);
                setNativeFieldValue(["#billing-first_name", "#billing_first_name", "input[name='billing_first_name']"], enteredFirstName);
            }
            if (enteredLastName) {
                setNativeFieldValue(["#shipping-last_name", "#shipping_last_name", "input[name='shipping_last_name']"], enteredLastName);
                setNativeFieldValue(["#billing-last_name", "#billing_last_name", "input[name='billing_last_name']"], enteredLastName);
            }
            if (enteredPhone) {
                setNativeFieldValue(["#shipping-phone", "#shipping_phone", "input[name='shipping_phone']"], enteredPhone);
                setNativeFieldValue(["#billing-phone", "#billing_phone", "input[name='billing_phone']"], enteredPhone);
            }

            setNativeFieldValue(["#shipping-postcode", "#shipping_postcode", "input[name='shipping_postcode']"], "16000");
            setNativeFieldValue(["#shipping-country", "#shipping_country", "select[name='shipping_country']"], "DZ");
            setNativeFieldValue(["#billing-postcode", "#billing_postcode", "input[name='billing_postcode']"], "16000");
            setNativeFieldValue(["#billing-country", "#billing_country", "select[name='billing_country']"], "DZ");
            if (stateCode) {
                setNativeFieldValue(["#shipping-state", "#shipping_state", "select[name='shipping_state']"], stateCode);
                setNativeFieldValue(["#billing-state", "#billing_state", "select[name='billing_state']"], stateCode);
            }
            if (cityLabel) {
                setNativeFieldValue(["#shipping-city", "#shipping_city", "input[name='shipping_city']"], cityLabel);
                setNativeFieldValue(["#billing-city", "#billing_city", "input[name='billing_city']"], cityLabel);
            }
            setNativeFieldValue(["#shipping-address_1", "#shipping_address_1", "input[name='shipping_address_1']"], addressLine);
            setNativeFieldValue(["#billing-address_1", "#billing_address_1", "input[name='billing_address_1']"], addressLine);
        }

        function schedulePriceRefresh(reason) {
            var triggerReason = reason || "unknown";
            dzfsTrace("SCHEDULE_PRICE_REFRESH", {
                reason: triggerReason,
                deliveryType: deliveryType,
                officeId: office.field && office.field.value ? String(office.field.value) : "",
                communeId: commune.field && commune.field.value ? String(commune.field.value) : "",
                stackSource: dzfsStackSource()
            });
            return fetchPriceAndUpdate(triggerReason);
        }

        function scheduleCacheRefresh(reason) {
            var p = fetchCacheByWilaya();
            return p;
        }

        function readVisibleShippingLabelAmount() {
            var node = document.querySelector("#shipping-option .wc-block-components-radio-control__secondary-label");
            if (!node) {
                return NaN;
            }
            return parseAmount((node.textContent || "").trim());
        }

        function readCartStoreShippingAmount() {
            var dataApi = window.wp && window.wp.data;
            if (!dataApi || typeof dataApi.select !== "function") {
                return NaN;
            }
            try {
                var cartStore = dataApi.select("wc/store/cart");
                if (!cartStore || typeof cartStore.getCartData !== "function") {
                    return NaN;
                }
                var cart = cartStore.getCartData();
                var raw = cart && cart.shippingRates && cart.shippingRates[0] && cart.shippingRates[0].shipping_rates && cart.shippingRates[0].shipping_rates[0]
                    ? cart.shippingRates[0].shipping_rates[0].price
                    : null;
                if (raw == null) {
                    return NaN;
                }
                var amount = Number(raw) / 100;
                return isNaN(amount) ? NaN : amount;
            } catch (error) {
                return NaN;
            }
        }

        function readCartStorePrimaryRate() {
            var dataApi = window.wp && window.wp.data;
            if (!dataApi || typeof dataApi.select !== "function") {
                return null;
            }
            try {
                var cartStore = dataApi.select("wc/store/cart");
                if (!cartStore || typeof cartStore.getCartData !== "function") {
                    return null;
                }
                var cart = cartStore.getCartData();
                if (!cart || !cart.shippingRates || !cart.shippingRates[0] || !cart.shippingRates[0].shipping_rates || !cart.shippingRates[0].shipping_rates[0]) {
                    return null;
                }
                return cart.shippingRates[0].shipping_rates[0];
            } catch (error) {
                return null;
            }
        }

        function formatMinorCurrencyAmount(rawMinor, rate) {
            var minorUnit = rate && rate.currency_minor_unit != null ? Number(rate.currency_minor_unit) : 2;
            if (isNaN(minorUnit) || minorUnit < 0) {
                minorUnit = 2;
            }
            var amount = Number(rawMinor == null ? 0 : rawMinor);
            if (isNaN(amount)) {
                amount = 0;
            }
            var divisor = Math.pow(10, minorUnit);
            var major = amount / divisor;
            var fixed = major.toFixed(minorUnit);
            var parts = fixed.split(".");
            var whole = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ".");
            var decimals = parts.length > 1 ? parts[1] : "00";
            var prefix = rate && typeof rate.currency_prefix === "string" ? rate.currency_prefix : (currencySymbol ? currencySymbol + " " : "");
            var suffix = rate && typeof rate.currency_suffix === "string" ? rate.currency_suffix : "";
            return prefix + whole + (minorUnit > 0 ? "," + decimals : "") + suffix;
        }

        function synchronizeVisibleShippingLabelFromStore() {
            var rate = readCartStorePrimaryRate();
            if (!rate || rate.price == null) {
                return;
            }
            var nextText = formatMinorCurrencyAmount(rate.price, rate);
            var nodes = document.querySelectorAll("#shipping-option .wc-block-components-radio-control__secondary-label");
            if (!nodes || !nodes.length) {
                return;
            }
            nodes.forEach(function(node) {
                if (!node) {
                    return;
                }
                var current = (node.textContent || "").trim();
                if (current !== nextText) {
                    node.textContent = nextText;
                }
            });
        }

        function startStoreShippingLabelSync() {
            if (dzfsStoreLabelSyncUnsubscribe) {
                return;
            }
            var dataApi = window.wp && window.wp.data;
            if (!dataApi || typeof dataApi.subscribe !== "function") {
                return;
            }

            dzfsStoreLabelSyncUnsubscribe = dataApi.subscribe(function() {
                var rate = readCartStorePrimaryRate();
                var signature = rate && rate.rate_id
                    ? String(rate.rate_id) + "|" + String(rate.price || "")
                    : "";
                if (signature === dzfsStoreLabelSyncSignature) {
                    return;
                }
                dzfsStoreLabelSyncSignature = signature;
                synchronizeVisibleShippingLabelFromStore();

                var selection = dzfsRuntimeState.getSelection ? dzfsRuntimeState.getSelection() : null;
                var selectionKey = selection
                    ? [selection.deliveryType || "", selection.wilayaId || "", selection.communeId || "", selection.officeId || ""].join("|")
                    : "";
                var confirmed = selectionKey && Object.prototype.hasOwnProperty.call(dzfsConfirmedShippingByKey, selectionKey)
                    ? dzfsConfirmedShippingByKey[selectionKey]
                    : null;
                if (!confirmed || !confirmed.context || !isSyncContextCurrent(confirmed.context)) {
                    return;
                }

                var currentCartShipping = readCartStoreShippingAmount();
                var currentVisibleShipping = readVisibleShippingLabelAmount();
                if (!amountsMatch(currentCartShipping, confirmed.price) || (!isNaN(currentVisibleShipping) && currentVisibleShipping <= 0 && confirmed.price > 0)) {
                    synchronizeVisibleShippingLabelFromStore();
                }
            });

            synchronizeVisibleShippingLabelFromStore();
        }

        function invalidateCartStoreResolvers() {
            var dataApi = window.wp && window.wp.data;
            if (!dataApi || typeof dataApi.dispatch !== "function") {
                return;
            }
            try {
                var cartDispatch = dataApi.dispatch("wc/store/cart");
                if (cartDispatch && typeof cartDispatch.invalidateResolutionForStoreSelector === "function") {
                    cartDispatch.invalidateResolutionForStoreSelector("getCartData");
                    cartDispatch.invalidateResolutionForStoreSelector("getShippingRates");
                    cartDispatch.invalidateResolutionForStoreSelector("getCartTotals");
                }
                if (cartDispatch && typeof cartDispatch.setIsCartDataStale === "function") {
                    cartDispatch.setIsCartDataStale(true);
                }
            } catch (error) {
            }
        }

        function reselectCurrentShippingRate() {
            var dataApi = window.wp && window.wp.data;
            if (!dataApi || typeof dataApi.select !== "function" || typeof dataApi.dispatch !== "function") {
                return;
            }
            try {
                var cartStore = dataApi.select("wc/store/cart");
                var cartDispatch = dataApi.dispatch("wc/store/cart");
                if (!cartStore || !cartDispatch || typeof cartStore.getCartData !== "function" || typeof cartDispatch.selectShippingRate !== "function") {
                    return;
                }
                var cart = cartStore.getCartData();
                var pkg = cart && cart.shippingRates && cart.shippingRates[0] ? cart.shippingRates[0] : null;
                var rate = pkg && pkg.shipping_rates && pkg.shipping_rates[0] ? pkg.shipping_rates[0] : null;
                var rateId = rate && rate.rate_id ? String(rate.rate_id) : "";
                if (!rateId) {
                    return;
                }
                var packageId = pkg && Object.prototype.hasOwnProperty.call(pkg, "package_id") ? String(pkg.package_id) : "0";
                cartDispatch.selectShippingRate(packageId, rateId);
            } catch (error) {
            }
        }

        function getCurrentSelectionKey() {
            return [
                deliveryType || "",
                wilaya.field && wilaya.field.value ? String(wilaya.field.value) : "",
                commune.field && commune.field.value ? String(commune.field.value) : "",
                office.field && office.field.value ? String(office.field.value) : ""
            ].join("|");
        }

        function buildSelectionFromCurrentFields() {
            return {
                deliveryType: deliveryType || "home",
                wilayaId: wilaya.field && wilaya.field.value ? String(wilaya.field.value) : "",
                communeId: commune.field && commune.field.value ? String(commune.field.value) : "",
                officeId: office.field && office.field.value ? String(office.field.value) : ""
            };
        }

        function normalizeAuthoritativeSelection(rawSelection) {
            var source = rawSelection || buildSelectionFromCurrentFields();
            var officeId = source.officeId ? String(source.officeId) : "";
            var deliveryTypeValue = source.deliveryType === "stopdesk" ? "stopdesk" : "home";
            if (officeId) {
                deliveryTypeValue = "stopdesk";
            }
            var normalized = {
                deliveryType: deliveryTypeValue,
                wilayaId: source.wilayaId ? String(source.wilayaId) : "",
                communeId: source.communeId ? String(source.communeId) : "",
                officeId: officeId
            };
            normalized.key = [normalized.deliveryType, normalized.wilayaId, normalized.communeId, normalized.officeId].join("|");
            normalized.updatedAt = Date.now();
            return normalized;
        }

        function updateAuthoritativeSelection(rawSelection) {
            dzfsAuthoritativeSelection = normalizeAuthoritativeSelection(rawSelection);
            return dzfsAuthoritativeSelection;
        }

        function getAuthoritativeSelection() {
            if (!dzfsAuthoritativeSelection || !dzfsAuthoritativeSelection.key) {
                return updateAuthoritativeSelection();
            }
            return dzfsAuthoritativeSelection;
        }

        function buildSyncContextFromSelection(selection, shippingPrice) {
            var normalizedSelection = normalizeAuthoritativeSelection(selection || buildSelectionFromCurrentFields());
            var numericPrice = Number(shippingPrice || 0);
            if (!isFinite(numericPrice) || numericPrice < 0) {
                numericPrice = 0;
            }
            return {
                deliveryType: normalizedSelection.deliveryType,
                wilayaId: normalizedSelection.wilayaId,
                communeId: normalizedSelection.communeId,
                officeId: normalizedSelection.officeId,
                shippingState: getNativeShippingStateLabel() || getNativeShippingStateValue(),
                shippingCity: getNativeShippingCity(),
                shippingAddress1: getNativeShippingAddress1(),
                shippingPrice: numericPrice,
                key: normalizedSelection.key
            };
        }

        function getSyncContext(shippingPrice) {
            return buildSyncContextFromSelection(getAuthoritativeSelection(), shippingPrice);
        }

        function buildSelectionSnapshotFromContext(syncContext) {
            var context = syncContext || getSyncContext(0);
            return {
                deliveryType: context.deliveryType || "",
                wilayaId: context.wilayaId || "",
                communeId: context.communeId || "",
                officeId: context.officeId || "",
                key: [context.deliveryType || "", context.wilayaId || "", context.communeId || "", context.officeId || ""].join("|")
            };
        }

        function isSelectionSnapshotCurrent(snapshot) {
            if (!snapshot || !snapshot.key) {
                return true;
            }
            return snapshot.key === getCurrentSelectionKey();
        }

        function rejectStaleCommit(reason, refreshToken, requestedPrice, snapshot) {
            dzfsTrace("DZFS_STALE_COMMIT_REJECTED", {
                reason: String(reason || "unknown"),
                refreshToken: Number(refreshToken || 0),
                activeRefreshToken: Number(dzfsActiveRefreshToken || 0),
                requestedPrice: Number(requestedPrice || 0),
                selectionKey: snapshot && snapshot.key ? snapshot.key : "",
                currentSelectionKey: getCurrentSelectionKey()
            });
            return STALE_REFRESH_ABORTED;
        }

        function blockHomeCommitByAuthoritativeStopdesk(syncContext, requestedPrice, refreshToken, snapshot) {
            var authoritative = getAuthoritativeSelection();
            var context = syncContext || getSyncContext(requestedPrice);
            if (!context || context.deliveryType !== "home") {
                return null;
            }
            if (authoritative.deliveryType === "stopdesk" && authoritative.officeId) {
                dzfsTrace("DZFS_HOME_COMMIT_BLOCKED_BY_STOPDESK", {
                    requestedKey: context.key || "",
                    authoritativeKey: authoritative.key || "",
                    requestedPrice: Number(requestedPrice || 0),
                    authoritativeDeliveryType: authoritative.deliveryType || "",
                    authoritativeOfficeId: authoritative.officeId || ""
                });
                return rejectStaleCommit("home_commit_blocked_by_stopdesk", refreshToken, requestedPrice, snapshot);
            }
            return null;
        }

        function enforceAuthoritativeSelection(syncContext, requestedPrice, refreshToken, snapshot) {
            var authoritative = getAuthoritativeSelection();
            var context = syncContext || getSyncContext(requestedPrice);
            if (context && authoritative && context.key && authoritative.key && context.key !== authoritative.key) {
                return rejectStaleCommit("authoritative_selection_mismatch", refreshToken, requestedPrice, snapshot || buildSelectionSnapshotFromContext(context));
            }
            return blockHomeCommitByAuthoritativeStopdesk(context, requestedPrice, refreshToken, snapshot || buildSelectionSnapshotFromContext(context));
        }

        function ownsRefresh(refreshToken, snapshot, requestedPrice, syncContext) {
            var token = Number(refreshToken || 0);
            if (token !== Number(dzfsActiveRefreshToken || 0)) {
                return rejectStaleCommit("refresh_token_mismatch", refreshToken, requestedPrice, snapshot);
            }
            if (!isSelectionSnapshotCurrent(snapshot)) {
                return rejectStaleCommit("selection_snapshot_mismatch", refreshToken, requestedPrice, snapshot);
            }

            var context = syncContext || null;
            if (snapshot && context && snapshot.key && context.key && snapshot.key !== context.key) {
                return rejectStaleCommit("context_selection_mismatch", refreshToken, requestedPrice, snapshot);
            }

            if (snapshot && snapshot.officeId) {
                if (!context || context.deliveryType !== "stopdesk" || !context.officeId) {
                    return rejectStaleCommit("stopdesk_home_conflict", refreshToken, requestedPrice, snapshot);
                }
            }

            var authoritativeError = enforceAuthoritativeSelection(context, requestedPrice, refreshToken, snapshot);
            if (authoritativeError) {
                return authoritativeError;
            }

            var confirmed = snapshot && snapshot.key && Object.prototype.hasOwnProperty.call(dzfsConfirmedShippingByKey, snapshot.key)
                ? dzfsConfirmedShippingByKey[snapshot.key]
                : null;
            var numericRequested = Number(requestedPrice || 0);
            if (confirmed && isFinite(Number(confirmed.price)) && Number(confirmed.price) > 0 && isFinite(numericRequested) && numericRequested > 0 && !amountsMatch(numericRequested, Number(confirmed.price))) {
                return rejectStaleCommit("confirmed_price_conflict", refreshToken, numericRequested, snapshot);
            }

            return null;
        }

        function isSyncContextCurrent(syncContext) {
            if (!syncContext || !syncContext.key) {
                return true;
            }
            return syncContext.key === getCurrentSelectionKey();
        }

        function buildExtensionCartPayload(syncContext) {
            return {
                namespace: "dzfs-delivery",
                data: {
                    deliveryType: syncContext && syncContext.deliveryType ? syncContext.deliveryType : deliveryType,
                    wilayaId: syncContext ? syncContext.wilayaId : wilaya.field.value,
                    communeId: syncContext ? syncContext.communeId : commune.field.value,
                    officeId: syncContext ? syncContext.officeId : office.field.value
                }
            };
        }

        function readCartStoreTotalAmount() {
            var dataApi = window.wp && window.wp.data;
            if (!dataApi || typeof dataApi.select !== "function") {
                return NaN;
            }
            try {
                var cartStore = dataApi.select("wc/store/cart");
                if (!cartStore || typeof cartStore.getCartData !== "function") {
                    return NaN;
                }
                var cart = cartStore.getCartData();
                var raw = cart && cart.totals && cart.totals.total_price != null
                    ? cart.totals.total_price
                    : (cart && cart.total != null ? cart.total : null);
                if (raw == null) {
                    return NaN;
                }
                var amount = Number(raw) / 100;
                return isNaN(amount) ? NaN : amount;
            } catch (error) {
                return NaN;
            }
        }

        function rememberConfirmedShipping(syncContext, expectedPrice) {
            var numericPrice = Number(expectedPrice || 0);
            if (!syncContext || !syncContext.key || !isFinite(numericPrice) || numericPrice <= 0) {
                return;
            }
            dzfsConfirmedShippingByKey[syncContext.key] = {
                price: numericPrice,
                context: syncContext,
                ts: Date.now()
            };
        }

        function getConfirmedShipping(syncContext) {
            if (!syncContext || !syncContext.key) {
                return null;
            }
            return Object.prototype.hasOwnProperty.call(dzfsConfirmedShippingByKey, syncContext.key)
                ? dzfsConfirmedShippingByKey[syncContext.key]
                : null;
        }

        function delayPromise(ms) {
            return new Promise(function(resolve) {
                setTimeout(resolve, Number(ms || 0));
            });
        }

        function scheduleConfirmedShippingRepair(syncContext, expectedPrice) {
            var numericPrice = Number(expectedPrice || 0);
            if (!syncContext || !syncContext.key || !isFinite(numericPrice) || numericPrice <= 0) {
                return;
            }
            if (dzfsPendingConfirmedRepairKey === syncContext.key) {
                return;
            }
            dzfsPendingConfirmedRepairKey = syncContext.key;
            setTimeout(function() {
                var confirmed = getConfirmedShipping(syncContext);
                var currentCartShipping = readCartStoreShippingAmount();
                dzfsPendingConfirmedRepairKey = "";
                if (!confirmed || !isSyncContextCurrent(syncContext)) {
                    return;
                }
                if (amountsMatch(currentCartShipping, confirmed.price)) {
                    return;
                }
                var repairToken = Number(dzfsActiveRefreshToken || 0);
                var repairSnapshot = buildSelectionSnapshotFromContext(confirmed.context);
                forceSyncBlockTotals(confirmed.price, 0, confirmed.context, repairToken, repairSnapshot).then(function(forceStatus) {
                    if (forceStatus && forceStatus.ok) {
                        ensureShippingLabelSynchronized(confirmed.price, 0, confirmed.context, repairToken, repairSnapshot);
                    }
                });
            }, 0);
        }

        function forceSyncBlockTotals(shippingPrice, attempt, syncContext, refreshToken, selectionSnapshot) {
            return Promise.resolve({ ok: false, result: null, cartStoreShippingLine: NaN, visibleShippingLine: NaN, cartTotal: NaN, attempts: 0 });
        }

        function ensureShippingLabelSynchronized(expectedPrice, attempt, syncContext, refreshToken, selectionSnapshot) {
            return Promise.resolve({ ok: true, repaired: false, uiOnly: false });
        }

        function finalizeSynchronizedShipping(result, expectedPrice, syncContext, forceStatus, refreshToken, selectionSnapshot) {
            return result;
        }

        function syncBlockTotals(shippingPrice, refreshToken, selectionSnapshot, providedContext) {
            var syncContext = providedContext || getSyncContext(0);
            if (!syncContext || !syncContext.wilayaId) {
                return Promise.resolve(null);
            }
            var blocksCheckout = getBlocksCheckout();
            if (!blocksCheckout || typeof blocksCheckout.extensionCartUpdate !== "function") {
                return Promise.resolve(null);
            }
            return blocksCheckout.extensionCartUpdate(buildExtensionCartPayload(syncContext, 0)).then(function(result) {
                invalidateCartStoreResolvers();
                reselectCurrentShippingRate();
                synchronizeVisibleShippingLabelFromStore();
                return result;
            }).catch(function() {
                return null;
            });
        }

        dzfsRuntimeState.syncTotals = function(price) {
            return syncBlockTotals(0, null, null, getSyncContext(0));
        };

        function fetchCacheByWilaya() {
            if (!wilaya.field.value) {
                fillSelect(commune.field, [], "commune_id", "commune_name", text("selectCommune", "Select commune"));
                fillSelect(office.field, [], "office_id", "office_name", text("selectOffice", "Select office"));
                setCheckoutSubmitDisabled(dzfsDeliveryCacheHardError);
                return Promise.resolve();
            }

            var cacheKey = getCachedDeliveryKey(wilaya.field.value);
            var cachedPayload = readCachedJSON(cacheKey);
            if (cachedPayload) {
                setStaleStatusMessage("");
                setCheckoutSubmitDisabled(false);
                fillSelect(commune.field, cachedPayload.communes || [], "commune_id", "commune_name", text("selectCommune", "Select commune"));
                fillSelect(office.field, cachedPayload.offices || [], "office_id", "office_name", text("selectOffice", "Select office"));
                dzfsLastSuccessfulDeliveryPayload = cachedPayload;
                setLoadingVisualState(false);
                return Promise.resolve(cachedPayload);
            }

            setLoadingVisualState(true);
            setCacheLoadingLabels(true);

            return dedupeRequest("cache:" + wilaya.field.value, function() {
                return postForm("dzfs_delivery_cache", { wilayaId: wilaya.field.value }).then(function(result) {
                    var json = result && result.json ? result.json : {};
                    var isSuccess = !!(result && result.ok && json && json.success);
                    if (!isSuccess) {
                        var errorPayload = json && json.data ? json.data : {};
                        var errorMessage = errorPayload && errorPayload.message ? String(errorPayload.message) : "Delivery location data is currently unavailable. Please try again.";
                        setCacheErrorMessage(errorMessage);
                        setCheckoutSubmitDisabled(true);
                        console.error("DZFS delivery cache failed", {
                            status: result ? result.status : 0,
                            response: json
                        });
                        throw {
                            status: result ? result.status : 0,
                            response: json
                        };
                    }

                    var payload = normalizeDeliveryPayload(json.data || {});
                    var raw = json.data || {};
                    var stale = !!(raw && raw.stale);
                    var staleMessage = raw && raw.staleMessage ? String(raw.staleMessage) : "";
                    if (stale) {
                        setStaleStatusMessage(staleMessage || DZFS_STALE_MESSAGE);
                    } else {
                        setStaleStatusMessage("");
                    }
                    setCheckoutSubmitDisabled(false);
                    writeCachedJSON(cacheKey, payload, DZFS_CACHE_TTL_MS);
                    dzfsLastSuccessfulDeliveryPayload = payload;
                    return payload;
                });
            }).then(function(payload) {
                fillSelect(commune.field, payload.communes || [], "commune_id", "commune_name", text("selectCommune", "Select commune"));
                fillSelect(office.field, payload.offices || [], "office_id", "office_name", text("selectOffice", "Select office"));
                applyPersistedSelectionToFields();
                persistCurrentSelection();
                setLoadingVisualState(false);

                // Avoid initial zero-price lock by selecting a real commune once options are available.
                if (!commune.field.value && commune.field.options && commune.field.options.length > 1) {
                    commune.field.selectedIndex = 1;
                    // Also sync native city with the auto-selected commune
                    var autoOpt = commune.field.options[1];
                    if (autoOpt && autoOpt.value) {
                        setNativeFieldValue(
                            ["#shipping-city", "#shipping_city", "input[name='shipping_city']"],
                            (autoOpt.textContent || "").trim()
                        );
                    }
                }

                return payload;
            }).catch(function() {
                if (dzfsLastSuccessfulDeliveryPayload) {
                    fillSelect(commune.field, dzfsLastSuccessfulDeliveryPayload.communes || [], "commune_id", "commune_name", text("selectCommune", "Select commune"));
                    fillSelect(office.field, dzfsLastSuccessfulDeliveryPayload.offices || [], "office_id", "office_name", text("selectOffice", "Select office"));
                } else {
                    markPlaceholder(commune.field, text("selectCommune", "Select commune"));
                    markPlaceholder(office.field, text("selectOffice", "Select office"));
                }
                setLoadingVisualState(false);
            });
        }

        function bootstrapWilayasIfMissing() {
            if (Array.isArray(initialWilayas) && initialWilayas.length > 0) {
                setCheckoutSubmitDisabled(false);
                return Promise.resolve(initialWilayas);
            }

            setLoadingVisualState(true);
            setCacheLoadingLabels(true);

            return postForm("dzfs_delivery_cache", { wilayaId: "" }).then(function(result) {
                var json = result && result.json ? result.json : {};
                var isSuccess = !!(result && result.ok && json && json.success);
                if (!isSuccess) {
                    var errorPayload = json && json.data ? json.data : {};
                    var errorMessage = errorPayload && errorPayload.message ? String(errorPayload.message) : "Delivery location data is currently unavailable. Please try again.";
                    setCacheErrorMessage(errorMessage);
                    setCheckoutSubmitDisabled(true);
                    console.error("DZFS delivery cache failed", {
                        status: result ? result.status : 0,
                        response: json
                    });
                    return [];
                }

                var payload = json.data || {};
                var wilayas = Array.isArray(payload.wilayas) ? payload.wilayas : [];
                if (!wilayas.length) {
                    setCacheErrorMessage("Delivery location data is currently unavailable. Please try again.");
                    setCheckoutSubmitDisabled(true);
                    console.error("DZFS delivery cache failed", {
                        status: result ? result.status : 0,
                        response: json
                    });
                    return [];
                }

                initialWilayas = wilayas;
                writeCachedJSON("dzfs_wilayas_all", initialWilayas, DZFS_CACHE_TTL_MS);
                fillSelect(wilaya.field, initialWilayas, "wilaya_id", "wilaya_name", text("selectWilaya", "Select wilaya"));
                setCacheErrorMessage("");
                setCheckoutSubmitDisabled(false);
                return wilayas;
            }).catch(function(error) {
                setCacheErrorMessage("Delivery location data is currently unavailable. Please try again.");
                setCheckoutSubmitDisabled(true);
                console.error("DZFS delivery cache failed", error);
                return [];
            }).finally(function() {
                setLoadingVisualState(false);
            });
        }

        function fetchPriceAndUpdate(triggerReason) {
            console.log("[DZFS-T] fetchPriceAndUpdate ENTER reason=" + triggerReason + " inFlight=" + dzfsPriceRefreshInFlight);
            if (dzfsPriceRefreshInFlight) {
                console.log("[DZFS-T] EXIT inFlight=true");
                return Promise.resolve(null);
            }

            dzfsPriceRefreshInFlight = true;

            function finalize(result) {
                dzfsPriceRefreshInFlight = false;
                return Promise.resolve(result);
            }

            trySyncWilayaFromNativeState();
            syncHiddenNativeAddressFields();
            setLoadingVisualState(true);

            return Promise.resolve().then(function() {
                console.log("[DZFS-T] async body cacheHardError=" + dzfsDeliveryCacheHardError);
                if (dzfsDeliveryCacheHardError) {
                    console.log("[DZFS-T] EXIT cacheHardError=true");
                    setCheckoutSubmitDisabled(true);
                    setStaleStatusMessage("Delivery location data is currently unavailable. Please try again.");
                    updateSummary();
                    setLoadingVisualState(false);
                    return finalize(null);
                }

                var selection = buildLocalSelection();
                console.log("[DZFS-T] selection wilayaId=" + selection.wilayaId + " type=" + selection.deliveryType + " officeId=" + selection.officeId);
                if (!selection.wilayaId) {
                    console.log("[DZFS-T] EXIT wilayaId empty");
                    setCheckoutSubmitDisabled(true);
                    setStaleStatusMessage("Please complete the delivery selection before checkout.");
                    updateSummary();
                    setLoadingVisualState(false);
                    return finalize(null);
                }

                if (selection.deliveryType === "stopdesk" && !selection.officeId) {
                    console.log("[DZFS-T] EXIT stopdesk no officeId");
                    setCheckoutSubmitDisabled(true);
                    setStaleStatusMessage("Please select a stopdesk office");
                    updateSummary();
                    setLoadingVisualState(false);
                    return finalize(null);
                }

                setCheckoutSubmitDisabled(false);
                setStaleStatusMessage("");
                updateAuthoritativeSelection(selection);
                persistCurrentSelection();
                updateSummary();
                setLoadingVisualState(false);

                var blocksCheckout = getBlocksCheckout();
                console.log("[DZFS-T] blocksCheckout=" + (blocksCheckout ? "FOUND extCU=" + typeof blocksCheckout.extensionCartUpdate : "NULL"));
                if (!blocksCheckout || typeof blocksCheckout.extensionCartUpdate !== "function") {
                    console.log("[DZFS-T] EXIT blocksCheckout null or no extensionCartUpdate");
                    invalidateCartStoreResolvers();
                    reselectCurrentShippingRate();
                    synchronizeVisibleShippingLabelFromStore();
                    return finalize(null);
                }

                var payload = buildExtensionCartPayload(selection);
                console.log("[DZFS-T] CALLING extensionCartUpdate payload=" + JSON.stringify(payload));
                return blocksCheckout.extensionCartUpdate(payload).then(function(result) {
                    console.log("[DZFS-T] extensionCartUpdate RESULT=" + JSON.stringify(result));
                    if (result && result.ok === false) {
                        setCheckoutSubmitDisabled(true);
                        setStaleStatusMessage(result.validationError || result.staleMessage || "Please complete the delivery selection before checkout.");
                        updateSummary();
                        invalidateCartStoreResolvers();
                        reselectCurrentShippingRate();
                        synchronizeVisibleShippingLabelFromStore();
                        return finalize(null);
                    }
                    invalidateCartStoreResolvers();
                    reselectCurrentShippingRate();
                    synchronizeVisibleShippingLabelFromStore();
                    updateSummary();
                    return finalize(result);
                }).catch(function(err) {
                    console.log("[DZFS-T] extensionCartUpdate CATCH err=" + (err && err.message ? err.message : String(err)));
                    invalidateCartStoreResolvers();
                    reselectCurrentShippingRate();
                    synchronizeVisibleShippingLabelFromStore();
                    updateSummary();
                    return finalize(null);
                });
            }).catch(function(err) {
                console.log("[DZFS-T] OUTER CATCH err=" + (err && err.message ? err.message : String(err)));
                setCheckoutSubmitDisabled(true);
                setStaleStatusMessage("Delivery price is unavailable for the selected location.");
                updateSummary();
                setLoadingVisualState(false);
                return finalize(null);
            });
        }

        wilaya.field.addEventListener("change", function() {
            // Sync native shipping state select to matching WC state code (e.g. "DZ-16").
            var selectedOpt = wilaya.field.options[wilaya.field.selectedIndex];
            var wilayaLabel = selectedOpt && selectedOpt.value ? (selectedOpt.textContent || "").trim() : "";
            if (wilayaLabel) {
                var stateCode = findStateCodeForWilayaName(wilayaLabel);
                if (stateCode) {
                    setNativeFieldValue(
                        ["#shipping-state", "#shipping_state", "select[name='shipping_state']"],
                        stateCode
                    );
                }
            }
            updateAuthoritativeSelection();
            persistCurrentSelection();
            scheduleCacheRefresh("wilaya_change").then(function() {
                return fetchPriceAndUpdate("wilaya_change");
            });
        });
        commune.field.addEventListener("change", function() {
            // Sync native shipping city with selected commune label.
            var selectedOpt = commune.field.options[commune.field.selectedIndex];
            var communeLabel = selectedOpt && selectedOpt.value ? (selectedOpt.textContent || "").trim() : "";
            if (communeLabel) {
                setNativeFieldValue(
                    ["#shipping-city", "#shipping_city", "input[name='shipping_city']"],
                    communeLabel
                );
            }
            updateAuthoritativeSelection();
            schedulePriceRefresh("commune_change");
            persistCurrentSelection();
        });
        office.field.addEventListener("change", function() {
            if (deliveryType !== "stopdesk") {
                return;
            }
            updateAuthoritativeSelection();
            persistCurrentSelection();
            schedulePriceRefresh("office_change");
        });
        [firstName.field, lastName.field, phone.field, homeAddress.field].forEach(function(fieldEl) {
            if (!fieldEl) return;
            fieldEl.addEventListener("input", syncHiddenNativeAddressFields);
            fieldEl.addEventListener("change", syncHiddenNativeAddressFields);
        });
        document.addEventListener("change", function(event) {
            var targetEl = event && event.target;
            if (!targetEl || !targetEl.matches) {
                return;
            }
            if (!event.isTrusted) {
                return;
            }
            if (dzfsSyncingNativeFields || Date.now() < dzfsIgnoreNativeChangesUntil) {
                return;
            }
            if (targetEl.matches("#shipping-state, #shipping_state, select[name='shipping_state'], #billing-state, #billing_state, select[name='billing_state'], #shipping-city, #shipping_city, input[name='shipping_city'], #shipping-address_1, #shipping-address_1, input[name='shipping_address_1'], #billing-address_1, #billing_address_1, input[name='billing_address_1']")) {
                schedulePriceRefresh("native_user_change");
            }
        });

        refreshMethodCardState();
        trySyncWilayaFromNativeState();
        applyPersistedSelectionToFields();
        updateAuthoritativeSelection();
        syncHiddenNativeAddressFields();
        persistCurrentSelection();
        updateSummary();
        startStoreShippingLabelSync();
        bootstrapWilayasIfMissing().then(function() {
            return fetchCacheByWilaya();
        }).then(function() {
            return fetchPriceAndUpdate("initial_mount");
        });

        (function warmTopWilayas() {
            if (String(data.provider || "yalidine").toLowerCase() === "yalidine") {
                return;
            }
            var topWilayas = readWilayaLabels(initialWilayas);
            if (!topWilayas.length) {
                return;
            }

            topWilayas.forEach(function(wilayaId, index) {
                setTimeout(function() {
                    dedupeRequest("prefetch:" + wilayaId, function() {
                        return postForm("dzfs_delivery_cache", { wilayaId: wilayaId }).then(function(result) {
                            var json = result && result.json ? result.json : {};
                            var payload = normalizeDeliveryPayload(json && json.success ? (json.data || {}) : {});
                            writeCachedJSON(getCachedDeliveryKey(wilayaId), payload, DZFS_CACHE_TTL_MS);
                            return payload;
                        });
                    }).catch(function() {
                        return null;
                    });
                }, index * 40);
            });
        })();
    }

    var registerPlugin = window.wp.plugins.registerPlugin;
    var createElement = window.wp.element.createElement;

    registerPlugin("dzfs-checkout-block-integration", {
        scope: "woocommerce-checkout",
        render: function() {
            mountBlockFields();
            return createElement("div", { style: { display: "none" }, "data-dzfs-checkout-block": "1" });
        }
    });

    var observerThrottleTimer = null;
    var observer = new MutationObserver(function(mutations) {
        dzfsTrace("MUTATION_OBSERVER_CALLBACK", {
            mutationCount: Array.isArray(mutations) ? mutations.length : 0
        });
        if (observerThrottleTimer) {
            return;
        }
        observerThrottleTimer = setTimeout(function() {
            observerThrottleTimer = null;
            mountBlockFields();
            normalizeCheckoutSummaryLabels();
        }, DZFS_DOM_THROTTLE_MS);
    });

    observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
    mountBlockFields();
    normalizeCheckoutSummaryLabels();
})(typeof window !== "undefined" ? window : undefined);
