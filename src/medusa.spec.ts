import { detectMedusaIntent, validateMedusaParams, ALLOWED_CARRIERS } from "./services/medusa";

describe("Medusa Integration Service Tests", () => {
  describe("1. Intent Detection", () => {
    it("should detect order lookup intent", () => {
      const result = detectMedusaIntent("Anh muốn kiểm tra đơn hàng DH-998811");
      expect(result).not.toBeNull();
      expect(result?.toolName).toBe("tra_don");
      expect(result?.params.orderId).toBe("DH-998811");
    });

    it("should detect inventory check intent", () => {
      const result = detectMedusaIntent("Cho hỏi tồn kho SKU-MEN-TOI-01 còn bao nhiêu?");
      expect(result).not.toBeNull();
      expect(result?.toolName).toBe("tra_ton_kho");
      expect(result?.params.sku).toBe("SKU-MEN-TOI-01");
    });

    it("should return null for non-Medusa general queries", () => {
      const result = detectMedusaIntent("Shop có mở cửa ngày chủ nhật không?");
      expect(result).toBeNull();
    });
  });

  describe("2. Parameter Validation & Constraints", () => {
    it("should validate order lookup required parameters", () => {
      const val = validateMedusaParams("tra_don", {});
      expect(val.valid).toBe(false);
      expect(val.errors[0]).toContain("Thiếu tham số bắt buộc");
    });

    it("should reject chot_don if carrier is invalid", () => {
      const val = validateMedusaParams("chot_don", {
        orderId: "ord_1",
        lineItemId: "li_1",
        sku: "SKU1",
        quantity: 5,
        carrier: "invalid_carrier",
      });
      expect(val.valid).toBe(false);
      expect(val.errors[0]).toContain("Hãng giao hàng \"invalid_carrier\" không hợp lệ");
    });

    it("should reject chot_don if quantity exceeds 100 limit", () => {
      const val = validateMedusaParams("chot_don", {
        orderId: "ord_1",
        lineItemId: "li_1",
        sku: "SKU1",
        quantity: 150,
        carrier: "ghn",
      });
      expect(val.valid).toBe(false);
      expect(val.errors[0]).toContain("vượt quá hạn mức tự động");
    });

    it("should approve valid chot_don request", () => {
      const val = validateMedusaParams("chot_don", {
        orderId: "ord_1",
        lineItemId: "li_1",
        sku: "SKU1",
        quantity: 2,
        carrier: "ghn",
      });
      expect(val.valid).toBe(true);
      expect(val.errors.length).toBe(0);
    });
  });
});
