import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

function readPluginFile(relativePath: string): string {
  const absolutePath = path.resolve(process.cwd(), "..", "..", "wordpress-plugin", "dz-fraud-shield", relativePath);
  return fs.readFileSync(absolutePath, "utf8");
}

describe("Woo plugin auto-block defaults", () => {
  it("keeps helper default auto_block disabled", () => {
    const helpersPhp = readPluginFile(path.join("includes", "class-dzfs-helpers.php"));
    expect(helpersPhp).toContain("return self::get_option('auto_block', 'no') === 'yes';");
  });

  it("keeps settings sanitize/reset defaults auto_block disabled", () => {
    const settingsPhp = readPluginFile(path.join("includes", "class-dzfs-settings.php"));
    expect(settingsPhp).toContain("'auto_block' => DZFS_Helpers::get_option('auto_block', 'no')");
    expect(settingsPhp).toContain("'auto_block' => !empty($input['auto_block']) ? 'yes' : 'no'");
  });

  it("keeps onboarding bootstrap default auto_block disabled", () => {
    const onboardingPhp = readPluginFile(path.join("includes", "class-dzfs-onboarding.php"));
    expect(onboardingPhp).toContain("$settings['auto_block'] = 'no';");
  });

  it("requires explicit auto-block before failing a BLOCK risk order", () => {
    const woocommercePhp = readPluginFile(path.join("includes", "class-dzfs-woocommerce.php"));
    expect(woocommercePhp).toContain("if (DZFS_Helpers::auto_block_enabled()) {");
    expect(woocommercePhp).toContain("$order->update_status('on-hold', 'DZ Fraud Shield marked this order BLOCK risk. Manual merchant decision required.');");
  });

  it("keeps short default timeout and extended delivery timeout", () => {
    const apiClientPhp = readPluginFile(path.join("includes", "class-dzfs-api-client.php"));
    expect(apiClientPhp).toContain("apply_filters('dzfs_api_timeout_seconds', 2)");
    expect(apiClientPhp).toContain("apply_filters('dzfs_delivery_api_timeout_seconds', 8)");
    expect(apiClientPhp).toContain("usleep(300000);");
  });

  it("adds deferred risk check note when SaaS is unavailable", () => {
    const woocommercePhp = readPluginFile(path.join("includes", "class-dzfs-woocommerce.php"));
    expect(woocommercePhp).toContain("Risk check deferred because SaaS is temporarily unavailable");
  });
});
