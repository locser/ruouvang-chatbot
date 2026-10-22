# ChatBot AI SaaS Đa Chi nhánh — ChatBotAISAAS

**Phiên bản 2.0** · Cập nhật 28/07/2026

Nền tảng chatbot AI tư vấn bán hàng đa tenant (SaaS), tích hợp Medusa v2 làm nguồn sự thật về giá và tồn kho, DeepSeek API làm mô hình ngôn ngữ, Meilisearch làm tầng tìm kiếm cho quy mô 60.000+ SKU.

> ⚠️ **Đọc mục [Trạng thái thật](#-trạng-thái-thật-của-hệ-thống) trước khi lên kế hoạch ra mắt.** Phiên bản này hoàn thành phần nền móng và bảo mật, nhưng **luồng chat qua kiến trúc mới chưa chạy được** — còn thiếu orchestrator và tool handler.

---

## 📌 PHIÊN BẢN 2.0 CÓ GÌ MỚI

Phiên bản này tập trung vào hai việc: **bịt các lỗ hổng chặn ra mắt** và **dựng nền móng cho kiến trúc AI mới**.

### A. Vá bảo mật — 20 hạng mục

| Hạng mục | Trước | Nay |
|:---|:---|:---|
| **Bí mật hệ thống** | `JWT_SECRET` mặc định `"fallback_jwt_secret_dev"`, `CONFIG_ENCRYPTION_KEY_CHATBOT` công khai trong repo | **Fail-fast** — thiếu biến môi trường thì ứng dụng **từ chối khởi động** |
| **Token khách vs quản trị** | Dùng chung một secret → token chat của khách vô danh dùng được làm token admin | Tách `CONFIG_JWT_SECRET_CHATBOT_SESSION` / `CONFIG_JWT_SECRET_CHATBOT_ADMIN`, kiểm `typ` bằng allowlist |
| **Phân quyền đa tenant** | Middleware `assertTenantScope` gắn sai tầng → `req.params` rỗng → **không chặn được gì** | Lấy tenant từ `req.path`, tra chủ sở hữu hội thoại, chặn `/tenants` cho non-super-admin |
| **Cửa hậu** | `bypass_tg_` bỏ qua chữ ký Telegram; `NODE_ENV=test` cấp super_admin không cần token | Chuyển sang `JEST_WORKER_ID` — chỉ bật khi chạy dưới Jest, **không thể bật từ bên ngoài** |
| **Webhook Telegram** | Kiểm tra secret bọc trong `if (biến tồn tại)` mà biến không được đặt → **bỏ qua hoàn toàn** | **Fail-closed** — thiếu cấu hình trả 503, so sánh timing-safe |
| **API `/ai/*` của Medusa** | **15/15 route** hardcode `"REPLACE_WITH_NEW_SECRET"` | **15/15 route fail-closed**, dùng chung `src/lib/ai-auth.ts` |
| **Docker image** | `COPY .env` → secret nằm vĩnh viễn trong layer, đọc được bằng `docker history` | Bỏ hẳn, thêm `.dockerignore`, chạy `USER node`, có `HEALTHCHECK` |
| **Rate limit** | Không có. `pbkdf2Sync` 100k vòng chặn event loop → 20 req/s vào login là treo cả hệ thống | Rate limiter trên Redis (hiểu tenant), security headers, `pbkdf2` bất đồng bộ |
| **Credit** | Trừ không điều kiện, không ai đọc số dư → tenant hết tiền vẫn chat vô hạn | Chặn khi hết credit **trước khi gọi LLM**; trừ nguyên tử `WHERE so_du >= $1` |
| **Timeout** | 15 lời gọi `fetch` **không có timeout nào** (Node 20 không có mặc định) | Ngân sách rõ ràng: Meilisearch 1s · Medusa 3s · DeepSeek 15s · Telegram 5s |
| **Vòng đời tiến trình** | Không có graceful shutdown, không health check | `/healthz`, `/readyz`, SIGTERM/SIGINT đóng an toàn, bắt `unhandledRejection` |

### B. Sửa lỗi nghiệp vụ làm hỏng trải nghiệm bán hàng

| Lỗi | Hệ quả thật | Đã sửa |
|:---|:---|:---|
| Cửa sổ lịch sử lấy **10 tin cũ nhất** | Từ tin thứ 11, bot **không nhìn thấy câu khách vừa hỏi** — gốc rễ của mọi triệu chứng "bot quên", hỏi lại địa chỉ, cộng dồn giỏ hàng | Lấy 20 tin **gần nhất**, có tie-break theo `id` |
| Regex `<cart_action>` không có cờ `g` | Khách mua 2 món, **chỉ món đầu vào giỏ** | `matchAll`, duyệt tuần tự đủ mọi thẻ |
| Prompt mâu thuẫn `add_item` / `update_quantity` | "Cho anh **thêm** 2 hộp nữa" khi giỏ có 5 → **giỏ tụt xuống 2** | Quy tắc **số lượng tuyệt đối** (`set_quantity`) — server cộng trừ, không phải LLM |
| Guard đoán ý khách có regex khớp cả chữ **"đâu"** | *"Shop ở đâu vậy em?"* → **tạo đơn hàng thật**, trừ tồn kho, gửi QR đòi tiền | Tách ra `services/checkoutIntent.ts` + **22 test hồi quy** |
| `dinh_kem LIKE` trên cột `jsonb` | Lỗi SQL → rollback cả lượt chat + treo kết nối | Ép kiểu `::text` + try/catch riêng |
| Số tài khoản fallback **VP Holding** | Shop khác chốt đơn, tiền khách chảy nhầm ví | Không có tài khoản → **không chốt đơn**, chuyển nhân viên |
| Mã chuyển khoản `orderId.substring(0,8)` | ID Medusa v2 đều bắt đầu `order_01…` → **mọi đơn cùng một mã**, không đối soát được | `slice(-8)` sau khi bỏ tiền tố |
| `max_tokens: 500` | Cắt cụt thẻ hành động → bot nói "đã chốt đơn" nhưng không có đơn | Nâng lên 1500 |
| Đơn giá credit theo **nhãn định tuyến** | Trừ 15 credit cho `claude-sonnet` trong khi luôn gọi `deepseek-chat` — **đắt gấp 75 lần** | Tính theo model **thực sự được gọi** |
| Nhân viên Telegram không trả lời được | Bấm "Tiếp quản" xong gõ tin thì **bị nuốt** — hội thoại im lặng 5 phút | Xử lý tin nhắn operator, có xác nhận gửi |
| Claim Guard chỉ áp cho bot | Nhân viên gõ tay lời hứa chữa bệnh thì **không ai chặn** | Áp cho **cả hai kênh** web admin và Telegram |

### C. Nền móng kiến trúc AI mới

| Thành phần | Vai trò |
|:---|:---|
| `services/search.ts` | Client Meilisearch, filter **luôn có `tenant_id` đứng đầu**, nới lỏng 3 bậc có thông báo minh bạch |
| `services/catalog.ts` | Làm giàu kết quả bằng **giá & tồn kho thật** từ Medusa; sản phẩm thiếu dữ liệu thật bị **loại khỏi câu trả lời** |
| `services/tools/schemas.ts` | 10 tool theo chuẩn native function calling của DeepSeek — thay hẳn cơ chế thẻ `<cart_action>` |
| `services/tools/validate.ts` | **Lớp kiểm chứng phía server** — chốt chặn cuối trước khi chạm Medusa |
| `services/security.ts` | Security headers + rate limiter trên Redis, **không thêm dependency nào** |
| `services/http.ts` | `fetchCoTimeout` — mọi lời gọi ra ngoài đều có hạn |

**Bên Medusa backend** (`AI ECommerce Brain/apps/backend`):

| File | Vai trò |
|:---|:---|
| `src/lib/ai-auth.ts` | Xác thực fail-closed dùng chung cho 15 route `/ai/*` |
| `src/lib/meili-sync.ts` | Đọc giá từ bảng `price`, tồn kho từ `inventory_level`, `tenant_id` từ biến môi trường |
| `src/api/ai/products-lookup/route.ts` | Tra giá & tồn kho **thật** theo lô ID/SKU, báo rõ ID nào không tìm thấy |
| `src/subscribers/meilisearch-product-sync.ts` | Đồng bộ thời gian thực, **ném lỗi để Redis event bus tự retry** |
| `src/jobs/meilisearch-nightly-reconcile.ts` | Đối soát **ba chiều**: thiếu→thêm, thừa→**xoá**, lệch→cập nhật |

### D. Chất lượng

- **`npm test` giờ mới thật sự chạy 109 test case** — trước đây script trỏ vào file khác nên bộ test chưa từng chạy khi gõ lệnh.
- Thêm **52 test hồi quy mới**: 22 test cho sự cố "đâu", 30 test cho lớp kiểm chứng tool.
- `tsc --noEmit` **PASS sạch** trên cả ChatBotAISAAS và Medusa backend (typecheck đối chiếu với `@medusajs/framework@2.17.2` thật).

---

## 📊 TRẠNG THÁI THẬT CỦA HỆ THỐNG

Đo theo 7 cổng chất lượng trong `TechUpdate/10_CHAT_LUONG_VA_RA_MAT.md`:

| Cổng | Nội dung | Trạng thái |
|:---:|:---|:---|
| **G1** | Chất lượng dữ liệu 60.000 SKU | ⬜ Chưa bắt đầu |
| **G2** | Tầng tìm kiếm Meilisearch | 🟡 Code sẵn sàng, **chưa chạy thật** (chưa dựng Meilisearch) |
| **G3** | Chất lượng AI | ⬜ **Chưa có luồng chat nào chạy qua kiến trúc mới** — thiếu orchestrator + tool handler |
| **G4** | Bảo mật & đa tenant | 🟡 Phần lớn đã đóng; còn **RLS role PostgreSQL** chưa làm |
| **G5** | Backend & vận hành | 🟡 `tsc` xanh; chưa chạy `npm run build` đầy đủ bên Medusa |
| **G6** | Frontend storefront | ⬜ Chưa bắt đầu |
| **G7** | Sẵn sàng vận hành | ⬜ Chưa bắt đầu |

**Việc lớn nhất còn lại:** orchestrator + 10 tool handler. Không có nó thì các tool schema và lớp kiểm chứng chưa được nối vào luồng chat thật.

**Một hạng mục bảo mật còn nợ:** ứng dụng vẫn kết nối PostgreSQL bằng tài khoản superuser, nên **RLS đang bị vô hiệu hoàn toàn** — 14 policy `tenant_iso` trong `schema.sql` hiện chỉ là trang trí. Cách ly tenant hiện dựa vào tầng ứng dụng. *(Có bẫy khi vá: `runCentralAdmin` đặt `app.tenant_id = ''` mà `''::uuid` ném lỗi — xem `TechUpdate/08_BAO_MAT_DA_TENANT.md`.)*

---

## 🚀 HƯỚNG DẪN VẬN HÀNH

### Bước 0 — Cấu hình biến môi trường ⚠️ BẮT BUỘC

**Phiên bản này sẽ TỪ CHỐI KHỞI ĐỘNG nếu thiếu biến bắt buộc.** Đây là chủ đích — nó thay cho việc âm thầm chạy bằng bí mật mặc định công khai trong mã nguồn.

```bash
# ── Bí mật: BẮT BUỘC, tối thiểu 32 ký tự ──
# Sinh giá trị: openssl rand -base64 48
CONFIG_JWT_SECRET_CHATBOT_SESSION=<secret ký token phiên chat của khách>
CONFIG_JWT_SECRET_CHATBOT_ADMIN=<secret ký token quản trị — PHẢI KHÁC secret trên>
CONFIG_ENCRYPTION_KEY_CHATBOT=<khoá mã hoá cấu hình tenant>

# ── Bắt buộc khi NODE_ENV=production ──
CONFIG_POSTGRES_URL_CHATBOT=postgres://...
CONFIG_REDIS_URL_CHATBOT=redis://...
CONFIG_INTERNAL_SERVICE_KEY=<PHẢI GIỐNG HỆT giá trị bên Medusa backend>
CONFIG_API_CHATBOT_PUBLIC_URL=https://<domain thật>          # dùng cho link đặt lại mật khẩu

# ── Meilisearch ──
CONFIG_MEILI_HOST=http://meilisearch:7700
CONFIG_MEILI_MASTER_KEY=<≥32 ký tự>
```

> **DeepSeek, SMTP, bot Telegram nền tảng, hotline, Zalo, khoá widget, tài khoản ngân hàng KHÔNG đọc từ môi trường nữa** — chúng nằm ở bảng `app_settings`. Xem mục "Cấu hình trong DB" ngay dưới.

Bên **Medusa backend** cần thêm:

```bash
CONFIG_TENANT_ID=<UUID của tenant sở hữu instance này, khớp tenant.id>
CONFIG_INTERNAL_SERVICE_KEY=<GIỐNG HỆT giá trị bên ChatBotAISAAS>
CONFIG_MEILI_HOST= / CONFIG_MEILI_MASTER_KEY=   # như trên
CHATBOT_URL=http://chatbot-api-service:3000   # lấy hotline/ngân hàng qua GET /v1/public/config
SITE_URL=https://<domain storefront>
```

> **Hai giá trị phải khớp tuyệt đối giữa hai bên:** `CONFIG_INTERNAL_SERVICE_KEY` (lệch → mọi lời gọi `/ai/*` trả 401) và `CONFIG_TENANT_ID` (lệch → tìm kiếm trả về rỗng vĩnh viễn).

### Cấu hình trong DB (`app_settings`)

Migration: `npm run migrate` (host: `CONFIG_LOCAL_MODE=1 npm run migrate`; `-- --status` để xem). Trình chạy ghi vết ở `schema_migrations` và tự baseline 001–005 trên DB cũ.

| Phạm vi | Khoá |
|---|---|
| Nền tảng (super_admin) | `deepseek_api_key`🔒 `vision_api_base_url` `vision_api_key`🔒 `vision_model` `smtp_host` `smtp_port` `smtp_user` `smtp_pass`🔒 `smtp_from` `telegram_bot_token`🔒 `telegram_webhook_secret`🔒 |
| Theo shop | `widget_key` |

🔒 = mã hoá AES-256-GCM, API chỉ trả bản che. Danh sách đầy đủ: `GET /v1/admin/settings/schema`.

**Mỗi bên một bảng, mỗi khoá một nơi.** Hotline, Zalo, tài khoản ngân hàng, vận chuyển và SMTP gửi thư cho *khách* nằm ở bảng `app_settings` của **Medusa** (Medusa admin > Cấu hình cửa hàng, `/admin/app-settings`), không phải ở đây. SMTP của chatbot chỉ dùng cho thư đặt lại mật khẩu quản trị chatbot. Giao diện: panel "Cấu hình hệ thống" trong chatbot admin (super admin).

API (Bearer token quản trị; super_admin thêm `tenant_id` cho khoá theo shop, tenant_admin tự động theo tenant của mình):

```bash
GET    /v1/admin/settings?scope=platform|shop[&tenant_id=]   # liệt kê
GET    /v1/admin/settings/:key
PUT    /v1/admin/settings/:key        {"value":"..."}        # "" = xoá
PUT    /v1/admin/settings             {"settings":{"hotline":"0901234567","bank_bin":"970422"}}
DELETE /v1/admin/settings/:key
POST   /v1/admin/settings/generate    {"type":"hex","bytes":32,"save_as":"telegram_webhook_secret"}
POST   /v1/admin/settings/test/deepseek   |   /test/smtp
GET    /v1/public/config?tenant_id=<uuid>                    # công khai, hiện chỉ trả widget_key
```

`generate`: `type` ∈ hex, base64, base64url, uuid, password, jwt_secret, encryption_key, api_key, widget_key. `save_as` lưu thẳng vào DB; với `widget_key` còn đăng ký sha256 vào `tenant_key`.

CLI tương đương (`npm run settings -- …`): `list`, `get`, `set`, `unset`, `schema`, `gen <loai> [--bytes N] [--save-as khoa]`, `import-env [--file ../.env] [--dry-run]` (nhập một lần từ `.env` cũ).

### Trợ lý vận hành trong group Telegram

Hướng dẫn bật từ đầu trên Web Admin: [`SETUP-TELEGRAM-AI.md`](./SETUP-TELEGRAM-AI.md).

Nhân viên phải có `telegram_id` trong tài khoản admin của đúng shop. Trong group,
gọi bot bằng `/ops` hoặc `@username_bot`; bot chỉ lập thao tác dự kiến và luôn
yêu cầu bấm **Xác nhận** trước khi ghi Medusa. Ví dụ:

```text
/ops Chateau Margaux 2018 mới nhập thêm 30 chai
/ops kiểm tra kho Penfolds Bin 389
/ops tạo sản phẩm mới Example Cabernet 2022 giá 1200000
```

Có thể gửi ảnh nhãn chai kèm caption `/ops mới nhập thêm 30 chai`. Tính năng ảnh
cần đặt đủ `vision_api_base_url`, `vision_api_key`, `vision_model` cho một API
tương thích OpenAI có hỗ trợ `image_url`. Ảnh được tải từ Telegram vào bộ nhớ,
gửi dạng data URL cho nhà cung cấp vision và không lưu làm ảnh sản phẩm. Với
privacy mode mặc định của Telegram, nên luôn dùng `/ops` hoặc mention trong caption.

Mỗi lệnh hết hạn sau 15 phút, có audit người yêu cầu/người xác nhận và khóa
idempotency theo Telegram message để webhook gửi lại không làm cộng kho hai lần.

### Bước 1 — Khởi động hạ tầng

```bash
docker-compose up -d      # PostgreSQL :54321 · Redis :63791 · MinIO :9002
```

### Bước 2 — Tạo cấu trúc CSDL

```bash
npm run build
node dist/db/init.js
```

> ⚠️ **`init.ts` chạy `DROP SCHEMA public CASCADE` — xoá sạch dữ liệu, không hỏi lại.** Chỉ dùng cho môi trường mới. **Tuyệt đối không chạy trên production.** Việc chuyển sang công cụ migration có version còn nằm trong backlog.

### Bước 3 — Khởi chạy dịch vụ

```bash
npm run dev       # API Gateway :3000
npm run worker    # Queue worker xử lý tri thức (cửa sổ terminal khác)
```

Kiểm tra sống: `curl http://localhost:3000/healthz` · Kiểm tra sẵn sàng: `/readyz`

### Bước 4 — Kiểm thử

```bash
npm run typecheck   # tsc --noEmit
npm test            # 109 test case (jest + supertest + DB thật)
```

Giao diện:

| Trang | Đường dẫn |
|:---|:---|
| Web Admin | `http://localhost:3000/admin/index.html` |
| Widget chat khách | `http://localhost:3000/widget/index.html?key=pk_live_a3f9` |
| Telegram Mini App | `http://localhost:3000/tma/index.html` |

### Bước 5 — Smoke test 15 phút trước mỗi lần lên production

| # | Thao tác | Kết quả bắt buộc |
|:--:|:---|:---|
| 1 | Hỏi giá một sản phẩm | Giá khớp Medusa |
| 2 | Thêm 2 sản phẩm vào giỏ | Cả 2 vào giỏ, không mất món |
| 3 | **Gõ "shop ở đâu vậy em?"** | **Trả lời địa chỉ, TUYỆT ĐỐI KHÔNG tạo đơn** |
| 4 | "Cho anh thêm 2 hộp nữa" (giỏ đang có 5) | Giỏ thành **7**, không phải 2 |
| 5 | Cho SĐT + địa chỉ | Ghi nhận, không hỏi lại |
| 6 | "Chốt đơn đi em" | Tạo đơn, QR hiện **trong cùng lượt** |
| 7 | Kiểm mã chuyển khoản | Khác với đơn trước đó |
| 8 | "Cái này chữa tiểu đường được không?" | Claim Guard chặn, chuyển nhân viên |
| 9 | Nhân viên tiếp quản qua Telegram và trả lời | Khách nhận được tin |
| 10 | Hội thoại 25 lượt | Bot vẫn nhớ địa chỉ đã cho |
| 11 | `/ops <tên chai> mới nhập thêm 30 chai` trong group | Bot cho chọn đúng SKU, chỉ cộng sau khi bấm xác nhận; bấm lại không cộng lần hai |
| 12 | Gửi ảnh chai + caption `/ops mới nhập thêm 30 chai` | Bot đọc nhãn, đối chiếu catalog và hỏi xác nhận |

Bước 3, 4, 6 là ba sự cố đã xảy ra thật. Chúng ở đây vĩnh viễn.

---

## 📁 CẤU TRÚC DỰ ÁN

```
ChatBotAISAAS/
├── src/
│   ├── index.ts                    API Gateway (1.800+ dòng — đang chờ tách module)
│   ├── config/env.ts               Cấu hình fail-fast, tách secret khách/admin
│   ├── db/
│   │   ├── schema.sql              Thiết kế CSDL + 14 RLS policy
│   │   ├── client.ts               runInTenantContext — cô lập tenant
│   │   └── init.ts                 ⚠️ DROP SCHEMA — chỉ dùng cho môi trường mới
│   ├── services/
│   │   ├── search.ts               ★ Meilisearch, filter theo tenant, nới lỏng 3 bậc
│   │   ├── catalog.ts              ★ Làm giàu giá & tồn kho THẬT từ Medusa
│   │   ├── tools/schemas.ts        ★ 10 tool native function calling
│   │   ├── tools/validate.ts       ★ Lớp kiểm chứng phía server
│   │   ├── security.ts             ★ Headers + rate limit trên Redis
│   │   ├── http.ts                 ★ fetch có timeout bắt buộc
│   │   ├── checkoutIntent.ts       ★ Nhận diện ý định chốt đơn (có test hồi quy)
│   │   ├── priceCheck.ts           Bộ soi tiền
│   │   ├── claimGuard.ts           Tường lửa quảng cáo y tế (NĐ 15 / FDA / EFSA)
│   │   ├── llm.ts                  DeepSeek + system prompt
│   │   └── medusa.ts               Cầu nối Medusa
│   ├── *.spec.ts                   161 test case
│   └── worker.ts                   Queue worker nạp tri thức
├── public/widget/                  Widget chat nhúng website
├── tma/                            Console Telegram cho nhân viên
├── admin/                          Trang quản trị đa vai trò
└── Test/                           Báo cáo review, fix log, 1.000 kịch bản test
```
★ = mới trong phiên bản 2.0

**Dự án liên quan:** `../AI ECommerce Brain/apps/backend` (Medusa v2.17.2 — 15 route `/ai/*`, subscriber và job đồng bộ Meilisearch)

---

## 📚 TÀI LIỆU

Bộ tài liệu kỹ thuật đầy đủ nằm ở `../TechUpdate/` — **13 file đánh số, đọc theo thứ tự**:

| File | Nội dung |
|:---|:---|
| `01_QUYET_DINH_KIEN_TRUC_ADR.md` | **Nguồn sự thật duy nhất** — 14 quyết định đã chốt. Mọi con số, tên gọi, công nghệ chỉ định nghĩa ở đây |
| `02` → `09` | Kiến trúc · dữ liệu · Meilisearch · AI agent · backend · hiệu năng · bảo mật · frontend |
| `10_CHAT_LUONG_VA_RA_MAT.md` | 7 cổng chất lượng — **điều kiện được phép mở cửa** |
| `11_CHI_PHI.md` · `12_LO_TRINH_BACKLOG.md` | Mô hình chi phí · backlog có ước lượng |

Báo cáo review và nhật ký sửa lỗi nằm ở `Test/`:
`CodeReview_…` · `NghiemThu_Hotfix_…` · `CODING_LOG_…` · `REVIEW_Dot2_…` · `FIXLOG_Dot2_…`

---

## ⚠️ NHỮNG CÁI BẪY ĐÃ BIẾT

Ghi lại để người làm tiếp không mất thời gian dò lại:

| Bẫy | Chi tiết |
|:---|:---|
| **Repo không dùng git** | Bắt buộc backup thủ công trước mỗi lần sửa lớn. Các thư mục `_backup_truoc_khi_fix_*` là bản lưu |
| **Vá secret nửa vời còn nguy hiểm hơn** | Chỉ xoá `\|\| "REPLACE_WITH_NEW_SECRET"` mà không thêm `if (!KEY) return false` → khi biến không đặt, `undefined === undefined` = **true**, API mở toang |
| **Middleware Express gắn theo prefix không thấy `req.params`** | `app.use("/v1/admin", mw)` chạy **trước** khi router khớp route → `req.params` rỗng. Đây là lý do `assertTenantScope` từng hoàn toàn vô tác dụng |
| **Chuyển sang role PostgreSQL không bypass RLS sẽ làm sập `/v1/chat/session`** | `runCentralAdmin` đặt `app.tenant_id = ''`, mà `''::uuid` ném lỗi. Phải sửa policy **trước** khi đổi kết nối |
| **Giá trong Medusa v2 không nằm trên variant** | Nằm ở Price Set riêng. Đọc `variant.price_vnd` luôn cho `undefined` → mọi sản phẩm giá 0, bộ lọc giá vô nghĩa |
| **`query.graph` không phân trang thì bị giới hạn mặc định** | Job đối soát từng chỉ đồng bộ trang đầu rồi báo "hoàn tất" — lỗi im lặng nguy hiểm nhất |
| **Sự kiện tồn kho ≠ `product.updated`** | Tên đúng là `inventory.inventory-level.updated`, là **internal event chưa có tài liệu chính thức**, có thể đổi giữa các bản minor |
| **Bảng `product_tag` chưa được kiểm chứng** | Không chỗ nào trong repo dùng — tránh join, lấy tags từ `metadata` |
| **Jest không chạy được trong máy ảo Cowork** | `node_modules` cài từ Windows thiếu package trên Linux. Typecheck bằng `node node_modules/typescript/bin/tsc` |

---

## 🎯 VIỆC TIẾP THEO

**Ưu tiên 1 — mở khoá G3:** orchestrator + 10 tool handler + system prompt mới. Đây là mảnh ghép cuối để luồng chat chạy qua kiến trúc mới.

**Ưu tiên 2 — đóng G4:** role PostgreSQL `NOSUPERUSER NOBYPASSRLS` để RLS thật sự có hiệu lực.

**Chờ quyết định:** hướng phục vụ ảnh sản phẩm *(MinIO qua `http://IP:9000` sẽ bị trình duyệt chặn do mixed content — khuyến nghị phục vụ qua `/images/...` trên chính domain storefront)* · đơn giá DeepSeek để hoàn thiện mô hình chi phí.

**Chờ hạ tầng:** dựng Meilisearch và tạo index `products` · `npm install` + `npm run build` bên Medusa backend · chuẩn hoá dữ liệu 60.000 SKU.
