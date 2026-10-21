-- ============================================================================
--  BẢNG ai_batch — CHẠY TRÊN CSDL MEDUSA (không phải CSDL SaaS)
--  Ngày: 28/07/2026
--
--  Chạy:  psql "$DATABASE_URL" -f 002_ai_batch.sql
--
--  Vì sao có file này: `src/index.ts` đọc và ghi bảng `ai_batch` ở ba chỗ
--  (poller batch dòng 339/346, tạo batch SEO dòng 529) nhưng KHÔNG có
--  migration nào trong toàn bộ repo tạo ra nó. Trước đây mọi lời gọi
--  /api/seo-batch và mỗi vòng poll 60 giây đều ném lỗi "relation ai_batch
--  does not exist" — lỗi bị nuốt trong try/catch nên không ai thấy.
--
--  Idempotent. KHÔNG có lệnh DROP nào.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS ai_batch (
  id          bigserial PRIMARY KEY,
  -- ID lô do Anthropic Message Batches API trả về (msgbatch_...).
  batch_id    text NOT NULL,
  -- Loại công việc. Hiện chỉ có 'seo'; để text thay vì enum cho dễ thêm sau.
  loai        text NOT NULL,
  trang_thai  text NOT NULL DEFAULT 'DANG_CHAY'
              CHECK (trang_thai IN ('DANG_CHAY', 'XONG', 'LOI', 'HUY')),
  -- Payload gửi đi + kết quả gộp về. Code dùng `du_lieu || $2::jsonb` nên
  -- BẮT BUỘC là jsonb và KHÔNG được NULL (NULL || x = NULL, sẽ mất kết quả).
  du_lieu     jsonb NOT NULL DEFAULT '{}'::jsonb,
  tao_luc     timestamptz NOT NULL DEFAULT now(),
  xong_luc    timestamptz
);

-- Một batch_id chỉ được ghi một lần: poller chạy 60 giây/lần, nếu tạo trùng
-- thì cùng một lô SEO bị tính tiền và ghi kết quả hai lần.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_batch_batch_id ON ai_batch (batch_id);

-- Poller chỉ quét các lô đang chạy — index từng phần cho đúng truy vấn đó.
CREATE INDEX IF NOT EXISTS idx_ai_batch_dang_chay
  ON ai_batch (id) WHERE trang_thai = 'DANG_CHAY';

COMMENT ON TABLE ai_batch IS
  'Lô công việc gửi qua Anthropic Message Batches API (rẻ hơn ~50% so với gọi lẻ).';

-- ---------------------------------------------------------------------------
-- Siết lược đồ cho bảng ĐÃ TỒN TẠI SẴN
--
-- Bảng này từng được tạo tay ngoài migration nên `CREATE TABLE IF NOT EXISTS`
-- ở trên bị bỏ qua và các ràng buộc mới không được áp. Hai lệnh dưới đây sửa
-- đúng khác biệt nguy hiểm nhất: `du_lieu` đang cho phép NULL, trong khi
-- poller chạy `du_lieu || $2::jsonb` — với NULL thì kết quả cả lô biến mất
-- lặng lẽ, batch báo XONG mà không có dữ liệu.
-- ---------------------------------------------------------------------------
UPDATE ai_batch SET du_lieu = '{}'::jsonb WHERE du_lieu IS NULL;

ALTER TABLE ai_batch ALTER COLUMN du_lieu SET NOT NULL;
ALTER TABLE ai_batch ALTER COLUMN du_lieu SET DEFAULT '{}'::jsonb;
ALTER TABLE ai_batch ALTER COLUMN tao_luc SET NOT NULL;

-- Chặn trạng thái lạ do gõ nhầm. Thêm rời để chạy lại nhiều lần vẫn an toàn.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ai_batch_trang_thai_check'
  ) THEN
    ALTER TABLE ai_batch ADD CONSTRAINT ai_batch_trang_thai_check
      CHECK (trang_thai IN ('DANG_CHAY', 'XONG', 'LOI', 'HUY'));
  END IF;
END $$;

COMMIT;

-- ============================================================================
-- KIỂM CHỨNG SAU KHI CHẠY
-- ============================================================================
-- SELECT to_regclass('ai_batch');            → khác NULL
-- \d ai_batch                                → có đủ 7 cột, du_lieu NOT NULL
