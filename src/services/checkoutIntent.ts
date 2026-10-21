/**
 * Nhận diện ý định chốt đơn / xin mã QR của khách.
 *
 * Tách riêng khỏi index.ts để CÓ THỂ UNIT TEST được — đây chính là chỗ đã gây
 * sự cố "bot tự chốt đơn khi khách nói từ đâu" (regex cũ có nhánh `|đâu` đứng
 * một mình, khớp cả "shop ở đâu vậy em?").
 *
 * NGUYÊN TẮC KHI SỬA FILE NÀY:
 *  - Tuyệt đối KHÔNG thêm từ đơn lẻ phổ thông (đâu, ok, ừ, thanh toán...).
 *  - Chỉ thêm CỤM TỪ đầy đủ, và phải bổ sung test vào checkout-intent.spec.ts.
 */

// Khách chủ động xin mã QR hoặc xác nhận chốt đơn
export const KHACH_MUON_CHOT =
  /(qr\s*code|qrcode|mã\s*qr|gửi\s*qr)|((chốt|xác\s*nhận)\s*(đơn|mua))|(chuyển\s*khoản\s*(thế\s*nào|sao|ra\s*sao|ở\s*đâu|vào\s*đâu|đi|nhé|nha))/i;

// Bot đã hứa gửi QR trong câu trả lời nhưng quên xuất thẻ <cart_action>
export const BOT_HUA_GUI_QR =
  /gửi mã qr|mã qr thanh toán|quét mã qr|gửi qrcode|thanh toán cho nhân viên/i;

export function khachMuonChotDon(text: string): boolean {
  return KHACH_MUON_CHOT.test(text || "");
}

export function botHuaGuiQr(responseText: string): boolean {
  return BOT_HUA_GUI_QR.test(responseText || "");
}
