-- ============================================================================
--  KỊCH BẢN CỨNG CÓ THỂ CHUYỂN NHÂN VIÊN
--  Ngày: 29/07/2026
--
--  Chạy:  psql "$DATABASE_URL" -f 004_kich_ban_chuyen_nguoi.sql
--
--  ═══ VÌ SAO ═══
--
--  Kịch bản cứng trước đây CHỈ trả về văn bản rồi kết thúc lượt (index.ts,
--  nhánh `if (hardMatch)`). Nhưng nhiều kịch bản có nội dung là "em xin phép
--  chuyển anh/chị tới nhân viên" — phí ship, đổi trả, địa chỉ, câu hỏi sức
--  khoẻ. Bot NÓI là chuyển nhưng KHÔNG chuyển: hội thoại vẫn ở chế độ BOT,
--  không ai được báo, khách ngồi chờ một nhân viên không bao giờ tới.
--
--  Đây là loại lỗi tệ hơn im lặng: nó tạo ra lời hứa rồi bỏ rơi khách.
--
--  Cột này cho phép đánh dấu kịch bản nào phải thực sự leo thang. Mặc định
--  false nên mọi kịch bản cũ giữ nguyên hành vi.
--
--  Idempotent. KHÔNG có lệnh DROP nào.
-- ============================================================================

BEGIN;

ALTER TABLE kb_script
  ADD COLUMN IF NOT EXISTS chuyen_nguoi boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN kb_script.chuyen_nguoi IS
  'true = sau khi trả lời thì chuyển hội thoại sang CHO_NGUOI và báo nhân viên. '
  'Dùng cho kịch bản có nội dung hứa chuyển người — nói mà không làm là bỏ rơi khách.';

COMMIT;

-- ============================================================================
-- KIỂM CHỨNG
-- ============================================================================
-- \d kb_script                         → có cột chuyen_nguoi
-- SELECT count(*) FROM kb_script WHERE chuyen_nguoi;   → số kịch bản sẽ leo thang
