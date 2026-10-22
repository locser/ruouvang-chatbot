import crypto from "crypto";
import { pool } from "../db/client";
import { encrypt, decrypt } from "./encryption";
import { LoiCaiDat } from "./sinhChuoi";

export { LoiCaiDat, LOAI_CHUOI, sinhChuoi } from "./sinhChuoi";
export type { LoaiChuoi } from "./sinhChuoi";

/**
 * CẤU HÌNH CỦA CHATBOT, LẤY TỪ BẢNG `app_settings` TRONG DB CHATBOT
 * ===========================================================================
 *
 * Nguồn sự thật DUY NHẤT cho khoá chatbot dùng (DeepSeek, SMTP gửi thư đặt lại mật
 * khẩu admin, bot Telegram nền tảng, khoá widget). Medusa có bảng `app_settings`
 * RIÊNG trong DB của nó cho dữ liệu cửa hàng — mỗi khoá chỉ nằm ở một bên.
 * KHÔNG đọc lại từ biến môi trường: đã đưa vào DB thì chỉ có một chỗ để sửa, và lệch giữa
 * hai nguồn là loại lỗi khó tìm nhất.
 *
 * Biến môi trường chỉ còn giữ thứ cần có TRƯỚC khi nối được CSDL.
 *
 * Phạm vi:
 *   · "nen_tang" — tenant_id NULL, dùng chung cả hệ thống. Chỉ đọc được bằng pool
 *                  `app_central` (BYPASSRLS), nằm ngoài tầm với của luồng chat.
 *   · "shop"     — theo từng tenant.
 *
 * Khoá bí mật được mã hoá AES-256-GCM (cùng CONFIG_ENCRYPTION_KEY_CHATBOT với tenant_platform).
 */

export type PhamVi = "nen_tang" | "shop";

export interface KhaiBaoCaiDat {
  key: string;
  phamVi: PhamVi;
  /** Mã hoá khi lưu, che khi hiển thị, không bao giờ trả ra endpoint công khai. */
  biMat: boolean;
  /** Được phép trả qua GET /v1/public/config (storefront/Medusa đọc không cần đăng nhập). */
  congKhai: boolean;
  moTa: string;
  macDinh?: string;
  /** Trả chuỗi lỗi nếu sai. */
  kiemTra?: (v: string) => string | null;
}

const laSo = (min: number, max: number) => (v: string) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? null : `phải là số nguyên ${min}–${max}`;
};
const toiDa = (n: number) => (v: string) => (v.length <= n ? null : `tối đa ${n} ký tự`);

