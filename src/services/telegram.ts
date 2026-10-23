import { pool, runInTenantContext } from "../db/client";
import { BotShop, chonBot, layBotCuaShop } from "./telegramTenant";

/**
 * GỬI TIN QUA TELEGRAM — THEO BOT CỦA TỪNG SHOP
 * ===========================================================================
 *
 * Trước đây file này gắn cứng một token duy nhất lấy từ biến môi trường:
 *
 *     const TELEGRAM_API_BASE = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`;
 *
 * Nghĩa là toàn hệ thống chỉ chạy được ĐÚNG MỘT bot. Với SaaS bán cho nhiều
 * shop thì shop thứ hai không thể có bot mang thương hiệu riêng, và tệ hơn:
 * tin nhắn của shop A và shop B đi chung một bot.
 *
 * Nay mọi hàm gửi tin đều phải biết **mình đang nói thay shop nào**. Không có
 * bot của shop thì KHÔNG gửi — tuyệt đối không lặng lẽ rơi về bot nền tảng,
 * vì như vậy là để lộ nội dung hội thoại của shop này qua bot của shop khác.
 */

const API = (token: string) => `https://api.telegram.org/bot${token}`;

export interface TelegramSendMessageOptions {
  chat_id: string | number;
  text: string;
  parse_mode?: "Markdown" | "HTML";
  reply_markup?: any;
}

function escapeMarkdown(text: string): string {
  return text.replace(/([*_`\[])/g, "\\$1");
}

/**
 * Gửi tin bằng một bot cụ thể. Đây là tầng thấp nhất — người gọi tự chịu trách
 * nhiệm chọn đúng bot.
 */
export async function guiTinQuaBot(
  bot: BotShop | null,
  options: TelegramSendMessageOptions
): Promise<boolean> {
  if (!bot || !bot.token || bot.token === "mock_key_for_dev") {
    console.log(
      `[Telegram] Chưa cấu hình bot${bot?.tenantId ? ` cho shop ${bot.tenantId}` : ""} — bỏ qua tin gửi tới ${options.chat_id}.`
    );
    return false;
  }

  try {
    const res = await fetch(`${API(bot.token)}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(options),
    });
    const data = (await res.json()) as any;
    if (!data.ok) {
      console.error("[Telegram] Gửi tin thất bại:", data);
      return false;
    }
    return true;
  } catch (error) {
    console.error("[Telegram] Lỗi khi gửi tin:", error);
    return false;
  }
}

/**
 * Gửi tin thay mặt một shop. `tenantId` là `null` nghĩa là thông báo cấp nền
 * tảng (super admin) — khi đó mới dùng bot nền tảng từ biến môi trường.
 */
export async function sendTelegramMessage(
  tenantId: string | null | undefined,
  options: TelegramSendMessageOptions
): Promise<boolean> {
  const bot = await chonBot(tenantId);
  if (!bot && tenantId) {
    console.error(
      `[Telegram] Shop ${tenantId} chưa cấu hình telegram_bot_token — không gửi được thông báo. ` +
      `Bổ sung vào tenant_setting rồi chạy lại.`
    );
  }
  return guiTinQuaBot(bot, options);
}

/**
 * Trả lời callback_query để Telegram tắt vòng xoay trên nút bấm.
 *
 * Thiếu bước này thì nút "Tiếp quản hội thoại" quay mãi tới khi hết giờ, nhân
 * viên tưởng hỏng và bấm lại nhiều lần.
 */
