import { hashPassword, verifyPassword, verifyTelegramSignature } from "./services/auth";

describe("VPH AI ChatBot Authentication Services", () => {
  describe("1. Password Hashing (PBKDF2)", () => {
    it("should correctly hash and verify password", () => {
      const password = "mySecurePassword123";
      const hash = hashPassword(password);
      
      expect(hash).toContain(":");
      expect(verifyPassword(password, hash)).toBe(true);
    });

    it("should reject incorrect passwords", () => {
      const password = "mySecurePassword123";
      const hash = hashPassword(password);
      
      expect(verifyPassword("wrongPassword", hash)).toBe(false);
    });
  });

  describe("2. Telegram WebApp Signature Verification", () => {
    const testBotToken = "543216789:ABCdefGhIJKlmNoPQRsTUVwxyZ";

    it("should allow bypass under development settings if initData starts with bypass_tg_", () => {
      const result = verifyTelegramSignature("bypass_tg_test", testBotToken);
      expect(result).toBe(true);
    });

    it("should reject invalid/empty signature data", () => {
      const result = verifyTelegramSignature("user=abc", testBotToken);
      expect(result).toBe(false);
    });
  });
});
