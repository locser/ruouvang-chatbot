-- ============================================================================
--  VÁ RLS — CHẠY TRÊN CSDL SaaS (chatbot_saas)
--  Ngày: 28/07/2026
--
--  Chạy:  psql "$DATABASE_URL_ADMIN" -f 003_rls_hardening.sql
--         (phải chạy bằng vai trò sở hữu bảng, ví dụ vph_admin)
--
--  ═══ VÌ SAO CẦN FILE NÀY ═══
--
--  Trước file này, 14 policy `tenant_iso` trong schema.sql chỉ là trang trí:
--  ứng dụng kết nối bằng `vph_admin` vốn là SUPERUSER + BYPASSRLS, nên
--  PostgreSQL bỏ qua toàn bộ policy. Cách ly tenant hoàn toàn dựa vào tầng ứng
--  dụng — một câu WHERE viết sót là rò dữ liệu giữa các shop.
--
--  ═══ CÁI BẪY PHẢI SỬA TRƯỚC KHI ĐỔI VAI TRÒ ═══
--
--  Mọi policy cũ viết:
--      tenant_id = current_setting('app.tenant_id', true)::uuid
--
--  `runCentralAdmin()` đặt biến đó thành CHUỖI RỖNG. Trong PostgreSQL,
--  ''::uuid KHÔNG trả về NULL mà NÉM LỖI:
--      ERROR: invalid input syntax for type uuid: ""
--  Nghĩa là ngày đổi sang vai trò không vượt rào, MỌI truy vấn xuyên tenant
--  (đăng nhập admin, định tuyến webhook, tra API key) sẽ hỏng đồng loạt.
--  Vì vậy phải vá policy TRƯỚC, đổi vai trò SAU — không làm ngược lại.
--
--  Cách vá: NULLIF(current_setting('app.tenant_id', true), '')::uuid
--
--  ⚠️ KHÔNG dùng `current_setting(...) <> '' AND tenant_id = ...::uuid`.
--  Cách đó TRÔNG an toàn nhưng KHÔNG chạy: PostgreSQL không bảo đảm thứ tự
--  đánh giá hai vế của AND, bộ tối ưu vẫn được phép ép kiểu ''::uuid trước khi
--  xét guard và vẫn ném đúng lỗi cũ. Đã kiểm chứng thực tế trên chính CSDL này
--  ngày 28/07/2026: guard `<> ''` KHÔNG cứu được. (Migration
--  001_ai_operator_2.sql dùng mẫu đó cho 3 bảng mới — cũng đã sửa ở đây.)
--
--  NULLIF an toàn vì là một biểu thức duy nhất, không phụ thuộc thứ tự:
--    ''               → NULL → NULL::uuid → NULL → `tenant_id = NULL` là NULL
--    chưa đặt bao giờ → NULL → như trên
--  Hàng cho ra NULL trong USING bị loại. FAIL-CLOSED: không có tenant context
--  = không thấy hàng nào, thay vì ném lỗi hoặc thấy tất cả.
--
--  ═══ VÌ SAO HAI VAI TRÒ, KHÔNG PHẢI MỘT CỜ BỎ QUA ═══
--
--  Cách dễ là thêm `OR current_setting('app.bypass') = 'on'` vào policy. Nhưng
--  như vậy chính là tự khoét một cửa hậu nằm sẵn trong luật bảo vệ: bất kỳ chỗ
--  nào lỡ set_config cờ đó đều xuyên thủng toàn bộ cách ly.
--
--  Thay vào đó dùng thuộc tính vai trò của PostgreSQL:
--    · app_rls     — NOSUPERUSER NOBYPASSRLS → policy CÓ hiệu lực. Dùng cho
--                    runInTenantContext(), tức toàn bộ đường đi của khách hàng.
--    · app_central — NOSUPERUSER BYPASSRLS   → bỏ qua policy. CHỈ dùng cho
--                    runCentralAdmin(): tra API key, định tuyến webhook, đăng
--                    nhập quản trị. Quyền vượt rào nằm ở vai trò kết nối, kiểm
--                    soát được từ chuỗi kết nối, không nằm rải trong luật.
--
--  Idempotent. KHÔNG có lệnh DROP TABLE / DELETE nào.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Vá 14 policy cũ: thêm guard trước khi ép kiểu uuid
--
--    DROP POLICY rồi CREATE lại là cách duy nhất đổi biểu thức USING/WITH CHECK
--    (PostgreSQL không cho ALTER POLICY đổi biểu thức trên mọi phiên bản).
--    Cả khối nằm trong một transaction nên không có khoảnh khắc nào bảng mất
--    policy khi nhìn từ phiên khác.
-- ---------------------------------------------------------------------------

