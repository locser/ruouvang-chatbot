import { BotShop, } from "./telegramTenant";
import { guiTinQuaBot, answerCallbackQuery } from "./telegram";
import { runInTenantContext } from "../db/client";
import { getTenantMedusaConfig, MedusaConfig } from "./medusa";
import { timSanPham, SanPhamTimDuoc } from "./search";
import { goiDeepSeekCoTool, ChatMessageTool } from "./llm";
import { layCaiDat } from "./caiDat";
import { fetchCoTimeout, fetchJson, TIMEOUT } from "./http";
import { env } from "../config/env";

type LoaiLenh = "inventory_adjust" | "create_product" | "inventory_lookup";

export interface LenhVanHanh {
  type: LoaiLenh;
  product_query?: string;
  quantity_change?: number;
  title?: string;
  sku?: string;
  price_vnd?: number;
  initial_quantity?: number;
  description?: string;
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
const CALLBACK_RE = new RegExp(`^ops_(ok|no|pick)_(${UUID_RE})(?:_(\\d+))?$`, "i");

function html(v: unknown): string {
  return String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function boDau(v: string): string {
  return v.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function boTienTo(text: string): string {
  return text
    .replace(/^\s*\/ops(?:@\w+)?\s*/i, "")
    .replace(/@\w+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Parser chắc chắn cho các câu kho phổ biến; câu tự do hơn sẽ đi qua LLM. */
export function phanTichLenhNhanh(raw: string): LenhVanHanh | null {
  const text = boTienTo(raw);
  const plain = boDau(text);

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

export function laYeuCauVanHanh(message: TelegramMessageLike, bot: BotShop): boolean {
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
] as const;

async function phanTichBangAi(text: string): Promise<LenhVanHanh | null> {
  const messages: ChatMessageTool[] = [
    { role: "system", content:
      "Bạn là bộ phân tích lệnh vận hành kho. Chỉ gọi đúng một tool khi nhân viên yêu cầu rõ. " +
      "Không đoán SKU, giá, số lượng. 'nhập thêm N' là quantity_change dương; 'xuất/giảm N' là âm. " +
      "Nếu chưa đủ dữ kiện thì không gọi tool." },
    { role: "user", content: text },
  ];
  const kq = await goiDeepSeekCoTool(messages, OPERATOR_TOOLS as unknown as object[]);
  const call = kq.tool_calls?.[0];
  if (!call || !["inventory_adjust", "inventory_lookup", "create_product"].includes(call.function.name)) return null;
  try {
    const p = JSON.parse(call.function.arguments || "{}");
    return { type: call.function.name as LoaiLenh, ...p };
  } catch {
    return null;
  }
}

async function moTaAnh(bot: BotShop, photo: NonNullable<TelegramMessageLike["photo"]>[number]): Promise<string> {
  if ((photo.file_size ?? 0) > 8 * 1024 * 1024) throw new Error("Ảnh vượt quá 8 MB.");
  const [base, key, model] = await Promise.all([
    layCaiDat("vision_api_base_url"), layCaiDat("vision_api_key"), layCaiDat("vision_model"),
  ]);
  if (!base || !key || !model) {
    throw new Error("Chưa cấu hình vision_api_base_url, vision_api_key và vision_model trong Cài đặt nền tảng.");
  }
  const file = await fetchJson<any>(`${`https://api.telegram.org/bot${bot.token}`}/getFile?file_id=${encodeURIComponent(photo.file_id)}`, {}, TIMEOUT.TELEGRAM);
  const filePath = file?.result?.file_path;
  if (!filePath) throw new Error("Telegram không trả đường dẫn ảnh.");
  const anh = await fetchCoTimeout(`https://api.telegram.org/file/bot${bot.token}/${filePath}`, {}, TIMEOUT.TELEGRAM);
  if (!anh.ok) throw new Error(`Không tải được ảnh Telegram (${anh.status}).`);
  const bytes = Buffer.from(await anh.arrayBuffer());
  if (bytes.length > 8 * 1024 * 1024) throw new Error("Ảnh vượt quá 8 MB.");
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
  if (typeof content !== "string" || !content.trim()) throw new Error("Vision API không nhận diện được nhãn chai.");
  return content.trim().slice(0, 1200);
}

async function layMedusa(tenantId: string): Promise<MedusaConfig> {
  const cfg = await runInTenantContext(tenantId, (client) => getTenantMedusaConfig(client, tenantId));
  if (!cfg) throw new Error("Shop chưa kết nối Medusa hoặc kết nối đang tắt.");
  return cfg;
}

async function goiBackend(cfg: MedusaConfig, path: string, body: Record<string, unknown>): Promise<any> {
  return fetchJson(new URL(path, cfg.baseUrl).toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-ai-secret-key": env.AI_SECRET_KEY },
    body: JSON.stringify(body),
  }, 15_000);
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
    throw new Error("Thiếu tên sản phẩm hoặc số lượng cần thay đổi.");
  }
  if (lenh.type === "inventory_adjust" && (Math.abs(Number(lenh.quantity_change)) > 100_000 || !Number.isInteger(lenh.quantity_change))) {
    throw new Error("Số lượng thay đổi phải là số nguyên và không vượt quá 100.000 mỗi lần.");
  }
  const kq = await timSanPham(tenantId, { query, in_stock_only: false, limit: 5 });
  const candidates = kq.products.filter((p) => p.sku);
  if (!candidates.length) throw new Error(`Không tìm thấy sản phẩm khớp “${query}”. Nếu là hàng mới, hãy nói “tạo sản phẩm mới ...”.`);
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
  if (!lenh) throw new Error("Mình chưa hiểu thao tác. Hãy ghi rõ tên chai và số lượng, ví dụ: /ops Chateau X mới nhập thêm 30 chai.");

  if (lenh.type === "create_product") {
    if (!lenh.title?.trim()) throw new Error("Chưa đọc được tên sản phẩm. Hãy gửi lại ảnh rõ nhãn hoặc ghi tên chai.");
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

async function thucThi(tenantId: string, action: any): Promise<any> {
  const cfg = await layMedusa(tenantId);
  const p = action.payload || {};
  if (action.action_type === "inventory_adjust") {
    return goiBackend(cfg, "/ai/update-inventory", { sku: p.sku, quantityChange: Number(p.quantity_change) });
  }
  if (action.action_type === "inventory_lookup") {
    return goiBackend(cfg, "/ai/products-lookup", { skus: [p.sku] });
  }
  return goiBackend(cfg, "/ai/create-product", {
    product: { title: p.title, description: p.description, sku: p.sku, price_vnd: p.price_vnd },
    initial_quantity: Number(p.initial_quantity || 0),
  });
}

export async function xuLyCallbackVanHanh(bot: BotShop, tenantId: string, callback: TelegramCallbackLike): Promise<boolean> {
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
    await guiTinQuaBot(bot, { chat_id: chatId, text: `❌ Không thực hiện được: ${html(loi)}`, parse_mode: "HTML" });
  }
  return true;
}

