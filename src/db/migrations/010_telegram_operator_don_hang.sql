-- Thêm 2 loại lệnh vận hành đơn hàng qua Telegram: liệt kê đơn chờ duyệt và duyệt đơn.
-- Tên ràng buộc do PostgreSQL tự đặt ở migration 007.
BEGIN;
ALTER TABLE telegram_operator_action DROP CONSTRAINT IF EXISTS telegram_operator_action_action_type_check;
ALTER TABLE telegram_operator_action ADD CONSTRAINT telegram_operator_action_action_type_check
  CHECK (action_type IN ('inventory_adjust', 'create_product', 'inventory_lookup', 'order_list_pending', 'order_complete'));
COMMIT;
