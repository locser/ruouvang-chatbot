-- Mã giỏ hàng của Medusa v2 có dạng "cart_01M4SYS5…" (text), KHÔNG phải UUID.
-- Cột cũ kiểu uuid làm lệnh UPDATE conversation SET cart_id = 'cart_…' lỗi 22P02
-- và kéo sập cả transaction của lượt chat ("current transaction is aborted").
ALTER TABLE conversation ALTER COLUMN cart_id TYPE text USING cart_id::text;
