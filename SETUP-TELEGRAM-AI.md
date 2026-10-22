# Setup Telegram AI vận hành

Không cần sửa SQL hoặc chạy lệnh đăng ký webhook bằng tay. Sau khi deploy phiên
bản này, toàn bộ phần kết nối nằm trong Web Admin.

## 1. Tạo bot Telegram

1. Mở `@BotFather`, chạy `/newbot`.
2. Lưu lại **username** và **token** BotFather cấp.
3. Có thể dùng `/setcommands` để thêm:

   ```text
   ops - Trợ lý vận hành kho và sản phẩm
   help - Hướng dẫn
   ```

## 2. Cấu hình AI cấp hệ thống

Đăng nhập Web Admin bằng `super_admin` → **Cấu hình hệ thống**:

| Khoá | Ý nghĩa |
|---|---|
| `deepseek_api_key` | Hiểu câu lệnh vận hành tự do bằng tiếng Việt |
| `vision_api_base_url` | Base URL API tương thích OpenAI, không gồm `/chat/completions` |
| `vision_api_key` | API key của nhà cung cấp vision |
| `vision_model` | Model có hỗ trợ nội dung `image_url` |

Nếu chưa cấu hình Vision, lệnh chữ vẫn dùng được; gửi ảnh sẽ được từ chối với
thông báo cấu hình còn thiếu.

## 3. Kết nối bot cho từng shop

Chọn shop → **Cấu hình Bot** → **Telegram AI vận hành**:

1. Nhập địa chỉ Medusa backend của shop.
2. Nhập username bot, không gồm ký tự `@`.
3. Nhập token BotFather → bấm **1. Lưu token**.
4. Nhập URL HTTPS công khai của Chatbot API, ví dụ
   `https://chatbot.example.vn`.
5. Bấm **2. Đăng ký webhook**.
6. Bấm **Kiểm tra kết nối**; checklist phải báo webhook đang hoạt động.

URL công khai phải đi vào đúng service `ruouvang-chatbot`. Telegram không chấp
nhận `http://localhost`, IP LAN hoặc URL chỉ truy cập được trong Docker network.

## 4. Cấp quyền cho nhân viên

Trong Web Admin → **Nhân viên**, tạo hoặc cập nhật nhân viên với Telegram ID
dạng số. Telegram ID là ID tài khoản cá nhân, không phải username và không phải
Group ID.

Chỉ người có Telegram ID thuộc đúng shop mới gọi được lệnh vận hành. Không cần
cấu hình Group ID.

## 5. Thêm bot vào group

1. Thêm bot vào group nhân viên.
2. Với privacy mode mặc định, luôn bắt đầu caption/tin nhắn bằng `/ops` hoặc
   mention `@username_bot`.
3. Nếu muốn bot nhận mọi ảnh không có caption, vào `@BotFather` → `/setprivacy`
   → chọn bot → **Disable**. Chỉ nên làm trong group nội bộ.

Smoke test:

```text
/ops
/ops kiểm tra kho Penfolds Bin 389
/ops Chateau Margaux 2018 mới nhập thêm 30 chai
```

Sau lệnh nhập kho, bot phải cho chọn SKU (nếu có nhiều kết quả) và hiện nút
**Xác nhận**. Chỉ sau khi nhân viên bấm nút thì tồn kho mới thay đổi.

Test ảnh: gửi ảnh nhãn chai với caption:

```text
/ops mới nhập thêm 30 chai
```

## 6. Migration và triển khai

Container chatbot chạy migration lúc start. Nếu triển khai thủ công:

```bash
npm run migrate
npm run build
npm start
```

Backend Medusa cũng phải được deploy cùng phiên bản vì chatbot gọi các endpoint
`/ai/products-lookup`, `/ai/update-inventory` và `/ai/create-product`.
`CONFIG_INTERNAL_SERVICE_KEY` phải giống hệt nhau ở hai service.

