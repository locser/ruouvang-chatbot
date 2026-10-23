import "../config/napEnvGoc";
import fs from "fs";
import path from "path";
import { Pool } from "pg";
import { hashPasswordAsync } from "../services/auth";

/**
 * TRÌNH CHẠY MIGRATION
 * ===========================================================================
 *
 *   npm run migrate              # áp mọi migration chưa chạy, theo thứ tự tên file
 *   npm run migrate -- --status  # chỉ liệt kê đã chạy / chưa chạy
 *   npm run migrate -- --baseline 005   # đánh dấu 001..005 là đã chạy (không chạy lại)
 *
 * Chạy từ máy host (DB trong Docker): CONFIG_LOCAL_MODE=1 npm run migrate
 *
 * Trước file này các migration 001–005 được chạy tay bằng psql, không có sổ ghi
 * vết. Lần đầu chạy trên CSDL đã có bảng `tenant` mà sổ còn trống, trình chạy tự
 * baseline 001–005 (đã áp thủ công) rồi mới áp phần còn lại. CSDL trống hoàn
 * toàn thì runner nạp `schema.sql` — snapshot này đã gồm sẵn mọi bảng đến 006.
 *
 * DB TRẮNG (chưa có bảng `tenant`): trình chạy tự nạp `schema.sql` (khung cơ sở, chỉ CREATE, không
 * DROP) rồi áp tuần tự 001..N đúng như README mục 4. Không có bước này, container chatbot ở lần live
 * đầu chết ngay với "relation tenant_setting does not exist". Tắt bằng `--khong-nap-schema`.
 *
 * Kết nối bằng CONFIG_POSTGRES_URL_CHATBOT (vai trò chủ sở hữu bảng): migration cần quyền DDL,
 * mà `app_rls`/`app_central` cố ý không có.
 */

const BASELINE_MAC_DINH = "005";
const PHIEN_BAN_SCHEMA = "011";
// Khóa theo phiên PostgreSQL, ngăn hai replica cùng áp một migration khi deploy.
// Hai số cố định là namespace riêng của trình migration chatbot C.W. Wines.
const KHOA_MIGRATION: [number, number] = [1129797481, 20261022];

function thuMucMigration(): string {
  for (const p of [
    path.join(__dirname, "migrations"),
    path.join(__dirname, "../../src/db/migrations"),
  ]) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error("Không tìm thấy thư mục migrations");
}

