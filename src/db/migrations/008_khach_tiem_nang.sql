-- ============================================================================
--  BẢNG `khach_tiem_nang` — khách để lại tên + số điện thoại để nhân viên gọi tư vấn
--  Ngày: 22/10/2026
--
--  Khách CHƯA mua vẫn do AI tư vấn. Khi khách tự nguyện để lại số để được gọi,
--  bot gọi tool save_lead → ghi một dòng ở đây và báo nhân viên qua Telegram.
--  Mỗi hội thoại chỉ có MỘT dòng (khách đổi số thì cập nhật), nên báo lại
--  nhân viên chỉ khi số điện thoại thật sự đổi.
--
--  Idempotent. KHÔNG có DROP / DELETE.
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS khach_tiem_nang (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  conversation_id  uuid NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  ten              text,
  so_dien_thoai    text NOT NULL,
  nhu_cau          text,
  trang_thai       text NOT NULL DEFAULT 'moi' CHECK (trang_thai IN ('moi', 'da_goi', 'bo_qua')),
  da_bao_nhan_vien boolean NOT NULL DEFAULT false,
  tao_luc          timestamptz NOT NULL DEFAULT now(),
  cap_nhat_luc     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id)
);
CREATE INDEX IF NOT EXISTS khach_tiem_nang_tenant_idx ON khach_tiem_nang (tenant_id, trang_thai, tao_luc DESC);

ALTER TABLE khach_tiem_nang ENABLE ROW LEVEL SECURITY;
ALTER TABLE khach_tiem_nang FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_iso ON khach_tiem_nang;
CREATE POLICY tenant_iso ON khach_tiem_nang
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rls') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON khach_tiem_nang TO app_rls;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_central') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON khach_tiem_nang TO app_central;
  END IF;
END $$;

COMMIT;
