/**
 * LỚP KIỂM CHỨNG PHÍA SERVER cho mọi lời gọi tool của LLM.
 *
 * Nguyên tắc: KHÔNG TIN THAM SỐ MÔ HÌNH SINH RA, kể cả khi khớp JSON Schema.
 * Schema chỉ bảo đảm đúng KIỂU; nó không bảo đảm SKU có thật, số lượng hợp lý,
 * hay khách đã thực sự đồng ý chốt đơn.
 *
 * Mọi ràng buộc ở đây đều xuất phát từ sự cố có thật trong production:
 *  - LLM bịa SKU theo pattern trong ví dụ của prompt → đơn hàng thất bại im lặng
 *  - "thêm 2 hộp nữa" khi giỏ có 5 → giỏ tụt xuống 2 (trừ mất hàng)
 *  - Số lượng 0 bị `|| 1` biến thành 1 món
 *  - Regex đoán ý khách khớp cả chữ "đâu" → tự động chốt đơn thật
 *
 * Xem TechUpdate/05_AI_AGENT_TOOLCALLING.md §3.
 */

export const TEN_TOOL_HOP_LE = [
  "search_products",
  "get_product_detail",
  "compare_products",
  "set_cart_item",
  "remove_cart_item",
  "clear_cart",
  "set_shipping_info",
  "checkout",
  "get_order_status",
  "escalate_to_human",
  "save_lead",
  "get_store_locations",
] as const;

export type TenTool = (typeof TEN_TOOL_HOP_LE)[number];

export const GIOI_HAN = {
  /** Số lượng tối đa cho một SKU trong giỏ. Chặn "đặt 9999 cái" làm cạn kho ảo. */
  SO_LUONG_TOI_DA: 100,
  /** Số tool call tối đa trong một lượt. Chặn vòng lặp vô hạn. */
  TOOL_CALL_MOI_LUOT: 5,
  /** Số sản phẩm tối đa trong một lần so sánh. */
  SO_SANH_TOI_DA: 3,
} as const;

export type KetQuaKiemChung<T> =
  | { hopLe: true; duLieu: T }
  | { hopLe: false; ly_do: string; thongDiepChoKhach: string; maLoi: string };

function tuChoi(maLoi: string, ly_do: string, thongDiepChoKhach: string): KetQuaKiemChung<never> {
  return { hopLe: false, maLoi, ly_do, thongDiepChoKhach };
}

// ---------------------------------------------------------------------------
// Tên tool
// ---------------------------------------------------------------------------
export function kiemTraTenTool(ten: string): KetQuaKiemChung<TenTool> {
  if ((TEN_TOOL_HOP_LE as readonly string[]).includes(ten)) {
    return { hopLe: true, duLieu: ten as TenTool };
  }
  return tuChoi(
    "TOOL_KHONG_HOP_LE",
    `Tool "${ten}" không nằm trong danh sách cho phép`,
    "Dạ em chưa hỗ trợ thao tác này ạ. Anh/chị cho em xin thêm thông tin nhé!"
  );
}

// ---------------------------------------------------------------------------
// Số lượng — quy tắc TUYỆT ĐỐI (ADR-007)
// ---------------------------------------------------------------------------
export interface SoLuongDaChuanHoa {
  soLuong: number;
  /** true = khách muốn bỏ món khỏi giỏ (số lượng 0). */
  laXoaMon: boolean;
}

/**
 * `quantity` LUÔN là tổng số lượng cuối cùng, không phải phần tăng thêm.
 *
 * Không dùng `Number(x) || 1`: biểu thức đó biến 0 thành 1 (khách muốn bỏ món
 * lại thành đặt 1 món) và cho lọt số âm vì -5 là truthy.
 */
