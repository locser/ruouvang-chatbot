/**
 * BỘ TEST BỔ SUNG (REGRESSION) — Lớp Unit/Logic thuần
 * File MỚI phục vụ nghiệm thu BOD. KHÔNG sửa code nguồn.
 * Mỗi test gắn mã TC-xxx theo checklist 210 case để truy vết.
 */
import { botDangQuyDoi, chuanHoa } from "./services/priceCheck";
import { assertSafeTranslation } from "./services/claimGuard";
import { routeModel } from "./services/llm";
import { detectMedusaIntent, validateMedusaParams, ALLOWED_CARRIERS } from "./services/medusa";

describe("NHÓM 4 — Bộ soi tiền (Price Checker Firewall)", () => {
  test("TC-076: chặn USD ($) trong kênh VND", () => {
    expect(botDangQuyDoi("Giá khoảng $29 ạ", "VND")).toBe(true);
  });
  test("TC-077: chặn EUR trong kênh VND", () => {
    expect(botDangQuyDoi("29 EUR, khoảng 780k VND", "VND")).toBe(true);
  });
  test("TC-078: chặn từ 'đồng' trong kênh JPY", () => {
    expect(botDangQuyDoi("Tương đương 2.500.000 đồng", "JPY")).toBe(true);
  });
  test("TC-079: chặn ký hiệu ₫ trong kênh EUR", () => {
    expect(botDangQuyDoi("Chỉ khoảng 20₫ thôi ạ", "EUR")).toBe(true);
  });
  test("TC-080: chặn khi có 2 mệnh giá (USD + đ) trong kênh VND", () => {
    expect(botDangQuyDoi("Giá 50 USD và 1.200.000đ ạ", "VND")).toBe(true);
  });
  test("TC-081: cho qua 290.000đ trong kênh VND", () => {
    expect(botDangQuyDoi("Giá 290.000đ ạ", "VND")).toBe(false);
  });
  test("TC-082: cho qua 290.000₫ trong kênh VND", () => {
    expect(botDangQuyDoi("Giá 290.000₫ ạ", "VND")).toBe(false);
  });
  test("TC-083: cho qua 'nghìn đồng' trong kênh VND", () => {
    expect(botDangQuyDoi("Giá 290 nghìn đồng ạ", "VND")).toBe(false);
  });
  test("TC-084: cho qua 29 EUR trong kênh EUR", () => {
    expect(botDangQuyDoi("Giá niêm yết là 29 EUR ạ", "EUR")).toBe(false);
  });
  test("TC-085: KHÔNG phạt nhầm chữ 'được'", () => {
    expect(botDangQuyDoi("Đơn hàng đã được giao rồi ạ", "VND")).toBe(false);
  });
  test("TC-086: KHÔNG phạt nhầm chữ 'đặt'", () => {
    expect(botDangQuyDoi("Sản phẩm đã đặt thành công", "VND")).toBe(false);
  });
  test("TC-087: KHÔNG phạt nhầm chữ 'đã'", () => {
    expect(botDangQuyDoi("Dữ liệu đã được nạp", "VND")).toBe(false);
  });
  test("TC-088: cho qua câu không có giá tệ", () => {
    expect(botDangQuyDoi("Hôm nay trời đẹp quá", "VND")).toBe(false);
  });
  test("TC-093: chuẩn hóa VNĐ -> VND", () => {
    expect(chuanHoa("VNĐ")).toBe("VND");
  });
  test("TC-094: chuẩn hóa $ -> USD", () => {
    expect(chuanHoa("$")).toBe("USD");
  });
  test("TC-095: chuẩn hóa € -> EUR", () => {
    expect(chuanHoa("€")).toBe("EUR");
  });
});

