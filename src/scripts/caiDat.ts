import "../config/napEnvGoc";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { LOAI_CHUOI, LoaiChuoi, sinhChuoi } from "../services/sinhChuoi";

/**
 * CÔNG CỤ DÒNG LỆNH CHO `app_settings`
 * ===========================================================================
 *
 *   npm run settings -- list   [--tenant <uuid>]
 *   npm run settings -- get    <khoa> [--tenant <uuid>]            in giá trị THẬT (kể cả bí mật)
 *   npm run settings -- set    <khoa> <gia_tri> [--tenant <uuid>]
 *   npm run settings -- unset  <khoa> [--tenant <uuid>]
 *   npm run settings -- gen    <loai> [--bytes N] [--prefix sk] [--save-as <khoa>] [--tenant <uuid>]
 *   npm run settings -- import-env [--file ../.env] [--tenant <uuid>] [--dry-run]
 *   npm run settings -- schema
 *
 * Từ máy host (DB trong Docker):  CONFIG_LOCAL_MODE=1 npm run settings -- list
 *
 * `gen` chỉ SINH chuỗi (không cần DB) trừ khi có --save-as. Loại: ${"hex, base64, base64url, uuid, password, jwt_secret, encryption_key, api_key, widget_key"}.
 * `import-env` đọc các khoá cũ trong file .env và ghi vào DB — chạy MỘT LẦN khi
 * chuyển cấu hình; sau đó xoá các dòng đó khỏi .env (code không còn đọc chúng).
 */

