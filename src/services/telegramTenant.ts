import { runInTenantContext, runCentralAdmin } from "../db/client";
import { layCaiDat } from "./caiDat";

/**
 * SỔ ĐĂNG KÝ BOT TELEGRAM THEO TỪNG SHOP
 * ===========================================================================
 *
 * Kiến trúc đã chốt: **mỗi shop một bot Telegram riêng** (@FarmersMarketHue_Bot,
 * @CellphoneS_Bot…), và **một bot làm cả hai việc**:
 *
 *   - Khách chat mua hàng   → webhook  POST /v1/tg/webhook/:tenant_id
 *   - Chủ shop duyệt đơn    → Mini App GET  /operator?t=<tenant_id>  (bên ai-service)
 *
 * Hai việc đó không đụng nhau: Telegram cho phép một bot vừa có webhook, vừa có
 * Mini App. Nhưng CẢ HAI đều cần đúng bot token của shop — nên token phải có
 * **một nguồn sự thật duy nhất**. Nguồn đó là `tenant_setting`, KHÔNG phải biến
 * môi trường.
 *
 * Vì sao bỏ `env.TELEGRAM_BOT_TOKEN` làm nguồn chính: biến môi trường chỉ chứa
 * được ĐÚNG MỘT token cho toàn hệ thống. Shop thứ hai muốn có bot riêng là vỡ
 * ngay, và webhook `/v1/tg/webhook` (không có tenant) cũng không biết update
 * vừa nhận thuộc shop nào.
 *
 * Bot nền tảng (`app_settings.telegram_bot_token`) chỉ dùng cho **thông báo cấp hệ thống** — thông báo gửi
 * cho super admin (không thuộc shop nào), ví dụ email quên mật khẩu của tài
 * khoản quản trị cấp hệ thống.
 */

export interface BotShop {
  tenantId: string;
  token: string;
  username: string | null;
  /** Bí mật webhook riêng của shop — Telegram gửi lại ở header x-telegram-bot-api-secret-token. */
  webhookSecret: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Cache ngắn hạn. Webhook Telegram gọi rất dày, không thể mỗi update một truy
 * vấn CSDL. 60 giây đủ ngắn để đổi token xong là có hiệu lực gần như ngay, mà
 * vẫn cắt được gần hết tải đọc.
 */
const CACHE_MS = 60_000;
const boNho = new Map<string, { luc: number; gt: BotShop | null }>();

export function xoaCacheBot(tenantId?: string): void {
  if (tenantId) boNho.delete(tenantId);
  else boNho.clear();
}

/**
 * Bot của một shop. Trả `null` khi shop chưa cấu hình bot — người gọi phải xử lý
 * trường hợp này, KHÔNG được lặng lẽ rơi về bot nền tảng: gửi tin của shop A qua
 * bot của shop B là lộ dữ liệu chéo tenant.
 */
export async function layBotCuaShop(tenantId: string): Promise<BotShop | null> {
  if (!tenantId || !UUID_RE.test(tenantId)) return null;

  const c = boNho.get(tenantId);
  if (c && Date.now() - c.luc < CACHE_MS) return c.gt;

  let kq: BotShop | null = null;
  try {
    // Đọc trong ngữ cảnh tenant → hợp lệ với RLS, không cần quyền vượt rào.
    kq = await runInTenantContext(tenantId, async (client) => {
      const r = await client.query(
        `SELECT telegram_bot_token, telegram_bot_username, telegram_webhook_secret
           FROM tenant_setting WHERE tenant_id = $1`,
        [tenantId]
      );
      const row = r.rows[0];
      if (!row?.telegram_bot_token) return null;
      return {
        tenantId,
        token: String(row.telegram_bot_token),
        username: row.telegram_bot_username ?? null,
        webhookSecret: row.telegram_webhook_secret ?? null,
      } as BotShop;
    });
  } catch (e) {
    console.error(`[BotShop] Không đọc được cấu hình bot của tenant ${tenantId}:`, e);
    return null; // Không cache lỗi — lần sau thử lại.
  }

  boNho.set(tenantId, { luc: Date.now(), gt: kq });
  return kq;
}

/**
 * Toàn bộ bot đang cấu hình.
 *
 * CHỈ dùng cho hai việc: đăng ký webhook hàng loạt, và đường lui khi xác thực
 * Mini App mà client không gửi kèm gợi ý tenant. Đây là truy vấn xuyên tenant
 * nên chạy qua `runCentralAdmin` — cần vai trò CSDL đọc được mọi dòng.
 */
export async function layTatCaBot(): Promise<BotShop[]> {
  try {
    return await runCentralAdmin(async (client) => {
      const r = await client.query(
        `SELECT tenant_id, telegram_bot_token, telegram_bot_username, telegram_webhook_secret
           FROM tenant_setting
          WHERE telegram_bot_token IS NOT NULL AND telegram_bot_token <> ''`
      );
      return r.rows.map((x: any) => ({
        tenantId: String(x.tenant_id),
        token: String(x.telegram_bot_token),
        username: x.telegram_bot_username ?? null,
        webhookSecret: x.telegram_webhook_secret ?? null,
      }));
    });
  } catch (e) {
    console.error("[BotShop] Không liệt kê được danh sách bot:", e);
    return [];
  }
}

/**
 * Bot nền tảng — chỉ cho thông báo KHÔNG thuộc shop nào (super admin).
 * Trả `null` nếu chưa cấu hình; người gọi phải bỏ qua chứ không được báo lỗi.
 */
export async function layBotNenTang(): Promise<BotShop | null> {
  const t = await layCaiDat("telegram_bot_token");
  if (!t) return null;
  return { tenantId: "", token: t, username: null, webhookSecret: (await layCaiDat("telegram_webhook_secret")) || null };
}

/**
 * Chọn bot để gửi tin: có tenant thì dùng bot của shop, không có (super admin)
 * thì dùng bot nền tảng. KHÔNG bao giờ lấy bot nền tảng thay cho bot shop khi
 * shop chưa cấu hình — trả `null` để người gọi biết mà báo cho quản trị viên.
 */
export async function chonBot(tenantId: string | null | undefined): Promise<BotShop | null> {
  if (tenantId) return layBotCuaShop(tenantId);
  return layBotNenTang();
}
