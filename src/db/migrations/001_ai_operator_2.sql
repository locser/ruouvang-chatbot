-- ============================================================================
--  AI OPERATOR 2.0 — MIGRATION CHO CSDL ChatBotAISAAS (KHÔNG PHẢI DB Medusa)
--  Ngày: 28/07/2026
--
--  Chạy:  psql "$SAAS_DATABASE_URL" -f 001_ai_operator_2.sql
--
--  Toàn bộ script này AN TOÀN khi chạy lại nhiều lần (idempotent).
--  KHÔNG có lệnh DROP nào — không xoá dữ liệu đang có.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. tenant_setting: Bot Telegram riêng cho từng shop (Dedicated Bot per Tenant)
-- ---------------------------------------------------------------------------
ALTER TABLE tenant_setting
  ADD COLUMN IF NOT EXISTS telegram_bot_token       text,
  ADD COLUMN IF NOT EXISTS telegram_bot_username    text,
  ADD COLUMN IF NOT EXISTS telegram_webhook_secret  text,
  -- URL Medusa của shop này. Không phải bí mật (chỉ là địa chỉ), nên để plaintext
  -- thay vì nhét vào cấu hình mã hoá — AI Operator cần đọc nhanh khi liệt kê đơn.
  ADD COLUMN IF NOT EXISTS medusa_base_url          text;

COMMENT ON COLUMN tenant_setting.telegram_bot_token IS
  'Token bot Telegram riêng của shop. LƯU Ý: đây là bí mật — cân nhắc mã hoá ở bản sau.';
COMMENT ON COLUMN tenant_setting.medusa_base_url IS
  'Địa chỉ Medusa của shop, ví dụ http://medusa-shopA:9000. Mỗi tenant một Medusa riêng.';

-- ---------------------------------------------------------------------------
-- 2. admin_user_tenant: một nick Telegram quản lý NHIỀU shop (1-N)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_user_tenant (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id uuid NOT NULL REFERENCES admin_user(id) ON DELETE CASCADE,
  tenant_id     uuid NOT NULL REFERENCES tenant(id)     ON DELETE CASCADE,
  vai_tro       text NOT NULL DEFAULT 'operator'
                CHECK (vai_tro IN ('owner', 'operator', 'viewer')),
  tao_luc       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (admin_user_id, tenant_id)
);

CREATE INDEX IF NOT EXISTS idx_aut_admin ON admin_user_tenant (admin_user_id);
CREATE INDEX IF NOT EXISTS idx_aut_tenant ON admin_user_tenant (tenant_id);

COMMENT ON TABLE admin_user_tenant IS
  'Phân quyền 1 tài khoản quản trị ↔ N shop. Nguồn sự thật cho Shop Switcher trong Mini App.';

-- ---------------------------------------------------------------------------
-- 3. tenant_revenue_daily: sổ doanh thu theo ngày
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenant_revenue_daily (
  tenant_id         uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  ngay              date NOT NULL DEFAULT CURRENT_DATE,
  tong_doanh_thu    bigint NOT NULL DEFAULT 0,
  so_don_hoan_thanh integer NOT NULL DEFAULT 0,
  cap_nhat_luc      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, ngay)
);

COMMENT ON TABLE tenant_revenue_daily IS
  'Doanh thu cộng dồn theo ngày, ghi khi operator bấm Duyệt Giao & Hoàn Thành.';

-- ---------------------------------------------------------------------------
-- 4. operator_action_log: chống duyệt trùng (idempotency)
--
--    Quan trọng: nút "1-Tap" rất dễ bị bấm hai lần (mạng chậm, tay run, hoặc
--    Telegram gửi lại request). Nếu không chặn, doanh thu bị cộng hai lần.
--    UNIQUE trên idempotency_key làm trọng tài — không cần khoá phân tán.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS operator_action_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL UNIQUE,
  tenant_id       uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  admin_user_id   uuid REFERENCES admin_user(id) ON DELETE SET NULL,
  hanh_dong       text NOT NULL,
  order_id        text,
  tham_so         jsonb NOT NULL DEFAULT '{}',
  trang_thai      text NOT NULL DEFAULT 'DANG_CHAY'
                  CHECK (trang_thai IN ('DANG_CHAY', 'XONG', 'LOI')),
  ket_qua         jsonb,
  loi             text,
  tao_luc         timestamptz NOT NULL DEFAULT now(),
  xong_luc        timestamptz
);

CREATE INDEX IF NOT EXISTS idx_oal_tenant_time
  ON operator_action_log (tenant_id, tao_luc DESC);

-- ---------------------------------------------------------------------------
-- 5. RLS cho các bảng mới
--
--    ⚠️ LƯU Ý: ứng dụng hiện vẫn kết nối PostgreSQL bằng tài khoản superuser,
--    nên MỌI policy RLS (kể cả các policy đã có sẵn) đang bị bỏ qua hoàn toàn.
--    Các policy dưới đây được khai báo sẵn để khi đội chuyển sang role
--    NOSUPERUSER NOBYPASSRLS thì bảng mới đã sẵn sàng, không phải sửa lại.
--    Xem TechUpdate/08_BAO_MAT_DA_TENANT.md §2 (có bẫy ''::uuid).
-- ---------------------------------------------------------------------------
ALTER TABLE admin_user_tenant    ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_revenue_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE operator_action_log  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_iso ON admin_user_tenant;
CREATE POLICY tenant_iso ON admin_user_tenant USING (
  current_setting('app.tenant_id', true) <> ''
  AND tenant_id = current_setting('app.tenant_id', true)::uuid
);

DROP POLICY IF EXISTS tenant_iso ON tenant_revenue_daily;
CREATE POLICY tenant_iso ON tenant_revenue_daily USING (
  current_setting('app.tenant_id', true) <> ''
  AND tenant_id = current_setting('app.tenant_id', true)::uuid
);

DROP POLICY IF EXISTS tenant_iso ON operator_action_log;
CREATE POLICY tenant_iso ON operator_action_log USING (
  current_setting('app.tenant_id', true) <> ''
  AND tenant_id = current_setting('app.tenant_id', true)::uuid
);

COMMIT;

-- ============================================================================
-- KIỂM CHỨNG SAU KHI CHẠY
-- ============================================================================
-- SELECT column_name FROM information_schema.columns
--  WHERE table_name = 'tenant_setting' AND column_name LIKE 'telegram%';
--   → phải có 3 dòng
--
-- SELECT to_regclass('admin_user_tenant'), to_regclass('tenant_revenue_daily'),
--        to_regclass('operator_action_log');
--   → cả 3 khác NULL
--
-- Gán quyền cho chủ shop (thay UUID thật):
--   INSERT INTO admin_user_tenant (admin_user_id, tenant_id, vai_tro)
--   VALUES ('<admin_user_id>', '<tenant_id>', 'owner')
--   ON CONFLICT DO NOTHING;
-- ============================================================================