export async function answerCallbackQuery(
  bot: BotShop | null,
  callbackQueryId: string,
  text?: string,
  canhBao = false
): Promise<void> {
  if (!bot?.token) return;
  try {
    await fetch(`${API(bot.token)}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        callback_query_id: callbackQueryId,
        text: text?.slice(0, 200),
        show_alert: canhBao,
      }),
    });
  } catch (e) {
    console.error("[Telegram] Không trả lời được callback_query:", e);
  }
}

/**
 * Danh sách chat_id của nhân viên được nhận cảnh báo của một shop.
 *
 * Nguồn: `admin_user_tenant` (một người quản nhiều shop) hợp với `admin_user.
 * tenant_id` (cách gán cũ, vẫn còn dữ liệu). Truy vấn chạy trong ngữ cảnh tenant
 * nên hợp lệ với RLS.
 */
async function layNhanVienCuaShop(tenantId: string): Promise<string[]> {
  try {
    return await runInTenantContext(tenantId, async (client) => {
      const r = await client.query(
        `SELECT DISTINCT au.telegram_id
           FROM admin_user au
          WHERE au.telegram_id IS NOT NULL
            AND au.telegram_id <> ''
            AND ( au.tenant_id = $1
                  OR EXISTS (SELECT 1 FROM admin_user_tenant aut
                              WHERE aut.admin_user_id = au.id
                                AND aut.tenant_id = $1) )`,
        [tenantId]
      );
      return r.rows.map((x: any) => String(x.telegram_id));
    });
  } catch (e) {
    console.error(`[Telegram] Không lấy được danh sách nhân viên của shop ${tenantId}:`, e);
    return [];
  }
}

/** Tra tenant của một hội thoại. Dùng khi người gọi chỉ có conversationId. */
async function layTenantCuaHoiThoai(conversationId: string): Promise<string | null> {
  try {
    const r = await pool.query("SELECT tenant_id FROM conversation WHERE id = $1", [conversationId]);
    return r.rows[0]?.tenant_id ? String(r.rows[0].tenant_id) : null;
  } catch (e) {
    console.error("[Telegram] Không tra được tenant của hội thoại:", e);
    return null;
  }
}

/**
 * Cảnh báo leo thang kèm nút "Tiếp quản hội thoại".
 *
 * Chữ ký cũ nhận `chatId` nhưng MỌI nơi gọi đều truyền chuỗi giữ chỗ
 * `"@aiad1_bot"` — tức tham số đó chưa bao giờ có tác dụng, và cái tên bot gắn
 * cứng ấy chính là dấu vết của mô hình một-bot-cho-tất-cả. Nay bỏ hẳn: tenant
 * và người nhận đều suy ra từ chính hội thoại.
 */
export async function sendTakeoverAlert(
  conversationId: string,
  customerMsg: string,
  reason?: string
): Promise<boolean> {
  const tenantId = await layTenantCuaHoiThoai(conversationId);
  if (!tenantId) {
    console.error(`[Telegram] Không tìm thấy hội thoại ${conversationId} — bỏ qua cảnh báo.`);
    return false;
  }

  const bot = await layBotCuaShop(tenantId);
  if (!bot) {
    console.error(
      `[Telegram] Shop ${tenantId} chưa có bot riêng — nhân viên sẽ KHÔNG nhận được cảnh báo ` +
      `tiếp quản cho hội thoại ${conversationId}. Cấu hình tenant_setting.telegram_bot_token.`
    );
    return false;
  }

  const nhanVien = await layNhanVienCuaShop(tenantId);
  if (nhanVien.length === 0) {
    console.warn(`[Telegram] Shop ${tenantId} chưa có nhân viên nào liên kết Telegram.`);
    return false;
  }

  const text =
    `🚨 *YÊU CẦU HỖ TRỢ KHÁCH HÀNG*\n\n` +
    `📌 *Mã hội thoại*: \`${conversationId}\`\n` +
    `💬 *Nội dung khách*: "${escapeMarkdown(customerMsg)}"\n` +
    `⚠️ *Lý do chuyển*: ${escapeMarkdown(reason || "Khách cần hỗ trợ trực tiếp")}\n\n` +
    `_Bấm nút bên dưới để nhận tiếp quản ngay trên Telegram!_`;

  const reply_markup = {
    inline_keyboard: [[{ text: "💬 Tiếp quản hội thoại", callback_data: `takeover_${conversationId}` }]],
  };

  let tatCaOk = true;
  for (const chatId of nhanVien) {
    const ok = await guiTinQuaBot(bot, { chat_id: chatId, text, parse_mode: "Markdown", reply_markup });
    if (!ok) tatCaOk = false;
  }
  return tatCaOk;
}

/**
 * Báo đơn mới cho nhân viên của shop qua bot riêng của shop. Nội dung là HTML do bên gọi
 * dựng sẵn (đã escape). `nut` là nút bấm mở thẳng trang đơn; Telegram từ chối URL
 * localhost/IP nội bộ trong nút, nên khi gặp địa chỉ đó thì chuyển thành dòng chữ cuối tin.
 * Trả về số nơi gửi thành công.
 */
export async function guiThongBaoDonMoi(
  tenantId: string,
  text: string,
  nut?: { text: string; url: string },
  nutDuyet?: { text: string; callback_data: string }
): Promise<number> {
  const bot = await layBotCuaShop(tenantId);
  if (!bot) {
    console.warn(`[Telegram] Shop ${tenantId} chưa có bot riêng — không báo được đơn mới.`);
    return 0;
  }
  const nhanVien = await layNhanVienCuaShop(tenantId);
  if (nhanVien.length === 0) {
    console.warn(`[Telegram] Shop ${tenantId} chưa có nhân viên nào liên kết Telegram.`);
    return 0;
  }

  let noiDung = text;
  let reply_markup: any = undefined;
  if (nut) {
    let host = "";
    try { host = new URL(nut.url).hostname; } catch { /* URL hỏng: bỏ nút */ }
    const noiBo = /^(localhost|127\.|10\.|192\.168\.|0\.0\.0\.0)/.test(host) || host === "";
    if (!host) {
      // không có link hợp lệ thì không thêm gì
    } else if (noiBo) {
      // Chữ có gắn link (text_link): bấm được trên Telegram máy tính cùng máy chạy Medusa.
      const href = nut.url.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
      noiDung += `\n\n<a href="${href}">${nut.text.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</a>`;
    } else {
      reply_markup = { inline_keyboard: [[{ text: nut.text, url: nut.url }]] };
    }
  }

  if (nutDuyet) {
    // Nút duyệt đơn là một hàng riêng, đứng trên nút mở admin (nếu có).
    const hang = [{ text: nutDuyet.text, callback_data: nutDuyet.callback_data }];
    reply_markup = { inline_keyboard: [hang, ...(reply_markup?.inline_keyboard ?? [])] };
  }

  let soOk = 0;
  for (const chatId of nhanVien) {
    if (await guiTinQuaBot(bot, { chat_id: chatId, text: noiDung, parse_mode: "HTML", reply_markup })) soOk++;
  }
  return soOk;
}

/** Nhắc nhân viên sắp hết thời hạn giữ hội thoại. */
export async function notifyOperatorWarning(conversationId: string): Promise<boolean> {
  const tenantId = await layTenantCuaHoiThoai(conversationId);
  if (!tenantId) return false;

  const bot = await layBotCuaShop(tenantId);
  if (!bot) return false;

  const nhanVien = await layNhanVienCuaShop(tenantId);
  const text =
    `⏰ *CẢNH BÁO THỜI GIAN CHỜ*\n\n` +
    `Hội thoại \`${conversationId}\` sắp hết thời hạn hỗ trợ thủ công.\n` +
    `Nếu anh/chị không phản hồi trong 2 phút tới, Bot sẽ tự động tiếp quản lại phiên chat này!`;

  let tatCaOk = nhanVien.length > 0;
  for (const chatId of nhanVien) {
    const ok = await guiTinQuaBot(bot, { chat_id: chatId, text, parse_mode: "Markdown" });
    if (!ok) tatCaOk = false;
  }
  return tatCaOk;
}

// ---------------------------------------------------------------------------
// Đăng ký webhook
// ---------------------------------------------------------------------------

export interface KetQuaDangKy {
  ok: boolean;
  tenantId: string;
  url?: string;
  loi?: string;
}

/**
 * Trỏ webhook của bot một shop về đúng đường dẫn có `tenant_id`.
 *
 * `secret_token` là bắt buộc: Telegram sẽ gửi kèm header
 * `x-telegram-bot-api-secret-token` ở mỗi update, và webhook từ chối request
 * thiếu/sai header này. Bản cũ gọi `setWebhook` mà KHÔNG đặt secret_token, nên
 * dù server có kiểm tra thì mọi update thật cũng bị chặn.
 */
export async function dangKyWebhookChoShop(
  bot: BotShop,
  baseUrl: string,
  secret: string
): Promise<KetQuaDangKy> {
  const url = `${baseUrl.replace(/\/+$/, "")}/v1/tg/webhook/${bot.tenantId}`;
  try {
    const res = await fetch(`${API(bot.token)}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url,
        secret_token: secret,
        allowed_updates: ["message", "callback_query"],
        drop_pending_updates: false,
      }),
    });
    const data = (await res.json()) as any;
    if (data.ok !== true) {
      return { ok: false, tenantId: bot.tenantId, url, loi: data.description ?? JSON.stringify(data) };
    }
    return { ok: true, tenantId: bot.tenantId, url };
  } catch (e: any) {
    return { ok: false, tenantId: bot.tenantId, url, loi: e?.message ?? String(e) };
  }
}

/** Trạng thái webhook hiện tại của một bot — để nghiệm thu sau khi đăng ký. */
export async function layThongTinWebhook(bot: BotShop): Promise<any> {
  try {
    const res = await fetch(`${API(bot.token)}/getWebhookInfo`);
    return await res.json();
  } catch (e: any) {
    return { ok: false, description: e?.message ?? String(e) };
  }
}

/** Tên bot theo Telegram — dùng để đối chiếu với telegram_bot_username trong CSDL. */
export async function layThongTinBot(bot: BotShop): Promise<{ ok: boolean; username?: string; loi?: string }> {
  try {
    const res = await fetch(`${API(bot.token)}/getMe`);
    const data = (await res.json()) as any;
    if (data.ok !== true) return { ok: false, loi: data.description };
    return { ok: true, username: data.result?.username };
  } catch (e: any) {
    return { ok: false, loi: e?.message ?? String(e) };
  }
}
