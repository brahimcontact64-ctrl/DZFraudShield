import { describe, expect, it } from "vitest";
import { normalizeAlgerianPhone } from "@/lib/security/phone";

describe("normalizeAlgerianPhone", () => {
  it("normalizes local 0 format", () => {
    expect(normalizeAlgerianPhone("0555123456")).toBe("+213555123456");
  });

  it("normalizes +213 format", () => {
    expect(normalizeAlgerianPhone("+213661234567")).toBe("+213661234567");
  });

  it("normalizes 00213 format", () => {
    expect(normalizeAlgerianPhone("00213771234567")).toBe("+213771234567");
  });

  it("rejects non mobile prefixes", () => {
    expect(normalizeAlgerianPhone("0212345678")).toBeNull();
  });

  it("rejects invalid length", () => {
    expect(normalizeAlgerianPhone("05551234")).toBeNull();
  });

  it("maps all required ZR input formats to one identity phone", () => {
    const expected = "+213662255853";
    expect(normalizeAlgerianPhone("0662255853")).toBe(expected);
    expect(normalizeAlgerianPhone("662255853")).toBe(expected);
    expect(normalizeAlgerianPhone("213662255853")).toBe(expected);
    expect(normalizeAlgerianPhone("+213662255853")).toBe(expected);
  });
});
