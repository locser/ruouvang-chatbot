import "../config/napEnvGoc";
import crypto from "crypto";
import { pool } from "../db/client";
import { hashPassword } from "../services/auth";

/**
 * TẠO TÀI KHOẢN QUẢN TRỊ ĐẦU TIÊN
 * ===========================================================================
 *
 *   node dist/scripts/taoAdmin.js --username admin --email admin@shop.vn [--password <mk>] [--tenant <uuid>]
 *
 * Không có `--tenant` ⇒ super_admin (xem được mọi shop, sửa cấu hình nền tảng).
 * Có `--tenant`     ⇒ tenant_admin của đúng shop đó.
 * Không truyền `--password` thì sinh ngẫu nhiên và in ra MỘT lần.
 *
 * Vì sao có script này: ở lần live đầu chưa có admin nào, mà mọi API quản trị cần đăng nhập —
 * trước đây phải tự INSERT vào admin_user kèm băm mật khẩu bằng tay.
 */

function co(ten: string): string | undefined {
  const i = process.argv.indexOf(`--${ten}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const username = co("username");
  const email = co("email");
  const tenant = co("tenant") ?? null;
  if (!username || !email) throw new Error("Thiếu --username hoặc --email");
  if (tenant && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenant)) {
    throw new Error("--tenant phải là UUID");
  }
  const matKhau = co("password") ?? crypto.randomBytes(12).toString("base64url");
  if (matKhau.length < 10) throw new Error("Mật khẩu tối thiểu 10 ký tự");

  const r = await pool.query(
    `INSERT INTO admin_user (tenant_id, username, password_hash, email) VALUES ($1, $2, $3, $4)
     ON CONFLICT (username) DO NOTHING RETURNING id`,
    [tenant, username, hashPassword(matKhau), email]
  );
  if (r.rowCount === 0) {
    console.log(`Tài khoản "${username}" đã tồn tại — không đổi gì.`);
    return;
  }
  console.log(`✔ Đã tạo ${tenant ? "tenant_admin" : "super_admin"} "${username}"`);
  if (!co("password")) console.log(`  Mật khẩu (chỉ hiện một lần): ${matKhau}`);
}

main()
  .catch((e) => {
    console.error(e.message || e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
