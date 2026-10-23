import { BotShop, } from "./telegramTenant";
import { guiTinQuaBot, answerCallbackQuery } from "./telegram";
import { runInTenantContext } from "../db/client";
import { getTenantMedusaConfig, MedusaConfig } from "./medusa";
import { timSanPham, SanPhamTimDuoc } from "./search";
import { goiDeepSeekCoTool, ChatMessageTool } from "./llm";
import { layCaiDat } from "./caiDat";
import { fetchCoTimeout, fetchJson, TIMEOUT } from "./http";
import { env } from "../config/env";
import { randomInt } from "crypto";

type LoaiLenh = "inventory_adjust" | "create_product" | "inventory_lookup" | "order_list_pending" | "order_complete" | "order_lookup" | "order_payment_received" | "order_cancel" | "revenue_report"
  | "discount_create" | "product_hide" | "product_show" | "product_price" | "price_update" | "forward_to_customer";

export interface LenhVanHanh {
  type: LoaiLenh;
  product_query?: string;
  quantity_change?: number;
  title?: string;
  sku?: string;
  price_vnd?: number;
  initial_quantity?: number;
  description?: string;
  order_number?: number;
  /** Câu nhắc nhiều số đơn ("duyệt đơn 12, 13"): phải hỏi lại, không đoán. */
  order_numbers?: number[];
  /** Tra đơn: theo SĐT hoặc theo tên khách (chỉ đọc). */
  lookup_kind?: "phone" | "name";
  lookup_text?: string;
  /** Báo cáo doanh thu: số ngày gần nhất. */
  report_days?: number;
  /** Mốc lịch theo giờ VN do backend tính: hôm nay / tuần này / tháng này. */
  report_period?: "today" | "this_week" | "this_month";
  /** Tạo mã giảm giá: đúng một trong percent / amount. */
  discount_percent?: number;
  discount_amount?: number;
  discount_code?: string;
  /** Hạn dùng của mã: ngày cụ thể (năm có thể thiếu) hoặc "trong N ngày"; giới hạn số lượt dùng. */
  han_ngay?: { d: number; m: number; y?: number };
  han_so_ngay?: number;
  usage_limit?: number;
  /** Số trần nhỏ không đơn vị ("giảm 10"): phải hỏi lại 10% hay 10.000đ. */
  so_tran?: number;
  /** Câu có ý tạo mã nhưng không hiểu hết: lý do để báo nhân viên (không được rơi sang nhánh khác). */
  loi_hieu?: string;
  price_vnd_moi?: number;
}

/** Giới hạn cứng phía bot cho mã giảm giá (backend không tự chặn; chưa có cấu hình app_settings). */
export const GIOI_HAN_MA_GIAM = { toi_da_phan_tram: 30, toi_da_so_tien: 500_000, toi_thieu_so_tien: 1_000 } as const;

interface TelegramMessageLike {
  message_id?: string | number;
  chat: { id: string | number; type?: string };
  from?: { id?: string | number };
  text?: string;
  caption?: string;
  photo?: Array<{ file_id: string; file_size?: number; width?: number; height?: number }>;
  reply_to_message?: { from?: { username?: string; is_bot?: boolean } };
}

interface TelegramCallbackLike {
  id: string;
  data?: string;
  from?: { id?: string | number };
  message?: { chat?: { id?: string | number } };
}

const UUID_RE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const CALLBACK_DON_RE = /^ops_ord_(\d{1,9})$/;
const CALLBACK_LIST = "ops_list";
const CALLBACK_PAY_RE = /^ops_pay_(\d{1,9})$/;
const CALLBACK_REPORT_RE = /^ops_rep_(1|7|30|today|this_week|this_month)$/;
const CALLBACK_XEM_RE = /^ops_view_(\d{1,9})$/;
const CALLBACK_HUY_RE = /^ops_cxl_(\d{1,9})$/;
const CALLBACK_MA_RE = /^ops_dsc_(p|a)(\d{1,7})$/;
const CALLBACK_RE = new RegExp(`^ops_(ok|no|pick)_(${UUID_RE})(?:_(\\d+))?$`, "i");

export function html(v: unknown): string {
  return String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function boDau(v: string): string {
  return v.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/gi, "d").toLowerCase();
}

