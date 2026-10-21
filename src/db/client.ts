import { Pool, PoolClient } from "pg";
import { env } from "../config/env";

/**
 * HAI POOL, HAI VAI TRÒ CSDL — xem src/db/migrations/003_rls_hardening.sql
 *
 *   poolTenant  → app_rls     (NOBYPASSRLS) → 17 policy tenant_iso CÓ hiệu lực
 *   pool        → app_central (BYPASSRLS)   → truy vấn xuyên tenant
 *
 * Vì sao tách: trước đây tất cả chạy bằng `vph_admin`, vốn là SUPERUSER +
 * BYPASSRLS, nên toàn bộ RLS chỉ là trang trí và cách ly tenant phụ thuộc
 * 100% vào việc mọi câu WHERE đều được viết đúng. Nay đường đi của khách hàng
 * (runInTenantContext) chạy bằng vai trò bị RLS chặn thật: quên WHERE là
 * PostgreSQL trả về 0 dòng, không phải dữ liệu của shop khác.
 *
 * Vì sao đường quản trị vẫn dùng vai trò vượt rào: 26 chỗ trong index.ts gọi
 * thẳng `pool.query` cho các việc bản chất là xuyên tenant (đăng nhập admin,
 * liệt kê tenant, tra API key khi mở phiên, định tuyến webhook). Chúng được
 * canh bởi `requireAdminAuth` + `assertTenantScope` ở tầng ứng dụng. Ép cả
 * nhóm đó vào RLS cần audit từng chỗ một và sẽ làm hỏng đăng nhập nếu sót —
 * đó là việc riêng, không gộp vào đợt này.
 */

/** Có bật RLS thật hay không — quyết định bởi việc có cấu hình vai trò riêng. */
export const RLS_DANG_BAT = Boolean(env.DATABASE_URL_APP);

if (!RLS_DANG_BAT) {
  console.warn(
    "[CSDL] CONFIG_POSTGRES_URL_CHATBOT_APP chưa đặt — luồng chat vẫn chạy bằng vai trò cũ và " +
    "RLS KHÔNG có hiệu lực. Cách ly tenant lúc này chỉ dựa vào tầng ứng dụng."
  );
}

/** Pool xuyên tenant (app_central). Mọi `pool.query` sẵn có giữ nguyên hành vi. */
export const pool = new Pool({
  connectionString: env.DATABASE_URL_CENTRAL || env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

/** Pool cho đường đi của khách hàng (app_rls) — policy có hiệu lực. */
export const poolTenant = new Pool({
  connectionString: env.DATABASE_URL_APP || env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

/**
 * Executes DB queries inside a transaction scope context-bound to a specific tenant.
 * Sets PostgreSQL transaction config 'app.tenant_id' locally, which triggers Row Level Security.
 */
export async function runInTenantContext<T>(
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  if (!tenantId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantId)) {
    throw new Error(`CRITICAL: Invalid or missing tenant_id: '${tenantId}'`);
  }

  // Pool có RLS. `app.tenant_id` đặt ở phạm vi transaction (tham số true) nên
  // tự xoá khi COMMIT/ROLLBACK — kết nối trả về pool không mang theo ngữ cảnh
  // của khách trước.
  const client = await poolTenant.connect();
  try {
    await client.query("BEGIN");

    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    
    const result = await fn(client);
    
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Central admin queries (running outside specific tenant isolation scope)
 * e.g., to load tenant keys during bootstrap, routing, or centralized global logging.
 */
export async function runCentralAdmin<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    
    // Ngữ cảnh tenant để RỖNG một cách tường minh.
    //
    // Với vai trò `app_central` (BYPASSRLS) thì dòng này không đổi kết quả —
    // nhưng vẫn giữ, vì hai lý do: nó ghi rõ ý định "truy vấn này cố ý xuyên
    // tenant", và nếu ai đó lỡ trỏ pool này về vai trò có RLS thì policy dùng
    // NULLIF sẽ trả 0 dòng thay vì ném lỗi hay lộ dữ liệu.
    await client.query("SELECT set_config('app.tenant_id', '', true)");
    
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
