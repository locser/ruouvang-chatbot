-- Create pgvector extension for RAG
CREATE EXTENSION IF NOT EXISTS vector;

-- Custom types and enums
CREATE TYPE nganh_t      AS ENUM ('thuc_pham', 'wellness', 'my_pham', 'thoi_trang', 'dien_tu', 'khac');
CREATE TYPE conv_mode_t  AS ENUM ('BOT', 'CHO_NGUOI', 'NGUOI', 'DONG');
CREATE TYPE vai_tro_t    AS ENUM ('khach', 'bot', 'nguoi');

-- 1. Tenant Table
CREATE TABLE tenant (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ten             text NOT NULL,
  nganh           nganh_t NOT NULL,
  bac_du_lieu     smallint NOT NULL DEFAULT 0 CHECK (bac_du_lieu BETWEEN 0 AND 3),
  -- Claim firewall automatically activated for food, wellness, cosmetics
  tuong_lua_claim boolean GENERATED ALWAYS AS (nganh IN ('thuc_pham', 'wellness', 'my_pham')) STORED,
  locale_da_bat   text[] NOT NULL DEFAULT '{}',
  goi             text NOT NULL DEFAULT 'free',
  tao_luc         timestamptz NOT NULL DEFAULT now()
);

-- 2. Tenant Keys (API Keys used by clients in widget requests)
CREATE TABLE tenant_key (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  khoa_bam         text NOT NULL UNIQUE,          -- sha256 of public key, never store raw keys
  origin_allowlist text[] NOT NULL,
  het_han          timestamptz,
  thu_hoi_luc      timestamptz,
  tao_luc          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON tenant_key (khoa_bam) WHERE thu_hoi_luc IS NULL;

-- 3. Tenant Integration Credentials (Shopify, WooCommerce, Telegram tokens - encrypted)
CREATE TABLE tenant_platform (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  loai            text NOT NULL CHECK (loai IN ('shopify', 'woo', 'haravan', 'sapo', 'vph_store', 'telegram', 'medusa')),
  cau_hinh_ma_hoa text NOT NULL,                  -- AES-256-GCM encrypted JSON credentials
  trang_thai      text NOT NULL DEFAULT 'hoat_dong',
  loi_gan_nhat    text,
  tao_luc         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, loai)
);

-- 4. Conversation Table
CREATE TABLE conversation (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  visitor_id            text NOT NULL,
  channel_id            text,                     -- Origin platform/channel identifier
  currency_code         text,                     -- Fixed currency code from channel settings
  mode                  conv_mode_t NOT NULL DEFAULT 'BOT',
  mode_version          integer NOT NULL DEFAULT 0,   -- Optimistic lock to prevent race condition during takeover
  assigned_to           text,                     -- Admin/Operator user identifier (Telegram ID or username)
  locale_nhan_duoc      text,                     -- Detected client locale (e.g. vi-VN)
  claim_locale_ap_dung  text,                     -- Compliance fallback (e.g., 'en-IE' if locale is unknown)
  cart_id               text,                     -- Medusa cart ID (dạng "cart_01…", không phải UUID)
  diem_cam_xuc          smallint CHECK (diem_cam_xuc BETWEEN 1 AND 5),
  ly_do_leo_thang       text,                     -- Reason for escalating to human
  last_human_msg_at     timestamptz,
  last_customer_msg_at   timestamptz,
  da_canh_bao_nguoi     boolean NOT NULL DEFAULT false,
  tao_luc               timestamptz NOT NULL DEFAULT now(),
  dong_luc              timestamptz
);
CREATE INDEX ON conversation (tenant_id, mode) WHERE dong_luc IS NULL;
CREATE INDEX ON conversation (tenant_id, visitor_id) WHERE dong_luc IS NULL;
CREATE INDEX ON conversation (visitor_id);

