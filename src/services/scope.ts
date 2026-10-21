/**
 * Domain guard phía server: chặn câu ngoài phạm vi rượu và đơn hàng TRƯỚC khi
 * gọi kịch bản cứng hay LLM. Không chỉ dựa vào prompt (CHATBOT_DEPLOYMENT_PLAN P0).
 *
 * Chỉ là danh sách CHẶN (deny-list), không phải danh sách CHO PHÉP, để lời chào
 * và câu hỏi chung chung vẫn đi qua tới LLM. Chuẩn hoá bỏ dấu trước khi so khớp,
 * nên "lập trình", "lap trinh", "Lập Trình" đều bắt được.
 */

export const CAU_NGOAI_PHAM_VI = "Dạ em chỉ hỗ trợ tư vấn sản phẩm rượu và đơn hàng của cửa hàng ạ.";

export type KetQuaPhamVi =
  | { loai: "trong_pham_vi" }
  | { loai: "ngoai_pham_vi"; traLoi: string }
  | { loai: "chua_du_tuoi"; traLoi: string }
  // Sức khỏe / pháp lý: không trả lời, chuyển nhân viên (xử lý cùng nhánh chuyển người).
  | { loai: "chuyen_nguoi" };

/** Bỏ dấu tiếng Việt, đổi đ → d, hạ chữ thường, gom khoảng trắng. */
export function chuanHoaKhongDau(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "d")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

const MAU_NGOAI_PHAM_VI: RegExp[] = [
  // Lập trình
  /\b(python|javascript|typescript|java|sql|html|css|react|viet code|lap trinh|viet (mot )?(ham|chuong trinh|script))\b/,
  // Toán
  /\b(giai (bai )?toan|phuong trinh|tich phan|dao ham|bai toan)\b/,
  // Tin tức, tài chính, thời tiết, thể thao, chính trị
  /\b(thoi tiet|bong da|chung khoan|bitcoin|tien ao|chinh tri|thoi su|ty gia|gia vang)\b/,
];

const MAU_CHUA_DU_TUOI = /\b(hoc sinh|cap (1|2|3)|tre em)\b/;

/** "15 tuổi", "mười sáu tuổi" không xét ở đây; chỉ bắt dạng số. */
const MAU_TUOI = /\b(\d{1,2})\s*(tuoi)\b/g;

const MAU_SUC_KHOE_PHAP_LY = [
  /\b(suc khoe|benh|chua benh|thuoc|mang thai|co thai|tieu duong|huyet ap|di ung|ung thu|tim mach)\b/,
  /\bdau (bung|dau|nguc|lung|hong)\b/,
  /\b(phap ly|phap luat|luat su|to cao|khieu nai)\b/,
];

/**
 * Trả về "trong_pham_vi" khi không có dấu hiệu ngoài phạm vi.
 * Thứ tự kiểm tra: tuổi (ưu tiên cao nhất, có quy định pháp luật) → ngoài phạm vi
 * → sức khỏe/pháp lý.
 */
export function danhGiaPhamVi(text: string): KetQuaPhamVi {
  const t = chuanHoaKhongDau(text);

  if (MAU_CHUA_DU_TUOI.test(t)) {
    return { loai: "chua_du_tuoi", traLoi: "Dạ em xin lỗi, em chỉ bán rượu cho khách từ đủ 18 tuổi ạ." };
  }
  for (const m of t.matchAll(MAU_TUOI)) {
    if (Number(m[1]) < 18) {
      return { loai: "chua_du_tuoi", traLoi: "Dạ em xin lỗi, em chỉ bán rượu cho khách từ đủ 18 tuổi ạ." };
    }
  }

  if (MAU_NGOAI_PHAM_VI.some((r) => r.test(t))) {
    return { loai: "ngoai_pham_vi", traLoi: CAU_NGOAI_PHAM_VI };
  }

  if (MAU_SUC_KHOE_PHAP_LY.some((r) => r.test(t))) {
    return { loai: "chuyen_nguoi" };
  }

  return { loai: "trong_pham_vi" };
}
