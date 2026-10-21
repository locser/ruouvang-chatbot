import { runInTenantContext, runCentralAdmin } from "../db/client";
import { notifyOperatorWarning, sendTakeoverAlert } from "./telegram";

export type QuyetDinh =
  | { hanh_dong: "khong_lam_gi"; ly_do: string }
  | { hanh_dong: "canh_bao_nguoi" }
  | { hanh_dong: "tra_bot"; bao_khach: boolean }
  | { hanh_dong: "reo_lai" }          // Escalates to other operator
  | { hanh_dong: "dong_hoi_thoai" };

export interface ConversationData {
  id: string;
  tenant_id: string;
  mode: string;
  ly_do_leo_thang: string | null;
  last_human_msg_at: Date | null;
  last_customer_msg_at: Date | null;
  da_canh_bao_nguoi: boolean;
}

export interface TenantSettingData {
  tu_dong_tra_bot: boolean;
  nguong_cho_nguoi_nhan_ms: number; // in milliseconds
  nguong_nguoi_im_lang_ms: number;
  canh_bao_nguoi_truoc_ms: number;
  ly_do_khong_tra_bot: string[];
  hanh_dong_khi_het_gio: string;
  bao_khach_khi_doi_vai: boolean;
  dong_hoi_thoai_sau_ms: number;
}

/**
 * Pure decision logic function (deterministic, highly testable)
 */
export function quyetDinhTraBot(
  c: ConversationData,
  s: TenantSettingData,
  now: Date
): QuyetDinh {
  if (c.mode !== "NGUOI") {
    return { hanh_dong: "khong_lam_gi", ly_do: "khong_o_che_do_NGUOI" };
  }
  if (!s.tu_dong_tra_bot) {
    return { hanh_dong: "khong_lam_gi", ly_do: "tat_trong_setting" };
  }

  // Check if customer is waiting for a reply
  const khachDangCho =
    c.last_customer_msg_at != null &&
    (c.last_human_msg_at == null || c.last_customer_msg_at.getTime() > c.last_human_msg_at.getTime());

  if (!khachDangCho) {
    const imLau =
      c.last_customer_msg_at != null &&
      now.getTime() - c.last_customer_msg_at.getTime() > s.dong_hoi_thoai_sau_ms;
    return imLau
      ? { hanh_dong: "dong_hoi_thoai" }
      : { hanh_dong: "khong_lam_gi", ly_do: "khach_khong_cho" };
  }

  const choBaoLau = now.getTime() - c.last_customer_msg_at!.getTime();

  // If escalation reason is in the hard-list (payments, compliance claims, health) -> do NOT return to bot
  if (c.ly_do_leo_thang && s.ly_do_khong_tra_bot.includes(c.ly_do_leo_thang)) {
    return choBaoLau > s.nguong_nguoi_im_lang_ms
      ? { hanh_dong: "reo_lai" }
      : { hanh_dong: "khong_lam_gi", ly_do: "nhom_cung_chua_qua_nguong" };
  }

  if (choBaoLau > s.nguong_nguoi_im_lang_ms) {
    return s.hanh_dong_khi_het_gio === "de_cho"
      ? { hanh_dong: "khong_lam_gi", ly_do: "setting_de_cho" }
      : s.hanh_dong_khi_het_gio === "chuyen_nguoi_khac"
      ? { hanh_dong: "reo_lai" }
      : { hanh_dong: "tra_bot", bao_khach: s.bao_khach_khi_doi_vai };
  }

  // Pre-timeout warning notification trigger
  const conLai = s.nguong_nguoi_im_lang_ms - choBaoLau;
  if (conLai <= s.canh_bao_nguoi_truoc_ms && !c.da_canh_bao_nguoi) {
    return { hanh_dong: "canh_bao_nguoi" };
  }

  return { hanh_dong: "khong_lam_gi", ly_do: "chua_qua_nguong" };
}

