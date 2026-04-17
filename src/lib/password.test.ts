import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password.js";

describe("hashPassword", () => {
  it("returns a string in the form salt:hash", () => {
    const result = hashPassword("mySecret");
    const parts = result.split(":");
    expect(parts).toHaveLength(2);
    const [salt, hash] = parts as [string, string];
    expect(salt.length).toBeGreaterThan(0);
    expect(hash.length).toBeGreaterThan(0);
  });

  it("produces different outputs for the same password (random salt)", () => {
    const h1 = hashPassword("samePassword");
    const h2 = hashPassword("samePassword");
    expect(h1).not.toBe(h2);
  });

  it("produces a deterministically long hash (64 bytes = 128 hex chars)", () => {
    const result = hashPassword("test");
    const [, hash] = result.split(":");
    // KEYLEN=64 → 128 hex chars
    expect(hash).toHaveLength(128);
  });
});

describe("verifyPassword", () => {
  it("verifies a correct password against its hash", () => {
    const password = "CorrectHorseBatteryStaple";
    const stored = hashPassword(password);
    expect(verifyPassword(password, stored)).toBe(true);
  });

  it("rejects an incorrect password", () => {
    const stored = hashPassword("realPassword");
    expect(verifyPassword("wrongPassword", stored)).toBe(false);
  });

  it("returns false for an empty stored hash", () => {
    expect(verifyPassword("anything", "")).toBe(false);
  });

  it("returns false when stored hash has no colon separator", () => {
    expect(verifyPassword("anything", "nocolonhere")).toBe(false);
  });

  it("returns false when password is empty string", () => {
    const stored = hashPassword("notEmpty");
    expect(verifyPassword("", stored)).toBe(false);
  });

  it("round-trips multiple different passwords correctly", () => {
    const passwords = ["alpha", "beta123!", "กขค", "a".repeat(100)];
    for (const pw of passwords) {
      const stored = hashPassword(pw);
      expect(verifyPassword(pw, stored)).toBe(true);
      expect(verifyPassword(pw + "x", stored)).toBe(false);
    }
  });
});