-- `tenant` khác các bảng còn lại: khoá là cột `id`, không phải `tenant_id`.
DROP POLICY IF EXISTS tenant_iso ON tenant;
CREATE POLICY tenant_iso ON tenant
  USING (
          id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  );

DO $$
DECLARE
  b text;
  -- 13 bảng dùng chung khuôn `tenant_id`.
  bang text[] := ARRAY[
    'tenant_key', 'tenant_platform', 'conversation', 'message',
    'kb_document', 'kb_chunk', 'kb_table', 'kb_table_row', 'kb_script',
    'tenant_setting', 'credit_balance', 'credit_ledger', 'admin_user'
  ];
BEGIN
  FOREACH b IN ARRAY bang LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_iso ON %I', b);
    EXECUTE format($f$
      CREATE POLICY tenant_iso ON %I
        USING (
          tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        )
        WITH CHECK (
          tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        )
    $f$, b);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Ba policy do 001_ai_operator_2.sql tạo đã có guard `<> ''` sẵn.
--    Viết lại theo cùng khuôn coalesce() để 17 policy hoàn toàn đồng nhất —
--    17 luật giống hệt nhau dễ soát hơn 14 luật một kiểu và 3 luật kiểu khác.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  b text;
  bang text[] := ARRAY['admin_user_tenant', 'tenant_revenue_daily', 'operator_action_log'];
BEGIN
  FOREACH b IN ARRAY bang LOOP
    IF to_regclass(b) IS NOT NULL THEN
      EXECUTE format('DROP POLICY IF EXISTS tenant_iso ON %I', b);
      EXECUTE format($f$
        CREATE POLICY tenant_iso ON %I
          USING (
          tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
          )
          WITH CHECK (
          tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
          )
      $f$, b);
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Hai vai trò ứng dụng
--
--    Tạo KHÔNG kèm mật khẩu. Mật khẩu đặt riêng bằng lệnh ALTER ROLE ở bước
--    triển khai, để bí mật không bao giờ nằm trong file được commit.
--
--    NOLOGIN → LOGIN được cấp cùng lúc với mật khẩu. Vai trò chưa có mật khẩu
--    mà đã login được là một cửa mở không ai để ý.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rls') THEN
    CREATE ROLE app_rls NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_central') THEN
    CREATE ROLE app_central NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

-- Bảo đảm thuộc tính đúng kể cả khi vai trò đã tồn tại từ trước với cấu hình khác.
ALTER ROLE app_rls     NOSUPERUSER NOBYPASSRLS;
ALTER ROLE app_central NOSUPERUSER BYPASSRLS;

GRANT USAGE ON SCHEMA public TO app_rls, app_central;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON ALL TABLES IN SCHEMA public TO app_rls, app_central;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_rls, app_central;

-- Bảng/sequence tạo về sau tự có quyền, khỏi phải nhớ cấp lại.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_rls, app_central;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_rls, app_central;

COMMIT;

-- ============================================================================
-- KIỂM CHỨNG SAU KHI CHẠY
-- ============================================================================
-- 1. Đủ 17 policy và tất cả đều có guard:
--      SELECT count(*) FROM pg_policies
--       WHERE schemaname='public' AND qual LIKE '%NULLIF%';
--      → phải bằng tổng số policy tenant_iso
--
-- 2. Thuộc tính vai trò:
--      SELECT rolname, rolsuper, rolbypassrls, rolcanlogin
--        FROM pg_roles WHERE rolname IN ('app_rls','app_central');
--      → app_rls: f/f   ·   app_central: f/t
--
-- 3. Cách ly thật sự (chạy bằng app_rls sau khi đã cấp mật khẩu):
--      BEGIN;
--      SELECT set_config('app.tenant_id', '<tenant_A>', true);
--      SELECT count(*) FROM conversation;   -- chỉ hội thoại của A
--      SELECT set_config('app.tenant_id', '', true);
--      SELECT count(*) FROM conversation;   -- phải là 0, KHÔNG được ném lỗi
--      ROLLBACK;
