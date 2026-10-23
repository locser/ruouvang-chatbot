import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const laMoiTruongTest = typeof process.env.JEST_WORKER_ID !== "undefined";
const laProduction = process.env.NODE_ENV === "production";

/**
 * Bắt buộc có biến môi trường. KHÔNG có giá trị mặc định cho bí mật.
 *
 * Vì sao: bản trước đặt JWT_SECRET = "fallback_jwt_secret_dev" và
 * ENCRYPTION_KEY = "0123456789abcdef..." ngay trong mã nguồn. Ai đọc được repo
 * là ký được token super_admin và giải mã được credential Medusa của mọi tenant.
 *
 * Ở môi trường test, dùng giá trị cố định để bộ test chạy được — nhưng giá trị
 * đó KHÔNG BAO GIỜ tồn tại ngoài Jest.
 */
function batBuoc(ten: string, doDaiToiThieu = 32): string {
  const v = process.env[ten];
  if (v && v.length >= doDaiToiThieu) return v;

  if (laMoiTruongTest) return `test_${ten}_`.padEnd(doDaiToiThieu, "x");

  if (v && v.length < doDaiToiThieu) {
    throw new Error(
      `[CAU HINH] ${ten} quá ngắn (${v.length} ký tự, cần ≥ ${doDaiToiThieu}). ` +
      `Sinh giá trị mới bằng: openssl rand -base64 48`
    );
  }
  throw new Error(
    `[CAU HINH] Thiếu biến môi trường bắt buộc: ${ten}. ` +
    `Ứng dụng từ chối khởi động để tránh chạy bằng bí mật mặc định.`
  );
}

/** Biến không phải bí mật — cho phép mặc định ở dev, bắt buộc ở production. */
function batBuocOProduction(ten: string, macDinh: string): string {
  const v = process.env[ten];
  if (v) return v;
  if (laProduction) {
    throw new Error(`[CAU HINH] Thiếu ${ten} — bắt buộc khi NODE_ENV=production.`);
  }
  return macDinh;
}

export const env = {
  PORT: parseInt(process.env.SERVICE_PORT || "3000", 10),
  NODE_ENV: process.env.NODE_ENV || "development",

  // --- Bí mật: fail-fast, không mặc định ---
  // Token phiên chat của khách và token quản trị PHẢI ký bằng 2 secret khác nhau.
  // Dùng chung một secret chính là nguyên nhân gốc của lỗ hổng leo thang đặc quyền
  // (token khách vô danh dùng được làm token admin).
  SESSION_JWT_SECRET: batBuoc("CONFIG_JWT_SECRET_CHATBOT_SESSION"),
  ADMIN_JWT_SECRET: batBuoc("CONFIG_JWT_SECRET_CHATBOT_ADMIN"),
  ENCRYPTION_KEY: batBuoc("CONFIG_ENCRYPTION_KEY_CHATBOT"),

  DATABASE_URL: batBuocOProduction(
    "CONFIG_POSTGRES_URL_CHATBOT",
    "postgres://vph_admin:REPLACE_WITH_NEW_SECRET@localhost:54321/chatbot_saas_dev"
  ),

  /**
   * Chuỗi kết nối cho ĐƯỜNG ĐI CỦA KHÁCH HÀNG — vai trò `app_rls`
   * (NOSUPERUSER NOBYPASSRLS), tức 17 policy `tenant_iso` CÓ hiệu lực.
   *
   * Dùng bởi `runInTenantContext()`. Nếu một câu truy vấn trong luồng chat lỡ
   * quên `WHERE tenant_id`, PostgreSQL vẫn chặn — cách ly không còn phụ thuộc
   * hoàn toàn vào việc lập trình viên nhớ hay quên.
   *
   * Thiếu biến này thì lùi về DATABASE_URL để không gãy khi triển khai từng
   * phần, nhưng khi đó RLS trở lại vô hiệu (vph_admin là superuser). Log cảnh
   * báo ở db/client.ts sẽ nói rõ.
   */
  DATABASE_URL_APP: process.env.CONFIG_POSTGRES_URL_CHATBOT_APP || "",

  /**
   * Chuỗi kết nối cho TRUY VẤN XUYÊN TENANT — vai trò `app_central`
   * (BYPASSRLS): tra API key khi mở phiên, định tuyến webhook Telegram, đăng
   * nhập quản trị, liệt kê tenant.
   *
   * Quyền vượt rào nằm ở thuộc tính vai trò chứ không phải một cờ trong policy
   * — xem src/db/migrations/003_rls_hardening.sql phần "vì sao hai vai trò".
   */
  DATABASE_URL_CENTRAL: process.env.CONFIG_POSTGRES_URL_CHATBOT_CENTRAL || "",
  REDIS_URL: batBuocOProduction("CONFIG_REDIS_URL_CHATBOT", "redis://localhost:63791"),

  // DEEPSEEK_API_KEY, SMTP_*, TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET KHÔNG
  // còn đọc từ môi trường: chúng nằm ở bảng `app_settings` (phạm vi nền tảng),
  // lấy bằng `layCaiDat()` trong services/caiDat.ts. Sửa qua API
  // PUT /v1/admin/settings/:key hoặc `npm run settings`.

  // Bật/tắt việc gửi cảnh báo từ backend (ai_outbox) vào nhóm Telegram của shop. Mặc định bật.
  OUTBOX_DISPATCHER_ENABLED: !/^(0|false|off|no)$/i.test(process.env.CONFIG_OUTBOX_DISPATCHER_ENABLED || ""),

  // Khoá chia sẻ giữa chatbot và Medusa cho các endpoint /ai/*
  AI_SECRET_KEY: batBuocOProduction("CONFIG_INTERNAL_SERVICE_KEY", "dev_ai_secret_key"),

  // --- Meilisearch (kiến trúc mới) ---
  MEILI_HOST: batBuocOProduction("CONFIG_MEILI_HOST", "http://localhost:7700"),
  MEILI_MASTER_KEY: batBuocOProduction("CONFIG_MEILI_MASTER_KEY", "dev_meili_master_key"),
  // Tên index cố định — không phải thứ cần cấu hình theo môi trường.
  MEILI_INDEX: "products",

  // --- URL công khai (dùng cho link đặt lại mật khẩu) ---
  APP_BASE_URL: batBuocOProduction("CONFIG_API_CHATBOT_PUBLIC_URL", "http://localhost:3000"),

  MINIO_ENDPOINT: process.env.CONFIG_MINIO_HOST || "localhost",
  MINIO_PORT: parseInt(process.env.CONFIG_MINIO_PORT || "9000", 10),
  MINIO_ACCESS_KEY: process.env.CONFIG_MINIO_ACCESS_KEY || "minioadmin",
  MINIO_SECRET_KEY: process.env.CONFIG_MINIO_SECRET_KEY || "REPLACE_WITH_NEW_SECRET",


  /**
   * TƯƠNG THÍCH NGƯỢC: các file cũ còn dùng env.JWT_SECRET.
   * Trỏ về secret quản trị để không gãy khi biên dịch, nhưng KHÔNG dùng cho
   * token khách. Sẽ gỡ bỏ khi mọi chỗ đã chuyển sang 2 secret riêng.
   * @deprecated dùng SESSION_JWT_SECRET hoặc ADMIN_JWT_SECRET
   */
  get JWT_SECRET(): string {
    return this.ADMIN_JWT_SECRET;
  },
};