/**
 * Periodically scans the database for operator-idle sessions and executes decisions.
 */
export async function scanAndReapConversations(now: Date = new Date()) {
  // Query all active operator sessions
  const activeConversations = await runCentralAdmin(async (client) => {
    const result = await client.query(
      `SELECT id, tenant_id, mode, ly_do_leo_thang, last_human_msg_at, last_customer_msg_at, da_canh_bao_nguoi 
       FROM conversation 
       WHERE mode = 'NGUOI' AND dong_luc IS NULL`
    );
    return result.rows as ConversationData[];
  });

  for (const c of activeConversations) {
    await runInTenantContext(c.tenant_id, async (client) => {
      // Fetch settings (use simple fallbacks if settings table is empty)
      const setRes = await client.query(
        `SELECT tu_dong_tra_bot, ly_do_khong_tra_bot, hanh_dong_khi_het_gio, bao_khach_khi_doi_vai 
         FROM tenant_setting 
         WHERE tenant_id = $1`,
        [c.tenant_id]
      );
      
      const dbSettings = setRes.rows[0] || {};
      
      // Default timing configurations in milliseconds:
      const settings: TenantSettingData = {
        tu_dong_tra_bot: dbSettings.tu_dong_tra_bot ?? true,
        nguong_cho_nguoi_nhan_ms: 5 * 60 * 1000,
        nguong_nguoi_im_lang_ms: 10 * 60 * 1000,
        canh_bao_nguoi_truoc_ms: 2 * 60 * 1000,
        ly_do_khong_tra_bot: dbSettings.ly_do_khong_tra_bot || ["khach_yeu_cau", "tien_bac", "claim_guard", "suc_khoe", "phap_ly"],
        hanh_dong_khi_het_gio: dbSettings.hanh_dong_khi_het_gio || "bot_tiep",
        bao_khach_khi_doi_vai: dbSettings.bao_khach_khi_doi_vai ?? true,
        dong_hoi_thoai_sau_ms: 30 * 60 * 1000,
      };

      const qd = quyetDinhTraBot(c, settings, now);

      switch (qd.hanh_dong) {
        case "canh_bao_nguoi":
          console.log(`[Reaper] Warning operator for idle conversation ${c.id}`);
          await client.query(
            `UPDATE conversation SET da_canh_bao_nguoi = true WHERE id = $1`,
            [c.id]
          );
          // Dispatch Telegram warning alert
          await notifyOperatorWarning(c.id);
          break;

        case "tra_bot":
          console.log(`[Reaper] Returning conversation ${c.id} to bot`);
          await client.query(
            `UPDATE conversation 
             SET mode = 'BOT', mode_version = mode_version + 1, assigned_to = NULL, da_canh_bao_nguoi = false 
             WHERE id = $1`,
            [c.id]
          );
          if (qd.bao_khach) {
            const transferText = "Nhân viên hiện đang bận ạ. Em là trợ lý ảo, hỗ trợ tạm anh/chị nhé — nhân viên sẽ quay lại sớm nhất.";
            await client.query(
              `INSERT INTO message (tenant_id, conversation_id, vai_tro, noi_dung, model) 
               VALUES ($1, $2, 'bot', $3, 'system')`,
              [c.tenant_id, c.id, transferText]
            );
          }
          break;

        case "reo_lai":
          console.log(`[Reaper] Escalating conversation ${c.id} due to operator abandonment`);
          // Dispatch Telegram escalation alert
          await sendTakeoverAlert(c.id, "Khách hàng chờ hỗ trợ quá lâu", c.ly_do_leo_thang || "Nhan vien im lang quá lau");
          break;

        case "dong_hoi_thoai":
          console.log(`[Reaper] Closing idle conversation ${c.id}`);
          await client.query(
            `UPDATE conversation SET mode = 'DONG', dong_luc = now() WHERE id = $1`,
            [c.id]
          );
          break;
      }
    });
  }
}
