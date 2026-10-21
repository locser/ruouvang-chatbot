/**
 * ONBOARD MỘT SHOP MỚI — tạo tenant + khoá widget + credit + cấu hình Medusa.
 *
 * Thay cho việc gõ tay 5 câu SQL rời rạc theo README §4.3, vốn dễ sót bước và
 * dễ sai thứ tự (tenant_setting có khoá ngoại tới tenant).
 *
 * Chạy:
 *   npx ts-node src/scripts/taoShop.ts \
 *     --ten "CellphoneS" --nganh dien_tu \
 *     --medusa http://backend-cellphones:9000 \
 *     --credit 100000
 *
 * Hai cờ dành cho shop mà storefront ĐÃ dựng xong và đang chạy:
 *   --id   <uuid>  ghim tenant_id trùng với `CONFIG_TENANT_ID` / bộ lọc Meilisearch
 *                  đã nướng cứng trong bản dựng (bỏ trống thì CSDL tự sinh).
 *   --khoa <pk_…>  dùng lại khoá widget đã nướng vào `NEXT_PUBLIC_CHATBOT_WIDGET_KEY`
 *                  thay vì cấp khoá mới (cấp mới là phải `next build` lại).
 *
 * In ra tenant_id và khoá công khai của widget. Khoá công khai chỉ hiện MỘT
 * LẦN duy nhất ở đây: CSDL chỉ lưu sha256 của nó (cột `tenant_key.khoa_bam`),
 * nên mất là phải cấp lại khoá mới chứ không tra lại được.
 *
 * Idempotent theo TÊN shop: chạy lại với cùng --ten sẽ cập nhật shop cũ thay vì
 * tạo bản trùng. Đã có 108 tenant rác trong CSDL staging vì các đợt test trước
 * không có tính chất này.
 */

import crypto from "crypto";
import { pool } from "../db/client";
import { encrypt } from "../services/encryption";
import { env } from "../config/env";

interface ThamSo {
  ten: string;
  nganh: string;
  medusa: string;
  credit: number;
  bacDuLieu: number;
  id?: string;
  khoa?: string;
}

const NGANH_HOP_LE = ["thuc_pham", "wellness", "my_pham", "thoi_trang", "dien_tu", "khac"];

const DANG_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function docThamSo(argv: string[]): ThamSo {
  const lay = (ten: string): string | undefined => {
    const i = argv.indexOf(`--${ten}`);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };

  const ten = lay("ten");
  const nganh = lay("nganh") ?? "khac";
  const medusa = lay("medusa");
  const id = lay("id");
  const khoa = lay("khoa");

  if (!ten) throw new Error("Thiếu --ten. Ví dụ: --ten \"CellphoneS\"");
  if (!medusa) throw new Error("Thiếu --medusa. Ví dụ: --medusa http://backend-cellphones:9000");
  if (!NGANH_HOP_LE.includes(nganh)) {
    throw new Error(`--nganh phải là một trong: ${NGANH_HOP_LE.join(", ")}`);
  }
  if (id && !DANG_UUID.test(id)) {
    throw new Error(`--id phải là UUID. Nhận được: "${id}"`);
  }
  if (khoa && !khoa.startsWith("pk_")) {
    throw new Error("--khoa phải bắt đầu bằng pk_ (khoá công khai của widget).");
  }

  return {
    ten,
    nganh,
    medusa,
    credit: Number(lay("credit") ?? 100000),
    bacDuLieu: Number(lay("bac-du-lieu") ?? 2),
    id,
    khoa,
  };
}