export function chuanHoaSoLuong(thoTuc: unknown): KetQuaKiemChung<SoLuongDaChuanHoa> {
  const n = typeof thoTuc === "number" ? thoTuc : Number(thoTuc);

  if (!Number.isFinite(n)) {
    return tuChoi(
      "SO_LUONG_KHONG_HOP_LE",
      `quantity không phải số: ${JSON.stringify(thoTuc)}`,
      "Dạ anh/chị cho em xin lại số lượng cụ thể giúp em nhé!"
    );
  }
  if (!Number.isInteger(n)) {
    return tuChoi(
      "SO_LUONG_KHONG_NGUYEN",
      `quantity không phải số nguyên: ${n}`,
      "Dạ số lượng cần là số nguyên ạ. Anh/chị lấy mấy cái ạ?"
    );
  }
  if (n < 0) {
    return tuChoi(
      "SO_LUONG_AM",
      `quantity âm: ${n}`,
      "Dạ anh/chị cho em xin lại số lượng giúp em nhé!"
    );
  }
  if (n === 0) return { hopLe: true, duLieu: { soLuong: 0, laXoaMon: true } };

  if (n > GIOI_HAN.SO_LUONG_TOI_DA) {
    return tuChoi(
      "SO_LUONG_VUOT_TRAN",
      `quantity ${n} vượt trần ${GIOI_HAN.SO_LUONG_TOI_DA}`,
      `Dạ đơn số lượng lớn (trên ${GIOI_HAN.SO_LUONG_TOI_DA}) em xin phép chuyển nhân viên báo giá sỉ cho anh/chị ạ!`
    );
  }
  return { hopLe: true, duLieu: { soLuong: n, laXoaMon: false } };
}

// ---------------------------------------------------------------------------
// SKU — chặn LLM bịa mã
// ---------------------------------------------------------------------------
export function kiemTraDinhDangSku(sku: unknown): KetQuaKiemChung<string> {
  if (typeof sku !== "string" || sku.trim().length === 0) {
    return tuChoi("SKU_RONG", "SKU rỗng hoặc không phải chuỗi", "Dạ anh/chị cho em xin lại tên sản phẩm giúp em nhé!");
  }
  const s = sku.trim();
  if (s.length > 64 || !/^[A-Za-z0-9._-]+$/.test(s)) {
    return tuChoi("SKU_SAI_DINH_DANG", `SKU sai định dạng: ${s}`, "Dạ em chưa tìm thấy sản phẩm này ạ. Anh/chị cho em xin lại tên sản phẩm nhé!");
  }
  return { hopLe: true, duLieu: s };
}

/**
 * Đối chiếu SKU với danh sách có thật của tenant.
 *
 * Đây là chốt chặn quan trọng nhất chống ảo giác. Prompt hệ thống có ví dụ
 * chứa SKU thật, nên mô hình rất dễ sinh mã theo cùng pattern nhưng không tồn
 * tại. Nếu không chặn ở đây, khách sẽ nghe "em đã thêm vào giỏ" trong khi giỏ
 * vẫn trống.
 */
export function kiemTraSkuCoThat(sku: string, skuHopLe: Set<string>): KetQuaKiemChung<string> {
  if (skuHopLe.has(sku)) return { hopLe: true, duLieu: sku };
  return tuChoi(
    "SKU_BIA",
    `SKU "${sku}" không tồn tại trong danh mục của tenant — nghi ngờ mô hình bịa mã`,
    "Dạ em xin lỗi, em chưa tìm thấy đúng sản phẩm này ạ. Anh/chị cho em xin lại tên sản phẩm để em kiểm tra nhé!"
  );
}

/**
 * Kiểm tra số lượng khách muốn mua so với tồn kho thật.
 *
 * `khongGioiHan = true` dành cho biến thể đặt `manage_inventory = false` trong
 * Medusa — nghĩa là "luôn bán được, không theo dõi số lượng". Những biến thể
 * này không có bản ghi tồn kho nên `tonKho` luôn về 0; nếu so số lượng như
 * thường thì bot từ chối bán MỌI sản phẩm. Ngày 04/08/2026 lỗi này chặn cả
 * 7.869 sản phẩm của shop Hasaki.
 */
export function kiemTraTonKho(
  soLuong: number,
  tonKho: number | null,
  khongGioiHan = false
): KetQuaKiemChung<number> {
  if (khongGioiHan) return { hopLe: true, duLieu: soLuong };
  if (tonKho === null) {
    return tuChoi(
      "THIEU_DU_LIEU_TON_KHO",
      "Không đọc được tồn kho thật từ Medusa",
      "Dạ em đang kiểm tra lại tồn kho, anh/chị đợi em một chút hoặc để em chuyển nhân viên hỗ trợ ngay ạ!"
    );
  }
  if (soLuong > tonKho) {
    return tuChoi(
      "VUOT_TON_KHO",
      `Yêu cầu ${soLuong} nhưng chỉ còn ${tonKho}`,
      tonKho > 0
        ? `Dạ sản phẩm này hiện chỉ còn ${tonKho} ạ. Anh/chị lấy ${tonKho} nhé?`
        : "Dạ sản phẩm này vừa hết hàng ạ. Em giới thiệu anh/chị mẫu tương tự nhé!"
    );
  }
  return { hopLe: true, duLieu: soLuong };
}

