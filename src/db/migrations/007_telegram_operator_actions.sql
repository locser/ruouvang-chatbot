-- Lệnh vận hành phát sinh từ Telegram. Mọi thao tác ghi đều phải được một
-- nhân viên của đúng tenant xác nhận, và mỗi action chỉ được thực thi một lần.
BEGIN;

CREATE TABLE IF NOT EXISTS telegram_operator_action (
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

CREATE INDEX IF NOT EXISTS telegram_operator_action_pending_idx
  ON telegram_operator_action (tenant_id, status, expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS telegram_operator_action_message_uq
  ON telegram_operator_action (tenant_id, telegram_chat_id, telegram_message_id)
  WHERE telegram_message_id IS NOT NULL;

CREATE OR REPLACE FUNCTION telegram_operator_action_touch() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS telegram_operator_action_touch ON telegram_operator_action;
CREATE TRIGGER telegram_operator_action_touch
  BEFORE UPDATE ON telegram_operator_action
  FOR EACH ROW EXECUTE FUNCTION telegram_operator_action_touch();

ALTER TABLE telegram_operator_action ENABLE ROW LEVEL SECURITY;
ALTER TABLE telegram_operator_action FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_iso ON telegram_operator_action;
CREATE POLICY tenant_iso ON telegram_operator_action
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rls') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON telegram_operator_action TO app_rls;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_central') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON telegram_operator_action TO app_central;
  END IF;
END $$;

COMMIT;