async function main() {
  const ts = docThamSo(process.argv.slice(2));

  // Khoá công khai của widget. Tiền tố pk_ để phân biệt với token phiên.
  //
  // `--khoa` dùng khi storefront ĐÃ nướng cứng một khoá sẵn: biến
  // `NEXT_PUBLIC_CHATBOT_WIDGET_KEY` được Next.js chèn vào mã lúc `next build`,
  // nên cấp khoá mới là phải dựng lại cả storefront. Truyền khoá cũ vào đây thì
  // chỉ cần chạy script, bản dựng đang chạy dùng được ngay.
  const khoaCongKhai = ts.khoa ?? "pk_live_" + crypto.randomBytes(16).toString("hex");
  const khoaBam = crypto.createHash("sha256").update(khoaCongKhai).digest("hex");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // --- tenant ---
    const cu = await client.query(`SELECT id FROM tenant WHERE ten = $1 LIMIT 1`, [ts.ten]);
    let tenantId: string;

    if (cu.rows.length > 0) {
      tenantId = cu.rows[0].id;
      if (ts.id && ts.id.toLowerCase() !== String(tenantId).toLowerCase()) {
        throw new Error(
          `Shop "${ts.ten}" đã có id ${tenantId}, không đổi được sang --id ${ts.id}. ` +
            `Đổi id tenant là đổi khoá ngoại của 17 bảng — làm bằng migration, không bằng script này.`
        );
      }
      await client.query(`UPDATE tenant SET nganh = $2, bac_du_lieu = $3 WHERE id = $1`, [
        tenantId, ts.nganh, ts.bacDuLieu,
      ]);
      console.log(`↻ Shop "${ts.ten}" đã có, cập nhật lại: ${tenantId}`);
    } else {
      // `--id` dùng khi Medusa đã chạy sẵn với một tenant_id cố định: giá trị đó
      // vừa là `CONFIG_TENANT_ID` vừa là bộ lọc `tenant_id` của Meilisearch, cả
      // hai đều nướng cứng vào bản dựng storefront. Để script tự sinh uuid mới là
      // chatbot và storefront nói về hai tenant khác nhau mà không báo lỗi gì.
      const moi = ts.id
        ? await client.query(
            `INSERT INTO tenant (id, ten, nganh, bac_du_lieu) VALUES ($1, $2, $3, $4) RETURNING id`,
            [ts.id, ts.ten, ts.nganh, ts.bacDuLieu]
          )
        : await client.query(
            `INSERT INTO tenant (ten, nganh, bac_du_lieu) VALUES ($1, $2, $3) RETURNING id`,
            [ts.ten, ts.nganh, ts.bacDuLieu]
          );
      tenantId = moi.rows[0].id;
      console.log(`✔ Tạo shop "${ts.ten}": ${tenantId}`);
    }

    // --- khoá widget ---
    //
    // `ON CONFLICT DO NOTHING` theo `khoa_bam`: chạy lại script với cùng `--khoa`
    // là việc bình thường (idempotent theo tên shop), không được vỡ vì trùng khoá.
    await client.query(
      `INSERT INTO tenant_key (tenant_id, khoa_bam, origin_allowlist) VALUES ($1, $2, ARRAY['*'])
       ON CONFLICT (khoa_bam) DO NOTHING`,
      [tenantId, khoaBam]
    );

    // --- widget_key công khai → app_settings (storefront đọc qua /v1/public/config) ---
    await client.query(
      `INSERT INTO app_settings (tenant_id, key, value, is_secret, updated_by) VALUES ($1, 'widget_key', $2, false, 'taoShop')
       ON CONFLICT ((COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid)), key)
       DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by`,
      [tenantId, khoaCongKhai]
    );

    // --- credit ---
    await client.query(
      `INSERT INTO credit_balance (tenant_id, so_du, da_tang) VALUES ($1, $2, $2)
       ON CONFLICT (tenant_id) DO UPDATE SET so_du = credit_balance.so_du + EXCLUDED.so_du,
                                            da_tang = credit_balance.da_tang + EXCLUDED.da_tang`,
      [tenantId, ts.credit]
    );

    // --- tenant_setting: địa chỉ Medusa RIÊNG của shop này ---
    //
    // Đây là nguồn sự thật cho AI Operator biết gọi Medusa nào. Cách ly tenant
    // ở tầng thương mại là TÁCH INSTANCE, không phải một cột tenant_id — bảng
    // `order` của Medusa v2 không hề có cột đó.
    await client.query(
      `INSERT INTO tenant_setting (tenant_id, medusa_base_url) VALUES ($1, $2)
       ON CONFLICT (tenant_id) DO UPDATE SET medusa_base_url = EXCLUDED.medusa_base_url`,
      [tenantId, ts.medusa]
    );

    // --- tenant_platform: cấu hình Medusa, mã hoá AES-256-GCM ---
    const cauHinh = JSON.stringify({
      enabled: true,
      baseUrl: ts.medusa,
      apiToken: env.AI_SECRET_KEY,
      defaultCarrier: "ghn",
    });
    await client.query(
      `INSERT INTO tenant_platform (tenant_id, loai, cau_hinh_ma_hoa, trang_thai)
       VALUES ($1, 'medusa', $2, 'hoat_dong')
       ON CONFLICT (tenant_id, loai) DO UPDATE
         SET cau_hinh_ma_hoa = EXCLUDED.cau_hinh_ma_hoa, trang_thai = 'hoat_dong'`,
      [tenantId, encrypt(cauHinh)]
    );

    await client.query("COMMIT");

    console.log("");
    console.log("═".repeat(64));
    console.log(`  TENANT_ID   : ${tenantId}`);
    console.log(`  Ngành       : ${ts.nganh}  (tường lửa claim tự bật cho thuc_pham/wellness/my_pham)`);
    console.log(`  Medusa      : ${ts.medusa}`);
    console.log(`  Credit      : ${ts.credit.toLocaleString("vi-VN")}`);
    console.log(`  KHOÁ WIDGET : ${khoaCongKhai}`);
    console.log("═".repeat(64));
    console.log("  ⚠️  Khoá widget chỉ hiện MỘT LẦN. CSDL chỉ lưu sha256 của nó.");
    console.log("");
    console.log("  Bước tiếp theo:");
    console.log("   1. Đặt CONFIG_TENANT_ID=" + tenantId + " cho Medusa của shop");
    console.log("   2. Cấp bot Telegram riêng:");
    console.log(`      UPDATE tenant_setting SET telegram_bot_token='<token>',`);
    console.log(`             telegram_bot_username='<ten_bot>' WHERE tenant_id='${tenantId}';`);
    console.log("   3. npm run tg:webhook -- --tenant " + tenantId);
    console.log("");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }

  await pool.end();
}

main().catch((e) => {
  console.error("✖ Lỗi:", e?.message ?? e);
  process.exit(1);
});