-- 5. Message Table
CREATE TABLE message (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  vai_tro         vai_tro_t NOT NULL,
  noi_dung        text NOT NULL,
  dinh_kem        jsonb NOT NULL DEFAULT '[]',    -- JSON array of images or product cards
  model           text,                           -- LLM model utilized (if applicable)
  tokens_vao      integer,
  tokens_ra       integer,
  credit_da_tru   numeric(12,4) DEFAULT 0,
  claim_flags     jsonb DEFAULT '[]',             -- Compliance violations flags
  nguon_kien_thuc jsonb DEFAULT '[]',             -- Citation trace (chunks referenced)
  tao_luc         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON message (conversation_id, tao_luc);

-- 6. Knowledge Base Documents (Metadata)
CREATE TABLE kb_document (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  ten_file   text NOT NULL,
  loai       text NOT NULL,
  kich_thuoc bigint NOT NULL,
  checksum   text NOT NULL,
  trang_thai text NOT NULL DEFAULT 'cho_xu_ly',
  loi        text,
  tao_luc    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, checksum)                    -- Avoid redundant processing/billing
);

-- 7. Knowledge Base Chunks (Vector storage)
CREATE TABLE kb_chunk (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES kb_document(id) ON DELETE CASCADE,
  noi_dung    text NOT NULL,
  embedding   vector(1536) NOT NULL,              -- 1536 dimensions for text-embedding-3-small or similar
  meta        jsonb DEFAULT '{}'
);
-- HNSW index for cosine distance vector search (fast lookup)
CREATE INDEX ON kb_chunk USING hnsw (embedding vector_cosine_ops);
CREATE INDEX ON kb_chunk (tenant_id);