function duongDanSchema(): string | null {
  for (const p of [
    path.join(__dirname, "schema.sql"),
    path.join(__dirname, "../../src/db/schema.sql"),
  ]) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function docCo(ten: string): string | undefined {
  const i = process.argv.indexOf(`--${ten}`);
  if (i < 0) return undefined;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : "";
}

function phienBan(tenFile: string): string {
  return tenFile.split("_")[0];
}

async function taoAdminDemo(client: import("pg").PoolClient): Promise<void> {
  // Tài khoản cố định cho bản live demo. Chỉ tạo trên DB trắng, không cập nhật
  // mật khẩu của tài khoản đã tồn tại ở các lần build/restart sau.
  const username = "admin";
  const email = "admin@cwwine.demo";
  const password = "CWWineDemo@2026";

  const daCo = await client.query(
    "SELECT username, email FROM admin_user WHERE username = $1 OR lower(email) = $2 LIMIT 1",
    [username, email]
  );
  if (daCo.rowCount) {
    const admin = daCo.rows[0];
    if (admin.username !== username || String(admin.email).toLowerCase() !== email) {
      throw new Error(`Username/email bootstrap chatbot bị trùng với tài khoản khác (${admin.username}).`);
    }
    console.log(`[migrate] Admin chatbot "${username}" đã tồn tại — giữ nguyên mật khẩu.`);
    return;
  }

  const passwordHash = await hashPasswordAsync(password);
  await client.query(
    "INSERT INTO admin_user (tenant_id, username, password_hash, email) VALUES (NULL, $1, $2, $3)",
    [username, passwordHash, email]
  );
  console.log(`[migrate] Đã tạo super_admin chatbot "${username}".`);
}

export async function chayMigration(): Promise<void> {
  const url = process.env.CONFIG_POSTGRES_URL_CHATBOT;
  if (!url) throw new Error("Thiếu CONFIG_POSTGRES_URL_CHATBOT (vai trò chủ sở hữu bảng).");

  const pool = new Pool({ connectionString: url, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1, $2)", KHOA_MIGRATION);

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version     text PRIMARY KEY,
        filename    text NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )`);

    // DB trắng → nạp khung cơ sở trước, rồi mới chạy migration.
    const coBangTruoc = (await client.query("SELECT to_regclass('public.tenant') AS t")).rows[0].t;
    let vuaNapSchema = false;
    if (!coBangTruoc && !process.argv.includes("--khong-nap-schema")) {
      const sp = duongDanSchema();
      if (!sp) throw new Error("DB trắng nhưng không tìm thấy schema.sql để nạp (image thiếu src/db/schema.sql?)");
      console.log("[migrate] DB trắng — nạp schema.sql (khung cơ sở) ...");
      try {
        await client.query(fs.readFileSync(sp, "utf8"));
        vuaNapSchema = true;
      } catch (e) {
        throw new Error(`Nạp schema.sql lỗi: ${(e as Error).message}`);
      }
    }

    const files = fs
      .readdirSync(thuMucMigration())
      .filter((f) => /^\d+_.+\.sql$/.test(f))
      .sort();

    const daChay = new Set<string>(
      (await client.query("SELECT version FROM schema_migrations")).rows.map((r) => r.version)
    );

    // Baseline: CSDL cũ đã áp 001–005 bằng tay.
    const baseline = docCo("baseline");
    // DB vừa nạp schema.sql đã có đầy đủ thay đổi đến PHIEN_BAN_SCHEMA. Đánh dấu
    // các migration tương ứng thay vì chạy lại DDL cũ (một số file tạo role và
    // cần CREATEROLE, quyền mà database hosted thường không cấp cho app user).
    const mocBaseline =
      baseline !== undefined
        ? (baseline || BASELINE_MAC_DINH)
        : vuaNapSchema
          ? PHIEN_BAN_SCHEMA
          : daChay.size === 0 && coBangTruoc
            ? BASELINE_MAC_DINH
            : null;
    if (mocBaseline) {
      for (const f of files) {
        if (phienBan(f) <= mocBaseline && !daChay.has(phienBan(f))) {
          await client.query(
            "INSERT INTO schema_migrations (version, filename) VALUES ($1,$2) ON CONFLICT DO NOTHING",
            [phienBan(f), f]
          );
          daChay.add(phienBan(f));
          console.log(`[baseline] ${f} — coi như đã áp thủ công`);
        }
      }
    }

    if (process.argv.includes("--status")) {
      for (const f of files) console.log(`${daChay.has(phienBan(f)) ? "✔ đã chạy " : "· chưa chạy"}  ${f}`);
      return;
    }

    let soDaAp = 0;
    for (const f of files) {
      if (daChay.has(phienBan(f))) continue;
      const sql = fs.readFileSync(path.join(thuMucMigration(), f), "utf8");
      console.log(`[migrate] áp ${f} ...`);
      try {
        await client.query(sql);
      } catch (e) {
        // File tự có BEGIN/COMMIT; lỗi giữa chừng để lại transaction hỏng → dọn.
        await client.query("ROLLBACK").catch(() => undefined);
        throw new Error(`Migration ${f} lỗi: ${(e as Error).message}`);
      }
      await client.query("INSERT INTO schema_migrations (version, filename) VALUES ($1,$2)", [phienBan(f), f]);
      soDaAp++;
    }
    await taoAdminDemo(client);
    console.log(soDaAp ? `[migrate] xong, đã áp ${soDaAp} migration.` : "[migrate] CSDL đã ở phiên bản mới nhất.");
  } finally {
    await client.query("SELECT pg_advisory_unlock($1, $2)", KHOA_MIGRATION).catch(() => undefined);
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  chayMigration().catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
}