const args = process.argv.slice(2);
const lenh = args[0];
const dich = args.filter((a, i) => i > 0 && !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--") && args[i - 1] !== "--dry-run"));
const co = (ten: string) => {
  const i = args.indexOf(`--${ten}`);
  return i >= 0 ? args[i + 1] : undefined;
};

/** env cũ → khoá app_settings */
const ANH_XA_ENV: Record<string, string> = {
  DEEPSEEK_API_KEY: "deepseek_api_key",
  SMTP_HOST: "smtp_host",
  SMTP_PORT: "smtp_port",
  SMTP_USER: "smtp_user",
  SMTP_PASS: "smtp_pass",
  SMTP_FROM: "smtp_from",
  TELEGRAM_BOT_TOKEN: "telegram_bot_token",
  TELEGRAM_WEBHOOK_SECRET: "telegram_webhook_secret",
  NEXT_PUBLIC_CHATBOT_WIDGET_KEY: "widget_key",
  // Hotline/Zalo/ngân hàng/vận chuyển và SMTP gửi KHÁCH thuộc bảng app_settings của Medusa
  // (script nap-cai-dat-tu-env bên Medusa). SMTP ở đây chỉ là thư đặt lại mật khẩu admin chatbot.
};

const GIA_TRI_GIA = /^(REPLACE_WITH|mock_|chua-dung-den|changeme|xxx)/i;

async function nhapTuEnv(): Promise<void> {
  const { datCaiDat, khaiBaoCuaKhoa } = await import("../services/caiDat");
  const file = path.resolve(co("file") ?? path.resolve(__dirname, "../../../.env"));
  if (!fs.existsSync(file)) throw new Error(`Không thấy file ${file}`);
  const e = dotenv.parse(fs.readFileSync(file));
  const tenant = co("tenant") ?? e.CONFIG_TENANT_ID;
  const thu = args.includes("--dry-run");

  const daDat = new Set<string>();
  for (const [ten, key] of Object.entries(ANH_XA_ENV)) {
    const v = (e[ten] ?? "").trim();
    if (!v || GIA_TRI_GIA.test(v)) continue;
    if (daDat.has(key)) continue;
    const kb = khaiBaoCuaKhoa(key)!;
    if (kb.phamVi === "shop" && !tenant) {
      console.log(`  bỏ qua ${ten}: cần --tenant hoặc CONFIG_TENANT_ID trong file`);
      continue;
    }
    try {
      if (!thu) await datCaiDat(key, v, { tenantId: tenant, nguoiSua: "import-env" });
      console.log(`  ${thu ? "[thử] " : ""}${ten} → ${key}${kb.phamVi === "shop" ? ` (tenant ${tenant})` : " (nền tảng)"}${kb.biMat ? "  [mã hoá]" : ""}`);
      daDat.add(key);
    } catch (err) {
      console.log(`  LỖI ${ten} → ${key}: ${(err as Error).message}`);
    }
  }
  console.log(daDat.size ? `Xong ${daDat.size} khoá.` : "Không có khoá nào để nhập.");
  if (daDat.size && !thu) {
    console.log("Giờ có thể xoá các dòng đó khỏi .env — code không còn đọc chúng.");
  }
}

async function main() {
  // Nạp muộn: chỉ `gen` thuần không được đụng tới DB / config/env.
  const dungDb = !(lenh === "gen" && !co("save-as")) && lenh !== undefined;
  const cd = dungDb ? await import("../services/caiDat") : undefined!;
  const { DANH_SACH_CAI_DAT, datCaiDat, khaiBaoCuaKhoa, layCaiDat, lietKeCaiDat, xoaCaiDat } = cd ?? ({} as any);
  const pool = dungDb ? (await import("../db/client")).pool : undefined!;
  poolDeDong = pool;
  switch (lenh) {
    case "gen": {
      const loai = (dich[0] ?? "hex") as LoaiChuoi;
      if (!LOAI_CHUOI.includes(loai)) throw new Error(`Loại phải thuộc: ${LOAI_CHUOI.join(", ")}`);
      const bytes = co("bytes") ? Number(co("bytes")) : undefined;
      const value = sinhChuoi(loai, { soByte: bytes, tienTo: co("prefix") });
      const luu = co("save-as");
      if (luu) {
        const kb = khaiBaoCuaKhoa(luu);
        if (!kb) throw new Error(`Khoá không hợp lệ: ${luu}`);
        if (luu === "widget_key") {
          const crypto = await import("crypto");
          await pool.query(
            `INSERT INTO tenant_key (tenant_id, khoa_bam, origin_allowlist) VALUES ($1, $2, ARRAY['*']) ON CONFLICT (khoa_bam) DO NOTHING`,
            [co("tenant"), crypto.createHash("sha256").update(value).digest("hex")]
          );
        }
        await datCaiDat(luu, value, { tenantId: co("tenant"), nguoiSua: "cli" });
        console.error(`(đã lưu vào ${luu})`);
      }
      console.log(value);
      return;
    }
    case "schema":
      for (const d of DANH_SACH_CAI_DAT) {
        console.log(`${d.key.padEnd(26)} ${d.phamVi.padEnd(9)} ${d.biMat ? "bí mật " : d.congKhai ? "công khai" : "        "}  ${d.moTa}`);
      }
      return;
    case "list": {
      const t = co("tenant");
      for (const m of await lietKeCaiDat("nen_tang")) console.log(`[nền tảng] ${m.key.padEnd(26)} ${m.nguon.padEnd(8)} ${m.gia_tri}`);
      if (t) for (const m of await lietKeCaiDat("shop", t)) console.log(`[shop    ] ${m.key.padEnd(26)} ${m.nguon.padEnd(8)} ${m.gia_tri}`);
      else console.log("(thêm --tenant <uuid> để xem cấu hình của shop)");
      return;
    }
    case "get": {
      if (!dich[0]) throw new Error("Thiếu <khoa>");
      process.stdout.write((await layCaiDat(dich[0], co("tenant"))) + "\n");
      return;
    }
    case "set": {
      if (!dich[0] || dich[1] === undefined) throw new Error("Dùng: set <khoa> <gia_tri>");
      const ok = await datCaiDat(dich[0], dich[1], { tenantId: co("tenant"), nguoiSua: "cli" });
      console.log(ok ? `Đã đặt ${dich[0]}` : `Đã xoá ${dich[0]}`);
      return;
    }
    case "unset": {
      if (!dich[0]) throw new Error("Thiếu <khoa>");
      console.log((await xoaCaiDat(dich[0], co("tenant"))) ? `Đã xoá ${dich[0]}` : `${dich[0]} chưa được đặt`);
      return;
    }
    case "import-env":
      return nhapTuEnv();
    default:
      console.log(fs.readFileSync(__filename.replace(/\.js$/, ".ts"), "utf8").split("*/")[0].replace(/^[\s\S]*?\/\*\*/, ""));
  }
}

let poolDeDong: { end(): Promise<void> } | undefined;
main()
  .catch((e) => {
    console.error(e.message || e);
    process.exitCode = 1;
  })
  .finally(() => poolDeDong?.end());