describe("NHÓM 5 — Tường lửa claim (Claim Guard Compliance)", () => {
  const hasBlock = (locale: string, text: string) =>
    assertSafeTranslation(locale, text).some((f) => f.level === "BLOCK");
  const hasReview = (locale: string, text: string) =>
    assertSafeTranslation(locale, text).some((f) => f.level === "REVIEW");

  test("TC-096: chặn 'chữa bệnh' (vi-VN)", () => {
    expect(hasBlock("vi-VN", "Sản phẩm này giúp chữa bệnh tiểu đường")).toBe(true);
  });
  test("TC-097: chặn 'điều trị' (vi-VN)", () => {
    expect(hasBlock("vi-VN", "Men vi sinh này giúp điều trị táo bón")).toBe(true);
  });
  test("TC-098: chặn 'đặc trị' (vi-VN)", () => {
    expect(hasBlock("vi-VN", "Đây là sản phẩm đặc trị đau bao tử")).toBe(true);
  });
  test("TC-099: chặn 'thay thế thuốc' (vi-VN)", () => {
    expect(hasBlock("vi-VN", "Nó có thể thay thế thuốc tây")).toBe(true);
  });
  test("TC-100: chặn cam kết '120 tuổi' (R13, vi-VN)", () => {
    expect(hasBlock("vi-VN", "Dùng giúp bạn sống tới 120 tuổi")).toBe(true);
  });
  test("TC-101: chặn 'probiotics' (en-IE / EU)", () => {
    expect(hasBlock("en-IE", "Our yogurt contains live probiotics")).toBe(true);
  });
  test("TC-102: chặn 'gut health' (en-IE / EU)", () => {
    expect(hasBlock("en-IE", "This product supports your gut health")).toBe(true);
  });
  test("TC-103: chặn 'live cultures' (en-IE / EU)", () => {
    expect(hasBlock("en-IE", "Contains live cultures to boost immunity")).toBe(true);
  });
  test("TC-104: chặn 'cures cancer' (en-US / FDA)", () => {
    expect(hasBlock("en-US", "This cures cancer")).toBe(true);
  });
  test("TC-105: chặn 'FDA approved' (en-US / FDA)", () => {
    expect(hasBlock("en-US", "This product is FDA approved")).toBe(true);
  });
  test("TC-106: 'probiotics' tại Mỹ = REVIEW (không BLOCK)", () => {
    expect(hasReview("en-US", "This contains active probiotics")).toBe(true);
    expect(hasBlock("en-US", "This contains active probiotics")).toBe(false);
  });
  test("TC-107: locale lạ (fr-FR) fallback luật EU nghiêm ngặt -> BLOCK probiotic", () => {
    expect(hasBlock("fr-FR", "Contains active probiotics")).toBe(true);
  });
  test("TC-108: cho phép mô tả 'hỗ trợ tiêu hóa' (vi-VN)", () => {
    expect(hasBlock("vi-VN", "Sản phẩm hỗ trợ tiêu hóa tốt hơn")).toBe(false);
  });
  test("TC-113: regex cờ 'i' vẫn bắt 'Đặc Trị' viết hoa", () => {
    expect(hasBlock("vi-VN", "Đặc Trị Đau Bao Tử")).toBe(true);
  });
  test("TC-114: cho phép mỹ phẩm không claim chữa bệnh", () => {
    expect(hasBlock("vi-VN", "Kem dưỡng ẩm giúp da mềm mịn")).toBe(false);
  });
  test("TC-115: cho phép mô tả thời trang", () => {
    expect(hasBlock("vi-VN", "Áo thun chất liệu cotton 100% thoáng mát")).toBe(false);
  });
});

describe("NHÓM 2 — Định tuyến mô hình (Model Routing)", () => {
  test("TC-032: câu đơn giản -> deepseek-flash", () => {
    expect(routeModel("Áo thun có size L không?")).toBe("deepseek-flash");
  });
  test("TC-033: câu hoàn tiền/hỏng -> claude-sonnet", () => {
    expect(routeModel("Tôi muốn hoàn tiền đơn hàng bị hỏng")).toBe("claude-sonnet");
  });
  test("TC-034: từ khóa 'lừa đảo'/'chất lượng' -> claude-sonnet", () => {
    expect(routeModel("Shop này lừa đảo, chất lượng kém")).toBe("claude-sonnet");
  });
});

describe("NHÓM 3 — Nhận diện intent & validate tham số Medusa", () => {
  test("TC-072: 'tồn kho SKU-8899' -> tra_ton_kho", () => {
    const r = detectMedusaIntent("Cửa hàng còn tồn kho SKU-8899 không");
    expect(r?.toolName).toBe("tra_ton_kho");
    expect(r?.params.sku).toBe("SKU-8899");
  });
  test("TC-073: câu hỏi địa chỉ -> null (không gọi Medusa thừa)", () => {
    expect(detectMedusaIntent("Shop ở địa chỉ nào thế?")).toBeNull();
  });
  test("TC-071 [GAP]: câu tra đơn KHÔNG có từ khóa 'kiểm tra/tra' KHÔNG được nhận diện (khác kỳ vọng checklist)", () => {
    // Ghi nhận hành vi THỰC TẾ: regex yêu cầu tiền tố 'kiểm tra|trạng thái|tra' trước 'đơn'.
    expect(detectMedusaIntent("Đơn DH-1234 của anh đi tới đâu rồi e")).toBeNull();
  });
  test("TC-058: chốt đơn quantity 150 (>100) -> invalid", () => {
    const v = validateMedusaParams("chot_don", { orderId: "o1", lineItemId: "l1", sku: "S1", quantity: 150, carrier: "ghn" });
    expect(v.valid).toBe(false);
  });
  test("TC-059: chốt đơn carrier sai -> invalid", () => {
    const v = validateMedusaParams("chot_don", { orderId: "o1", lineItemId: "l1", sku: "S1", quantity: 2, carrier: "invalid_express" });
    expect(v.valid).toBe(false);
  });
  test("TC-060..065: 6 hãng hợp lệ đều pass (ghn/ghtk/ninjavan/vtp/vnpost/jt)", () => {
    for (const c of ALLOWED_CARRIERS) {
      const v = validateMedusaParams("chot_don", { orderId: "o1", lineItemId: "l1", sku: "S1", quantity: 2, carrier: c });
      expect(v.valid).toBe(true);
    }
  });
});
