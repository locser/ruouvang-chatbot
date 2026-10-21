-- ============================================================================
--  BẢNG CẤU HÌNH ỨNG DỤNG `app_settings`
--  Ngày: 21/10/2026
--
--  Chạy:  npm run migrate           (khuyên dùng — ghi vết vào schema_migrations)
--     hoặc: psql "$CONFIG_POSTGRES_URL_CHATBOT" -f 006_app_settings.sql
--
--  ═══ VÌ SAO ═══
--
--  Trước đây các khoá tích hợp (DeepSeek, SMTP, bot Telegram nền tảng, hotline,
--  Zalo, tài khoản ngân hàng…) nằm rải trong `.env` của ba dịch vụ. Đổi một khoá
--  là phải sửa file rồi khởi động lại; cùng một giá trị còn bị đặt hai tên khác
--  nhau (MEDUSA_BANK_* và NEXT_PUBLIC_NH_*).
--
--  Bảng này là nguồn sự thật duy nhất cho nhóm cấu hình đó. `.env` chỉ còn giữ
--  những gì cần có TRƯỚC khi nối được CSDL (chuỗi kết nối, bí mật lõi).
--
--  ═══ THIẾT KẾ ═══
--
--  · `tenant_id` NULL  = cấu hình toàn nền tảng (DeepSeek, SMTP, bot nền tảng).
--    `tenant_id` có giá trị = cấu hình riêng của một shop.
--  · `is_secret` = true  → `value` là bản mã AES-256-GCM (iv:tag:cipher), giải
--    mã bằng CONFIG_ENCRYPTION_KEY_CHATBOT. API quản trị chỉ trả bản che (••••1234).
--  · RLS: dòng có tenant chỉ thấy được trong đúng ngữ cảnh tenant đó. Dòng
--    nền tảng (tenant_id NULL) KHÔNG khớp policy nào, nên vai trò `app_rls`
--    không thấy — chỉ `app_central` (BYPASSRLS) đọc được. Đúng ý: khoá DeepSeek
--    không bao giờ nằm trong tầm với của luồng chat.
--  · Policy dùng NULLIF(...)::uuid theo đúng bài học ở 003_rls_hardening.sql.
--
--  Idempotent. KHÔNG có lệnh DROP TABLE / DELETE nào.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS app_settings (
  id          bigserial   PRIMARY KEY,
  tenant_id   uuid        REFERENCES tenant(id) ON DELETE CASCADE,
  key         text        NOT NULL,
  value       text        NOT NULL DEFAULT '',
  is_secret   boolean     NOT NULL DEFAULT false,
  updated_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_settings_key_format CHECK (key ~ '^[a-z][a-z0-9_]{1,63}$')
);

-- Một khoá chỉ có một giá trị cho mỗi phạm vi. UNIQUE thường coi NULL là khác
-- nhau nên không chặn được hai dòng nền tảng trùng khoá; dùng chỉ mục biểu thức
-- đổi NULL thành uuid rỗng để ép duy nhất cả với phạm vi nền tảng.
CREATE UNIQUE INDEX IF NOT EXISTS app_settings_scope_key_uq
  ON app_settings ((COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid)), key);

CREATE INDEX IF NOT EXISTS app_settings_tenant_idx ON app_settings (tenant_id);

COMMENT ON TABLE  app_settings IS
  'Cấu hình ứng dụng dạng khoá-giá trị. tenant_id NULL = toàn nền tảng. Giá trị bí mật mã hoá AES-256-GCM.';
COMMENT ON COLUMN app_settings.value IS
  'Giá trị thô, hoặc iv:tag:cipher (hex) khi is_secret = true.';

-- Tự cập nhật updated_at.
CREATE OR REPLACE FUNCTION app_settings_touch() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS app_settings_touch ON app_settings;
CREATE TRIGGER app_settings_touch
  BEFORE UPDATE ON app_settings
  FOR EACH ROW EXECUTE FUNCTION app_settings_touch();

-- RLS
ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_settings FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_iso ON app_settings;
CREATE POLICY tenant_iso ON app_settings
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Quyền cho hai vai trò ứng dụng (nếu 003 đã tạo). ALTER DEFAULT PRIVILEGES ở
-- 003 chỉ phủ bảng tạo bởi cùng chủ sở hữu, nên cấp tường minh cho chắc.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rls') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON app_settings TO app_rls;
    GRANT USAGE, SELECT ON SEQUENCE app_settings_id_seq TO app_rls;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_central') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON app_settings TO app_central;
    GRANT USAGE, SELECT ON SEQUENCE app_settings_id_seq TO app_central;
  END IF;
END $$;

COMMIT;

-- ============================================================================
-- KIỂM CHỨNG
-- ============================================================================
-- \d app_settings                                     → có bảng, chỉ mục, trigger, policy
-- SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname='app_settings';
--                                                     → t | t
-- SET ROLE app_rls; SELECT count(*) FROM app_settings; → 0 (không thấy dòng nền tảng)
-- ============================================================================