// ---------------------------------------------------------------------------
// Số điện thoại Việt Nam
// ---------------------------------------------------------------------------
export function chuanHoaSoDienThoai(sdt: unknown): KetQuaKiemChung<string> {
  if (typeof sdt !== "string") {
    return tuChoi("SDT_RONG", "SĐT không phải chuỗi", "Dạ anh/chị cho em xin số điện thoại nhận hàng nhé!");
  }
  let s = sdt.replace(/[\s.\-()]/g, "");
  if (s.startsWith("+84")) s = "0" + s.slice(3);
  else if (s.startsWith("84") && s.length >= 11) s = "0" + s.slice(2);

  if (!/^0[35789]\d{8}$/.test(s)) {
    return tuChoi(
      "SDT_SAI_DINH_DANG",
      `SĐT không hợp lệ: ${sdt}`,
      "Dạ số điện thoại chưa đúng định dạng ạ. Anh/chị cho em xin lại số 10 chữ số giúp em nhé!"
    );
  }
  return { hopLe: true, duLieu: s };
}

/**
 * SĐT khách tiềm năng — dễ hơn SĐT giao hàng, chỉ chặn số RÁC rõ ràng.
 *
 * Nhận số di động (03/05/07/08/09, 10 số) và số máy bàn (02x, 11 số), chịu được
 * dấu cách, chấm, gạch, +84. Loại: sai độ dài/đầu số, và số khách gõ bừa như
 * 0900000000 (lặp một chữ số), 0912345678 / 0987654321 (dãy tăng giảm dần),
 * 0909090909 (lặp một cặp). Cố ý KHÔNG chặn số đẹp thật như 0988668866.
 */
export function chuanHoaSdtKhachTiemNang(sdt: unknown): KetQuaKiemChung<string> {
  const tuChoiSdt = (lyDo: string) =>
    tuChoi(
      "SDT_KHONG_HOP_LE",
      lyDo,
      "Dạ số này em chưa ghi nhận được ạ. Nếu anh/chị tiện thì kiểm tra lại giúp em, còn không thì mình cứ tiếp tục nhé!"
    );
  if (typeof sdt !== "string") return tuChoiSdt("SĐT không phải chuỗi");

  let s = sdt.replace(/[\s.\-()]/g, "");
  if (s.startsWith("+84")) s = "0" + s.slice(3);
  else if (s.startsWith("84") && s.length >= 11) s = "0" + s.slice(2);

  if (!/^(0[35789]\d{8}|02\d{9})$/.test(s)) return tuChoiSdt(`Sai độ dài hoặc đầu số: ${sdt}`);

  const phanSo = s.slice(2); // bỏ đầu số 0x để mẫu của nhà mạng không bị tính là "lặp"
  if (/(\d)\1{5,}/.test(phanSo)) return tuChoiSdt("Lặp một chữ số quá nhiều");
  if (/(\d\d)\1{2,}/.test(phanSo)) return tuChoiSdt("Lặp một cặp số (090909…)");
  const tang = "0123456789";
  const giam = "9876543210";
  for (let i = 0; i + 6 <= s.length; i++) {
    const doan = s.slice(i, i + 6);
    if (tang.includes(doan) || giam.includes(doan)) return tuChoiSdt("Dãy số tăng/giảm dần");
  }
  return { hopLe: true, duLieu: s };
}

// ---------------------------------------------------------------------------
// Điều kiện tiên quyết để chốt đơn (tài liệu 05 §4)
// ---------------------------------------------------------------------------
export interface TrangThaiDonHang {
  soMonTrongGio: number;
  coSoDienThoai: boolean;
  coDiaChi: boolean;
  coTenNguoiNhan: boolean;
  /** Khách đã xác nhận chốt đơn RÕ RÀNG ngay trong lượt này. */
  khachDaXacNhan: boolean;
  /** Cửa hàng đã cấu hình tài khoản ngân hàng. */
  shopCoTaiKhoanNganHang: boolean;
  /** Món hết hàng phát hiện tại thời điểm chốt. */
  monHetHang: string[];
  /** Tổng tiền lệch so với con số vừa báo khách (0 = khớp). */
  lechTien: number;
}