export const DANH_SACH_CAI_DAT: KhaiBaoCaiDat[] = [
  // --- Toàn nền tảng ---
  { key: "deepseek_api_key", phamVi: "nen_tang", biMat: true, congKhai: false, moTa: "Khoá API DeepSeek cho chatbot", kiemTra: toiDa(300) },
  { key: "vision_api_base_url", phamVi: "nen_tang", biMat: false, congKhai: false, moTa: "Base URL API vision tương thích OpenAI (ví dụ https://api.openai.com/v1)", kiemTra: (v) => (/^https:\/\//i.test(v) && v.length <= 500 ? null : "phải là URL https, tối đa 500 ký tự") },
  { key: "vision_api_key", phamVi: "nen_tang", biMat: true, congKhai: false, moTa: "Khoá API cho mô hình đọc nhãn chai từ ảnh Telegram", kiemTra: toiDa(500) },
  { key: "vision_model", phamVi: "nen_tang", biMat: false, congKhai: false, moTa: "Tên mô hình vision hỗ trợ image_url", kiemTra: toiDa(120) },
  { key: "smtp_host", phamVi: "nen_tang", biMat: false, congKhai: false, moTa: "Máy chủ SMTP gửi thư (đặt lại mật khẩu quản trị)", macDinh: "smtp.gmail.com", kiemTra: toiDa(255) },
  { key: "smtp_port", phamVi: "nen_tang", biMat: false, congKhai: false, moTa: "Cổng SMTP", macDinh: "587", kiemTra: laSo(1, 65535) },
  { key: "smtp_user", phamVi: "nen_tang", biMat: false, congKhai: false, moTa: "Tài khoản SMTP", kiemTra: toiDa(255) },
  { key: "smtp_pass", phamVi: "nen_tang", biMat: true, congKhai: false, moTa: "Mật khẩu SMTP (hoặc app password)", kiemTra: toiDa(255) },
  { key: "smtp_from", phamVi: "nen_tang", biMat: false, congKhai: false, moTa: "Người gửi, ví dụ: \"C.W. Wines\" <no-reply@cwwines.vn>", macDinh: '"VPH AI ChatBot" <no-reply@vpholding.com>', kiemTra: toiDa(255) },
  { key: "telegram_bot_token", phamVi: "nen_tang", biMat: true, congKhai: false, moTa: "Token bot Telegram NỀN TẢNG (thông báo cho super admin). Bot từng shop nằm ở tenant_setting", kiemTra: toiDa(200) },
  { key: "telegram_webhook_secret", phamVi: "nen_tang", biMat: true, congKhai: false, moTa: "Bí mật webhook của bot nền tảng (≥ 16 ký tự)", kiemTra: (v) => (v.length >= 16 && v.length <= 256 ? null : "16–256 ký tự") },

  // --- Theo shop ---
  // Chỉ còn khoá widget (do chatbot cấp). Hotline, Zalo, ngân hàng, vận chuyển, SMTP gửi khách
  // là dữ liệu cửa hàng → bảng app_settings của Medusa, KHÔNG nằm ở đây (mỗi khoá một nơi).
  { key: "widget_key", phamVi: "shop", biMat: false, congKhai: true, moTa: "Khoá công khai (pk_…) của widget chat nhúng trên storefront", kiemTra: (v) => (/^pk_[A-Za-z0-9_-]{8,100}$/.test(v) ? null : "phải bắt đầu bằng pk_") },
];

const THEO_KHOA = new Map(DANH_SACH_CAI_DAT.map((d) => [d.key, d]));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function khaiBaoCuaKhoa(key: string): KhaiBaoCaiDat | undefined {
  return THEO_KHOA.get(key);
}

// ---------------------------------------------------------------------------
// Bộ nhớ đệm
// ---------------------------------------------------------------------------

/** Đủ ngắn để đổi khoá xong có hiệu lực trong chớp mắt, đủ dài để cắt tải đọc. */
const CACHE_MS = 30_000;
const boNho = new Map<string, { luc: number; gt: string }>();
const nhoTheoKhoa = (key: string, tenantId: string | null) => `${tenantId ?? "*"}|${key}`;

export function xoaCacheCaiDat(): void {
  boNho.clear();
}

/** Jest không có DB cấu hình thật; test đặt giá trị bằng hàm này. */
const ghiDeTest = new Map<string, string>();
const laJest = () => typeof process.env.JEST_WORKER_ID !== "undefined";
export function datCaiDatChoTest(key: string, value: string | null, tenantId: string | null = null): void {
  const k = nhoTheoKhoa(key, tenantId);
  if (value === null) ghiDeTest.delete(k);
  else ghiDeTest.set(k, value);
}

// ---------------------------------------------------------------------------
// Đọc
// ---------------------------------------------------------------------------

function giaiMa(row: { value: string; is_secret: boolean }): string {
  if (!row.is_secret) return row.value;
  try {
    return decrypt(row.value);
  } catch (e) {
    console.error("[CaiDat] Không giải mã được một khoá bí mật (sai CONFIG_ENCRYPTION_KEY_CHATBOT?):", (e as Error).message);
    return "";
  }
}

/**
 * Lấy giá trị một cấu hình. Không có thì trả giá trị mặc định của khai báo, hoặc "".
 * Khoá "nen_tang" bỏ qua `tenantId`; khoá "shop" mà thiếu `tenantId` thì trả "".
 * Không bao giờ ném lỗi: DB hỏng → dùng bản đệm cũ nếu có.
 */
export async function layCaiDat(key: string, tenantId?: string | null): Promise<string> {
  const kb = THEO_KHOA.get(key);
  if (!kb) throw new Error(`Khoá cấu hình không được khai báo: ${key}`);
  const tid = kb.phamVi === "shop" ? tenantId ?? null : null;
  if (kb.phamVi === "shop" && !tid) return kb.macDinh ?? "";

  const nho = nhoTheoKhoa(key, tid);
  if (laJest()) return ghiDeTest.get(nho) ?? kb.macDinh ?? "";

  const c = boNho.get(nho);
  if (c && Date.now() - c.luc < CACHE_MS) return c.gt;

  try {
    if (tid && !UUID_RE.test(tid)) return kb.macDinh ?? "";
    const r = tid
      ? await pool.query(`SELECT value, is_secret FROM app_settings WHERE tenant_id = $1 AND key = $2`, [tid, key])
      : await pool.query(`SELECT value, is_secret FROM app_settings WHERE tenant_id IS NULL AND key = $1`, [key]);
    const gt = r.rows[0] ? giaiMa(r.rows[0]) : "";
    const kq = gt !== "" ? gt : kb.macDinh ?? "";
    // Khoá bộ đệm có thể do bên ngoài tạo ra (tenant_id ở endpoint công khai) → chặn phình bộ nhớ.
    if (boNho.size > 5000) boNho.clear();
    boNho.set(nho, { luc: Date.now(), gt: kq });
    return kq;
  } catch (e) {
    console.error(`[CaiDat] Không đọc được "${key}":`, (e as Error).message);
    return c?.gt ?? kb.macDinh ?? "";
  }
}

export interface MucCaiDat {
  key: string;
  pham_vi: PhamVi;
  mo_ta: string;
  bi_mat: boolean;
  cong_khai: boolean;
  da_dat: boolean;
  /** Giá trị; khoá bí mật bị che. */
  gia_tri: string;
  nguon: "db" | "mac_dinh" | "chua_dat";
  cap_nhat_luc: string | null;
  cap_nhat_boi: string | null;
}

/** Che khoá bí mật: chỉ để lộ 4 ký tự cuối. */
export function cheBiMat(v: string): string {
  if (!v) return "";
  return v.length <= 8 ? "••••" : `••••${v.slice(-4)}`;
}

/** Danh sách mọi cấu hình của một phạm vi, kèm trạng thái đã đặt hay chưa. */
export async function lietKeCaiDat(phamVi: PhamVi, tenantId?: string | null): Promise<MucCaiDat[]> {
  const khaiBao = DANH_SACH_CAI_DAT.filter((d) => d.phamVi === phamVi);
  const tid = phamVi === "shop" ? tenantId ?? null : null;
  if (phamVi === "shop" && (!tid || !UUID_RE.test(tid))) throw new Error("Cần tenant_id hợp lệ cho cấu hình của shop");

  const r = tid
    ? await pool.query(`SELECT key, value, is_secret, updated_at, updated_by FROM app_settings WHERE tenant_id = $1`, [tid])
    : await pool.query(`SELECT key, value, is_secret, updated_at, updated_by FROM app_settings WHERE tenant_id IS NULL`);
  const theoKhoa = new Map(r.rows.map((x: any) => [x.key as string, x]));

  return khaiBao.map((kb) => {
    const row: any = theoKhoa.get(kb.key);
    const co = Boolean(row && row.value !== "");
    const gt = co ? giaiMa(row) : "";
    return {
      key: kb.key,
      pham_vi: kb.phamVi,
      mo_ta: kb.moTa,
      bi_mat: kb.biMat,
      cong_khai: kb.congKhai,
      da_dat: co,
      gia_tri: kb.biMat ? cheBiMat(gt) : co ? gt : kb.macDinh ?? "",
      nguon: co ? "db" : kb.macDinh !== undefined ? "mac_dinh" : "chua_dat",
      cap_nhat_luc: row ? new Date(row.updated_at).toISOString() : null,
      cap_nhat_boi: row?.updated_by ?? null,
    } satisfies MucCaiDat;
  });
}

/** Các cấu hình `congKhai` của một shop, để storefront/Medusa đọc. Không bao giờ có khoá bí mật. */
export async function layCauHinhCongKhai(tenantId: string): Promise<Record<string, string>> {
  const kq: Record<string, string> = {};
  for (const kb of DANH_SACH_CAI_DAT) {
    if (!kb.congKhai || kb.biMat || kb.phamVi !== "shop") continue;
    kq[kb.key] = await layCaiDat(kb.key, tenantId);
  }
  return kq;
}

// ---------------------------------------------------------------------------
// Ghi
// ---------------------------------------------------------------------------

/** Kiểm tra khoá + giá trị theo khai báo; trả về khai báo. Ném LoiCaiDat nếu sai. */
export function kiemTraCaiDat(key: string, value: unknown): KhaiBaoCaiDat {
  const kb = THEO_KHOA.get(key);
  if (!kb) throw new LoiCaiDat(`Khoá không hợp lệ: ${key}. Xem GET /v1/admin/settings/schema`, 404);
  if (typeof value !== "string") throw new LoiCaiDat(`${key}: giá trị phải là chuỗi`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new LoiCaiDat(`${key}: chứa ký tự điều khiển`);
  const v = value.trim();
  if (v !== "" && kb.kiemTra) {
    const loi = kb.kiemTra(v);
    if (loi) throw new LoiCaiDat(`${key}: ${loi}`);
  }
  return kb;
}

/**
 * Ghi (hoặc xoá nếu giá trị rỗng) một cấu hình. Khoá bí mật được mã hoá.
 * Trả `true` nếu đã đặt, `false` nếu đã xoá.
 */
export async function datCaiDat(
  key: string,
  value: string,
  opts: { tenantId?: string | null; nguoiSua?: string } = {}
): Promise<boolean> {
  const kb = kiemTraCaiDat(key, value);
  const v = value.trim();
  const tid = kb.phamVi === "shop" ? opts.tenantId ?? null : null;
  if (kb.phamVi === "shop" && (!tid || !UUID_RE.test(tid))) throw new LoiCaiDat(`${key}: cần tenant_id hợp lệ`);

  if (v === "") {
    await xoaCaiDat(key, tid);
    return false;
  }
  const luu = kb.biMat ? encrypt(v) : v;
  await pool.query(
    `INSERT INTO app_settings (tenant_id, key, value, is_secret, updated_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT ((COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid)), key)
     DO UPDATE SET value = EXCLUDED.value, is_secret = EXCLUDED.is_secret, updated_by = EXCLUDED.updated_by`,
    [tid, key, luu, kb.biMat, opts.nguoiSua ?? null]
  );
  boNho.delete(nhoTheoKhoa(key, tid));
  return true;
}

export async function xoaCaiDat(key: string, tenantId?: string | null): Promise<boolean> {
  const kb = THEO_KHOA.get(key);
  if (!kb) throw new LoiCaiDat(`Khoá không hợp lệ: ${key}`, 404);
  const tid = kb.phamVi === "shop" ? tenantId ?? null : null;
  const r = tid
    ? await pool.query(`DELETE FROM app_settings WHERE tenant_id = $1 AND key = $2`, [tid, key])
    : await pool.query(`DELETE FROM app_settings WHERE tenant_id IS NULL AND key = $1`, [key]);
  boNho.delete(nhoTheoKhoa(key, tid));
  return (r.rowCount ?? 0) > 0;
}
