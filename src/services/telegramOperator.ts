import { BotShop, } from "./telegramTenant";
import { guiTinQuaBot, answerCallbackQuery } from "./telegram";
import { runInTenantContext } from "../db/client";
import { getTenantMedusaConfig, MedusaConfig } from "./medusa";
import { timSanPham, SanPhamTimDuoc } from "./search";
import { goiDeepSeekCoTool, ChatMessageTool } from "./llm";
import { layCaiDat } from "./caiDat";
import { fetchCoTimeout, fetchJson, TIMEOUT } from "./http";
import { env } from "../config/env";

type LoaiLenh = "inventory_adjust" | "create_product" | "inventory_lookup" | "order_list_pending" | "order_complete" | "order_lookup";

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
}

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
const CALLBACK_XEM_RE = /^ops_view_(\d{1,9})$/;
const CALLBACK_RE = new RegExp(`^ops_(ok|no|pick)_(${UUID_RE})(?:_(\\d+))?$`, "i");

function html(v: unknown): string {
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
    return { text: "Anh/chị gõ “đơn mới” để xem đơn chờ duyệt, hoặc “duyệt đơn 12”." };
  }
  return null;
}

/** Câu trông giống một lệnh (đơn hoặc kho) — dùng để nhắc nhân viên đang tiếp quản gõ /ops. */
export function trongGiongLenh(raw: string): boolean {
  return phanTichLenhNhanh(raw) !== null || goiYDonHang(raw, false) !== null;
}

/** Parser chắc chắn cho các câu kho phổ biến; câu tự do hơn sẽ đi qua LLM. */
export function phanTichLenhNhanh(raw: string): LenhVanHanh | null {
  const text = boTienTo(raw);
  const plain = boDau(text);

  const donHang = phanTichLenhDonHang(raw);
  if (donHang) return donHang;

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

  const tang = plain.match(/(?:moi\s+nhap|nhap(?:\s+kho)?|tang|cong)(?:\s+them)?\s*(\d{1,6})\s*(?:chai|hop|thung|san\s*pham|sp)?/i);
  const giam = plain.match(/(?:xuat|giam|bot|tru)(?:\s+kho|\s+di|\s+them)?\s*(\d{1,6})\s*(?:chai|hop|thung|san\s*pham|sp)?/i);
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
] as const;

async function phanTichBangAi(text: string): Promise<LenhVanHanh | null> {
  const messages: ChatMessageTool[] = [
    { role: "system", content:
      "Bạn là bộ phân tích lệnh vận hành kho. Chỉ gọi đúng một tool khi nhân viên yêu cầu rõ. " +
      "Không đoán SKU, giá, số lượng. 'nhập thêm N' là quantity_change dương; 'xuất/giảm N' là âm. " +
      "Hỏi đơn mới/đơn chưa duyệt thì gọi order_list_pending; xem/tra đơn thì gọi order_lookup (không duyệt); duyệt/xác nhận đơn N thì gọi order_complete với số đơn N. " +
      "Nếu chưa đủ dữ kiện thì không gọi tool." },
    { role: "user", content: text },
  ];
  const kq = await goiDeepSeekCoTool(messages, OPERATOR_TOOLS as unknown as object[]);
  const call = kq.tool_calls?.[0];
  if (!call || !["inventory_adjust", "inventory_lookup", "create_product", "order_list_pending", "order_complete", "order_lookup"].includes(call.function.name)) return null;
  try {
    const p = JSON.parse(call.function.arguments || "{}");
    if (call.function.name === "order_complete") {
      const n = Number(p.order_number);
      if (!Number.isSafeInteger(n) || n <= 0) return null;
      return { type: "order_complete", order_number: n };
    }
    if (call.function.name === "order_list_pending") return { type: "order_list_pending" };
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

async function docBackend(cfg: MedusaConfig, path: string): Promise<any> {
  try {
    return await fetchJson(new URL(path, cfg.baseUrl).toString(), {
      headers: { "x-ai-secret-key": env.AI_SECRET_KEY },
    }, 15_000);
  } catch (e) {
    console.error("[telegram-operator] đọc backend lỗi:", e);
    throw new LoiThanThien("Em chưa lấy được danh sách đơn lúc này. Anh/chị thử lại sau ít phút giúp em nhé.");
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

function nutXacNhan(id: string) {
  return { inline_keyboard: [[
    { text: "✅ Xác nhận", callback_data: `ops_ok_${id}` },
    { text: "❌ Huỷ", callback_data: `ops_no_${id}` },
  ]] };
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
  } else if (type === "inventory_lookup") {
    text = `🔎 Tra tồn kho <b>${html(payload.title)}</b> — SKU <code>${html(payload.sku)}</code>?`;
  } else {
    text = `🆕 <b>Xác nhận tạo sản phẩm nháp</b>\nTên: <b>${html(payload.title)}</b>\nSKU: <code>${html(payload.sku)}</code>` +
      (payload.price_vnd != null ? `\nGiá: ${Number(payload.price_vnd).toLocaleString("vi-VN")}đ` : "\nGiá: chưa nhập") +
      (payload.initial_quantity != null ? `\nTồn đầu: ${html(payload.initial_quantity)}` : "\nTồn đầu: 0");
  }
  await guiTinQuaBot(bot, { chat_id: chatId, text, parse_mode: "HTML", reply_markup: nutXacNhan(id) });
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
    return r.rows[0]?.id ? String(r.rows[0].id) : null;
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
    reply_markup: o.status === "pending"
      ? { inline_keyboard: [[{ text: "✅ Duyệt đơn này", callback_data: `ops_ord_${o.display_id}` }]] }
      : undefined,
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
  }
  return Array.from(kq);
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
  return goiBackend(cfg, "/ai/create-product", {
    product: { title: p.title, description: p.description, sku: p.sku, price_vnd: p.price_vnd },
    initial_quantity: Number(p.initial_quantity || 0),
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
         WHERE id=$1 AND tenant_id=$2 AND telegram_chat_id=$3 AND status='awaiting_selection' AND expires_at > now()`,
        [id, tenantId, chatId]
      );
      const row = r.rows[0];
      const p = row?.payload?.candidates?.[idx];
      if (!row || !p?.sku) return null;
      const payload = { ...row.payload, sku: p.sku, title: p.title };
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
        RETURNING *`,
      [operatorId, id, tenantId, chatId]
    );
    return r.rows[0] || null;
  });
  if (!action) {
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
    await guiTinQuaBot(bot, { chat_id: chatId, text, parse_mode: "HTML" });
  } catch (e: any) {
    const loi = String(e?.message || e).slice(0, 1000);
    await runInTenantContext(tenantId, (client) => client.query(
      `UPDATE telegram_operator_action SET status='failed', error=$1 WHERE id=$2 AND tenant_id=$3`,
      [loi, id, tenantId]
    ));
    const thanThien = action.action_type === "order_complete"
      ? (e instanceof LoiThanThien ? e.message : `Chưa duyệt được đơn #${action.payload?.display_id ?? ""}. Anh/chị thử lại sau ít phút giúp em nhé.`)
      : `Không thực hiện được: ${loi}`;
    await guiTinQuaBot(bot, { chat_id: chatId, text: `❌ ${html(thanThien)}`, parse_mode: "HTML" });
  }
  return true;
}

