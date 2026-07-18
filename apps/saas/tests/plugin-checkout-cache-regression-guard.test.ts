import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function readWorkspaceFile(relativePathFromRepoRoot: string) {
  const filePath = resolve(process.cwd(), "..", "..", relativePathFromRepoRoot);
  return readFileSync(filePath, "utf8");
}

describe("DZFS checkout cache regression guards", () => {
  it("uses extended timeout and one retry for delivery-cache only", () => {
    const source = readWorkspaceFile("wordpress-plugin/dz-fraud-shield/includes/class-dzfs-api-client.php");

    expect(source).toContain("private function delivery_timeout_seconds() {");
    expect(source).toContain("apply_filters('dzfs_delivery_api_timeout_seconds', 8)");
    expect(source).toContain("usleep(300000);");
    expect(source).toContain("return $this->post($url, $payload, $this->delivery_timeout_seconds());");
  });

  it("treats upstream API failures as explicit ajax errors", () => {
    const source = readWorkspaceFile("wordpress-plugin/dz-fraud-shield/includes/class-dzfs-woocommerce.php");

    expect(source).toContain("public function ajax_delivery_cache() {");
    expect(source).toContain("if (is_wp_error($cache)) {");
    expect(source).toContain("wp_send_json_error(array(");
    expect(source).toContain("'upstream_status' =>");
    expect(source).toContain("'delivery_cache_invalid_response'");
  });

  it("treats empty upstream wilayas as an explicit error", () => {
    const source = readWorkspaceFile("wordpress-plugin/dz-fraud-shield/includes/class-dzfs-woocommerce.php");

    expect(source).toContain("if (empty($wilayas)) {");
    expect(source).toContain("'delivery_cache_empty_wilayas'");
    expect(source).toContain("'Delivery cache did not return wilaya data.'");
  });

  it("keeps previous dropdown data on cache error and locks checkout", () => {
    const source = readWorkspaceFile("wordpress-plugin/dz-fraud-shield/assets/checkout-block.js");
    const fetchCacheStart = source.indexOf("function fetchCacheByWilaya() {");
    const fetchPriceStart = source.indexOf("function fetchPriceAndUpdate(");

    expect(fetchCacheStart).toBeGreaterThan(-1);
    expect(fetchPriceStart).toBeGreaterThan(fetchCacheStart);

    const fetchCacheBody = source.slice(fetchCacheStart, fetchPriceStart);
    const catchStart = fetchCacheBody.indexOf("}).catch(function() {");

    expect(catchStart).toBeGreaterThan(-1);

    const catchBody = fetchCacheBody.slice(catchStart);
    expect(catchBody).toContain("dzfsLastSuccessfulDeliveryPayload");
    expect(catchBody).not.toContain("fillSelect(commune.field, [], \"commune_id\"");
    expect(catchBody).not.toContain("fillSelect(office.field, [], \"office_id\"");

    expect(fetchCacheBody).toContain("console.error(\"DZFS delivery cache failed\"");
    expect(fetchCacheBody).toContain("setCheckoutSubmitDisabled(true);");
  });
});