-- 8. Structured Excel Tables (Custom DB storage to avoid RAG hallucinations)
CREATE TABLE kb_table (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  ten_bang   text NOT NULL,
  lay_do_cot jsonb NOT NULL,                     -- Columns definition {name, type}
  so_dong    integer NOT NULL DEFAULT 0,
  tao_luc    timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE kb_table_row (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  table_id  uuid NOT NULL REFERENCES kb_table(id) ON DELETE CASCADE,
  du_lieu   jsonb NOT NULL                        -- Row properties as JSON object
);
CREATE INDEX ON kb_table_row USING gin (du_lieu);
CREATE INDEX ON kb_table_row (tenant_id, table_id);

-- 9. Conversational Hard Scripts (deterministic Q&A scripts matched via regex)
CREATE TABLE kb_script (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  loai      text NOT NULL CHECK (loai IN ('cung', 'mem')),
  mau_khop  text,                                  -- Regex pattern for hard scripts
  tra_loi   text NOT NULL,
  locale    text,
  uu_tien   integer NOT NULL DEFAULT 0,
  tao_luc   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON kb_script (tenant_id, uu_tien DESC);

-- 10. Tenant Settings Table
CREATE TABLE tenant_setting (
  tenant_id             uuid PRIMARY KEY REFERENCES tenant(id) ON DELETE CASCADE,
  tu_dong_tra_bot       boolean NOT NULL DEFAULT true,
  nguong_cho_nguoi_nhan interval NOT NULL DEFAULT '5 minutes'::interval,
  nguong_nguoi_im_lang  interval NOT NULL DEFAULT '10 minutes'::interval,
  canh_bao_nguoi_truoc  interval NOT NULL DEFAULT '2 minutes'::interval,
  ly_do_khong_tra_bot   text[]   NOT NULL DEFAULT '{khach_yeu_cau,tien_bac,claim_guard,suc_khoe,phap_ly}'::text[],
  hanh_dong_khi_het_gio text     NOT NULL DEFAULT 'bot_tiep',
  bao_khach_khi_doi_vai boolean  NOT NULL DEFAULT true,
  gio_lam_viec          jsonb    NOT NULL DEFAULT '{"tz":"Asia/Ho_Chi_Minh","ngay":[1,2,3,4,5,6],"tu":"08:00","den":"18:00"}'::jsonb,
  ngoai_gio_lam_gi      text     NOT NULL DEFAULT 'bot_tiep_va_hen',
  dong_hoi_thoai_sau    interval NOT NULL DEFAULT '30 minutes'::interval
);

-- 11. Credit System Tables
CREATE TABLE credit_balance (
  tenant_id     uuid PRIMARY KEY REFERENCES tenant(id) ON DELETE CASCADE,
  so_du         numeric(14,4) NOT NULL DEFAULT 0,
  da_tang       numeric(14,4) NOT NULL DEFAULT 0,
  tran_ngay     numeric(14,4),
  cap_nhat_luc  timestamptz NOT NULL DEFAULT now()
);

-- Immutable Credit Transaction Log (Audit Log)
CREATE TABLE credit_ledger (
  id              bigserial PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  loai_hanh_dong  text NOT NULL,                   -- 'chat' | 'embed' | 'crawl' | 'vision' | 'storage' | 'nap'
  so_credit       numeric(12,4) NOT NULL,          -- Negative for charges, positive for deposits
  chi_phi_that_usd numeric(12,6),                  -- Operational cost check
  model           text,
  tokens          integer,
  conversation_id uuid,
  tao_luc         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON credit_ledger (tenant_id, tao_luc DESC);

-- Immutable Ledger Rules (Deny direct updates & deletes on audit log)
CREATE RULE ledger_no_update AS ON UPDATE TO credit_ledger DO INSTEAD NOTHING;
CREATE RULE ledger_no_delete AS ON DELETE TO credit_ledger DO INSTEAD NOTHING;

-- 12. Admin User Table
CREATE TABLE admin_user (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid REFERENCES tenant(id) ON DELETE CASCADE, -- NULL for Super Admin
  username        text NOT NULL UNIQUE,
  password_hash   text NOT NULL,
  email           text NOT NULL UNIQUE,
  telegram_id     text UNIQUE,
  reset_token     text,
  reset_expires   timestamptz,
  tao_luc         timestamptz NOT NULL DEFAULT now()
);

-- Lệnh vận hành Telegram: lưu trạng thái để xác nhận một lần và truy vết ai đã làm gì.
CREATE TABLE telegram_operator_action (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  telegram_chat_id      text NOT NULL,
  telegram_message_id   text,
  requested_by          text NOT NULL,
  confirmed_by          text,
  action_type           text NOT NULL CHECK (action_type IN ('inventory_adjust', 'create_product', 'inventory_lookup')),
  status                text NOT NULL DEFAULT 'awaiting_confirmation'
                        CHECK (status IN ('awaiting_selection', 'awaiting_confirmation', 'executing', 'completed', 'cancelled', 'failed', 'expired')),
  payload               jsonb NOT NULL DEFAULT '{}'::jsonb,
  original_text         text NOT NULL DEFAULT '',
  result                jsonb,
  error                 text,
  expires_at            timestamptz NOT NULL DEFAULT (now() + interval '15 minutes'),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX telegram_operator_action_pending_idx
  ON telegram_operator_action (tenant_id, status, expires_at);
CREATE UNIQUE INDEX telegram_operator_action_message_uq
  ON telegram_operator_action (tenant_id, telegram_chat_id, telegram_message_id)
  WHERE telegram_message_id IS NOT NULL;
CREATE OR REPLACE FUNCTION telegram_operator_action_touch() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER telegram_operator_action_touch
  BEFORE UPDATE ON telegram_operator_action
  FOR EACH ROW EXECUTE FUNCTION telegram_operator_action_touch();

-- -----------------------------------------------------------------------------
-- ROW LEVEL SECURITY (RLS) POLICIES
-- -----------------------------------------------------------------------------
ALTER TABLE tenant            ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_key        ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_platform   ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation      ENABLE ROW LEVEL SECURITY;
ALTER TABLE message           ENABLE ROW LEVEL SECURITY;
ALTER TABLE kb_document       ENABLE ROW LEVEL SECURITY;
ALTER TABLE kb_chunk          ENABLE ROW LEVEL SECURITY;
ALTER TABLE kb_table          ENABLE ROW LEVEL SECURITY;
ALTER TABLE kb_table_row      ENABLE ROW LEVEL SECURITY;
ALTER TABLE kb_script         ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_setting    ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_balance    ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_ledger     ENABLE ROW LEVEL SECURITY;
ALTER TABLE telegram_operator_action ENABLE ROW LEVEL SECURITY;

ALTER TABLE tenant            FORCE ROW LEVEL SECURITY;
ALTER TABLE tenant_key        FORCE ROW LEVEL SECURITY;
ALTER TABLE tenant_platform   FORCE ROW LEVEL SECURITY;
ALTER TABLE conversation      FORCE ROW LEVEL SECURITY;
ALTER TABLE message           FORCE ROW LEVEL SECURITY;
ALTER TABLE kb_document       FORCE ROW LEVEL SECURITY;
ALTER TABLE kb_chunk          FORCE ROW LEVEL SECURITY;
ALTER TABLE kb_table          FORCE ROW LEVEL SECURITY;
ALTER TABLE kb_table_row      FORCE ROW LEVEL SECURITY;
ALTER TABLE kb_script         FORCE ROW LEVEL SECURITY;
ALTER TABLE tenant_setting    FORCE ROW LEVEL SECURITY;
ALTER TABLE credit_balance    FORCE ROW LEVEL SECURITY;
ALTER TABLE credit_ledger     FORCE ROW LEVEL SECURITY;
ALTER TABLE telegram_operator_action FORCE ROW LEVEL SECURITY;

-- Policy to isolate data based on database setting: app.tenant_id
CREATE POLICY tenant_iso ON tenant USING (id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY tenant_iso ON tenant_key 
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY tenant_iso ON tenant_platform
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY tenant_iso ON conversation
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY tenant_iso ON message
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY tenant_iso ON kb_document
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY tenant_iso ON kb_chunk
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY tenant_iso ON kb_table
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY tenant_iso ON kb_table_row
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY tenant_iso ON kb_script
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY tenant_iso ON tenant_setting
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY tenant_iso ON telegram_operator_action
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY tenant_iso ON credit_balance
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY tenant_iso ON credit_ledger
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE admin_user        ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_user        FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_iso ON admin_user
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);


-- 006: Bảng cấu hình ứng dụng (xem migrations/006_app_settings.sql để biết thiết kế)
CREATE TABLE app_settings (
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
CREATE UNIQUE INDEX app_settings_scope_key_uq
  ON app_settings ((COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid)), key);
CREATE INDEX app_settings_tenant_idx ON app_settings (tenant_id);

CREATE FUNCTION app_settings_touch() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER app_settings_touch BEFORE UPDATE ON app_settings
  FOR EACH ROW EXECUTE FUNCTION app_settings_touch();

ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_settings FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_iso ON app_settings
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);


-- 008: Khách để lại số điện thoại cho nhân viên gọi tư vấn (xem migrations/008_khach_tiem_nang.sql)
CREATE TABLE khach_tiem_nang (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  conversation_id  uuid NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  ten              text,
  so_dien_thoai    text NOT NULL,
  nhu_cau          text,
  trang_thai       text NOT NULL DEFAULT 'moi' CHECK (trang_thai IN ('moi', 'da_goi', 'bo_qua')),
  da_bao_nhan_vien boolean NOT NULL DEFAULT false,
  da_dong_bo_backend boolean NOT NULL DEFAULT false,
  tao_luc          timestamptz NOT NULL DEFAULT now(),
  cap_nhat_luc     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id)
);
CREATE INDEX khach_tiem_nang_tenant_idx ON khach_tiem_nang (tenant_id, trang_thai, tao_luc DESC);
ALTER TABLE khach_tiem_nang ENABLE ROW LEVEL SECURITY;
ALTER TABLE khach_tiem_nang FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_iso ON khach_tiem_nang
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE INDEX khach_tiem_nang_chua_dong_bo_idx ON khach_tiem_nang (tao_luc) WHERE da_dong_bo_backend = false;
