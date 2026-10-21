/**
 * TEST HỒI QUY cho sự cố 2026-07-28: bot TỰ ĐỘNG CHỐT ĐƠN khi khách chỉ nói
 * một câu bình thường có chứa từ "đâu" (regex guard cũ có nhánh `|đâu` đứng riêng).
 *
 * Bất kỳ ai sửa services/checkoutIntent.ts đều phải giữ bộ test này xanh.
 */
import { khachMuonChotDon, botHuaGuiQr } from "./services/checkoutIntent";

describe("checkoutIntent — KHÔNG được tự chốt đơn với câu hỏi bình thường", () => {
  const KHONG_DUOC_CHOT = [
    "shop ở đâu vậy em?",
    "bánh nậm làm từ đâu?",
    "giao hàng tới đâu ạ",
    "sao chưa thấy đâu",
    "anh chưa đặt gì đâu em",
    "shop mình có mấy hình thức thanh toán?",
    "thanh toán khi nhận hàng được không em",
    "cho anh hỏi giá bao nhiêu",
    "còn hàng không em",
    "ok em",
    "ừ",
    "đâu",
  ];

  test.each(KHONG_DUOC_CHOT)("KHÔNG chốt đơn: %s", (cau) => {
    expect(khachMuonChotDon(cau)).toBe(false);
  });
});

describe("checkoutIntent — PHẢI nhận diện đúng ý định chốt đơn", () => {
  const PHAI_CHOT = [
    "qr code đâu em",
    "gửi mã QR cho anh",
    "cho anh xin qrcode thanh toán",
    "chốt đơn đi em",
    "ok chốt đơn nhé",
    "anh xác nhận mua",
    "chuyển khoản thế nào em",
    "chuyển khoản vào đâu vậy",
  ];

  test.each(PHAI_CHOT)("CHỐT ĐƠN: %s", (cau) => {
    expect(khachMuonChotDon(cau)).toBe(true);
  });
});

describe("checkoutIntent — bot hứa gửi QR nhưng quên xuất thẻ", () => {
  test("nhận diện câu bot hứa gửi QR", () => {
    expect(botHuaGuiQr("Dạ em gửi mã qr thanh toán cho anh ngay ạ!")).toBe(true);
  });
  test("câu tư vấn thường không kích hoạt", () => {
    expect(botHuaGuiQr("Dạ bánh nậm chay còn hàng ạ, giá 2.500đ/cái.")).toBe(false);
  });
});
