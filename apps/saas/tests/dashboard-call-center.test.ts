import { describe, expect, it } from "vitest";
import { buildWhatsAppUrl, deriveCallCenterQueue } from "@/lib/dashboard-call-center";

describe("dashboard call center helpers", () => {
  it("prefers final merchant decisions over transient call events", () => {
    expect(deriveCallCenterQueue({ decision: "ACCEPTED", lastEventType: "call_center_no_answer" })).toBe("CONFIRMED");
    expect(deriveCallCenterQueue({ decision: "BLOCKED", lastEventType: "call_center_call_later" })).toBe("REFUSED");
  });

  it("maps transient call events when no final decision exists", () => {
    expect(deriveCallCenterQueue({ lastEventType: "call_center_call_later" })).toBe("CALL_LATER");
    expect(deriveCallCenterQueue({ lastEventType: "call_center_no_answer" })).toBe("NO_ANSWER");
    expect(deriveCallCenterQueue({})).toBe("NEW");
  });

  it("normalizes WhatsApp links for Algerian phone formats", () => {
    expect(buildWhatsAppUrl("0550 12 34 56")).toBe("https://wa.me/213550123456");
    expect(buildWhatsAppUrl("+213 550 12 34 56")).toBe("https://wa.me/213550123456");
  });
});
