import QRCode from "qrcode";

/**
 * Tự sinh mã VietQR (chuẩn NAPAS 247, chuyển tới số tài khoản) thay vì nhờ img.vietqr.io.
 *
 * Lý do: QR của img.vietqr.io là "QR động" (trường 01 = 12) kèm nội dung; MoMo quét
 * không được dù app ngân hàng quét bình thường. Mẫu quét được bằng MoMo (tạo ở
 * vietqr.vn) là "QR tĩnh" (01 = 11). Đã thử cả hai biến thể "tĩnh + có nội dung" và
 * "động + không nội dung" đều quét được bằng MoMo → dùng "tĩnh + có nội dung" để vẫn
 * điền sẵn mã đơn.
 */

/** Mã chữ VietQR → BIN NAPAS 6 số. Cấu hình `bank_bin` có thể là mã chữ hoặc đã là BIN. */
const BIN_THEO_MA: Record<string, string> = {
  VCB: "970436", ICB: "970415", CTG: "970415", BIDV: "970418", AGRIBANK: "970405", VBA: "970405",
  MB: "970422", MBB: "970422", TCB: "970407", ACB: "970416", VPB: "970432", TPB: "970423",
  STB: "970403", HDB: "970437", VIB: "970441", SHB: "970443", OCB: "970448", MSB: "970426",
  EIB: "970431", SCB: "970429", SEAB: "970440", LPB: "970449", BAB: "970409", NAB: "970428",
  VAB: "970425", NCB: "970419", PVCB: "970412", ABB: "970425", BVB: "970438", VCCB: "970454",
  KLB: "970452", CAKE: "546034", UBANK: "546035", TIMO: "963388", WOORI: "970457",
  KBANK: "668888", SHBVN: "970424", CIMB: "422589", HSBC: "458761", PBVN: "970439",
};

/** Trả BIN 6 số từ `bank_bin` (mã chữ như "MB"/"VCB" hoặc BIN), hoặc null nếu không nhận ra. */
export function binNganHang(maHoacBin: string): string | null {
  const v = (maHoacBin || "").trim().toUpperCase();
  if (/^\d{6}$/.test(v)) return v;
  return BIN_THEO_MA[v] ?? null;
}

const tlv = (id: string, v: string) => id + String(v.length).padStart(2, "0") + v;

function crc16(s: string): string {
  let c = 0xffff;
  for (const b of Buffer.from(s)) {
    c ^= b << 8;
    for (let i = 0; i < 8; i++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
  }
  return c.toString(16).toUpperCase().padStart(4, "0");
}

/** Nội dung chuyển khoản trong VietQR: ASCII, tối đa 25 ký tự. */
function lamSachNoiDung(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d")
    .replace(/[^A-Za-z0-9 ]/g, "").slice(0, 25);
}

/** Chuỗi VietQR (EMVCo) — QR tĩnh, số tiền và nội dung điền sẵn. */
export function chuoiVietQR(o: { bin: string; soTaiKhoan: string; soTien?: number; noiDung?: string }): string {
  const tk = tlv("00", "A000000727") + tlv("01", tlv("00", o.bin) + tlv("01", o.soTaiKhoan)) + tlv("02", "QRIBFTTA");
  let p = tlv("00", "01") + tlv("01", "11") + tlv("38", tk) + tlv("53", "704");
  const tien = Math.round(o.soTien ?? 0);
  if (tien > 0) p += tlv("54", String(tien));
  p += tlv("58", "VN");
  const nd = lamSachNoiDung(o.noiDung ?? "");
  if (nd) p += tlv("62", tlv("08", nd));
  p += "6304";
  return p + crc16(p);
}

/**
 * Ảnh QR dạng `data:image/png;base64,...` (khách không phải gọi dịch vụ ngoài, số tài
 * khoản không lộ ra bên thứ ba). Trả null khi không nhận ra mã ngân hàng.
 */
export async function anhVietQR(o: {
  maNganHang: string; soTaiKhoan: string; soTien: number; noiDung: string;
}): Promise<string | null> {
  const bin = binNganHang(o.maNganHang);
  if (!bin || !o.soTaiKhoan) return null;
  const chuoi = chuoiVietQR({ bin, soTaiKhoan: o.soTaiKhoan, soTien: o.soTien, noiDung: o.noiDung });
  return QRCode.toDataURL(chuoi, { width: 480, margin: 4, errorCorrectionLevel: "M" });
}
