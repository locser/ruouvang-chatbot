import * as crypto from "crypto";
import { runInTenantContext } from "../db/client";
import { env } from "../config/env";
import { layTatCaBot, layBotCuaShop, xoaCacheBot, BotShop } from "../services/telegramTenant";
import { dangKyWebhookChoShop, layThongTinWebhook, layThongTinBot } from "../services/telegram";

/**
 * ĐĂNG KÝ WEBHOOK TELEGRAM CHO TỪNG SHOP
 * ===========================================================================
 *
 *   npm run tg:webhook                       # tất cả shop, dùng CONFIG_API_CHATBOT_PUBLIC_URL
 *   npm run tg:webhook -- --url https://...  # ép base URL khác
 *   npm run tg:webhook -- --tenant <uuid>    # chỉ một shop
 *   npm run tg:webhook -- --kiem-tra         # chỉ xem trạng thái, không đổi gì
 *
 * Mỗi shop được trỏ về `<base>/v1/tg/webhook/<tenant_id>` kèm `secret_token`
 * riêng. Shop nào chưa có secret thì script tự sinh 32 byte ngẫu nhiên và lưu
 * vào `tenant_setting.telegram_webhook_secret` — sinh sẵn để hai đầu (Telegram
 * và server) không bao giờ lệch nhau.
 *
 * Base URL BẮT BUỘC là https: Telegram từ chối webhook http.
 */

function docThamSo(ten: string): string | undefined {
  const i = process.argv.indexOf(`--${ten}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const coCo = (ten: string) => process.argv.includes(`--${ten}`);

/** Lấy secret hiện có, hoặc sinh mới và lưu lại. */
async function baoDamCoSecret(bot: BotShop): Promise<string> {
  if (bot.webhookSecret && bot.webhookSecret.length >= 16) return bot.webhookSecret;

  const secret = crypto.randomBytes(32).toString("hex");
  await runInTenantContext(bot.tenantId, async (client) => {
    await client.query(
      `UPDATE tenant_setting SET telegram_webhook_secret = $2 WHERE tenant_id = $1`,
      [bot.tenantId, secret]
    );
  });
  xoaCacheBot(bot.tenantId);
  console.log(`  → Đã sinh secret mới cho shop ${bot.tenantId}`);
  return secret;
}

async function main(): Promise<void> {
  const baseUrl = docThamSo("url") || env.APP_BASE_URL;
  const chiTenant = docThamSo("tenant");
  const chiKiemTra = coCo("kiem-tra");

  if (!chiKiemTra) {
    if (!baseUrl) {
      console.error("Thiếu base URL. Đặt CONFIG_API_CHATBOT_PUBLIC_URL hoặc truyền --url https://...");
      process.exit(1);
    }
    if (!baseUrl.startsWith("https://")) {
      console.error(`Telegram chỉ chấp nhận webhook https. Nhận được: ${baseUrl}`);
      process.exit(1);
    }
  }

  const dsBot = chiTenant
    ? ([await layBotCuaShop(chiTenant)].filter(Boolean) as BotShop[])
    : await layTatCaBot();

  if (dsBot.length === 0) {
    console.error(
      "Không có shop nào cấu hình telegram_bot_token.\n" +
      "Chạy:  UPDATE tenant_setting SET telegram_bot_token='<token>' WHERE tenant_id='<uuid>';"
    );
    process.exit(1);
  }

  console.log(`Tìm thấy ${dsBot.length} shop có bot Telegram.\n`);
  let loi = 0;

  for (const bot of dsBot) {
    const me = await layThongTinBot(bot);
    const ten = me.ok ? `@${me.username}` : `(không đọc được getMe: ${me.loi})`;
    console.log(`Shop ${bot.tenantId} — ${ten}`);

    if (me.ok && bot.username && me.username !== bot.username.replace(/^@/, "")) {
      console.warn(
        `  ⚠ telegram_bot_username trong CSDL là "${bot.username}" nhưng Telegram trả về "@${me.username}". ` +
        `Token và tên bot đang lệch nhau.`
      );
    }

    if (chiKiemTra) {
      const tt = await layThongTinWebhook(bot);
      console.log(`  URL hiện tại : ${tt?.result?.url || "(chưa đặt)"}`);
      console.log(`  Chờ xử lý    : ${tt?.result?.pending_update_count ?? "?"}`);
      if (tt?.result?.last_error_message) {
        console.log(`  Lỗi gần nhất : ${tt.result.last_error_message}`);
        loi++;
      }
      console.log("");
      continue;
    }

    const secret = await baoDamCoSecret(bot);
    const kq = await dangKyWebhookChoShop(bot, baseUrl!, secret);
    if (!kq.ok) {
      console.error(`  ✗ Đăng ký thất bại: ${kq.loi}`);
      loi++;
    } else {
      console.log(`  ✓ ${kq.url}`);
    }
    console.log("");
  }

  if (loi > 0) {
    console.error(`Hoàn tất với ${loi} shop có vấn đề.`);
    process.exit(1);
  }
  console.log("Hoàn tất — tất cả shop đều ổn.");
  process.exit(0);
}

main().catch((e) => {
  console.error("Lỗi không mong đợi:", e);
  process.exit(1);
});
