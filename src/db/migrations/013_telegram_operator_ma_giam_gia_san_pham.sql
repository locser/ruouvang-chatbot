-- Thêm loại lệnh: tạo mã giảm giá, ẩn sản phẩm, mở bán lại sản phẩm.
-- Khuôn như migration 012: bỏ rồi tạo lại CHECK constraint của action_type.
BEGIN;
ALTER TABLE telegram_operator_action DROP CONSTRAINT IF EXISTS telegram_operator_action_action_type_check;
ALTER TABLE telegram_operator_action ADD CONSTRAINT telegram_operator_action_action_type_check
  CHECK (action_type IN ('inventory_adjust', 'create_product', 'inventory_lookup', 'order_list_pending', 'order_complete', 'order_payment_received', 'order_cancel', 'discount_create', 'product_hide', 'product_show'));
COMMIT;