function boTienTo(text: string): string {
  return text
    .replace(/^\s*\/ops(?:@\w+)?\s*/i, "")
    .replace(/@\w+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Lỗi đã được viết sẵn bằng tiếng Việt đời thường, cho phép gửi thẳng cho nhân viên. */
export class LoiThanThien extends Error {}

/** 1250000 -> "1.250.000đ" (không phụ thuộc ICU của máy). */
export function dinhDangTien(n: unknown): string {
  const so = Math.round(Number(n) || 0);
  return `${String(so).replace(/\B(?=(\d{3})+(?!\d))/g, ".")}đ`;
}

/**
 * Câu nói về đơn hàng: "đơn mới", "có đơn nào chưa duyệt", "duyệt đơn 12",
 * "xác nhận đơn CW12". Chỉ nhận câu ngắn để không bắt nhầm lời trò chuyện dài.
 */
export function phanTichLenhDonHang(raw: string): LenhVanHanh | null {
  const text = boTienTo(raw);
  if (!text || text.length > 80) return null;
  const plain = boDau(text).replace(/[?!.,;:\s]+$/g, "").trim();

  const khac = phanTichNhanTienVaBaoCao(plain);
  if (khac) return khac;
  const huy = phanTichHuyDon(plain, text);
  if (huy) return huy;

  // Mọi mẫu đều NEO đầu và cuối câu: nhân viên nhắn khách ("Em xác nhận đơn 12
  // cho anh rồi nhé", "đơn 3 chai vang đỏ") thì không khớp.
  const dem = "(?:(?:vui long|nho|hay|ok|da|vang|giup em|giup minh|cho em|cho minh)\\s+)*";
  const hanhDong = "(?:duyet|xac nhan|hoan thanh)";
  const giup = "(?:\\s+(?:giup|gium|dum)(?:\\s+em|\\s+minh)?)?";
  const duoi = "(?:\\s+(?:nhe|nha|ne|di|ngay|a|voi|luon|giup|gium|dum|em|minh|anh|chi))*";
  const don = "(?:don(?:\\s+hang)?\\s*)?(?:so\\s*|ma\\s*)?";
  const so = "(?:#\\s*|cw\\s*)?(\\d{1,9})";

  const nhieu = plain.match(new RegExp(`^${dem}${hanhDong}${giup}\\s+${don}((?:#\\s*|cw\\s*)?\\d{1,9}(?:\\s*(?:,|;|&|va|voi|hoac|hay)?\\s*(?:#\\s*|cw\\s*)?\\d{1,9})+)${duoi}$`));
  if (nhieu && (/\bdon\b/.test(plain) || /(?:#|cw)\s*\d/.test(plain))) {
    const ds = Array.from(new Set((nhieu[1].match(/\d{1,9}/g) ?? []).map(Number))).filter((n) => n > 0);
    if (ds.length >= 2) return { type: "order_complete", order_numbers: ds.slice(0, 5) };
  }

  const truoc = plain.match(new RegExp(`^${dem}${hanhDong}${giup}\\s+${don}${so}${duoi}$`));
  const sau = plain.match(new RegExp(`^don(?:\\s+hang)?\\s*(?:so\\s*|ma\\s*)?${so}\\s+(?:nay\\s+)?(?:${hanhDong}|ok)${duoi}$`));
  const m = truoc || sau;
  if (m && (/\bdon\b/.test(plain) || /(?:#|cw)\s*\d/.test(plain))) {
    const n = Number(m[1]);
    if (Number.isSafeInteger(n) && n > 0) return { type: "order_complete", order_number: n };
  }

  const loc = "(?:moi|cho duyet|chua duyet|cho xac nhan|chua xac nhan|chua xu ly|can duyet|can xu ly)";
  const dauList = "(?:(?:anh oi|chi oi|em oi|oi)\\s+)?(?:(?:xem|cho xem|cho em xem|co|con)\\s+)?(?:(?:danh sach|cac|nhung)\\s+)?";
  const duoiList = "(?:\\s+(?:khong|nhe|nha|chua|dau|the|a|di|em|anh|chi))*";
  if (
    new RegExp(`^${dauList}don(?:\\s+hang)?\\s+${loc}(?:\\s+nao)?${duoiList}$`).test(plain) ||
    new RegExp(`^(?:co|con)\\s+don(?:\\s+hang)?\\s+nao\\s+${loc}${duoiList}$`).test(plain) ||
    /^(?:xem|danh sach|cac)\s+don(?:\s+hang)?$/.test(plain)
  ) {
    return { type: "order_list_pending" };
  }
  return phanTichTraDon(text, plain, raw);
}

/**
 * Huỷ đơn ("huỷ đơn 12", "huy don CW12 giúp em"): lệnh ghi không hoàn tác được nên neo CẢ câu,
 * bắt buộc có chữ "đơn" và bắt đầu bằng động từ huỷ. Câu hỏi, phủ định, câu kể ("đừng huỷ đơn 12",
 * "đơn 12 bị huỷ rồi", "khách muốn huỷ đơn 12 không ạ") và số tiền/SĐT đều không khớp.
 */
function phanTichHuyDon(plain: string, goc: string): LenhVanHanh | null {
  // Câu hỏi ("huỷ đơn 12?", "huỷ đơn 12 à", "... không") không bao giờ là lệnh.
  if (/\?/.test(goc) || /(?:^|\s)(?:à|ả|hả|hở|không|khong|chưa|chua)\s*[.!,;:…]*$/i.test(goc.trim())) return null;
  const dem = "(?:(?:vui long|nho|hay|giup em|giup minh|cho em|cho minh|anh oi|chi oi|em oi|oi)\\s+)*";
  const duoi = "(?:\\s+(?:nhe|nha|ne|di|ngay|a|voi|luon|giup|gium|dum|em|minh|anh|chi))*";
  const m = plain.match(new RegExp(`^${dem}huy\\s+don(?:\\s+hang)?\\s*(?:so\\s*|ma\\s*)?(?:#\\s*|cw\\s*)?(\\d{1,6})${duoi}$`));
  if (!m) return null;
  // Số đơn tối đa 6 chữ số; bắt đầu bằng 0 là số điện thoại.
  if (m[1].startsWith("0")) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n > 0 ? { type: "order_cancel", order_number: n } : null;
}

/**
 * Số tiền kiểu Việt: "50k", "1tr25", "1.250k", "1,25 triệu", "1.250.000", "500000đ".
 * Trả số đồng nguyên, hoặc null nếu không hiểu.
 */
export function parseTienVN(raw: string): number | null {
  const s = boDau(raw).replace(/\s+/g, "").replace(/(?:dong|vnd|d)$/, "");
  let m: RegExpMatchArray | null;
  let kq: number | null = null;
  if ((m = s.match(/^(\d+)(?:tr|trieu|m)(\d{1,3})$/))) kq = Math.round(Number(m[1]) * 1e6 + Number(`0.${m[2]}`) * 1e6);
  else if ((m = s.match(/^(\d+(?:[.,]\d+)?)(?:tr|trieu|m)$/))) kq = Math.round(Number(m[1].replace(",", ".")) * 1e6);
  else if ((m = s.match(/^(\d{1,3}(?:[.,]\d{3})+)(?:k|nghin|ngan)$/))) kq = Number(m[1].replace(/[.,]/g, "")) * 1000;
  else if ((m = s.match(/^(\d+(?:[.,]\d+)?)(?:k|nghin|ngan)$/))) kq = Math.round(Number(m[1].replace(",", ".")) * 1000);
  else if ((m = s.match(/^(\d{1,3}(?:[.,]\d{3})+)$/))) kq = Number(m[1].replace(/[.,]/g, ""));
  else if ((m = s.match(/^(\d+)$/))) kq = Number(m[1]);
  return kq !== null && Number.isSafeInteger(kq) && kq >= 0 && kq <= 1e12 ? kq : null;
}

const MAU_TIEN = "\\d[\\d.,]*(?:\\s*(?:trieu|tr|m)\\s*\\d{0,3}|\\s*(?:k|nghin|ngan)|\\s*(?:dong|vnd|d))?";
const TU_LOT = new Set(["nhe", "nha", "ne", "di", "ngay", "a", "voi", "luon", "giup", "gium", "dum", "em", "minh", "anh", "chi", "vui", "long", "nho", "hay", "cho", "khach", "moi", "mot", "oi"]);

/** Câu hỏi hoặc ngập ngừng ("...?", "... à", "... không"): không bao giờ là lệnh ghi. */
function laCauHoi(goc: string): boolean {
  return /\?/.test(goc) || /(?:^|\s)(?:à|ả|hả|hở|không|khong|chưa|chua)\s*[.!,;:…]*$/i.test(goc.trim());
}

/**
 * Hạn dùng của mã: 23:59:59 giờ Việt Nam của ngày đó. Ngày không có năm mà đã qua thì hiểu là năm sau.
 * Ném LoiThanThien nếu ngày không có thật, đã qua (có ghi năm) hoặc xa quá 1 năm.
 */
export function tinhHanDung(spec: { ngay?: { d: number; m: number; y?: number }; soNgay?: number }, now: Date = new Date()): { ends_at: string; nhan: string } {
  const vn = new Date(now.getTime() + 7 * 3600_000);
  const homNay = Date.UTC(vn.getUTCFullYear(), vn.getUTCMonth(), vn.getUTCDate());
  let moc: number;
  if (spec.soNgay != null) {
    moc = homNay + spec.soNgay * 86400_000;
  } else if (spec.ngay) {
    let { d, m, y } = spec.ngay;
    const coNam = y != null;
    if (y != null && y < 100) y += 2000;
    let yy = y ?? vn.getUTCFullYear();
    const hopLe = (nam: number) => { const t = new Date(Date.UTC(nam, m - 1, d)); return t.getUTCFullYear() === nam && t.getUTCMonth() === m - 1 && t.getUTCDate() === d; };
    if (!hopLe(yy)) throw new LoiThanThien(`Ngày ${d}/${m} không có thật. Anh/chị kiểm tra lại ngày hết hạn giúp em.`);
    moc = Date.UTC(yy, m - 1, d);
    if (moc < homNay) {
      if (coNam) throw new LoiThanThien(`Ngày hết hạn ${d}/${m}/${yy} đã qua rồi. Anh/chị cho em ngày ở tương lai nhé.`);
      yy += 1;
      if (!hopLe(yy)) throw new LoiThanThien(`Ngày ${d}/${m} không có thật. Anh/chị kiểm tra lại ngày hết hạn giúp em.`);
      moc = Date.UTC(yy, m - 1, d);
    }
  } else throw new LoiThanThien("Thiếu ngày hết hạn.");
  if (moc - homNay > 366 * 86400_000) throw new LoiThanThien("Hạn dùng xa quá 1 năm, em chưa đặt được. Anh/chị cho hạn ngắn hơn nhé.");
  const t = new Date(moc);
  const h = (n: number) => String(n).padStart(2, "0");
  const dd = h(t.getUTCDate()), mm = h(t.getUTCMonth() + 1), yyyy = t.getUTCFullYear();
  return { ends_at: `${yyyy}-${mm}-${dd}T23:59:59+07:00`, nhan: `23:59 ${dd}/${mm}/${yyyy}` };
}

const LOI_MA_CHUNG = "Em chỉ tạo mã giảm theo % hoặc số tiền, kèm hạn (hết hạn 31/12, trong 7 ngày) và số lượt (dùng 50 lần).";
const loiMa = (loi_hieu: string): LenhVanHanh => ({ type: "discount_create", loi_hieu });

/** Câu có ý tạo mã giảm giá mà bot không hiểu hết: phải từ chối rõ, không được rơi sang nhánh kho. */
export function coYTaoMaGiam(plain: string): boolean {
  return /\b(?:tao|them)\s+(?:ma|voucher|coupon)\b/.test(plain) || /(?:^|\s)ma\s+(?:giam|khuyen mai|uu dai)\b/.test(plain) ||
    /\bgiam(?:\s+gia)?\s*\d[\d.,]*\s*(?:%|phan\s*tram)/.test(plain) ||
    /\bgiam(?:\s+gia)?\s*\d[\d.,]*\s*(?:k|nghin|ngan|tr|trieu|d|dong|vnd)\b/.test(plain);
}

/** Tạo mã giảm giá. Neo đầu câu ("tạo mã ..."); đã có ý tạo mã mà không hiểu hết thì trả lệnh mang `loi_hieu`. */
function phanTichMaGiam(text: string, plain: string): LenhVanHanh | null {
  let r = plain.replace(/[?!.,;:\s]+$/g, "");
  const dau = r.match(/^(?:(?:vui long|nho|hay|giup em|giup minh|cho em|cho minh|em can|anh oi|chi oi|em oi|oi)\s+)*(?:tao|them)\s+(?:ma|voucher|coupon)\b/);
  if (!dau) return null;
  if (laCauHoi(text)) return loiMa("Câu này em thấy là câu hỏi nên chưa tạo mã. Anh/chị gõ lại dạng lệnh, ví dụ: tạo mã giảm 10%.");
  r = r.slice(dau[0].length).replace(/;|(?<!\d),|,(?!\d)/g, " ");
  const kq: LenhVanHanh = { type: "discount_create" };
  // Mã tự đặt: lấy từ chữ gốc ("tạo mã TET10 ..."), phải viết HOA hoặc có chữ số.
  const mMa = text.match(/(?:^|\s)(?:m[ãa]|voucher|coupon)\s+([A-Za-z0-9_-]{3,20})(?=\s|$)/i);
  if (mMa && !["giam", "khuyen", "uu", "gia", "het", "han", "cho", "moi", "trong", "den", "dung", "toi", "nhe", "nha", "di", "ne", "hom", "nay", "hang", "tuan", "thang", "mua", "dong", "tien", "phan", "tram", "nhanh", "sinh", "nhat", "tu", "cua", "va", "de", "cac", "mot", "lan", "luot", "san", "pham", "hom"].includes(boDau(mMa[1]).toLowerCase())) {
    kq.discount_code = mMa[1].toUpperCase();
    r = r.replace(boDau(mMa[1]).toLowerCase(), " ");
  }
  const ngay = r.match(/(?:het han|han dung|han su dung|dung den|den het|den ngay|den|han)\s*(?:vao\s+|ngay\s+)?(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?/);
  if (ngay) {
    kq.han_ngay = { d: Number(ngay[1]), m: Number(ngay[2]), y: ngay[3] ? Number(ngay[3]) : undefined };
    r = r.replace(ngay[0], " ");
  } else {
    const tuongDoi = r.match(/(?:het han trong|het han sau|dung trong|trong|han)\s+(\d{1,3})\s*(ngay|tuan|thang)\b/);
    if (tuongDoi) {
      const n = Number(tuongDoi[1]);
      kq.han_so_ngay = n * (tuongDoi[2] === "tuan" ? 7 : tuongDoi[2] === "thang" ? 30 : 1);
      r = r.replace(tuongDoi[0], " ");
    }
  }
  const luot = r.match(/(?:chi\s+)?(?:dung\s+)?(?:duoc\s+)?(?:toi da\s+)?(\d{1,6})\s*(?:lan|luot)\b|gioi han\s+(\d{1,6})(?:\s*(?:lan|luot))?\b/);
  if (luot) {
    kq.usage_limit = Number(luot[1] ?? luot[2]);
    r = r.replace(luot[0], " ");
  }
  r = r.replace(/\b(?:giam gia|khuyen mai|uu dai)\b(?!\s*\d)/, "giam");
  const pct = r.match(/\bgiam(?:\s+gia)?\s*(\d{1,3}(?:[.,]\d+)?)\s*(?:%|phan\s*tram)/);
  if (pct) {
    kq.discount_percent = Number(pct[1].replace(",", "."));
    r = r.replace(pct[0], " ");
  } else {
    const tien = r.match(new RegExp(`\\bgiam(?:\\s+gia)?\\s+(${MAU_TIEN})(?!\\s*%)`));
    const v = tien ? parseTienVN(tien[1]) : null;
    if (!tien || v === null) return loiMa(`Em chưa hiểu mức giảm. Anh/chị gõ ví dụ: tạo mã giảm 10% hoặc tạo mã giảm 50k. ${LOI_MA_CHUNG}`);
    // Số trần nhỏ không đơn vị ("giảm 10"): hỏi lại 10% hay 10.000đ, không đoán.
    if (/^\d{1,3}$/.test(tien[1].trim()) && v <= 100) kq.so_tran = v;
    else kq.discount_amount = v;
    r = r.replace(tien[0], " ");
  }
  const du = r.split(/\s+/).filter(Boolean).filter((w) => !TU_LOT.has(w) && w !== "giam" && w !== "gia" && w !== "ma");
  if (du.length) return loiMa(`Em chưa hỗ trợ điều kiện “${du.join(" ")}” cho mã giảm giá nên chưa tạo. ${LOI_MA_CHUNG}`);
  return kq;
}

/** Cắt phần tiền tố lệnh để lấy tên sản phẩm (giữ nguyên chữ hoa/dấu), bỏ chữ "sản phẩm/sp" đứng đầu tên. */
function layTenSauTienTo(text: string, plain: string, tienTo: RegExp): string | null {
  const m = plain.match(tienTo);
  if (!m) return null;
  const tu = text.split(/\s+/).filter(Boolean);
  const tuPlain = plain.split(/\s+/).filter(Boolean);
  if (tu.length !== tuPlain.length) return null;
  const k = m[0].trim().split(/\s+/).length;
  const con = tu.slice(k);
  while (con.length > 1 && /^(?:san|pham|sp)$/.test(boDau(con[0]))) con.shift();
  while (con.length && TU_LOT.has(boDau(con[con.length - 1]).replace(/[^a-z0-9]/g, ""))) con.pop();
  return con.join(" ").replace(/[?!.,;:]+$/g, "").trim();
}

/**
 * Ẩn / mở bán lại sản phẩm, đổi giá. Chỉ nhận dạng lệnh có động từ rõ VÀ chữ "sản phẩm/sp" (ẩn, ngừng bán, mở bán lại)
 * hoặc "đổi/sửa giá": câu thường nói với khách ("giá chai này 500k ạ", "ngừng bán rồi anh ạ") không bao giờ khớp.
 */
function phanTichSanPham(text: string, plain: string): LenhVanHanh | null {
  if (laCauHoi(text)) return null;
  const dem = "(?:(?:vui long|nho|hay|giup em|giup minh|cho em|cho minh|anh oi|chi oi|em oi|oi)\\s+)*";
  const sp = "(?:san pham|sp)";
  const hopLe = (ten: string | null): ten is string => Boolean(ten) && ten!.length >= 2 && ten!.length <= 80 &&
    !/^(?:hang|nhe|het|luon|vi|do|tu|rieng|sang|chieu|toi|hom|mai|tuan|thang|nay|kia|moi|la|thanh|gia)\b/.test(boDau(ten!));
  const an = layTenSauTienTo(text, plain, new RegExp(`^${dem}(?:(?:an|giau|tat ban)\\s+${sp}|(?:tam )?ngung ban\\s+${sp}|ngung kinh doanh\\s+${sp})\\s+(?=\\S)`));
  if (hopLe(an)) return { type: "product_hide", product_query: an };
  const hien = layTenSauTienTo(text, plain, new RegExp(`^${dem}(?:mo ban lai\\s+${sp}|mo lai ban\\s+${sp}|hien lai san pham|hien san pham|bat lai san pham)\\s+(?=\\S)`));
  if (hopLe(hien)) return { type: "product_show", product_query: hien };
  const tuPlain = plain.replace(/[?!.,;:\s]+$/g, "").split(/\s+/);
  while (tuPlain.length && TU_LOT.has(tuPlain[tuPlain.length - 1])) tuPlain.pop();
  const mGia = tuPlain.join(" ").match(new RegExp(`^${dem}(?:doi gia|sua gia|cap nhat gia)\\s+(.+?)\\s+(?:thanh|la|=|->|moi)?\\s*(${MAU_TIEN})\\s*$`));
  if (mGia) {
    const v = parseTienVN(mGia[2]);
    const ten = layTenSauTienTo(text, plain, new RegExp(`^${dem}(?:doi gia|sua gia|cap nhat gia)\\s+(?=\\S)`));
    if (v !== null && v >= 1000 && ten !== null) {
      const tu = ten.split(/\s+/);
      const soTuTien = mGia[2].trim().split(/\s+/).length;
      let tenSp = tu.slice(0, Math.max(0, tu.length - soTuTien));
      while (tenSp.length && /^(?:thanh|la|moi|=|->)$/.test(boDau(tenSp[tenSp.length - 1]))) tenSp = tenSp.slice(0, -1);
      const t = tenSp.join(" ").trim();
      if (hopLe(t)) return { type: "product_price", product_query: t, price_vnd: v };
    }
  }
  return null;
}

/** Lệnh ghi về cửa hàng (mã giảm giá, ẩn/hiện sản phẩm, đổi giá). */
export function phanTichLenhShop(raw: string): LenhVanHanh | null {
  const text = boTienTo(raw);
  if (!text || text.length > 160) return null;
  const plain = boDau(text);
  return phanTichMaGiam(text, plain) ?? phanTichSanPham(text, plain);
}

/** Nhận tiền chuyển khoản ("đã nhận tiền đơn 12", "đơn 12 đã ck") và báo cáo doanh thu ("doanh thu 7 ngày"): neo cả câu. */
function phanTichNhanTienVaBaoCao(plain: string): LenhVanHanh | null {
  const dem = "(?:(?:vui long|nho|hay|xac nhan|ghi nhan|da|vang|giup em|giup minh|cho em|cho minh)\\s+)*";
  const duoi = "(?:\\s+(?:nhe|nha|ne|di|ngay|a|voi|luon|giup|gium|dum|em|minh|anh|chi))*";
  const xong = "(?:\\s+(?:roi|xong))?";
  const so = "(?:so\\s*|ma\\s*)?(?:#\\s*|cw\\s*)?(\\d{1,9})";
  const don = "don(?:\\s+hang)?";
  const tien = [
    `^${dem}(?:da\\s+)?(?:nhan|thu)(?:\\s+duoc)?\\s+tien(?:\\s+chuyen\\s+khoan)?(?:\\s+cua)?\\s+${don}\\s*${so}${xong}${duoi}$`,
    `^${don}\\s*${so}\\s+(?:da\\s+)?(?:chuyen\\s+khoan|ck|thanh\\s+toan|tra\\s+tien)${xong}${duoi}$`,
    // Bắt buộc có "đơn", # hoặc CW trước số: "khách 500 chuyển rồi" là số tiền, không phải số đơn.
    `^khach\\s+(?:${don}\\s*(?:so\\s*|ma\\s*)?(?:#\\s*|cw\\s*)?|#\\s*|cw\\s*)(\\d{1,9})\\s+(?:da\\s+)?(?:chuyen(?:\\s+khoan)?|ck)${xong}${duoi}$`,
  ];
  for (const re of tien) {
    const m = plain.match(new RegExp(re));
    if (m) {
      const n = Number(m[1]);
      if (Number.isSafeInteger(n) && n > 0) return { type: "order_payment_received", order_number: n };
    }
  }
  const duoiBc = "(?:\\s+(?:nhe|nha|ne|di|ngay|voi|luon))*";
  const bc = plain.match(new RegExp(
    `^(?:(?:cho\\s+)?(?:em\\s+)?(?:xem|vui long|nho|hay)\\s+)*(bao\\s+cao(?:\\s+(?:doanh\\s+thu|doanh\\s+so))?|doanh\\s+thu|doanh\\s+so)` +
    `(?:\\s+(?:trong\\s+|cua\\s+|vong\\s+)?(hom\\s+nay|tuan\\s+nay|thang\\s+nay|tuan\\s+qua|thang\\s+qua|(\\d{1,3})\\s+ngay(?:\\s+(?:qua|gan\\s+nhat))?))?${duoiBc}$`));
  if (bc) {
    const k = bc[2] ?? "";
    // "báo cáo" trơ trọi hay kèm tên người là lời nói thường, phải có doanh thu/doanh số hoặc khoảng thời gian.
    if (!/doanh/.test(bc[1]) && !k) return null;
    if (/hom nay/.test(k)) return { type: "revenue_report", report_period: "today" };
    if (/tuan nay/.test(k)) return { type: "revenue_report", report_period: "this_week" };
    if (/thang nay/.test(k)) return { type: "revenue_report", report_period: "this_month" };
    let days = 7;
    if (/thang/.test(k)) days = 30;
    else if (bc[3]) days = Number(bc[3]);
    if (days >= 1 && days <= 365) return { type: "revenue_report", report_days: days };
  }
  return null;
}

/** "xem đơn 12", "đơn 12 sao rồi", "tra đơn chị Lan", "đơn của 0912345678": chỉ đọc, không bao giờ ra bản nháp duyệt. */
function phanTichTraDon(text: string, plain: string, raw: string): LenhVanHanh | null {
  const dem = "(?:(?:vui long|nho|hay|giup em|giup minh|cho em|cho minh|anh oi|chi oi|em oi|oi)\\s+)*";
  const xem = "(?:xem|tra cuu|tra|kiem tra|check|tim)";
  const giup = "(?:\\s+(?:giup|gium|dum)(?:\\s+em|\\s+minh)?)?";
  const duoi = "(?:\\s+(?:nhe|nha|ne|di|ngay|a|voi|luon|giup|gium|dum|em|minh|anh|chi))*";
  const don = "don(?:\\s+hang)?";

  const mSo = plain.match(new RegExp(`^${dem}${xem}${giup}\\s+${don}\\s*(?:so\\s*|ma\\s*)?(?:#\\s*|cw\\s*)?(\\d{1,9})${duoi}$`))
    || plain.match(new RegExp(`^${dem}${don}\\s*(?:so\\s*|ma\\s*)?(?:#\\s*|cw\\s*)?(\\d{1,9})\\s+(?:sao roi|sao the|ra sao|the nao|den dau|xong chua|xong roi chua|da duyet chua|duyet chua|chua)${duoi}$`));
  if (mSo) {
    const so = mSo[1];
    // Dãy số dài là số điện thoại, không phải số đơn.
    if (so.length < 9 && !so.startsWith("0")) {
      const n = Number(so);
      if (Number.isSafeInteger(n) && n > 0) return { type: "order_lookup", order_number: n };
    }
  }

  const mSdt = plain.match(new RegExp(`^${dem}(?:${xem}\\s+)?${don}\\s+(?:cua\\s+)?(?:khach\\s+)?(?:sdt\\s*|so dien thoai\\s*|so\\s*)?(\\+?\\d[\\d .]{7,14}\\d)${duoi}$`));
  if (mSdt) {
    const digits = mSdt[1].replace(/\D/g, "");
    if (digits.length >= 9 && digits.length <= 12) return { type: "order_lookup", lookup_kind: "phone", lookup_text: digits };
  }

  // Nhánh tên dễ bắt nhầm chuyện phiếm, nên chỉ nhận khi có động từ tra/xem/tìm
  // kèm danh xưng (chị Lan), hoặc khi nhân viên chủ động gọi bot bằng /ops, @bot.
  const goiRoRang = /^\s*\/ops\b/i.test(raw) || /@\w+/.test(raw);
  const sach = text.replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  const plainSach = sach.map(boDau).join(" ");
  const mTen = plainSach.match(new RegExp(`^${dem}(?:(${xem})\\s+${don}\\s+(?:cua\\s+)?|${don}\\s+cua\\s+)(.+)$`));
  if (mTen) {
    const coDongTu = Boolean(mTen[1]);
    let tu = mTen[2].trim().split(/\s+/);
    const k = tu.length;
    const goc = sach.slice(sach.length - k);
    const boDuoi = new Set(["nhe", "nha", "ne", "di", "ngay", "voi", "luon", "giup", "gium", "dum", "em", "minh"]);
    const cumDuoi = [["giao", "chua"], ["sao", "roi"], ["the", "nao"], ["dau", "roi"], ["chua"], ["dau"]];
    let doi = true;
    while (doi && tu.length) {
      doi = false;
      if (boDuoi.has(tu[tu.length - 1])) { tu.pop(); doi = true; continue; }
      for (const c of cumDuoi) {
        if (tu.length > c.length && c.every((w, n) => tu[tu.length - c.length + n] === w)) { tu = tu.slice(0, tu.length - c.length); doi = true; break; }
      }
    }
    const danhXung = new Set(["chi", "anh", "co", "chu", "khach", "ban"]);
    const chuc = new Set(["khach", "anh", "chi", "co", "chu", "ong", "ba", "bac", "ban", "em"]);
    const coDanhXung = tu.length > 0 && danhXung.has(tu[0]);
    let dau = 0;
    while (dau < tu.length - 1 && chuc.has(tu[dau])) dau++;
    const ten = tu.slice(dau);
    const chuoi = ten.join(" ");
    const phiem = ten.some((w) => ["bi", "loi", "nhieu", "shop", "minh", "em"].includes(w)) ||
      /\bhom (?:nay|qua)\b|\bda duyet\b/.test(chuoi);
    const duDieuKien = goiRoRang || (coDongTu && coDanhXung);
    if (duDieuKien && !phiem && ten.length && ten.length <= 6 && chuoi.length >= 2 && !/\d/.test(chuoi) &&
      !/^(?:moi|cho|chua|can|nao|hang|khach)\b/.test(chuoi)) {
      return { type: "order_lookup", lookup_kind: "name", lookup_text: goc.slice(dau, dau + ten.length).join(" ") };
    }
  }
  return null;
}

function nutBaoCao() {
  return [
    { text: "Hôm nay", callback_data: "ops_rep_today" },
    { text: "Tuần này", callback_data: "ops_rep_this_week" },
    { text: "Tháng này", callback_data: "ops_rep_this_month" },
  ];
}

/**
 * Lưới gợi ý khi nhân viên gõ câu về đơn mà parser không hiểu: không đoán, chỉ
 * đưa nút để mở bản nháp (vẫn phải bấm Xác nhận). Chat nhóm thì chỉ gợi ý khi
 * câu rõ là duyệt đơn/xem đơn, để không gây ồn.
 */
export function goiYDonHang(raw: string, laChatRieng: boolean): { text: string; reply_markup?: object } | null {
  const text = boTienTo(raw);
  if (!text || text.length > 120) return null;
  const plain = boDau(text);
  const coDon = /\bdon\b|#|\bcw\s*\d/.test(plain);
  const so = Array.from(new Set((plain.match(/\d{1,9}/g) ?? []).map(Number))).filter((n) => n > 0).slice(0, 5);
  // Số đơn cho lệnh ghi tiền: chỉ số đứng ngay sau "đơn / đơn số / # / CW", bỏ số tiền (500k, 2 triệu) và dãy số dài (SĐT).
  const soDon = Array.from(new Set(Array.from(plain.matchAll(/(?:\bdon(?:\s+hang)?(?:\s*so)?\s*|#\s*|\bcw\s*)(\d{1,8})(?!\d)(?![a-z])(?!\s*(?:tr|trieu|nghin|ngan|dong)\b)/g)).map((m) => Number(m[1])))).filter((n) => n > 0);
  const batDauXacNhanTien = /^(?:(?:da|xac nhan)\s+)*(?:(?:ghi\s+)?nhan\s+(?:duoc\s+)?tien|ck|chuyen\s+khoan)\b/.test(plain);
  if (soDon.length === 1 && /\b(?:nhan\s+tien|chuyen\s+khoan|ck)\b/.test(plain) &&
    !/\b(?:khong|dung|chua|huy|roi)\b/.test(plain) && (laChatRieng || batDauXacNhanTien)) {
    return {
      text: `Anh/chị muốn ghi nhận đã nhận tiền đơn #${soDon[0]} phải không?`,
      reply_markup: { inline_keyboard: [[{ text: `💰 Đã nhận tiền đơn #${soDon[0]}`, callback_data: `ops_pay_${soDon[0]}` }]] },
    };
  }
  // Huỷ đơn: chỉ gợi ý ở chat riêng, hoặc khi câu BẮT ĐẦU bằng "huỷ đơn". Câu phủ định/kể/hỏi thì im lặng.
  const batDauHuy = /^(?:(?:vui long|nho|hay|giup em|giup minh|cho em|cho minh|anh oi|chi oi|em oi|oi)\s+)*huy\s+don\b/.test(plain);
  // Số đơn cho lệnh huỷ: tối đa 6 chữ số, không phải số có dấu ngăn nghìn, không đứng trước đơn vị (12 chai, 500k, 2 triệu).
  const soDonHuy = Array.from(new Set(Array.from(plain.matchAll(/(?:\bdon(?:\s+hang)?(?:\s*so)?\s*|#\s*|\bcw\s*)(\d{1,6})(?!\d)(?![.,]\d)(?![a-z])(?!\s*(?:tr|trieu|nghin|ngan|dong|d|vnd|aud|k|chai|hop|thung|ly|cai|sp|san pham)\b)/g)).map((m) => Number(m[1])))).filter((n) => n > 0);
  if (soDonHuy.length >= 1 && soDonHuy.length === so.length && /\bhuy\b/.test(plain) && (laChatRieng || batDauHuy) &&
    !/\b(?:khong|dung|chua|roi|bi|da|muon|neu|co nen|co the)\b/.test(plain) && !text.includes("?")) {
    const ds = soDonHuy.slice(0, 5);
    return {
      text: ds.length === 1 ? `Anh/chị muốn huỷ đơn #${ds[0]} phải không? Em sẽ hỏi xác nhận trước khi huỷ.` : `Anh/chị muốn huỷ đơn nào: ${ds.map((n) => `#${n}`).join(" hay ")}?`,
      reply_markup: { inline_keyboard: ds.map((n) => [{ text: `❌ Huỷ đơn #${n}`, callback_data: `ops_cxl_${n}` }]) },
    };
  }
  // Mã giảm giá / ẩn-hiện / đổi giá: chỉ ghi qua /ops; ở chat riêng thì gợi ý (mã không đặt tên thì có nút).
  if (laChatRieng) {
    const shop = phanTichLenhShop(raw);
    const dscDon = shop?.type === "discount_create" && !shop.loi_hieu && !shop.discount_code && !shop.han_ngay && !shop.han_so_ngay && shop.usage_limit == null;
    if (dscDon && shop) {
      const g = GIOI_HAN_MA_GIAM;
      const nut = (cb: string, nhan: string) => [{ text: `🎟 Tạo mã giảm ${nhan}`, callback_data: cb }];
      const dong: Array<Array<{ text: string; callback_data: string }>> = [];
      const pc = shop.discount_percent;
      if (pc != null && Number.isInteger(pc) && pc >= 1 && pc <= g.toi_da_phan_tram) dong.push(nut(`ops_dsc_p${pc}`, `${pc}%`));
      const am = shop.discount_amount;
      if (am != null && am >= g.toi_thieu_so_tien && am <= g.toi_da_so_tien) dong.push(nut(`ops_dsc_a${am}`, dinhDangTien(am)));
      if (shop.so_tran != null) {
        const n = shop.so_tran;
        if (n >= 1 && n <= g.toi_da_phan_tram) dong.push(nut(`ops_dsc_p${n}`, `${n}%`));
        if (n * 1000 >= g.toi_thieu_so_tien && n * 1000 <= g.toi_da_so_tien) dong.push(nut(`ops_dsc_a${n * 1000}`, dinhDangTien(n * 1000)));
      }
      // Mức ngoài giới hạn: không có nút, đi tiếp xuống gợi ý /ops để bot giải thích giới hạn.
      if (dong.length) {
        return {
          text: shop.so_tran != null ? `“${shop.so_tran}” là ${shop.so_tran}% hay ${dinhDangTien(shop.so_tran * 1000)}? Em sẽ tự sinh mã và hỏi xác nhận trước khi tạo.`
            : `Anh/chị muốn tạo mã giảm ${pc != null ? `${pc}%` : dinhDangTien(am)} phải không? Em sẽ tự sinh mã và hỏi xác nhận trước khi tạo.`,
          reply_markup: { inline_keyboard: dong },
        };
      }
    }
    if (shop) return { text: `Muốn em làm việc này, anh/chị gõ: /ops ${html(text)}\n(Em sẽ lập bản nháp và hỏi xác nhận trước khi thay đổi.)` };
  }
  if (/\b(?:doanh\s+thu|doanh\s+so)\b/.test(plain) || (laChatRieng && /\bbao\s+cao\b/.test(plain))) {
    return { text: "Anh/chị muốn xem doanh thu trong bao lâu?", reply_markup: { inline_keyboard: [nutBaoCao()] } };
  }
  if (coDon && so.length && !/\b(?:duyet|xac nhan|hoan thanh)\b/.test(plain) &&
    /\b(?:xem|tra|tra cuu|kiem tra|check)\b/.test(plain) && !/\b(?:khong|dung|chua|huy|roi)\b/.test(plain)) {
    return {
      text: so.length === 1 ? `Anh/chị muốn xem đơn #${so[0]} phải không?` : `Anh/chị muốn xem đơn nào: ${so.map((n) => `#${n}`).join(" hay ")}?`,
      reply_markup: { inline_keyboard: so.map((n) => [{ text: `Xem đơn #${n}`, callback_data: `ops_view_${n}` }]) },
    };
  }
  if (coDon && so.length && /\b(?:duyet|xac nhan|hoan thanh)\b/.test(plain) &&
    !/\b(?:khong|dung|chua|huy|roi)\b/.test(plain)) {
    const ds = so.map((n) => `#${n}`).join(" hay ");
    return {
      text: so.length === 1 ? `Anh/chị muốn duyệt đơn ${ds} phải không?` : `Anh/chị muốn duyệt đơn nào: ${ds}?`,
      reply_markup: { inline_keyboard: so.map((n) => [{ text: `Duyệt đơn #${n}`, callback_data: `ops_ord_${n}` }]) },
    };
  }
  if (/\bdon(?:\s+hang)?\s+moi\b|\bchua\s+duyet\b|\bcho\s+duyet\b/.test(plain)) {
    return {
      text: "Anh/chị muốn xem các đơn đang chờ duyệt phải không?",
      reply_markup: { inline_keyboard: [[{ text: "📋 Xem đơn chờ duyệt", callback_data: "ops_list" }]] },
    };
  }
  if (laChatRieng && /\bdon\b/.test(plain)) {
    return { text: "Anh/chị gõ “đơn mới” để xem đơn chờ duyệt, “duyệt đơn 12”, “đã nhận tiền đơn 12” “huỷ đơn 12”, “tạo mã giảm 10%”, “ẩn sản phẩm X” hoặc “doanh thu 7 ngày”." };
  }
  return null;
}

/** Câu trông giống một lệnh (đơn hoặc kho) — dùng để nhắc nhân viên đang tiếp quản gõ /ops. */
export function trongGiongLenh(raw: string): boolean {
  const l = phanTichLenhNhanh(raw);
  return (l !== null && !l.loi_hieu) || goiYDonHang(raw, false) !== null;
}

/** Parser chắc chắn cho các câu kho phổ biến; câu tự do hơn sẽ đi qua LLM. */
export function phanTichLenhNhanh(raw: string): LenhVanHanh | null {
  const text = boTienTo(raw);
  const plain = boDau(text);

  const donHang = phanTichLenhDonHang(raw);
  if (donHang) return donHang;
  // Phải đứng trước nhánh kho: "giảm 10%" sẽ bị hiểu nhầm là xuất kho.
  const shop = phanTichLenhShop(raw);
  if (shop) return shop;
  // Có ý tạo mã / có % giảm mà không hiểu: từ chối rõ, tuyệt đối không để "giảm N" rơi sang trừ kho.
  if (coYTaoMaGiam(plain)) return loiMa(`Em chưa hiểu mức giảm. Muốn tạo mã giảm giá, anh/chị gõ ví dụ: tạo mã giảm 10% hoặc tạo mã giảm 50k. ${LOI_MA_CHUNG}`);

  // Ưu tiên ý định tạo mới trước từ "nhập": câu "tạo sản phẩm mới X, nhập
  // 12 chai" không được hiểu nhầm là cộng kho cho một sản phẩm đã có.
  const tao = plain.match(/(?:them|tao)\s+(?:san\s+pham|chai)\s+moi|san\s+pham\s+moi/i);
  if (tao) {
    const title = text.replace(/(?:thêm|them|tạo|tao)\s+(?:sản phẩm|san pham|chai)\s+mới|sản phẩm mới|san pham moi/gi, " ")
      .replace(/\s+/g, " ").trim();
    const gia = plain.match(/(?:gia|giá)\s*(\d[\d.,]*)\s*(?:d|đ|vnd)?/i);
    const sl = plain.match(/(?:so luong|số lượng|nhap|nhập)\s*(\d{1,6})/i);
    if (title) return {
      type: "create_product",
      title: title
        .replace(/(?:gia|giá)\s*\d[\d.,]*\s*(?:d|đ|vnd)?/i, "")
        .replace(/(?:số lượng|so luong|nhập|nhap)\s*\d{1,6}\s*(?:chai|hộp|hop|thùng|thung)?/i, "")
        .trim(),
      price_vnd: gia ? Number(gia[1].replace(/[.,]/g, "")) : undefined,
      initial_quantity: sl ? Number(sl[1]) : undefined,
    };
  }

  const tang = plain.match(/(?:moi\s+nhap|nhap(?:\s+kho)?|tang|cong)(?:\s+them)?\s*(\d{1,6})(?!\d|\s*%|\s*phan\s*tram|\s*(?:k|nghin|ngan|tr|trieu|d|dong|vnd)\b)\s*(?:chai|hop|thung|san\s*pham|sp)?/i);
  const giam = plain.match(/(?:xuat|giam|bot|tru)(?:\s+kho|\s+di|\s+them)?\s*(\d{1,6})(?!\d|\s*%|\s*phan\s*tram|\s*(?:k|nghin|ngan|tr|trieu|d|dong|vnd)\b)\s*(?:chai|hop|thung|san\s*pham|sp)?/i);
  const thayDoi = tang || giam;
  if (thayDoi) {
    const so = Number(thayDoi[1]) * (giam ? -1 : 1);
    const viTri = thayDoi.index ?? 0;
    // Chỉ số trên chuỗi bỏ dấu khớp với chuỗi gốc cho chữ Latin/Vietnamese ở
    // đây; nếu không, nhánh replace từ khoá bên dưới vẫn giữ được tên chai.
    let query = `${text.slice(0, viTri)} ${text.slice(viTri + thayDoi[0].length)}`;
    query = query
      .replace(/thông tin đọc từ ảnh\s*:/gi, " ")
      .replace(/\b(?:chai|hộp|hop|thùng|thung|sản phẩm|san pham|sp|vào kho|vao kho)\b/gi, " ")
      .replace(/\s+/g, " ").trim();
    if (query) return { type: "inventory_adjust", product_query: query, quantity_change: so };
  }

  if (/(?:ton kho|còn bao nhiêu|con bao nhieu|kiem tra kho|check kho)/i.test(plain)) {
    const query = text
      .replace(/(?:tồn kho|ton kho|còn bao nhiêu|con bao nhieu|kiểm tra kho|kiem tra kho|check kho)/gi, " ")
      .replace(/\s+/g, " ").trim();
    if (query) return { type: "inventory_lookup", product_query: query };
  }

  return null;
}

const DEM_LENH = "(?:(?:vui long|nho|hay|giup em|giup minh|cho em|cho minh|anh oi|chi oi|em oi|oi)\\s+)*";
const MO_DAU_LENH_DON = new RegExp(`^${DEM_LENH}(?:duyet don|xac nhan don|hoan thanh don|huy don|xac nhan da nhan tien|(?:da\\s+)?(?:nhan|thu)(?:\\s+duoc)?\\s+tien|ghi nhan tien)\\b`);
const MO_DAU_LENH_SHOP = new RegExp(`^${DEM_LENH}(?:(?:tao|them)\\s+(?:ma|voucher|coupon)|(?:an|giau|tat ban)\\s+(?:san pham|sp)|(?:tam\\s+)?ngung ban\\s+(?:san pham|sp)|mo ban lai\\s+(?:san pham|sp)|hien lai san pham|hien san pham|bat lai san pham|ngung kinh doanh\\s+(?:san pham|sp)|(?:doi|sua|cap nhat)\\s+gia)\\b`);

/**
 * Cổng tiếp quản khách: chỉ chặn câu MỞ ĐẦU bằng động từ mệnh lệnh rõ (duyệt/huỷ đơn, đã nhận tiền đơn,
 * tạo mã, ẩn / ngừng bán / mở bán lại sản phẩm, đổi/sửa giá). Câu nói với khách ("giá bên em 1tr5 ạ",
 * "mã giảm 10% nha anh", "ngừng bán rồi anh ạ") không bị chặn nhầm.
 */
export function laLenhGhiDonHang(raw: string): boolean {
  const plain = boDau(boTienTo(raw));
  const mShop = plain.match(MO_DAU_LENH_SHOP);
  if (mShop) {
    // Câu kết bằng "nha/nhé anh/chị", "anh/chị ạ" hay có "rồi" ngay sau động từ là lời nói với khách.
    const gon = plain.replace(/[?!.,;:\s]+$/g, "");
    if (/\s(?:nha|nhe)\s+(?:anh|chi)$/.test(gon) || /\s(?:anh|chi)\s+a$/.test(gon)) return false;
    if (/^\s*(?:nay\s+)?roi\b/.test(plain.slice(mShop[0].length))) return false;
    // Chỉ chặn khi bot thật sự hiểu đây là lệnh hợp lệ; câu bot không hiểu thì để đi tiếp như lời nói với khách.
    const l = phanTichLenhShop(raw);
    return Boolean(l && !l.loi_hieu);
  }
  if (!MO_DAU_LENH_DON.test(plain)) return false;
  const t = phanTichLenhDonHang(raw)?.type;
  return t === "order_cancel" || t === "order_complete" || t === "order_payment_received";
}

/** Tin chỉ là câu nói về đơn hàng, không có /ops hay @bot. Người ngoài nhân viên gõ thì bỏ qua, không báo lỗi. */
export function laCauLenhDonHang(message: TelegramMessageLike): boolean {
  if (message.photo?.length) return false;
  return phanTichLenhDonHang(String(message.text ?? "")) !== null;
}

export function laYeuCauVanHanhRoRang(message: TelegramMessageLike, bot: BotShop): boolean {
  const text = String(message.text ?? message.caption ?? "");
  const username = bot.username?.replace(/^@/, "").toLowerCase();
  const duocNhac = Boolean(username && text.toLowerCase().includes(`@${username}`));
  const traLoiBot = Boolean(message.reply_to_message?.from?.is_bot &&
    (!username || message.reply_to_message?.from?.username?.toLowerCase() === username));
  const lenh = /^\s*\/ops(?:@\w+)?(?:\s|$)/i.test(text);
  // Ảnh từ nhân viên là yêu cầu vận hành (luồng cũ chưa xử lý ảnh), nhưng vẫn
  // chỉ lập bản nháp và bắt buộc xác nhận trước khi ghi.
  return lenh || duocNhac || traLoiBot || Boolean(message.photo?.length);
}

export function laYeuCauVanHanh(message: TelegramMessageLike, bot: BotShop): boolean {
  return laYeuCauVanHanhRoRang(message, bot) || laCauLenhDonHang(message);
}

const OPERATOR_TOOLS = [
  {
    type: "function",
    function: {
      name: "inventory_adjust",
      description: "Cộng hoặc trừ tồn kho của một sản phẩm đã có.",
      parameters: { type: "object", additionalProperties: false, properties: {
        product_query: { type: "string" }, quantity_change: { type: "integer", minimum: -100000, maximum: 100000 },
      }, required: ["product_query", "quantity_change"] },
    },
  },
  {
    type: "function",
    function: {
      name: "inventory_lookup",
      description: "Tra cứu tồn kho, không thay đổi dữ liệu.",
      parameters: { type: "object", additionalProperties: false, properties: { product_query: { type: "string" } }, required: ["product_query"] },
    },
  },
  {
    type: "function",
    function: {
      name: "create_product",
      description: "Tạo một sản phẩm mới ở trạng thái nháp.",
      parameters: { type: "object", additionalProperties: false, properties: {
        title: { type: "string" }, sku: { type: "string" }, price_vnd: { type: "integer", minimum: 0 },
        initial_quantity: { type: "integer", minimum: 0, maximum: 100000 }, description: { type: "string" },
      }, required: ["title"] },
    },
  },
  {
    type: "function",
    function: {
      name: "order_list_pending",
      description: "Liệt kê các đơn hàng đang chờ duyệt, không thay đổi dữ liệu. Dùng khi hỏi 'đơn mới', 'có đơn nào chưa duyệt'.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "order_complete",
      description: "Duyệt hoàn thành một đơn hàng theo số đơn (ví dụ 'duyệt đơn 12', 'xác nhận đơn CW12' -> order_number 12).",
      parameters: { type: "object", additionalProperties: false, properties: {
        order_number: { type: "integer", minimum: 1 },
      }, required: ["order_number"] },
    },
  },
  {
    type: "function",
    function: {
      name: "order_lookup",
      description: "Tra thông tin một đơn hàng (chỉ đọc) theo số đơn, số điện thoại hoặc tên khách. Dùng cho 'xem đơn 12', 'tra đơn chị Lan'. Không dùng để duyệt.",
      parameters: { type: "object", additionalProperties: false, properties: {
        order_number: { type: "integer", minimum: 1 }, query: { type: "string" },
      } },
    },
  },
  {
    type: "function",
    function: {
      name: "order_payment_received",
      description: "Ghi nhận ĐÃ NHẬN TIỀN CHUYỂN KHOẢN cho một đơn theo số đơn ('đã nhận tiền đơn 12', 'đơn 12 đã chuyển khoản').",
      parameters: { type: "object", additionalProperties: false, properties: { order_number: { type: "integer", minimum: 1 } }, required: ["order_number"] },
    },
  },
  {
    type: "function",
    function: {
      name: "discount_create",
      description: "Tạo mã giảm giá cho cả đơn: percent (%) HOẶC amount (đồng), chỉ một trong hai; code tuỳ chọn. Chỉ khi nhân viên yêu cầu rõ ('tạo mã giảm 10%').",
      parameters: { type: "object", additionalProperties: false, properties: {
        percent: { type: "number" }, amount: { type: "integer" }, code: { type: "string" },
      } },
    },
  },
  {
    type: "function",
    function: {
      name: "product_visibility",
      description: "Ẩn sản phẩm khỏi cửa hàng (visible=false: 'ẩn sản phẩm X', 'ngừng bán X') hoặc mở bán lại (visible=true). product_query là tên sản phẩm nguyên văn trong câu.",
      parameters: { type: "object", additionalProperties: false, properties: {
        product_query: { type: "string" }, visible: { type: "boolean" },
      }, required: ["product_query", "visible"] },
    },
  },
  {
    type: "function",
    function: {
      name: "product_price",
      description: "Đổi giá bán (VND) của một sản phẩm khi nhân viên ra lệnh rõ 'đổi giá X thành N'. product_query là tên nguyên văn trong câu, price_vnd là số đồng xuất hiện trong câu.",
      parameters: { type: "object", additionalProperties: false, properties: {
        product_query: { type: "string" }, price_vnd: { type: "integer", minimum: 1000 },
      }, required: ["product_query", "price_vnd"] },
    },
  },
  {
    type: "function",
    function: {
      name: "revenue_report",
      description: "Báo cáo doanh thu (chỉ đọc). 'hôm nay' = period today, 'tuần này' = this_week, 'tháng này' = this_month; 'N ngày' = days.",
      parameters: { type: "object", additionalProperties: false, properties: {
        period: { type: "string", enum: ["today", "this_week", "this_month"] }, days: { type: "integer", minimum: 1, maximum: 365 },
      } },
    },
  },
] as const;

async function phanTichBangAi(text: string): Promise<LenhVanHanh | null> {
  const messages: ChatMessageTool[] = [
    { role: "system", content:
      "Bạn là bộ phân tích lệnh vận hành kho. Chỉ gọi đúng một tool khi nhân viên yêu cầu rõ. " +
      "Không đoán SKU, giá, số lượng. 'nhập thêm N' là quantity_change dương; 'xuất/giảm N' là âm. " +
      "Hỏi đơn mới/đơn chưa duyệt thì gọi order_list_pending; xem/tra đơn thì gọi order_lookup (không duyệt); duyệt/xác nhận đơn N thì gọi order_complete với số đơn N. Bạn không có tool huỷ đơn; không đề xuất huỷ đơn. " +
      "Nếu chưa đủ dữ kiện thì không gọi tool." },
    { role: "user", content: text },
  ];
  const kq = await goiDeepSeekCoTool(messages, OPERATOR_TOOLS as unknown as object[]);
  const call = kq.tool_calls?.[0];
  if (!call || !["inventory_adjust", "inventory_lookup", "create_product", "order_list_pending", "order_complete", "order_lookup", "order_payment_received", "revenue_report", "discount_create", "product_visibility", "product_price"].includes(call.function.name)) return null;
  try {
    const p = JSON.parse(call.function.arguments || "{}");
    if (call.function.name === "order_complete") {
      const n = Number(p.order_number);
      if (!Number.isSafeInteger(n) || n <= 0) return null;
      return { type: "order_complete", order_number: n };
    }
    if (call.function.name === "order_list_pending") return { type: "order_list_pending" };
    if (call.function.name === "order_payment_received") {
      const n = Number(p.order_number);
      return Number.isSafeInteger(n) && n > 0 ? { type: "order_payment_received", order_number: n } : null;
    }
    if (call.function.name === "discount_create") {
      // Số LLM đưa phải xuất hiện trong câu gốc; chỉ nhận một loại mức giảm.
      const pc = p.percent != null ? Number(p.percent) : undefined;
      const am = p.amount != null ? Number(p.amount) : undefined;
      if ((pc == null) === (am == null)) return null;
      const plainGoc = boDau(text);
      const soTrongCau = new Set<number>();
      for (const m of plainGoc.matchAll(new RegExp(MAU_TIEN, "g"))) { const v = parseTienVN(m[0]); if (v !== null) soTrongCau.add(v); }
      for (const m of plainGoc.matchAll(/(\d{1,3}(?:[.,]\d+)?)\s*(?:%|phan\s*tram)/g)) soTrongCau.add(Number(m[1].replace(",", ".")));
      if (pc != null && (!Number.isFinite(pc) || !soTrongCau.has(pc) || !/%|phan\s*tram/.test(plainGoc))) return null;
      if (am != null && (!Number.isSafeInteger(am) || !soTrongCau.has(am))) return null;
      const tuNguyen = new Set(plainGoc.split(/[^a-z0-9_-]+/).filter(Boolean));
      const code = typeof p.code === "string" && /^[A-Za-z0-9_-]{3,20}$/.test(p.code) && tuNguyen.has(p.code.toLowerCase()) ? p.code.toUpperCase() : undefined;
      return { type: "discount_create", discount_percent: pc, discount_amount: am, discount_code: code };
    }
    if (call.function.name === "product_price") {
      const q = String(p.product_query ?? "").trim().slice(0, 80);
      const gia = Number(p.price_vnd);
      const plainGoc = boDau(text);
      const tuQ = boDau(q).split(/\s+/).filter(Boolean);
      const soTrongCau = new Set<number>();
      for (const m of plainGoc.matchAll(new RegExp(MAU_TIEN, "g"))) { const v = parseTienVN(m[0]); if (v !== null) soTrongCau.add(v); }
      // Bắt buộc có "đổi/sửa giá" trong câu, giá LLM đưa phải có trong câu gốc, tên phải có trong câu.
      if (!q || !Number.isSafeInteger(gia) || gia < 1000 || !soTrongCau.has(gia) || !/\b(?:doi|sua|cap nhat)\s+gia\b/.test(plainGoc) ||
        !tuQ.every((w) => plainGoc.includes(w))) return null;
      return { type: "product_price", product_query: q, price_vnd: gia };
    }
    if (call.function.name === "product_visibility") {
      const q = String(p.product_query ?? "").trim().slice(0, 80);
      const tuQ = boDau(q).split(/\s+/).filter(Boolean);
      if (!q || typeof p.visible !== "boolean" || !tuQ.every((w) => boDau(text).includes(w))) return null;
      return { type: p.visible ? "product_show" : "product_hide", product_query: q };
    }
    if (call.function.name === "revenue_report") {
      if (["today", "this_week", "this_month"].includes(p.period)) return { type: "revenue_report", report_period: p.period };
      const d = Number(p.days);
      return { type: "revenue_report", report_days: Number.isInteger(d) && d >= 1 && d <= 365 ? d : 7 };
    }
    if (call.function.name === "order_lookup") {
      const n = Number(p.order_number);
      if (Number.isSafeInteger(n) && n > 0) return { type: "order_lookup", order_number: n };
      const q = String(p.query ?? "").trim().slice(0, 60);
      if (!q) return null;
      const digits = q.replace(/\D/g, "");
      return digits.length >= 9 ? { type: "order_lookup", lookup_kind: "phone", lookup_text: digits }
        : { type: "order_lookup", lookup_kind: "name", lookup_text: q };
    }
    return { type: call.function.name as LoaiLenh, ...p };
  } catch {
    return null;
  }
}

async function moTaAnh(bot: BotShop, photo: NonNullable<TelegramMessageLike["photo"]>[number]): Promise<string> {
  if ((photo.file_size ?? 0) > 8 * 1024 * 1024) throw new LoiThanThien("Ảnh vượt quá 8 MB.");
  const [base, key, model] = await Promise.all([
    layCaiDat("vision_api_base_url"), layCaiDat("vision_api_key"), layCaiDat("vision_model"),
  ]);
  if (!base || !key || !model) {
    throw new LoiThanThien("Chưa cấu hình vision_api_base_url, vision_api_key và vision_model trong Cài đặt nền tảng.");
  }
  const file = await fetchJson<any>(`${`https://api.telegram.org/bot${bot.token}`}/getFile?file_id=${encodeURIComponent(photo.file_id)}`, {}, TIMEOUT.TELEGRAM);
  const filePath = file?.result?.file_path;
  if (!filePath) throw new Error("Telegram không trả đường dẫn ảnh.");
  const anh = await fetchCoTimeout(`https://api.telegram.org/file/bot${bot.token}/${filePath}`, {}, TIMEOUT.TELEGRAM);
  if (!anh.ok) throw new Error(`Không tải được ảnh Telegram (${anh.status}).`);
  const bytes = Buffer.from(await anh.arrayBuffer());
  if (bytes.length > 8 * 1024 * 1024) throw new LoiThanThien("Ảnh vượt quá 8 MB.");
  const mime = anh.headers.get("content-type") || "image/jpeg";
  const endpoint = `${base.replace(/\/+$/, "")}/chat/completions`;
  const res = await fetchCoTimeout(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 350,
      messages: [{ role: "user", content: [
        { type: "text", text: "Đọc nhãn chai rượu để quản lý kho. Trả lời ngắn: tên sản phẩm đầy đủ, nhà sản xuất, niên vụ, dung tích; không đoán chi tiết không nhìn thấy." },
        { type: "image_url", image_url: { url: `data:${mime};base64,${bytes.toString("base64")}` } },
      ] }],
    }),
  }, 30_000);
  if (!res.ok) throw new Error(`Vision API lỗi ${res.status}: ${(await res.text()).slice(0, 180)}`);
  const data: any = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) throw new LoiThanThien("Vision API không nhận diện được nhãn chai.");
  return content.trim().slice(0, 1200);
}

async function layMedusa(tenantId: string): Promise<MedusaConfig> {
  const cfg = await runInTenantContext(tenantId, (client) => getTenantMedusaConfig(client, tenantId));
  if (!cfg) throw new LoiThanThien("Shop chưa kết nối Medusa hoặc kết nối đang tắt.");
  return cfg;
}

async function goiBackend(cfg: MedusaConfig, path: string, body: Record<string, unknown>): Promise<any> {
  return fetchJson(new URL(path, cfg.baseUrl).toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-ai-secret-key": env.AI_SECRET_KEY },
    body: JSON.stringify(body),
  }, 15_000);
}

async function docBackend(cfg: MedusaConfig, path: string, loi = "Em chưa lấy được danh sách đơn lúc này. Anh/chị thử lại sau ít phút giúp em nhé."): Promise<any> {
  try {
    return await fetchJson(new URL(path, cfg.baseUrl).toString(), {
      headers: { "x-ai-secret-key": env.AI_SECRET_KEY },
    }, 15_000);
  } catch (e) {
    console.error("[telegram-operator] đọc backend lỗi:", e);
    throw new LoiThanThien(loi);
  }
}

type TrangThaiTien = "cod" | "cho_chuyen_khoan" | "da_thanh_toan" | null | undefined;

function dongTien(t: TrangThaiTien): string {
  if (t === "cod") return "💵 Thu tiền khi giao (COD)";
  if (t === "cho_chuyen_khoan") return "⏳ Chờ chuyển khoản — anh/chị kiểm tra đã nhận tiền chưa rồi hãy duyệt";
  if (t === "da_thanh_toan") return "✅ Đã nhận tiền";
  return "";
}

const BIEU_TUONG_TIEN: Record<string, string> = { cod: "💵", cho_chuyen_khoan: "⏳", da_thanh_toan: "✅" };

interface DonChoDuyet {
  payment_status?: TrangThaiTien;
  id: string;
  status?: string;
  display_id: number;
  total_vnd: number;
  created_at?: string;
  tracking_code?: string | null;
  customer?: { name?: string; phone?: string | null; address?: string | null };
  items?: Array<{ title: string; quantity: number }>;
}

async function layDon(cfg: MedusaConfig, params: Record<string, string>): Promise<DonChoDuyet[]> {
  const r = await docBackend(cfg, `/ai/orders-operator?${new URLSearchParams(params).toString()}`);
  return Array.isArray(r?.orders) ? r.orders : [];
}

/** Chọn đơn có số đơn khớp CHÍNH XÁC (q=1 cũng trả về 12, 21, 100...). */
export function chonDonTheoSo(orders: DonChoDuyet[], soDon: number): DonChoDuyet | null {
  return orders.find((o) => Number(o.display_id) === soDon) ?? null;
}

async function taoAction(tenantId: string, chatId: string, messageId: string | null, operatorId: string, type: LoaiLenh,
  status: "awaiting_selection" | "awaiting_confirmation", payload: Record<string, unknown>, originalText: string): Promise<{ id: string; created: boolean }> {
  return runInTenantContext(tenantId, async (client) => {
    const r = await client.query(
      `INSERT INTO telegram_operator_action
        (tenant_id, telegram_chat_id, telegram_message_id, requested_by, action_type, status, payload, original_text)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
       ON CONFLICT (tenant_id, telegram_chat_id, telegram_message_id)
         WHERE telegram_message_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [tenantId, chatId, messageId, operatorId, type, status, JSON.stringify(payload), originalText.slice(0, 4000)]
    );
    if (r.rows[0]?.id) return { id: String(r.rows[0].id), created: true };
    const old = await client.query(
      `SELECT id FROM telegram_operator_action WHERE tenant_id=$1 AND telegram_chat_id=$2 AND telegram_message_id=$3`,
      [tenantId, chatId, messageId]
    );
    return { id: String(old.rows[0]?.id || ""), created: false };
  });
}

function nutXacNhan(id: string, type?: LoaiLenh) {
  if (type === "order_cancel") {
    return { inline_keyboard: [[
      { text: "⚠️ Xác nhận HUỶ ĐƠN", callback_data: `ops_ok_${id}` },
      { text: "↩️ Không huỷ nữa", callback_data: `ops_no_${id}` },
    ]] };
  }
  return { inline_keyboard: [[
    { text: "✅ Xác nhận", callback_data: `ops_ok_${id}` },
    { text: "❌ Huỷ", callback_data: `ops_no_${id}` },
  ]] };
}

function cheSdt(v: unknown): string {
  const d = String(v ?? "").replace(/\D/g, "");
  if (!d) return "";
  return d.length >= 7 ? `${d.slice(0, 2)}xx***${d.slice(-3)}` : "***";
}

function dongTienKhiHuy(t: unknown, tong: unknown): string {
  if (t === "da_thanh_toan") return `💸 Khách ĐÃ chuyển ${dinhDangTien(tong)}. Huỷ xong anh/chị phải TỰ chuyển khoản trả lại khách — hệ thống chỉ ghi sổ, không tự trả tiền.`;
  if (t === "cod") return "💵 Thu khi giao, chưa thu tiền nên không có gì phải trả lại.";
  return "Anh/chị kiểm tra khách đã chuyển tiền chưa; nếu rồi thì phải tự chuyển trả.";
}

async function guiBanNhap(bot: BotShop, chatId: string, id: string, type: LoaiLenh, payload: any): Promise<void> {
  let text = "";
  if (type === "inventory_adjust") {
    const dau = Number(payload.quantity_change) >= 0 ? "+" : "";
    text = `📦 <b>Xác nhận cập nhật kho</b>\nSản phẩm: <b>${html(payload.title)}</b>\nSKU: <code>${html(payload.sku)}</code>\nThay đổi: <b>${dau}${html(payload.quantity_change)}</b>`;
  } else if (type === "order_complete") {
    const mon = (Array.isArray(payload.items) ? payload.items : []).slice(0, 10)
      .map((it: any) => `• ${html(it.quantity)} × ${html(it.title)}`).join("\n");
    text = `🧾 <b>Duyệt đơn #${html(payload.display_id)}?</b>\n👤 ${html(payload.customer_name || "Khách lẻ")}\n${mon}\n💰 Tổng: <b>${dinhDangTien(payload.total_vnd)}</b>${dongTien(payload.payment_status) ? `\n${dongTien(payload.payment_status)}` : ""}\n\nDuyệt xong kho sẽ được trừ. Bấm Xác nhận để duyệt nhé.`;
  } else if (type === "order_payment_received") {
    text = `💰 <b>Xác nhận đã nhận tiền chuyển khoản đơn #${html(payload.display_id)}?</b>\nKhách: ${html(payload.customer_name || "Khách lẻ")}\nSố tiền: <b>${dinhDangTien(payload.total_vnd)}</b>\n\nAnh/chị kiểm tra tài khoản ngân hàng đã có tiền rồi hãy bấm Xác nhận.`;
  } else if (type === "order_cancel") {
    const mon = (Array.isArray(payload.items) ? payload.items : []).slice(0, 10)
      .map((it: any) => `• ${html(it.quantity)} × ${html(it.title)}`).join("\n");
    text = `⚠️ <b>Huỷ đơn #${html(payload.display_id)}?</b>\nKhách: ${html(payload.customer_name || "Khách lẻ")}${payload.customer_phone_masked ? ` · ${html(payload.customer_phone_masked)}` : ""}\n${mon ? `${mon}\n` : ""}Tổng: <b>${dinhDangTien(payload.total_vnd)}</b>\n${html(dongTienKhiHuy(payload.payment_status, payload.total_vnd))}\nKhách KHÔNG được báo tự động — anh/chị nhắn khách giúp em.\n\n<b>Thao tác này không hoàn tác được.</b>`;
  } else if (type === "discount_create") {
    const muc = payload.percent != null ? `<b>${html(payload.percent)}%</b> trên cả đơn` : `<b>${dinhDangTien(payload.amount)}</b> trên cả đơn`;
    text = `🎟 <b>Tạo mã giảm giá?</b>\nMã: <code>${html(payload.code)}</code>\nMức giảm: ${muc}\n` +
      `Hạn dùng: ${payload.ends_at ? `đến <b>${html(payload.ends_label)}</b>` : "<b>KHÔNG có</b> (dùng mãi cho đến khi tắt)"}\n` +
      `Số lần dùng: ${payload.usage_limit != null ? `tối đa <b>${html(payload.usage_limit)}</b> lần` : "<b>KHÔNG giới hạn</b> — ai có mã cũng dùng được, dùng nhiều lần"}\n\n` +
      "Mã tạo xong muốn tắt phải vào trang quản trị. Bấm Xác nhận để tạo.";
  } else if (type === "price_update") {
    const cu = Number(payload.old_price_vnd) > 0 ? Number(payload.old_price_vnd) : null;
    const moi = Number(payload.new_price_vnd);
    let chenh = "";
    let canhBao = "";
    if (cu) {
      const pct = ((moi - cu) / cu) * 100;
      chenh = ` (${pct >= 0 ? "+" : ""}${(Math.round(pct * 10) / 10).toString().replace(".", ",")}%)`;
      if (moi < cu * 0.5 || moi > cu * 3) canhBao = "\n⚠️ Giá thay đổi rất lớn, anh/chị kiểm tra lại số.";
    }
    if (moi < 10_000) canhBao += `\n⚠️ Giá rất thấp (${dinhDangTien(moi)}), anh/chị kiểm tra lại số.`;
    text = `💲 <b>Đổi giá?</b>\n<b>${html(payload.title)}</b>${payload.sku ? ` (<code>${html(payload.sku)}</code>)` : ""}\nGiá: ${cu ? dinhDangTien(cu) : "chưa có giá"} → <b>${dinhDangTien(moi)}</b>${chenh}${canhBao}\n\nGiá mới áp dụng ngay cho khách. Bấm Xác nhận để đổi.`;
  } else if (type === "product_hide" || type === "product_show") {
    text = type === "product_hide"
      ? `🙈 <b>Ẩn sản phẩm khỏi cửa hàng?</b>\n<b>${html(payload.title)}</b>${payload.sku ? ` (<code>${html(payload.sku)}</code>)` : ""}\nKhách sẽ không thấy và không mua được. Muốn bán lại thì gõ “/ops mở bán lại ${html(payload.title)}”.`
      : `👁 <b>Mở bán lại sản phẩm?</b>\n<b>${html(payload.title)}</b>${payload.sku ? ` (<code>${html(payload.sku)}</code>)` : ""}\nSản phẩm sẽ hiện lại trên cửa hàng cho khách mua.`;
  } else if (type === "inventory_lookup") {
    text = `🔎 Tra tồn kho <b>${html(payload.title)}</b> — SKU <code>${html(payload.sku)}</code>?`;
  } else {
    text = `🆕 <b>Xác nhận tạo sản phẩm nháp</b>\nTên: <b>${html(payload.title)}</b>\nSKU: <code>${html(payload.sku)}</code>` +
      (payload.price_vnd != null ? `\nGiá: ${Number(payload.price_vnd).toLocaleString("vi-VN")}đ` : "\nGiá: chưa nhập") +
      (payload.initial_quantity != null ? `\nTồn đầu: ${html(payload.initial_quantity)}` : "\nTồn đầu: 0");
  }
  const markup: any = nutXacNhan(id, type);
  if (type === "order_complete" && payload.payment_status === "cho_chuyen_khoan") {
    markup.inline_keyboard.push([{ text: "💰 Đã nhận tiền", callback_data: `ops_pay_${payload.display_id}` }]);
  }
  await guiTinQuaBot(bot, { chat_id: chatId, text, parse_mode: "HTML", reply_markup: markup });
}

const BANG_MA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // bỏ 0/O, 1/I

/** Mã dễ đọc, không ký tự dễ nhầm: GIAM10-7KQ4, GIAM50K-X3PM. */
/** Luật mã của backend: trim, CHỮ HOA, chỉ [A-Z0-9_-], 3..32 ký tự. Sai thì trả null. */
export function chuanHoaMa(v: string): string | null {
  const m = String(v ?? "").trim().toUpperCase();
  return /^[A-Z0-9_-]{3,32}$/.test(m) ? m : null;
}

export function sinhMaGiamGia(percent?: number, amount?: number): string {
  let hau = "";
  for (let i = 0; i < 4; i++) hau += BANG_MA[randomInt(BANG_MA.length)];
  const dau = percent != null ? `GIAM${percent}` : `GIAM${Math.round(Number(amount) / 1000)}K`;
  return `${dau}-${hau}`;
}

async function lapBanNhapMaGiam(bot: BotShop, tenantId: string, chatId: string, operatorId: string,
  messageId: string | null, lenh: LenhVanHanh, originalText: string): Promise<void> {
  if (lenh.loi_hieu) throw new LoiThanThien(lenh.loi_hieu);
  const g = GIOI_HAN_MA_GIAM;
  const gioiHan = `Em chỉ tạo được mã giảm tối đa ${g.toi_da_phan_tram}% hoặc ${dinhDangTien(g.toi_da_so_tien)}. Mã lớn hơn anh/chị báo quản lý nhé.`;
  // "giảm 10" không đơn vị: hỏi lại bằng 2 nút, chỉ hiện mức nằm trong giới hạn.
  if (lenh.so_tran != null) {
    const n = lenh.so_tran;
    const dong: Array<Array<{ text: string; callback_data: string }>> = [];
    if (n >= 1 && n <= g.toi_da_phan_tram) dong.push([{ text: `🎟 Giảm ${n}%`, callback_data: `ops_dsc_p${n}` }]);
    if (n * 1000 >= g.toi_thieu_so_tien && n * 1000 <= g.toi_da_so_tien) dong.push([{ text: `🎟 Giảm ${dinhDangTien(n * 1000)}`, callback_data: `ops_dsc_a${n * 1000}` }]);
    if (!dong.length) throw new LoiThanThien(`Mức giảm “${n}” không hợp lệ. ${gioiHan}`);
    if (lenh.discount_code || lenh.han_ngay || lenh.han_so_ngay || lenh.usage_limit != null) {
      throw new LoiThanThien(`“${n}” là ${n}% hay ${dinhDangTien(n * 1000)}? Anh/chị gõ lại kèm đơn vị, ví dụ: tạo mã giảm ${n}% hoặc tạo mã giảm ${n}k.`);
    }
    await guiTinQuaBot(bot, { chat_id: chatId, text: `“${n}” là ${n}% hay ${dinhDangTien(n * 1000)}?`, reply_markup: { inline_keyboard: dong } });
    return;
  }
  const pc = lenh.discount_percent;
  const am = lenh.discount_amount;
  if ((pc == null) === (am == null)) throw new LoiThanThien("Anh/chị cho em xin đúng một mức giảm, ví dụ: tạo mã giảm 10% hoặc tạo mã giảm 50k.");
  if (pc != null) {
    if (!Number.isFinite(pc) || pc <= 0) throw new LoiThanThien("Mức giảm phải lớn hơn 0%.");
    if (!Number.isInteger(pc)) throw new LoiThanThien("Em chỉ tạo mã giảm theo số % nguyên, ví dụ 10%.");
    if (pc > g.toi_da_phan_tram) throw new LoiThanThien(`Mức giảm ${pc}% vượt giới hạn. ${gioiHan}`);
  } else {
    if (!Number.isSafeInteger(am) || (am as number) < g.toi_thieu_so_tien) throw new LoiThanThien(`Số tiền giảm quá nhỏ (tối thiểu ${dinhDangTien(g.toi_thieu_so_tien)}). Nếu ý anh/chị là giảm theo %, hãy gõ kèm dấu %, ví dụ: tạo mã giảm 10%.`);
    if ((am as number) > g.toi_da_so_tien) throw new LoiThanThien(`Mức giảm ${dinhDangTien(am)} vượt giới hạn. ${gioiHan}`);
  }
  if (lenh.usage_limit != null && (!Number.isSafeInteger(lenh.usage_limit) || lenh.usage_limit < 1 || lenh.usage_limit > 100_000)) {
    throw new LoiThanThien("Số lần dùng phải từ 1 đến 100.000.");
  }
  if (lenh.han_so_ngay != null && (lenh.han_so_ngay < 1 || lenh.han_so_ngay > 366)) throw new LoiThanThien("Hạn dùng phải từ 1 ngày đến 1 năm.");
  const han = lenh.han_ngay || lenh.han_so_ngay != null
    ? tinhHanDung(lenh.han_ngay ? { ngay: lenh.han_ngay } : { soNgay: lenh.han_so_ngay })
    : null;
  let code: string | null;
  if (lenh.discount_code) {
    code = chuanHoaMa(lenh.discount_code);
    if (!code) throw new LoiThanThien("Mã chỉ gồm chữ không dấu, số, gạch ngang hoặc gạch dưới, dài 3 đến 32 ký tự. Anh/chị đặt lại mã nhé.");
  } else code = sinhMaGiamGia(pc, am);
  const payload = {
    code, custom_code: Boolean(lenh.discount_code), percent: pc ?? null, amount: am ?? null,
    ends_at: han?.ends_at ?? null, ends_label: han?.nhan ?? null, usage_limit: lenh.usage_limit ?? null,
  };
  const action = await taoAction(tenantId, chatId, messageId, operatorId, "discount_create", "awaiting_confirmation", payload, originalText);
  if (action.created) await guiBanNhap(bot, chatId, action.id, "discount_create", payload);
}

/** Từ của câu tìm (bỏ dấu, giữ số) đều có trong tên sản phẩm thì mới được tự chọn. */
function khopUngVien(query: string, title: string, sku?: string): boolean {
  return khopDayDu(query, title) || Boolean(sku && boDau(sku).trim() === boDau(query).trim());
}

function khopDayDu(query: string, title: string): boolean {
  const tu = boDau(query).replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
  const t = boDau(title);
  return tu.length > 0 && tu.every((w) => t.includes(w));
}

interface UngVien { id: string; sku?: string; title: string; variant_id?: string; price_vnd?: number }

/** Gửi danh sách chọn (ops_pick) khi không chắc đúng sản phẩm. */
async function guiDanhSachChon(bot: BotShop, tenantId: string, chatId: string, operatorId: string, messageId: string | null,
  loai: LoaiLenh, payload: Record<string, unknown>, ungVien: UngVien[], query: string, originalText: string, tieuDe?: string): Promise<void> {
  const action = await taoAction(tenantId, chatId, messageId, operatorId, loai, "awaiting_selection", { ...payload, candidates: ungVien }, originalText);
  if (!action.created) return;
  await guiTinQuaBot(bot, {
    chat_id: chatId,
    text: `${tieuDe ?? `🔎 Tìm thấy ${ungVien.length} sản phẩm gần giống “${html(query)}”. Chọn đúng sản phẩm:`}\nKhông thấy đúng? Anh/chị gõ rõ tên hơn nhé.`,
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: ungVien.map((c, i) => [{ text: `${c.title}${c.sku ? ` (${c.sku})` : ""}${c.price_vnd ? ` · ${dinhDangTien(c.price_vnd)}` : ""}`.slice(0, 60), callback_data: `ops_pick_${action.id}_${i}` }]) },
  });
}

interface DongLookup { product_id: string; variant_id: string; sku?: string; title: string; variant_title?: string; price_vnd?: number }

async function traLookup(cfg: MedusaConfig, body: Record<string, unknown>): Promise<DongLookup[]> {
  try {
    const r = await goiBackend(cfg, "/ai/products-lookup", body);
    return Array.isArray(r?.items) ? r.items : [];
  } catch (e) {
    console.error("[telegram-operator] products-lookup lỗi:", e);
    throw new LoiThanThien("Em chưa tra được thông tin sản phẩm lúc này. Anh/chị thử lại sau ít phút giúp em nhé.");
  }
}

/** Ẩn / mở bán lại: tìm sản phẩm; chỉ tự chọn khi MỌI từ câu tìm có trong tên, còn lại luôn hiện danh sách. */
async function lapActionAnHien(bot: BotShop, tenantId: string, chatId: string, operatorId: string,
  messageId: string | null, lenh: LenhVanHanh, originalText: string): Promise<void> {
  const query = String(lenh.product_query || "").replace(/^(?:s[ảa]n ph[ẩa]m|sp)\s+/i, "").trim();
  if (!query) throw new LoiThanThien("Anh/chị cho em xin tên sản phẩm nhé, ví dụ: ẩn sản phẩm Penfolds Bin 389.");
  let candidates: UngVien[];
  if (lenh.type === "product_hide") {
    const kq = await timSanPham(tenantId, { query, in_stock_only: false, limit: 5 });
    candidates = kq.products.filter((p) => p.id).map((p) => ({ id: p.id, sku: p.sku, title: p.title }));
    if (!candidates.length) throw new LoiThanThien(`Không tìm thấy sản phẩm đang bán khớp “${query}”. Anh/chị gõ rõ tên hơn giúp em nhé.`);
  } else {
    // Sản phẩm đang ẩn không còn trong tìm kiếm: lấy ứng viên từ lịch sử ẩn qua bot (mới nhất trước) và/hoặc SKU gõ trực tiếp,
    // rồi hỏi backend (status=draft) để xác nhận chúng còn đang ẩn và lấy tên/SKU hiện tại.
    const cfg = await layMedusa(tenantId);
    const lichSu = await runInTenantContext(tenantId, async (client) => {
      const r = await client.query(
        `SELECT h.payload->>'product_id' AS id, h.payload->>'title' AS title, h.payload->>'sku' AS sku
           FROM telegram_operator_action h
          WHERE h.tenant_id=$1 AND h.action_type='product_hide' AND h.status='completed' AND h.payload->>'product_id' IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM telegram_operator_action s
                             WHERE s.tenant_id=h.tenant_id AND s.action_type='product_show' AND s.status='completed'
                               AND s.payload->>'product_id'=h.payload->>'product_id' AND s.created_at > h.created_at)
          ORDER BY h.created_at DESC LIMIT 200`,
        [tenantId]
      );
      return r.rows as Array<{ id: string; title: string; sku: string | null }>;
    });
    const daCo = new Set<string>();
    candidates = [];
    for (const r of lichSu) {
      if (!r.id || daCo.has(r.id) || !khopDayDu(query, r.title || "")) continue;
      daCo.add(r.id);
      candidates.push({ id: r.id, sku: r.sku ?? undefined, title: r.title });
      if (candidates.length >= 5) break;
    }
    const laSku = /^[A-Za-z0-9][A-Za-z0-9_-]{2,40}$/.test(query);
    if (candidates.length || laSku) {
      const dong = await traLookup(cfg, { ...(candidates.length ? { ids: candidates.map((c) => c.id) } : { skus: [query] }), status: "draft" });
      const theoSp = new Map<string, DongLookup>();
      for (const d of dong) if (!theoSp.has(d.product_id)) theoSp.set(d.product_id, d);
      candidates = Array.from(theoSp.values()).slice(0, 5).map((d) => ({ id: d.product_id, sku: d.sku, title: d.title }));
    }
    if (!candidates.length) throw new LoiThanThien(`Em không thấy sản phẩm đang ẩn nào khớp “${query}”. Em tra được các sản phẩm đã ẩn qua bot hoặc theo mã SKU (ví dụ: mở bán lại sản phẩm PF389).`);
  }
  const payload = { product_query: query };
  if (candidates.length === 1 && khopUngVien(query, candidates[0].title, candidates[0].sku)) {
    const c = candidates[0];
    const full = { ...payload, candidates, product_id: c.id, sku: c.sku, title: c.title };
    const action = await taoAction(tenantId, chatId, messageId, operatorId, lenh.type, "awaiting_confirmation", full, originalText);
    if (action.created) await guiBanNhap(bot, chatId, action.id, lenh.type, full);
    return;
  }
  await guiDanhSachChon(bot, tenantId, chatId, operatorId, messageId, lenh.type, payload, candidates, query, originalText);
}

/** Đổi giá: tìm sản phẩm, lấy giá hiện tại từ products-lookup, cho chọn biến thể nếu không chắc. */
async function lapActionDoiGia(bot: BotShop, tenantId: string, chatId: string, operatorId: string,
  messageId: string | null, lenh: LenhVanHanh, originalText: string): Promise<void> {
  const query = String(lenh.product_query || "").replace(/^(?:s[ảa]n ph[ẩa]m|sp)\s+/i, "").trim();
  const gia = Number(lenh.price_vnd);
  if (!query || !Number.isSafeInteger(gia) || gia < 1000 || gia > 1_000_000_000) {
    throw new LoiThanThien("Anh/chị cho em xin tên sản phẩm và giá mới (từ 1.000đ), ví dụ: đổi giá Penfolds Bin 389 thành 1.250.000.");
  }
  const cfg = await layMedusa(tenantId);
  const kq = await timSanPham(tenantId, { query, in_stock_only: false, limit: 5 });
  const sp = kq.products.filter((p) => p.id);
  if (!sp.length) throw new LoiThanThien(`Không tìm thấy sản phẩm đang bán khớp “${query}”. Anh/chị gõ rõ tên hơn giúp em nhé.`);
  const dongTho = await traLookup(cfg, { ids: sp.map((p) => p.id) });
  // Backend có thể trả nhiều dòng cho một biến thể (nhiều loại giá): gộp theo variant_id, giữ dòng đầu.
  const daThay = new Set<string>();
  const dong = dongTho.filter((d) => {
    const k = String(d.variant_id || `${d.product_id}:${d.sku ?? ""}`);
    if (daThay.has(k)) return false;
    daThay.add(k);
    return true;
  });
  if (!dong.length) throw new LoiThanThien("Em chưa lấy được giá hiện tại của sản phẩm này (có thể sản phẩm đang ẩn). Anh/chị kiểm tra trong trang quản trị giúp em nhé.");
  const nhan = (d: DongLookup) => `${d.title}${d.variant_title && d.variant_title !== d.title && !/^default/i.test(d.variant_title) ? ` — ${d.variant_title}` : ""}`;
  const ungVien: UngVien[] = dong.slice(0, 8).map((d) => ({ id: d.product_id, variant_id: d.variant_id, sku: d.sku, title: nhan(d), price_vnd: Number(d.price_vnd) || 0 }));
  const payload = { product_query: query, new_price_vnd: gia };
  if (sp.length === 1 && khopUngVien(query, sp[0].title, sp[0].sku) && dong.length === 1) {
    const d = dong[0];
    const full = { ...payload, product_id: d.product_id, variant_id: d.variant_id, sku: d.sku, title: nhan(d), old_price_vnd: Number(d.price_vnd) || null };
    const action = await taoAction(tenantId, chatId, messageId, operatorId, "price_update", "awaiting_confirmation", full, originalText);
    if (action.created) await guiBanNhap(bot, chatId, action.id, "price_update", full);
    return;
  }
  await guiDanhSachChon(bot, tenantId, chatId, operatorId, messageId, "price_update", payload, ungVien, query, originalText,
    (dong.length > 1 && sp.length === 1 ? `🔎 Sản phẩm có ${dong.length} lựa chọn. Chọn đúng loại cần đổi giá:` : `🔎 Tìm thấy ${ungVien.length} lựa chọn gần giống “${html(query)}”. Chọn đúng loại cần đổi giá:`) +
      (dong.length > 8 ? `\nCòn ${dong.length - 8} lựa chọn nữa chưa hiện, anh/chị gõ rõ tên biến thể hơn nhé.` : ""));
}

async function lapActionSanPham(bot: BotShop, tenantId: string, chatId: string, operatorId: string,
  messageId: string | null, lenh: LenhVanHanh, originalText: string): Promise<void> {
  const query = String(lenh.product_query || "").trim();
  if (!query || !Number.isFinite(lenh.quantity_change ?? (lenh.type === "inventory_lookup" ? 0 : NaN))) {
    throw new LoiThanThien("Thiếu tên sản phẩm hoặc số lượng cần thay đổi.");
  }
  if (lenh.type === "inventory_adjust" && (Math.abs(Number(lenh.quantity_change)) > 100_000 || !Number.isInteger(lenh.quantity_change))) {
    throw new LoiThanThien("Số lượng thay đổi phải là số nguyên và không vượt quá 100.000 mỗi lần.");
  }
  const kq = await timSanPham(tenantId, { query, in_stock_only: false, limit: 5 });
  const candidates = kq.products.filter((p) => p.sku);
  if (!candidates.length) throw new LoiThanThien(`Không tìm thấy sản phẩm khớp “${query}”. Nếu là hàng mới, hãy nói “tạo sản phẩm mới ...”.`);
  const payload = { ...lenh, candidates: candidates.map((p) => ({ id: p.id, sku: p.sku, title: p.title })) };
  if (candidates.length === 1) {
    const p = candidates[0];
    const action = await taoAction(tenantId, chatId, messageId, operatorId, lenh.type, "awaiting_confirmation", { ...payload, sku: p.sku, title: p.title }, originalText);
    if (action.created) await guiBanNhap(bot, chatId, action.id, lenh.type, { ...payload, sku: p.sku, title: p.title });
    return;
  }
  const action = await taoAction(tenantId, chatId, messageId, operatorId, lenh.type, "awaiting_selection", payload, originalText);
  if (!action.created) return;
  await guiTinQuaBot(bot, {
    chat_id: chatId,
    text: `🔎 Tìm thấy ${candidates.length} sản phẩm gần giống “${html(query)}”. Chọn đúng chai:`,
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: candidates.map((p, i) => [{ text: `${p.title} (${p.sku})`.slice(0, 60), callback_data: `ops_pick_${action.id}_${i}` }]) },
  });
}

/** Gửi lại bản nháp cũ thì cho thêm 15 phút, để bản nháp không hết hạn ngay sau khi vừa được nhắc lại. */
async function giaHanBanNhap(client: { query: (sql: string, params?: any[]) => Promise<any> }, tenantId: string, id: string): Promise<void> {
  await client.query(
    `UPDATE telegram_operator_action SET expires_at = now() + interval '15 minutes'
      WHERE id=$1 AND tenant_id=$2 AND status='awaiting_confirmation'`,
    [id, tenantId]
  );
}

async function lapBanNhapDonHang(bot: BotShop, tenantId: string, chatId: string, operatorId: string,
  messageId: string | null, soDon: number, originalText: string): Promise<void> {
  const cfg = await layMedusa(tenantId);
  // Backend lọc chính xác theo số đơn; vẫn kiểm lại phía này cho chắc.
  const don = chonDonTheoSo(await layDon(cfg, { display_id: String(soDon) }), soDon);
  if (!don) throw new LoiThanThien(`Không tìm thấy đơn số ${soDon}. Anh/chị kiểm tra lại số đơn giúp em nhé.`);
  if (don.status === "canceled") throw new LoiThanThien(`Đơn #${soDon} đã bị huỷ, không duyệt được.`);
  if (don.status === "completed") throw new LoiThanThien(`Đơn #${soDon} đã được duyệt trước đó rồi, không cần làm gì thêm.`);
  if (don.status !== "pending") throw new LoiThanThien(`Đơn #${soDon} hiện chưa duyệt được. Anh/chị kiểm tra đơn trong trang quản trị giúp em nhé.`);
  const payload = {
    order_id: don.id,
    display_id: don.display_id,
    customer_name: don.customer?.name || "Khách lẻ",
    total_vnd: don.total_vnd,
    payment_status: don.payment_status ?? null,
    items: (don.items ?? []).map((it) => ({ title: it.title, quantity: it.quantity })),
  };
  // Bấm "Duyệt đơn" nhiều lần: gửi lại đúng bản nháp còn hạn, không tạo thêm.
  const cu = await runInTenantContext(tenantId, async (client) => {
    const r = await client.query(
      `SELECT id FROM telegram_operator_action
        WHERE tenant_id=$1 AND telegram_chat_id=$2 AND action_type='order_complete'
          AND status='awaiting_confirmation' AND expires_at > now() AND payload->>'order_id'=$3
        ORDER BY created_at DESC LIMIT 1`,
      [tenantId, chatId, don.id]
    );
    const id = r.rows[0]?.id ? String(r.rows[0].id) : null;
    if (id) await giaHanBanNhap(client, tenantId, id);
    return id;
  });
  if (cu) {
    await guiBanNhap(bot, chatId, cu, "order_complete", payload);
    return;
  }
  const action = await taoAction(tenantId, chatId, messageId, operatorId, "order_complete", "awaiting_confirmation", payload, originalText);
  if (action.created) await guiBanNhap(bot, chatId, action.id, "order_complete", payload);
}

const TRANG_THAI_DON: Record<string, string> = { pending: "🕒 Chờ duyệt", completed: "✅ Đã hoàn thành", canceled: "❌ Đã huỷ" };

/** dd/mm hh:mm theo giờ Việt Nam (UTC+7). */
export function dinhDangNgayVN(iso?: string): string {
  const t = iso ? new Date(iso).getTime() : NaN;
  if (!Number.isFinite(t)) return "";
  const d = new Date(t + 7 * 3600_000);
  const h = (n: number) => String(n).padStart(2, "0");
  return `${h(d.getUTCDate())}/${h(d.getUTCMonth() + 1)} ${h(d.getUTCHours())}:${h(d.getUTCMinutes())}`;
}

export function chiTietDon(o: DonChoDuyet): string {
  const mon = (o.items ?? []).slice(0, 10).map((it) => `• ${html(it.quantity)} × ${html(it.title)}`).join("\n");
  const ngay = dinhDangNgayVN(o.created_at);
  return [
    `🧾 <b>Đơn #${html(o.display_id)}</b> · ${TRANG_THAI_DON[String(o.status)] ?? html(o.status)}`,
    ngay ? `📅 ${ngay}` : "",
    `👤 ${html(o.customer?.name || "Khách lẻ")}${o.customer?.phone ? ` · ${html(o.customer.phone)}` : ""}`,
    o.customer?.address ? `📍 ${html(o.customer.address)}` : "",
    mon,
    `💰 Tổng: <b>${dinhDangTien(o.total_vnd)}</b>`,
    dongTien(o.payment_status),
    o.tracking_code ? `🚚 Mã vận đơn: ${html(o.tracking_code)}` : "",
  ].filter(Boolean).join("\n");
}

async function guiMotDon(bot: BotShop, chatId: string, o: DonChoDuyet): Promise<void> {
  await guiTinQuaBot(bot, {
    chat_id: chatId,
    parse_mode: "HTML",
    text: chiTietDon(o),
    reply_markup: (() => {
      const hang: Array<Array<{ text: string; callback_data: string }>> = [];
      if (o.status === "pending") hang.push([{ text: "✅ Duyệt đơn này", callback_data: `ops_ord_${o.display_id}` }]);
      if (o.payment_status === "cho_chuyen_khoan" && o.status !== "canceled") hang.push([{ text: "💰 Đã nhận tiền", callback_data: `ops_pay_${o.display_id}` }]);
      // Nút nguy hiểm đặt cuối, nhãn rõ để không bấm nhầm. Vẫn phải qua bản nháp + Xác nhận.
      if (o.status === "pending") hang.push([{ text: "❌ Huỷ đơn này (hoàn tiền nếu đã thu)", callback_data: `ops_cxl_${o.display_id}` }]);
      return hang.length ? { inline_keyboard: hang } : undefined;
    })(),
  });
}

const CAC_TRANG_THAI = ["pending", "completed", "canceled"] as const;

async function traDonTheoSo(bot: BotShop, tenantId: string, chatId: string, soDon: number): Promise<void> {
  const cfg = await layMedusa(tenantId);
  const don = chonDonTheoSo(await layDon(cfg, { display_id: String(soDon) }), soDon);
  if (!don) throw new LoiThanThien(`Không tìm thấy đơn số ${soDon}. Anh/chị kiểm tra lại số đơn giúp em nhé.`);
  await guiMotDon(bot, chatId, don);
}

async function traDonTheoNguoi(bot: BotShop, tenantId: string, chatId: string, kind: "phone" | "name", chuoi: string): Promise<void> {
  const cfg = await layMedusa(tenantId);
  // Backend không lọc theo tên, và so SĐT bằng chuỗi thô (bỏ sót "0912 345 678"),
  // nên lấy các đơn gần đây của từng trạng thái rồi lọc ở đây.
  const gop = (await Promise.all(CAC_TRANG_THAI.map((st) => layDon(cfg, { status: st, limit: "50" })))).flat();
  const tuKhoa = boDau(chuoi).replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  const chin = chuoi.replace(/\D/g, "").slice(-9);
  const khop = gop.filter((o) => {
    if (kind === "phone") return chin.length >= 9 && String(o.customer?.phone ?? "").replace(/\D/g, "").endsWith(chin);
    // Khớp nguyên từ hoặc đầu từ ("An" khớp "Anh" nhưng không khớp "Lan").
    const tuTen = boDau(String(o.customer?.name ?? "")).replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
    return tuKhoa.length > 0 && tuKhoa.every((t) => tuTen.some((w) => w === t || w.startsWith(t)));
  });
  khop.sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")));
  if (!khop.length) {
    throw new LoiThanThien(`Em chỉ tìm được trong các đơn gần đây và chưa thấy đơn nào của ${kind === "phone" ? "số điện thoại này" : `“${chuoi}”`}. Anh/chị gõ số đơn (ví dụ: xem đơn 12) để em tìm chính xác nhé.`);
  }
  if (khop.length === 1) return guiMotDon(bot, chatId, khop[0]);
  const hien = khop.slice(0, 5);
  await guiTinQuaBot(bot, {
    chat_id: chatId,
    parse_mode: "HTML",
    text: `🔎 <b>Có ${khop.length} đơn khớp</b>\n\n` +
      hien.map((o) => `#${o.display_id} · ${html(o.customer?.name || "Khách lẻ")} · ${dinhDangTien(o.total_vnd)} · ${TRANG_THAI_DON[String(o.status)] ?? ""}`).join("\n") +
      (khop.length > 5 ? "\n\nCòn thêm đơn khác, anh/chị gõ rõ hơn (số điện thoại hoặc số đơn) để em tìm chính xác." : "") +
      "\n\nBấm nút để xem chi tiết:",
    reply_markup: { inline_keyboard: hien.map((o) => [{ text: `Xem đơn #${o.display_id}`, callback_data: `ops_view_${o.display_id}` }]) },
  });
}

async function lapBanNhapNhanTien(bot: BotShop, tenantId: string, chatId: string, operatorId: string,
  messageId: string | null, soDon: number, originalText: string): Promise<void> {
  const cfg = await layMedusa(tenantId);
  const don = chonDonTheoSo(await layDon(cfg, { display_id: String(soDon) }), soDon);
  if (!don) throw new LoiThanThien(`Không tìm thấy đơn số ${soDon}. Anh/chị kiểm tra lại số đơn giúp em nhé.`);
  if (don.status === "canceled") throw new LoiThanThien(`Đơn #${soDon} đã bị huỷ nên không ghi nhận tiền được.`);
  if (don.payment_status === "cod") throw new LoiThanThien(`Đơn #${soDon} là đơn thu tiền khi giao (COD), không cần xác nhận chuyển khoản.`);
  if (don.payment_status === "da_thanh_toan") throw new LoiThanThien(`Đơn #${soDon} đã ghi nhận tiền rồi, không cần làm gì thêm.`);
  if (don.payment_status !== "cho_chuyen_khoan") throw new LoiThanThien(`Đơn #${soDon} chưa rõ hình thức thanh toán, anh/chị kiểm tra trong trang quản trị giúp em.`);
  const payload = {
    order_id: don.id,
    display_id: don.display_id,
    order_status: don.status,
    customer_name: don.customer?.name || "Khách lẻ",
    total_vnd: don.total_vnd,
    payment_status: don.payment_status ?? null,
  };
  const cu = await runInTenantContext(tenantId, async (client) => {
    const r = await client.query(
      `SELECT id FROM telegram_operator_action
        WHERE tenant_id=$1 AND telegram_chat_id=$2 AND action_type='order_payment_received'
          AND status='awaiting_confirmation' AND expires_at > now() AND payload->>'order_id'=$3
        ORDER BY created_at DESC LIMIT 1`,
      [tenantId, chatId, don.id]
    );
    const id = r.rows[0]?.id ? String(r.rows[0].id) : null;
    if (id) await giaHanBanNhap(client, tenantId, id);
    return id;
  });
  if (cu) {
    await guiBanNhap(bot, chatId, cu, "order_payment_received", payload);
    return;
  }
  const action = await taoAction(tenantId, chatId, messageId, operatorId, "order_payment_received", "awaiting_confirmation", payload, originalText);
  if (action.created) await guiBanNhap(bot, chatId, action.id, "order_payment_received", payload);
}

async function lapBanNhapHuyDon(bot: BotShop, tenantId: string, chatId: string, operatorId: string,
  messageId: string | null, soDon: number, originalText: string): Promise<void> {
  const cfg = await layMedusa(tenantId);
  const don = chonDonTheoSo(await layDon(cfg, { display_id: String(soDon) }), soDon);
  if (!don) throw new LoiThanThien(`Không tìm thấy đơn số ${soDon}. Anh/chị kiểm tra lại số đơn giúp em nhé.`);
  if (don.status === "canceled") throw new LoiThanThien(`Đơn #${soDon} đã được huỷ rồi, không cần làm gì thêm.`);
  if (don.status === "completed") throw new LoiThanThien(`Đơn #${soDon} đã được duyệt (đã xuất kho), bot không huỷ được. Nếu khách trả hàng, anh/chị báo quản lý.`);
  if (don.status !== "pending") throw new LoiThanThien(`Đơn #${soDon} hiện không huỷ được. Anh/chị kiểm tra đơn trong trang quản trị hoặc báo quản lý giúp em.`);
  const payload = {
    order_id: don.id,
    display_id: don.display_id,
    customer_name: don.customer?.name || "Khách lẻ",
    customer_phone_masked: cheSdt(don.customer?.phone),
    total_vnd: don.total_vnd,
    payment_status: don.payment_status ?? null,
    items: (don.items ?? []).map((it) => ({ title: it.title, quantity: it.quantity })),
  };
  // Bản nháp huỷ là của riêng người tạo (chỉ người đó xác nhận được), nên chỉ gửi lại bản của chính họ.
  const cu = await runInTenantContext(tenantId, async (client) => {
    const r = await client.query(
      `SELECT id FROM telegram_operator_action
        WHERE tenant_id=$1 AND telegram_chat_id=$2 AND action_type='order_cancel'
          AND status='awaiting_confirmation' AND expires_at > now() AND payload->>'order_id'=$3
          AND requested_by=$4
        ORDER BY created_at DESC LIMIT 1`,
      [tenantId, chatId, don.id, operatorId]
    );
    const id = r.rows[0]?.id ? String(r.rows[0].id) : null;
    if (id) await giaHanBanNhap(client, tenantId, id);
    return id;
  });
  if (cu) {
    await guiBanNhap(bot, chatId, cu, "order_cancel", payload);
    return;
  }
  const action = await taoAction(tenantId, chatId, messageId, operatorId, "order_cancel", "awaiting_confirmation", payload, originalText);
  if (action.created) await guiBanNhap(bot, chatId, action.id, "order_cancel", payload);
}

const NHAN_KY_BAO_CAO: Record<string, string> = {
  today: "Hôm nay (từ 0h)", this_week: "Tuần này (từ thứ Hai)", this_month: "Tháng này (từ ngày 1)",
};

async function guiBaoCaoDoanhThu(bot: BotShop, tenantId: string, chatId: string, ky: { period?: string; days?: number }): Promise<void> {
  const cfg = await layMedusa(tenantId);
  const query = ky.period ? `period=${ky.period}` : `days=${ky.days ?? 7}`;
  const r = await docBackend(cfg, `/ai/report/revenue?${query}`, "Em chưa lấy được số liệu doanh thu lúc này. Anh/chị thử lại sau ít phút giúp em nhé.");
  const vnd = !r?.currency || String(r.currency).toUpperCase() === "VND";
  const tien = (n: unknown) => (vnd ? dinhDangTien(n) : `${Math.round(Number(n) || 0)} ${html(r.currency)}`);
  const top = (Array.isArray(r?.top_products) ? r.top_products : []).slice(0, 5)
    .map((t: any, i: number) => `${i + 1}. ${html(t.name)} · ${html(t.qty)}`).join("\n");
  const soDon = Number(r?.order_count) || 0;
  // Backend cũ bỏ qua `period` và trả theo số ngày: không gắn nhãn mốc lịch sai.
  const dungMoc = Boolean(ky.period) && r?.period === ky.period;
  const nhan = dungMoc ? NHAN_KY_BAO_CAO[ky.period!] : `${Number(r?.period_days) || ky.days || 7} ngày gần nhất`;
  const choDuyet = Number(r?.pending_count) || 0;
  const huy = Number(r?.canceled_count) || 0;
  const tu = dungMoc ? dinhDangNgayVN(r?.from) : "";
  const text = `📊 <b>Doanh thu ${html(nhan)}</b>\n\n` +
    (soDon === 0 ? "Chưa có đơn nào trong khoảng này." :
      `💰 Tổng giá trị đơn: <b>${tien(r.revenue_all)}</b> (${soDon} đơn)\n` +
      `✅ Đã thu tiền: <b>${tien(r.revenue_paid)}</b> (${Number(r.paid_order_count) || 0} đơn)\n` +
      `🧮 Trung bình mỗi đơn: ${tien(r.avg_order_value)}` +
      (choDuyet > 0 ? `\n🕒 Chờ duyệt: ${choDuyet} đơn${r.revenue_pending != null ? ` · ${tien(r.revenue_pending)}` : ""}` : "") +
      (top ? `\n\n🏆 <b>Bán chạy</b>\n${top}` : "")) +
    (huy > 0 ? `\n❌ Đơn huỷ: ${huy} (không tính)` : "") +
    `\n\n<i>${tu ? `Tính từ ${tu} đến bây giờ.` : `Tính theo ${Number(r?.period_days) || ky.days || 7} ngày gần nhất kể từ lúc này.`}</i>`;
  await guiTinQuaBot(bot, { chat_id: chatId, parse_mode: "HTML", text, reply_markup: { inline_keyboard: [nutBaoCao()] } });
}

async function guiDanhSachDonChoDuyet(bot: BotShop, tenantId: string, chatId: string): Promise<void> {
  const cfg = await layMedusa(tenantId);
  const ds = await layDon(cfg, { status: "pending", limit: "11", order: "asc" });
  if (!ds.length) {
    await guiTinQuaBot(bot, { chat_id: chatId, text: "🎉 Hiện không có đơn nào chờ duyệt." });
    return;
  }
  const hien = ds.slice(0, 10);
  const dong = hien.map((o) => `#${o.display_id} · ${html(o.customer?.name || "Khách lẻ")} · ${dinhDangTien(o.total_vnd)}${o.payment_status && BIEU_TUONG_TIEN[o.payment_status] ? ` ${BIEU_TUONG_TIEN[o.payment_status]}` : ""}`);
  await guiTinQuaBot(bot, {
    chat_id: chatId,
    parse_mode: "HTML",
    text: `🛒 <b>${ds.length > 10 ? "Có hơn 10" : `Có ${ds.length}`} đơn đang chờ duyệt</b>\n\n${dong.join("\n")}` +
      (ds.length > 10 ? "\n\nCòn thêm đơn khác, duyệt xong các đơn này em sẽ hiện tiếp." : "") +
      "\n\nBấm nút bên dưới để duyệt đơn:",
    reply_markup: { inline_keyboard: hien.map((o) => [{ text: `Duyệt đơn #${o.display_id}`, callback_data: `ops_ord_${o.display_id}` }]) },
  });
}

export async function xuLyYeuCauVanHanh(bot: BotShop, tenantId: string, message: TelegramMessageLike): Promise<void> {
  const chatId = String(message.chat.id);
  const messageId = message.message_id == null ? null : String(message.message_id);
  const operatorId = String(message.from?.id || "");
  let text = boTienTo(String(message.text ?? message.caption ?? ""));
  if (/^(help|tro giup|trợ giúp)?$/i.test(text) && !message.photo?.length) {
    await guiTinQuaBot(bot, { chat_id: chatId, parse_mode: "HTML", text:
      "🤖 <b>Trợ lý vận hành</b>\n\n" +
      "• <code>/ops Chateau Margaux mới nhập thêm 30 chai</code>\n" +
      "• <code>/ops kiểm tra kho Penfolds Bin 389</code>\n" +
      "• <code>/ops tạo sản phẩm mới ... giá 1200000</code>\n" +
      "• <code>đơn mới</code> hoặc <code>có đơn nào chưa duyệt</code>: xem đơn chờ duyệt\n" +
      "• <code>duyệt đơn 12</code>: duyệt đơn số 12\n" +
      "• <code>đã nhận tiền đơn 12</code>: ghi nhận khách đã chuyển khoản\n" +
      "• <code>huỷ đơn 12</code>: huỷ cả đơn chưa duyệt (nếu khách đã chuyển tiền thì phải tự chuyển trả)\n" +
      "• <code>tạo mã giảm 10%</code>, <code>tạo mã TET10 giảm 50k hết hạn 31/12 dùng 50 lần</code>: tạo mã giảm giá (tối đa 30% hoặc 500.000đ)\n" +
      "• <code>ẩn sản phẩm X</code>, <code>mở bán lại sản phẩm X</code>: ẩn / bán lại sản phẩm\n" +
      "• <code>đổi giá Penfolds Bin 389 thành 1.250.000</code>: đổi giá bán\n" +
      "• <code>doanh thu hôm nay</code>, <code>doanh thu 7 ngày</code>: xem doanh thu\n" +
      "• <code>xem đơn 12</code>, <code>tra đơn chị Lan</code>, <code>đơn của 0912345678</code>: xem thông tin đơn\n" +
      "• Gửi ảnh nhãn chai kèm chú thích <code>/ops mới nhập thêm 30 chai</code>\n\n" +
      "Bot luôn yêu cầu bấm xác nhận trước khi ghi dữ liệu." });
    return;
  }

  const coAnh = Boolean(message.photo?.length);
  if (message.photo?.length) {
    const photo = message.photo[message.photo.length - 1];
    const nhan = await moTaAnh(bot, photo);
    text = `${text || "Kiểm tra sản phẩm trong kho"}\nThông tin đọc từ ảnh: ${nhan}`;
  }

  // Ảnh có mô tả nhãn tự do nên ưu tiên LLM ghép caption + nội dung nhìn thấy.
  // Tin chữ phổ biến đi parser cứng trước để nhanh, rẻ và ổn định.
  const lenh = coAnh
    ? (await phanTichBangAi(text) ?? phanTichLenhNhanh(text))
    : (phanTichLenhNhanh(text) ?? await phanTichBangAi(text));
  if (!lenh) throw new LoiThanThien("Mình chưa hiểu thao tác. Hãy ghi rõ tên chai và số lượng, ví dụ: /ops Chateau X mới nhập thêm 30 chai. Muốn xem đơn, gõ “đơn mới”.");

  if (lenh.type === "order_payment_received") {
    const n = Number(lenh.order_number);
    if (!Number.isSafeInteger(n) || n <= 0) throw new LoiThanThien("Anh/chị cho em xin số đơn nhé, ví dụ: đã nhận tiền đơn 12.");
    await lapBanNhapNhanTien(bot, tenantId, chatId, operatorId, messageId, n, text);
    return;
  }
  if (lenh.type === "order_cancel") {
    const n = Number(lenh.order_number);
    if (!Number.isSafeInteger(n) || n <= 0) throw new LoiThanThien("Anh/chị cho em xin số đơn nhé, ví dụ: huỷ đơn 12.");
    await lapBanNhapHuyDon(bot, tenantId, chatId, operatorId, messageId, n, text);
    return;
  }
  if (lenh.type === "discount_create") {
    await lapBanNhapMaGiam(bot, tenantId, chatId, operatorId, messageId, lenh, text);
    return;
  }
  if (lenh.type === "product_hide" || lenh.type === "product_show") {
    await lapActionAnHien(bot, tenantId, chatId, operatorId, messageId, lenh, text);
    return;
  }
  if (lenh.type === "product_price") {
    await lapActionDoiGia(bot, tenantId, chatId, operatorId, messageId, lenh, text);
    return;
  }
  if (lenh.type === "revenue_report") {
    await guiBaoCaoDoanhThu(bot, tenantId, chatId, lenh.report_period ? { period: lenh.report_period } : { days: Number(lenh.report_days) || 7 });
    return;
  }
  if (lenh.type === "order_lookup") {
    if (lenh.order_number) await traDonTheoSo(bot, tenantId, chatId, Number(lenh.order_number));
    else if (lenh.lookup_kind && lenh.lookup_text) await traDonTheoNguoi(bot, tenantId, chatId, lenh.lookup_kind, lenh.lookup_text);
    else throw new LoiThanThien("Anh/chị cho em xin số đơn, số điện thoại hoặc tên khách nhé, ví dụ: xem đơn 12.");
    return;
  }
  if (lenh.type === "order_list_pending") {
    await guiDanhSachDonChoDuyet(bot, tenantId, chatId);
    return;
  }
  if (lenh.type === "order_complete" && (lenh.order_numbers?.length ?? 0) >= 2) {
    const ds = lenh.order_numbers!;
    await guiTinQuaBot(bot, {
      chat_id: chatId,
      text: `Anh/chị muốn duyệt đơn nào trước: ${ds.map((n) => `#${n}`).join(" hay ")}?`,
      reply_markup: { inline_keyboard: ds.map((n) => [{ text: `Duyệt đơn #${n}`, callback_data: `ops_ord_${n}` }]) },
    });
    return;
  }
  if (lenh.type === "order_complete") {
    const n = Number(lenh.order_number);
    if (!Number.isSafeInteger(n) || n <= 0) throw new LoiThanThien("Anh/chị cho em xin số đơn nhé, ví dụ: duyệt đơn 12.");
    await lapBanNhapDonHang(bot, tenantId, chatId, operatorId, messageId, n, text);
    return;
  }

  if (lenh.type === "create_product") {
    if (!lenh.title?.trim()) throw new LoiThanThien("Chưa đọc được tên sản phẩm. Hãy gửi lại ảnh rõ nhãn hoặc ghi tên chai.");
    const payload = {
      title: lenh.title.trim().slice(0, 250),
      sku: (lenh.sku?.trim() || `TG-${Date.now().toString(36).toUpperCase()}`).slice(0, 100),
      price_vnd: lenh.price_vnd,
      initial_quantity: Math.max(0, Math.trunc(lenh.initial_quantity ?? 0)),
      description: lenh.description?.slice(0, 4000),
    };
    const action = await taoAction(tenantId, chatId, messageId, operatorId, "create_product", "awaiting_confirmation", payload, text);
    if (action.created) await guiBanNhap(bot, chatId, action.id, "create_product", payload);
    return;
  }
  await lapActionSanPham(bot, tenantId, chatId, operatorId, messageId, lenh, text);
}

/** Chỉ giữ các cảnh báo đáng để ý, viết lại cho dễ hiểu; bỏ các ghi chú "đã làm từ trước". */
export function canhBaoDeHieu(ds: unknown): string[] {
  const kq = new Set<string>();
  for (const c of Array.isArray(ds) ? ds : []) {
    const t = String(c);
    if (/Không capture được payment/i.test(t)) kq.add("⚠️ Chưa thu được tiền của đơn trong hệ thống, anh/chị kiểm tra phần thanh toán trong trang quản trị nhé.");
    else if (/Không lưu được mã vận đơn/i.test(t)) kq.add("⚠️ Chưa lưu được mã vận đơn, anh/chị kiểm tra trong trang quản trị nhé.");
    else if (/chưa có payment/i.test(t)) kq.add("ℹ️ Đơn này chưa có khoản thanh toán nào trong hệ thống.");
    else if (/không có giao dịch thanh toán/i.test(t)) kq.add("ℹ️ Đơn này không có giao dịch thanh toán trong hệ thống, em chỉ ghi nhận là đã nhận tiền.");
  }
  return Array.from(kq);
}

/** Gọi /ai/order-payment-received; lỗi map theo `code` của backend, không đọc câu chữ. */
async function ghiNhanTienBackend(cfg: MedusaConfig, p: any): Promise<any> {
  const so = p.display_id;
  const lai = `gõ lại “đã nhận tiền đơn ${so}”`;
  let res: Response;
  try {
    res = await fetchCoTimeout(new URL("/ai/order-payment-received", cfg.baseUrl).toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-ai-secret-key": env.AI_SECRET_KEY },
      body: JSON.stringify({ order_id: p.order_id }),
    }, 60_000);
  } catch (e) {
    console.error("[telegram-operator] order-payment-received lỗi mạng:", e);
    throw new LoiThanThien(`Chưa rõ đơn #${so} đã ghi nhận tiền chưa. Anh/chị ${lai} để kiểm tra nhé.`);
  }
  const body: any = await res.json().catch(() => ({}));
  if (res.ok) return body;
  const code = String(body?.code || "");
  if (res.status === 401 || code === "unauthorized") {
    throw new LoiThanThien("Bot chưa kết nối được hệ thống bán hàng, anh/chị báo người quản trị giúp em.");
  }
  console.error(`[telegram-operator] order-payment-received ${res.status} code=${code}`);
  switch (code) {
    case "order_is_cod": throw new LoiThanThien(`Đơn #${so} là đơn thu tiền khi giao (COD), không cần xác nhận chuyển khoản.`);
    case "order_canceled": throw new LoiThanThien(`Đơn #${so} đã bị huỷ nên không ghi nhận tiền được.`);
    case "order_not_found": throw new LoiThanThien(`Không tìm thấy đơn số ${so}. Anh/chị kiểm tra lại số đơn giúp em nhé.`);
    case "order_status_invalid":
    case "order_payment_state_invalid":
      throw new LoiThanThien(`Đơn #${so} hiện chưa ghi nhận tiền được. Anh/chị kiểm tra đơn trong trang quản trị giúp em nhé.`);
    case "in_progress": throw new LoiThanThien(`Đơn #${so} đang được xử lý. Anh/chị đợi vài giây rồi ${lai} nhé.`);
    case "capture_failed": throw new LoiThanThien(`Chưa ghi nhận được tiền của đơn #${so} vì hệ thống chưa ghi được khoản thu. Anh/chị thử lại sau ít phút, hoặc kiểm tra trong trang quản trị nhé.`);
    case "metadata_update_failed": throw new LoiThanThien(`Chưa cập nhật xong trạng thái tiền của đơn #${so}. Anh/chị ${lai} để hệ thống làm tiếp nhé.`);
    default: throw new LoiThanThien(`Chưa rõ đơn #${so} đã ghi nhận tiền chưa. Anh/chị ${lai} để kiểm tra nhé.`);
  }
}

/**
 * Gọi /ai/refund-order (huỷ toàn bộ, không partial). Backend mới trả `code` (order_not_found,
 * order_completed, has_fulfillment, order_status_invalid, in_progress, lock_error, internal_error);
 * backend cũ không có `code` (mọi lỗi workflow là 500) nên fallback theo HTTP status, không đọc câu chữ.
 * LƯU Ý: provider thanh toán mặc định chỉ GHI SỔ hoàn tiền, không có tiền về khách.
 */
async function huyDonBackend(cfg: MedusaConfig, p: any): Promise<any> {
  const so = p.display_id;
  const lai = `gõ lại “huỷ đơn ${so}” để em kiểm tra tình trạng đơn`;
  let res: Response;
  try {
    res = await fetchCoTimeout(new URL("/ai/refund-order", cfg.baseUrl).toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-ai-secret-key": env.AI_SECRET_KEY },
      body: JSON.stringify({ orderId: p.order_id, reason: "Huỷ qua Telegram" }),
    }, 60_000);
  } catch (e) {
    console.error("[telegram-operator] refund-order lỗi mạng:", e);
    throw new LoiThanThien(`Chưa rõ đơn #${so} đã huỷ chưa. Anh/chị ${lai} nhé.`);
  }
  const body: any = await res.json().catch(() => ({}));
  if (res.ok) return body;
  const code = String(body?.code || "");
  console.error(`[telegram-operator] refund-order ${res.status} code=${code}`);
  if (res.status === 401 || code === "unauthorized") throw new LoiThanThien("Bot chưa kết nối được hệ thống bán hàng, anh/chị báo người quản trị giúp em.");
  switch (code) {
    case "order_not_found": throw new LoiThanThien(`Không tìm thấy đơn số ${so}. Anh/chị kiểm tra lại số đơn giúp em nhé.`);
    case "order_completed":
    case "has_fulfillment":
      throw new LoiThanThien(`Đơn #${so} đã được duyệt (đã xuất kho) nên bot không huỷ được; cần làm trả hàng, anh/chị báo quản lý.`);
    case "order_status_invalid": throw new LoiThanThien(`Đơn #${so} hiện không huỷ được. Anh/chị kiểm tra đơn trong trang quản trị hoặc báo quản lý giúp em.`);
    case "in_progress": throw new LoiThanThien(`Đơn #${so} đang được xử lý. Anh/chị đợi vài giây rồi ${lai} nhé.`);
    case "lock_error":
    case "internal_error":
      throw new LoiThanThien(`Chưa huỷ được đơn #${so} vì hệ thống đang lỗi. Anh/chị ${lai} sau ít phút nhé.`);
  }
  if (res.status === 404) throw new LoiThanThien(`Không tìm thấy đơn số ${so}. Anh/chị kiểm tra lại số đơn giúp em nhé.`);
  if (res.status === 400) throw new LoiThanThien(`Chưa huỷ được đơn #${so} vì thiếu thông tin đơn. Anh/chị báo người quản trị giúp em.`);
  throw new LoiThanThien(`Chưa huỷ được đơn #${so}. Có thể đơn đã được duyệt hoặc hệ thống đang lỗi. Anh/chị ${lai}, hoặc báo quản lý nếu đơn đã duyệt.`);
}

/**
 * POST /ai/create-discount {code, percent | amount, currency, ends_at?, usage_limit?}.
 * Lỗi map theo `code` của backend (invalid_value, duplicate_code, unauthorized, internal_error);
 * backend cũ không có code thì fallback theo HTTP status.
 */
async function taoMaGiamBackend(cfg: MedusaConfig, p: any): Promise<any> {
  let res: Response;
  const body: Record<string, unknown> = p.percent != null ? { code: p.code, percent: Number(p.percent) } : { code: p.code, amount: Number(p.amount), currency: "vnd" };
  if (p.ends_at) body.ends_at = p.ends_at;
  if (p.usage_limit != null) body.usage_limit = Number(p.usage_limit);
  try {
    res = await fetchCoTimeout(new URL("/ai/create-discount", cfg.baseUrl).toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-ai-secret-key": env.AI_SECRET_KEY },
      body: JSON.stringify(body),
    }, 60_000);
  } catch (e) {
    console.error("[telegram-operator] create-discount lỗi mạng:", e);
    throw new LoiThanThien(`Chưa rõ mã ${p.code} đã tạo chưa. Anh/chị kiểm tra trong trang quản trị trước khi tạo lại, kẻo bị trùng mã.`);
  }
  const resp: any = await res.json().catch(() => ({}));
  if (res.ok) return resp;
  const code = String(resp?.code || "");
  console.error(`[telegram-operator] create-discount ${res.status} code=${code}`);
  if (res.status === 401 || code === "unauthorized") throw new LoiThanThien("Bot chưa kết nối được hệ thống bán hàng, anh/chị báo người quản trị giúp em.");
  if (code === "duplicate_code") {
    throw new LoiThanThien(p.custom_code ? `Mã ${p.code} đã có, anh/chị đặt tên khác.` : `Mã ${p.code} bị trùng với mã đã có. Anh/chị gõ lại lệnh để em sinh mã khác.`);
  }
  if (code === "invalid_value") throw new LoiThanThien("Thông tin mã chưa hợp lệ (mức giảm, hạn hoặc số lượt). Anh/chị kiểm tra lại câu lệnh nhé.");
  if (code === "internal_error") throw new LoiThanThien(`Chưa tạo được mã ${p.code} vì hệ thống đang lỗi. Anh/chị thử lại sau ít phút nhé.`);
  if (res.status === 400) throw new LoiThanThien("Chưa tạo được mã vì thông tin chưa hợp lệ. Anh/chị kiểm tra lại câu lệnh nhé.");
  throw new LoiThanThien(`Chưa tạo được mã ${p.code}. Có thể mã bị trùng với mã đã có, anh/chị thử lại để em sinh mã khác, hoặc kiểm tra trong trang quản trị.`);
}

/** POST /ai/update-price {variant_id, amount_vnd}. Lỗi map theo `code`. */
async function doiGiaBackend(cfg: MedusaConfig, p: any): Promise<any> {
  let res: Response;
  try {
    res = await fetchCoTimeout(new URL("/ai/update-price", cfg.baseUrl).toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-ai-secret-key": env.AI_SECRET_KEY },
      body: JSON.stringify({ variant_id: p.variant_id, amount_vnd: Number(p.new_price_vnd) }),
    }, 60_000);
  } catch (e) {
    console.error("[telegram-operator] update-price lỗi mạng:", e);
    throw new LoiThanThien(`Chưa rõ giá “${p.title}” đã đổi chưa. Anh/chị kiểm tra trong trang quản trị trước khi đổi lại nhé.`);
  }
  const resp: any = await res.json().catch(() => ({}));
  if (res.ok) return resp;
  const code = String(resp?.code || "");
  console.error(`[telegram-operator] update-price ${res.status} code=${code}`);
  if (res.status === 401 || code === "unauthorized") throw new LoiThanThien("Bot chưa kết nối được hệ thống bán hàng, anh/chị báo người quản trị giúp em.");
  switch (code) {
    case "invalid_price": throw new LoiThanThien("Giá mới không hợp lệ. Anh/chị kiểm tra lại số tiền nhé.");
    case "variant_not_found":
    case "product_not_found": throw new LoiThanThien(`Không tìm thấy “${p.title}” (có thể đã bị xoá). Anh/chị kiểm tra trong trang quản trị giúp em.`);
    case "ambiguous_variant": throw new LoiThanThien(`“${p.title}” có nhiều loại, em chưa chọn được đúng loại. Anh/chị gõ lại lệnh và chọn loại cần đổi giá nhé.`);
    case "invalid_target": throw new LoiThanThien("Em chưa xác định được sản phẩm cần đổi giá. Anh/chị gõ lại lệnh nhé.");
    default: throw new LoiThanThien(`Chưa đổi được giá “${p.title}”. Anh/chị thử lại sau ít phút hoặc đổi trong trang quản trị giúp em nhé.`);
  }
}

/** POST /ai/update-product {id, update:{status}}. Lỗi map theo HTTP status. */
async function doiTrangThaiSanPhamBackend(cfg: MedusaConfig, p: any, status: "draft" | "published"): Promise<any> {
  let res: Response;
  try {
    res = await fetchCoTimeout(new URL("/ai/update-product", cfg.baseUrl).toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-ai-secret-key": env.AI_SECRET_KEY },
      body: JSON.stringify({ id: p.product_id, update: { status } }),
    }, 60_000);
  } catch (e) {
    console.error("[telegram-operator] update-product lỗi mạng:", e);
    throw new LoiThanThien(`Chưa rõ “${p.title}” đã ${status === "draft" ? "ẩn" : "mở bán lại"} chưa. Anh/chị kiểm tra trong trang quản trị nhé.`);
  }
  const resp: any = await res.json().catch(() => ({}));
  if (res.ok) return resp;
  console.error(`[telegram-operator] update-product ${res.status}`);
  if (res.status === 401) throw new LoiThanThien("Bot chưa kết nối được hệ thống bán hàng, anh/chị báo người quản trị giúp em.");
  throw new LoiThanThien(`Chưa ${status === "draft" ? "ẩn" : "mở bán lại"} được “${p.title}”. Anh/chị thử lại sau ít phút hoặc làm trong trang quản trị giúp em nhé.`);
}

/** Gọi /ai/order-complete và đổi mọi lỗi thành lời nhắn dễ hiểu. */
async function duyetDonBackend(cfg: MedusaConfig, p: any): Promise<any> {
  const so = p.display_id;
  let res: Response;
  try {
    res = await fetchCoTimeout(new URL("/ai/order-complete", cfg.baseUrl).toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-ai-secret-key": env.AI_SECRET_KEY },
      body: JSON.stringify({ order_id: p.order_id }),
    }, 60_000);
  } catch (e) {
    console.error("[telegram-operator] order-complete lỗi mạng:", e);
    throw new LoiThanThien(`Chưa rõ đơn #${so} đã duyệt xong chưa. Anh/chị gõ lại “duyệt đơn ${so}” để kiểm tra nhé.`);
  }
  const body: any = await res.json().catch(() => ({}));
  if (res.ok) return body;
  const loi = String(body?.error || "");
  console.error(`[telegram-operator] order-complete ${res.status}: ${loi.slice(0, 300)}`);
  if (res.status === 401) throw new LoiThanThien("Bot chưa kết nối được hệ thống bán hàng, anh/chị báo người quản trị giúp em.");
  if (res.status === 409 && body?.code === "order_canceled") {
    throw new LoiThanThien(`Đơn #${so} đã bị huỷ nên không duyệt được.`);
  }
  if (res.status === 409) {
    throw new LoiThanThien(`Đơn #${so} đang được xử lý. Anh/chị đợi vài giây rồi gõ lại “duyệt đơn ${so}” nhé.`);
  }
  if (body?.buoc_da_xong?.created_fulfillment === true) {
    throw new LoiThanThien(`Kho đã trừ nhưng đơn #${so} chưa đóng. Anh/chị gõ lại “duyệt đơn ${so}” để hoàn tất nhé.`);
  }
  if (/huỷ|hủy/i.test(loi)) throw new LoiThanThien(`Đơn #${so} đã bị huỷ nên không duyệt được.`);
  if (/Không tìm thấy đơn/i.test(loi)) throw new LoiThanThien(`Không tìm thấy đơn số ${so}. Anh/chị kiểm tra lại số đơn giúp em nhé.`);
  if (/không có dòng hàng/i.test(loi)) throw new LoiThanThien(`Đơn #${so} không có món nào nên chưa duyệt được. Anh/chị kiểm tra lại đơn trong trang quản trị nhé.`);
  if (body?.buoc_da_xong?.created_fulfillment === false) {
    throw new LoiThanThien(`Chưa duyệt được đơn #${so}, đơn vẫn còn mở và kho chưa bị trừ. Anh/chị kiểm tra tồn kho các món trong đơn rồi gõ lại “duyệt đơn ${so}” nhé.`);
  }
  throw new LoiThanThien(`Chưa rõ đơn #${so} đã duyệt xong chưa. Anh/chị gõ lại “duyệt đơn ${so}” để kiểm tra nhé.`);
}

async function thucThi(tenantId: string, action: any): Promise<any> {
  const cfg = await layMedusa(tenantId);
  const p = action.payload || {};
  if (action.action_type === "inventory_adjust") {
    return goiBackend(cfg, "/ai/update-inventory", { sku: p.sku, quantityChange: Number(p.quantity_change) });
  }
  if (action.action_type === "inventory_lookup") {
    return goiBackend(cfg, "/ai/products-lookup", { skus: [p.sku] });
  }
  if (action.action_type === "order_complete") return duyetDonBackend(cfg, p);
  if (action.action_type === "order_payment_received") return ghiNhanTienBackend(cfg, p);
  if (action.action_type === "order_cancel") return huyDonBackend(cfg, p);
  if (action.action_type === "discount_create") return taoMaGiamBackend(cfg, p);
  if (action.action_type === "price_update") return doiGiaBackend(cfg, p);
  if (action.action_type === "product_hide") return doiTrangThaiSanPhamBackend(cfg, p, "draft");
  if (action.action_type === "product_show") return doiTrangThaiSanPhamBackend(cfg, p, "published");
  if (action.action_type !== "create_product") throw new Error(`Loại thao tác không hỗ trợ: ${String(action.action_type)}`);
  return goiBackend(cfg, "/ai/create-product", {
    product: { title: p.title, description: p.description, sku: p.sku, price_vnd: p.price_vnd },
    initial_quantity: Number(p.initial_quantity || 0),
  });
}

/** Lưu câu nhân viên gõ khi đang tiếp quản mà bị chặn (giống lệnh), kèm ĐÚNG hội thoại lúc bị chặn, để nút "Vẫn gửi cho khách" không gửi nhầm khách khác. */
export async function luuCauChoGui(tenantId: string, chatId: string, operatorId: string, text: string,
  conversationId: string, messageId: string | null = null): Promise<string> {
  const a = await taoAction(tenantId, chatId, messageId, operatorId, "forward_to_customer", "awaiting_confirmation",
    { text: text.slice(0, 4000), conversation_id: conversationId }, text);
  return a.id;
}

/** Lấy (và đánh dấu đã dùng) câu đã lưu: chỉ đúng người gõ, đúng chat, còn hạn, dùng một lần. Trả cả hội thoại đã lưu. */
export async function layCauChoGui(tenantId: string, id: string, chatId: string, operatorId: string): Promise<{ text: string; conversationId: string } | null> {
  return runInTenantContext(tenantId, async (client) => {
    const r = await client.query(
      `UPDATE telegram_operator_action SET status='completed', confirmed_by=$1
        WHERE id=$2 AND tenant_id=$3 AND telegram_chat_id=$4 AND action_type='forward_to_customer'
          AND status='awaiting_confirmation' AND expires_at > now() AND requested_by=$1
        RETURNING payload->>'text' AS text, payload->>'conversation_id' AS conversation_id`,
      [operatorId, id, tenantId, chatId]
    );
    const row = r.rows[0];
    return row?.text && row?.conversation_id ? { text: String(row.text), conversationId: String(row.conversation_id) } : null;
  });
}

/** Hội thoại đã lưu có còn đúng là của nhân viên này, còn mở và đang do người trả lời không. */
export async function hoiThoaiConTiepQuan(tenantId: string, operatorId: string, conversationId: string): Promise<boolean> {
  return runInTenantContext(tenantId, async (client) => {
    const r = await client.query(
      `SELECT 1 FROM conversation
        WHERE id = $1 AND tenant_id = $2 AND assigned_to = $3
          AND mode IN ('NGUOI', 'CHO_NGUOI') AND dong_luc IS NULL`,
      [conversationId, tenantId, operatorId]
    );
    return r.rows.length > 0;
  });
}

export async function xuLyCallbackVanHanh(bot: BotShop, tenantId: string, callback: TelegramCallbackLike): Promise<boolean> {
  if (callback.data === CALLBACK_LIST) {
    const chat = String(callback.message?.chat?.id || "");
    await answerCallbackQuery(bot, callback.id, "Đang lấy danh sách…");
    try {
      await guiDanhSachDonChoDuyet(bot, tenantId, chat);
    } catch (e: any) {
      if (!(e instanceof LoiThanThien)) console.error("[telegram-operator] lấy danh sách đơn lỗi:", e);
      await guiTinQuaBot(bot, { chat_id: chat, text: `⚠️ ${html(e instanceof LoiThanThien ? e.message : "Em chưa lấy được danh sách đơn. Anh/chị thử lại sau ít phút giúp em nhé.")}`, parse_mode: "HTML" });
    }
    return true;
  }
  const khopTien = String(callback.data || "").match(CALLBACK_PAY_RE);
  const khopBc = String(callback.data || "").match(CALLBACK_REPORT_RE);
  if (khopTien || khopBc) {
    const chat = String(callback.message?.chat?.id || "");
    await answerCallbackQuery(bot, callback.id, khopTien ? "Đang mở đơn…" : "Đang tính doanh thu…");
    try {
      if (khopTien) await lapBanNhapNhanTien(bot, tenantId, chat, String(callback.from?.id || ""), `cb:${callback.id}`, Number(khopTien[1]), callback.data || "");
      else {
        const k = khopBc![1];
        await guiBaoCaoDoanhThu(bot, tenantId, chat, /^\d+$/.test(k) ? { days: Number(k) } : { period: k });
      }
    } catch (e: any) {
      if (!(e instanceof LoiThanThien)) console.error("[telegram-operator] nút tiền/báo cáo lỗi:", e);
      await guiTinQuaBot(bot, { chat_id: chat, text: `⚠️ ${html(e instanceof LoiThanThien ? e.message : "Em chưa làm được việc này. Anh/chị thử lại sau ít phút giúp em nhé.")}`, parse_mode: "HTML" });
    }
    return true;
  }
  const khopHuy = String(callback.data || "").match(CALLBACK_HUY_RE);
  if (khopHuy) {
    // Nút "Huỷ đơn": chưa huỷ gì, chỉ dựng bản nháp để nhân viên bấm Xác nhận.
    const chat = String(callback.message?.chat?.id || "");
    await answerCallbackQuery(bot, callback.id, "Đang mở đơn…");
    try {
      await lapBanNhapHuyDon(bot, tenantId, chat, String(callback.from?.id || ""), `cb:${callback.id}`, Number(khopHuy[1]), callback.data || "");
    } catch (e: any) {
      if (!(e instanceof LoiThanThien)) console.error("[telegram-operator] mở đơn để huỷ lỗi:", e);
      await guiTinQuaBot(bot, { chat_id: chat, text: `⚠️ ${html(e instanceof LoiThanThien ? e.message : "Em chưa mở được đơn này. Anh/chị thử lại sau ít phút giúp em nhé.")}`, parse_mode: "HTML" });
    }
    return true;
  }
  const khopMa = String(callback.data || "").match(CALLBACK_MA_RE);
  if (khopMa) {
    const chat = String(callback.message?.chat?.id || "");
    await answerCallbackQuery(bot, callback.id, "Đang lập bản nháp…");
    try {
      const v = Number(khopMa[2]);
      await lapBanNhapMaGiam(bot, tenantId, chat, String(callback.from?.id || ""), `cb:${callback.id}`,
        { type: "discount_create", ...(khopMa[1] === "p" ? { discount_percent: v } : { discount_amount: v }) }, callback.data || "");
    } catch (e: any) {
      if (!(e instanceof LoiThanThien)) console.error("[telegram-operator] nút mã giảm giá lỗi:", e);
      await guiTinQuaBot(bot, { chat_id: chat, text: `⚠️ ${html(e instanceof LoiThanThien ? e.message : "Em chưa làm được việc này. Anh/chị thử lại sau ít phút giúp em nhé.")}`, parse_mode: "HTML" });
    }
    return true;
  }
  const khopXem = String(callback.data || "").match(CALLBACK_XEM_RE);
  if (khopXem) {
    const chat = String(callback.message?.chat?.id || "");
    await answerCallbackQuery(bot, callback.id, "Đang mở đơn…");
    try {
      await traDonTheoSo(bot, tenantId, chat, Number(khopXem[1]));
    } catch (e: any) {
      if (!(e instanceof LoiThanThien)) console.error("[telegram-operator] xem đơn lỗi:", e);
      await guiTinQuaBot(bot, { chat_id: chat, text: `⚠️ ${html(e instanceof LoiThanThien ? e.message : "Em chưa mở được đơn này. Anh/chị thử lại sau ít phút giúp em nhé.")}`, parse_mode: "HTML" });
    }
    return true;
  }
  const khopDon = String(callback.data || "").match(CALLBACK_DON_RE);
  if (khopDon) {
    // Nút "Duyệt đơn #N": chưa ghi gì, chỉ dựng bản nháp để nhân viên bấm Xác nhận.
    const chat = String(callback.message?.chat?.id || "");
    await answerCallbackQuery(bot, callback.id, "Đang mở đơn…");
    try {
      await lapBanNhapDonHang(bot, tenantId, chat, String(callback.from?.id || ""), `cb:${callback.id}`, Number(khopDon[1]), callback.data || "");
    } catch (e: any) {
      const msg = e instanceof LoiThanThien ? e.message : "Em chưa mở được đơn này. Anh/chị thử lại sau ít phút giúp em nhé.";
      if (!(e instanceof LoiThanThien)) console.error("[telegram-operator] mở đơn lỗi:", e);
      await guiTinQuaBot(bot, { chat_id: chat, text: `⚠️ ${html(msg)}`, parse_mode: "HTML" });
    }
    return true;
  }
  const match = String(callback.data || "").match(CALLBACK_RE);
  if (!match) return false;
  const [, verb, id, indexRaw] = match;
  const operatorId = String(callback.from?.id || "");
  const chatId = String(callback.message?.chat?.id || "");

  if (verb.toLowerCase() === "no") {
    const changed = await runInTenantContext(tenantId, async (client) => {
      const r = await client.query(
        `UPDATE telegram_operator_action SET status='cancelled', confirmed_by=$1
         WHERE id=$2 AND tenant_id=$3 AND telegram_chat_id=$4
           AND status IN ('awaiting_selection','awaiting_confirmation') RETURNING id`,
        [operatorId, id, tenantId, chatId]
      );
      return Boolean(r.rowCount);
    });
    await answerCallbackQuery(bot, callback.id, changed ? "Đã huỷ thao tác." : "Thao tác đã được xử lý trước đó.");
    return true;
  }

  if (verb.toLowerCase() === "pick") {
    const idx = Number(indexRaw);
    const selected = await runInTenantContext(tenantId, async (client) => {
      const r = await client.query(
        `SELECT action_type, payload FROM telegram_operator_action
         WHERE id=$1 AND tenant_id=$2 AND telegram_chat_id=$3 AND status='awaiting_selection' AND expires_at > now()
           AND (action_type NOT IN ('order_cancel', 'discount_create', 'price_update') OR requested_by=$4)`,
        [id, tenantId, chatId, operatorId]
      );
      const row = r.rows[0];
      const p = row?.payload?.candidates?.[idx];
      if (!row || !(p?.sku || p?.id)) return null;
      const payload = { ...row.payload, sku: p.sku, title: p.title, product_id: p.id,
        ...(p.variant_id ? { variant_id: p.variant_id, old_price_vnd: Number(p.price_vnd) > 0 ? Number(p.price_vnd) : null } : {}) };
      await client.query(
        `UPDATE telegram_operator_action SET status='awaiting_confirmation', payload=$1::jsonb
         WHERE id=$2 AND tenant_id=$3 AND status='awaiting_selection'`,
        [JSON.stringify(payload), id, tenantId]
      );
      return { type: row.action_type as LoaiLenh, payload };
    });
    if (!selected) {
      await answerCallbackQuery(bot, callback.id, "Lựa chọn đã hết hạn hoặc đã được xử lý.", true);
      return true;
    }
    await answerCallbackQuery(bot, callback.id, "Đã chọn sản phẩm.");
    await guiBanNhap(bot, chatId, id, selected.type, selected.payload);
    return true;
  }

  // Claim nguyên tử: hai người bấm cùng lúc cũng chỉ một request được chạm Medusa.
  const action = await runInTenantContext(tenantId, async (client) => {
    const r = await client.query(
      `UPDATE telegram_operator_action
          SET status='executing', confirmed_by=$1
        WHERE id=$2 AND tenant_id=$3 AND telegram_chat_id=$4
          AND status='awaiting_confirmation' AND expires_at > now()
          AND action_type <> 'forward_to_customer'
          AND (action_type NOT IN ('order_cancel', 'discount_create', 'price_update') OR requested_by = $1)
        RETURNING *`,
      [operatorId, id, tenantId, chatId]
    );
    return r.rows[0] || null;
  });
  if (!action) {
    // Lệnh huỷ đơn chỉ người tạo mới xác nhận được: báo rõ nếu bị chặn vì lý do này.
    const cuaNguoiKhac = await runInTenantContext(tenantId, async (client) => {
      const r = await client.query(
        `SELECT action_type FROM telegram_operator_action
          WHERE id=$1 AND tenant_id=$2 AND telegram_chat_id=$3 AND action_type IN ('order_cancel', 'discount_create', 'price_update')
            AND status='awaiting_confirmation' AND expires_at > now() AND requested_by <> $4`,
        [id, tenantId, chatId, operatorId]
      );
      return r.rows[0] ? (r.rows[0].action_type ?? "order_cancel") as string : null;
    });
    if (cuaNguoiKhac) {
      await answerCallbackQuery(bot, callback.id, cuaNguoiKhac === "order_cancel" ? "Chỉ người tạo lệnh huỷ mới xác nhận được." : "Chỉ người tạo lệnh này mới xác nhận được.", true);
      return true;
    }
    await answerCallbackQuery(bot, callback.id, "Thao tác đã chạy, bị huỷ hoặc hết hạn.", true);
    return true;
  }

  await answerCallbackQuery(bot, callback.id, "Đang thực hiện…");
  try {
    const result = await thucThi(tenantId, action);
    await runInTenantContext(tenantId, (client) => client.query(
      `UPDATE telegram_operator_action SET status='completed', result=$1::jsonb WHERE id=$2 AND tenant_id=$3`,
      [JSON.stringify(result), id, tenantId]
    ));
    const p = action.payload || {};
    let text = "✅ Đã hoàn tất.";
    if (action.action_type === "inventory_adjust") text = `✅ Đã cập nhật <b>${html(p.title)}</b> (<code>${html(p.sku)}</code>): ${Number(p.quantity_change) >= 0 ? "+" : ""}${html(p.quantity_change)}.`;
    if (action.action_type === "inventory_lookup") {
      const item = result?.items?.[0];
      text = item ? `📦 <b>${html(item.title)}</b> (<code>${html(item.sku)}</code>) còn <b>${html(item.stock_qty)}</b>.` : "Không tìm thấy SKU trong kho thật.";
    }
    let replyMarkup: any = undefined;
    if (action.action_type === "order_payment_received") {
      text = result?.already
        ? `ℹ️ Đơn #${html(p.display_id)} đã ghi nhận tiền trước đó rồi.`
        : `✅ Đã ghi nhận tiền đơn #${html(p.display_id)}.` + canhBaoDeHieu(result?.canh_bao).map((c) => `\n${html(c)}`).join("");
      if (p.order_status === "pending") {
        text += "\nĐơn này còn chờ duyệt, anh/chị bấm nút bên dưới nếu muốn duyệt luôn.";
        replyMarkup = { inline_keyboard: [[{ text: "✅ Duyệt đơn này", callback_data: `ops_ord_${p.display_id}` }]] };
      }
    }
    if (action.action_type === "order_cancel") {
      if (result?.already === true) text = `ℹ️ Đơn #${html(p.display_id)} đã được huỷ rồi.`;
      else {
        const daThu = Number(result?.paid_amount);
        const canTra = typeof result?.needs_manual_refund === "boolean" ? result.needs_manual_refund : p.payment_status === "da_thanh_toan";
        const soTien = Number.isFinite(daThu) && daThu > 0 ? daThu : Number(p.total_vnd);
        text = `✅ Đã huỷ đơn #${html(p.display_id)}.` + (canTra
          ? `\n⚠️ Nhớ chuyển trả ${dinhDangTien(soTien)} cho khách và nhắn khách biết.`
          : "\nKhách không được báo tự động — anh/chị nhắn khách giúp em.");
      }
    }
    if (action.action_type === "discount_create") {
      const maTao = chuanHoaMa(String(result?.promotion?.code ?? "")) ?? p.code;
      text = `✅ Đã tạo mã <code>${html(maTao)}</code> — giảm ${p.percent != null ? `${html(p.percent)}%` : dinhDangTien(p.amount)}. Gửi mã này cho khách là dùng được.\n` +
        `Hạn dùng: ${p.ends_at ? `đến ${html(p.ends_label)}` : "không có"}. Số lần dùng: ${p.usage_limit != null ? `tối đa ${html(p.usage_limit)} lần` : "không giới hạn"}.`;
    }
    if (action.action_type === "price_update") {
      const cu = Number(result?.old_price_vnd) > 0 ? Number(result.old_price_vnd) : (Number(p.old_price_vnd) > 0 ? Number(p.old_price_vnd) : null);
      const moi = Number(result?.new_price_vnd) > 0 ? Number(result.new_price_vnd) : Number(p.new_price_vnd);
      text = `✅ Đã đổi giá <b>${html(result?.product_title ? `${result.product_title}${result?.variant_title && result.variant_title !== result.product_title ? ` — ${result.variant_title}` : ""}` : p.title)}</b>: ${cu ? `${dinhDangTien(cu)} → ` : ""}<b>${dinhDangTien(moi)}</b>.`;
    }
    if (action.action_type === "product_hide") text = `✅ Đã ẩn <b>${html(p.title)}</b> khỏi cửa hàng.`;
    if (action.action_type === "product_show") text = `✅ Đã mở bán lại <b>${html(p.title)}</b>.`;
    if (action.action_type === "order_complete") {
      text = result?.da_xu_ly_truoc_do
        ? `ℹ️ Đơn #${html(p.display_id)} đã được duyệt trước đó rồi.`
        : `✅ Đã duyệt đơn #${html(p.display_id)}, kho đã trừ.` +
          canhBaoDeHieu(result?.ket_qua?.canh_bao).map((c) => `\n${html(c)}`).join("");
    }
    if (action.action_type === "create_product") {
      const tonThanhCong = !Number(p.initial_quantity) || result?.inventory?.ok === true;
      text = `✅ Đã tạo sản phẩm nháp <b>${html(p.title)}</b> (<code>${html(p.sku)}</code>)` +
        (Number(p.initial_quantity) && tonThanhCong ? ` với tồn đầu ${html(p.initial_quantity)}` : "") + "." +
        (!tonThanhCong ? `\n⚠️ Sản phẩm đã tạo nhưng chưa ghi được tồn đầu: ${html(result?.inventory?.warning || "lỗi không xác định")}` : "");
    }
    await guiTinQuaBot(bot, { chat_id: chatId, text, parse_mode: "HTML", reply_markup: replyMarkup });
  } catch (e: any) {
    const loi = String(e?.message || e).slice(0, 1000);
    await runInTenantContext(tenantId, (client) => client.query(
      `UPDATE telegram_operator_action SET status='failed', error=$1 WHERE id=$2 AND tenant_id=$3`,
      [loi, id, tenantId]
    ));
    const thanThienMoi = ["discount_create", "product_hide", "product_show", "price_update"].includes(action.action_type);
    const thanThien = thanThienMoi
      ? (e instanceof LoiThanThien ? e.message : "Em chưa làm được việc này. Anh/chị thử lại sau ít phút giúp em nhé.")
      : action.action_type === "order_complete" || action.action_type === "order_payment_received" || action.action_type === "order_cancel"
      ? (e instanceof LoiThanThien ? e.message : `Chưa ${action.action_type === "order_complete" ? "duyệt được" : action.action_type === "order_cancel" ? "huỷ được" : "ghi nhận được tiền của"} đơn #${action.payload?.display_id ?? ""}. Anh/chị thử lại sau ít phút giúp em nhé.`)
      : `Không thực hiện được: ${loi}`;
    await guiTinQuaBot(bot, { chat_id: chatId, text: `❌ ${html(thanThien)}`, parse_mode: "HTML" });
  }
  return true;
}

