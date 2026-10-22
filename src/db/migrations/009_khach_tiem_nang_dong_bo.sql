-- Đánh dấu lead đã được đẩy sang backend Medusa chưa. Chatbot ghi lead vào đây
-- trước (không mất), rồi đẩy sang Medusa; lần nào lỗi thì vòng nền thử lại.
BEGIN;
ALTER TABLE khach_tiem_nang ADD COLUMN IF NOT EXISTS da_dong_bo_backend boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS khach_tiem_nang_chua_dong_bo_idx ON khach_tiem_nang (tao_luc) WHERE da_dong_bo_backend = false;
COMMIT;