export function kiemTraDuDieuKienChotDon(t: TrangThaiDonHang): KetQuaKiemChung<true> {
  if (t.soMonTrongGio <= 0) {
    return tuChoi("GIO_TRONG", "Giỏ hàng trống", "Dạ giỏ hàng của anh/chị đang trống ạ. Anh/chị muốn đặt sản phẩm nào để em thêm vào giúp nhé?");
  }
  if (!t.coSoDienThoai) {
    return tuChoi("THIEU_SDT", "Chưa có SĐT", "Dạ anh/chị cho em xin số điện thoại nhận hàng để em chốt đơn nhé!");
  }
  if (!t.coDiaChi) {
    return tuChoi("THIEU_DIA_CHI", "Chưa có địa chỉ", "Dạ anh/chị cho em xin địa chỉ nhận hàng giúp em nhé!");
  }
  if (!t.coTenNguoiNhan) {
    return tuChoi("THIEU_TEN", "Chưa có tên người nhận", "Dạ anh/chị cho em xin tên người nhận hàng nhé!");
  }
  if (t.monHetHang.length > 0) {
    return tuChoi(
      "MON_HET_HANG",
      `Hết hàng: ${t.monHetHang.join(", ")}`,
      `Dạ rất tiếc, ${t.monHetHang.join(", ")} vừa hết hàng ạ. Anh/chị muốn bỏ ra hay đổi sang mẫu khác giúp em nhé?`
    );
  }
  if (t.lechTien !== 0) {
    return tuChoi(
      "LECH_GIA",
      `Giá đã thay đổi ${t.lechTien}đ so với lúc báo khách`,
      "Dạ giá vừa có thay đổi ạ. Em xin phép báo lại giá mới để anh/chị xác nhận trước khi chốt nhé!"
    );
  }
  if (!t.shopCoTaiKhoanNganHang) {
    return tuChoi(
      "SHOP_CHUA_CAU_HINH_NGAN_HANG",
      "Tenant chưa cấu hình tài khoản ngân hàng",
      "Dạ em xin phép chuyển anh/chị tới nhân viên để hoàn tất thanh toán ngay ạ!"
    );
  }
  // Điều kiện cuối cùng và quan trọng nhất: khách phải đồng ý rõ ràng.
  // Ngày 28/07/2026 một guard đoán ý bằng regex khớp cả chữ "đâu" khiến câu
  // "shop ở đâu vậy em?" tạo đơn hàng thật. Việc chốt đơn CHỈ được đến từ
  // tool call tường minh cộng xác nhận rõ ràng của khách.
  if (!t.khachDaXacNhan) {
    return tuChoi(
      "CHUA_XAC_NHAN",
      "Khách chưa xác nhận chốt đơn trong lượt này",
      "Dạ anh/chị xác nhận giúp em là chốt đơn này nhé, em gửi mã QR thanh toán ngay ạ!"
    );
  }
  return { hopLe: true, duLieu: true };
}

// ---------------------------------------------------------------------------
// Chống vòng lặp
// ---------------------------------------------------------------------------
export function kiemTraSoLuongToolCall(soLuong: number): KetQuaKiemChung<number> {
  if (soLuong > GIOI_HAN.TOOL_CALL_MOI_LUOT) {
    return tuChoi(
      "QUA_NHIEU_TOOL_CALL",
      `${soLuong} tool call trong một lượt, vượt trần ${GIOI_HAN.TOOL_CALL_MOI_LUOT}`,
      "Dạ để em chuyển anh/chị tới nhân viên tư vấn cho nhanh ạ!"
    );
  }
  return { hopLe: true, duLieu: soLuong };
}

export function kiemTraDanhSachSoSanh(ids: unknown): KetQuaKiemChung<string[]> {
  if (!Array.isArray(ids) || ids.length < 2) {
    return tuChoi("SO_SANH_THIEU", "Cần ít nhất 2 sản phẩm để so sánh", "Dạ anh/chị cho em biết muốn so sánh những sản phẩm nào ạ?");
  }
  if (ids.length > GIOI_HAN.SO_SANH_TOI_DA) {
    return tuChoi(
      "SO_SANH_QUA_NHIEU",
      `So sánh ${ids.length} sản phẩm, vượt trần ${GIOI_HAN.SO_SANH_TOI_DA}`,
      `Dạ em so sánh tối đa ${GIOI_HAN.SO_SANH_TOI_DA} sản phẩm một lần cho dễ nhìn ạ!`
    );
  }
  const sach = ids.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
  if (sach.length !== ids.length) {
    return tuChoi("SO_SANH_ID_SAI", "Danh sách chứa ID không hợp lệ", "Dạ anh/chị cho em biết muốn so sánh sản phẩm nào ạ?");
  }
  return { hopLe: true, duLieu: sach };
}
