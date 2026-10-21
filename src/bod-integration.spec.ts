/**
 * BỘ TEST TÍCH HỢP HTTP + E2E (REGRESSION) — cần PostgreSQL + Redis + đã seed.
 * File MỚI phục vụ nghiệm thu BOD. KHÔNG sửa code nguồn.
 * Chạy thẳng vào Express `app` bằng supertest (không cần mở port).
 * LLM bị ép về chế độ mock offline (DEEPSEEK_API_KEY=mock) để không gọi API thật.
 */
import request from "supertest";
import crypto from "crypto";
import { app } from "./index";
import { pool } from "./db/client";
import { taoVectorEmbedding } from "./services/embedding";

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

// Tenant seed sẵn
const SEED_TENANT = "da97c3f1-41d7-4ef7-9e4e-adefca37c665";
const SEED_KEY = "pk_live_a3f9";

// Tenant E2E riêng cho kiểm thử tường lửa (UUID ngẫu nhiên để re-run được nhiều lần)
const T_PRICE = crypto.randomUUID();
const K_PRICE = "pk_price_" + crypto.randomUUID().slice(0, 8);
const T_CLAIM = crypto.randomUUID();
const K_CLAIM = "pk_claim_" + crypto.randomUUID().slice(0, 8);

async function seedFirewallTenant(id: string, key: string, nganh: string, chunkText: string) {
  await pool.query(`INSERT INTO tenant (id, ten, nganh) VALUES ($1,$2,$3)`, [id, `E2E ${nganh}`, nganh]);
  await pool.query(`INSERT INTO tenant_key (tenant_id, khoa_bam, origin_allowlist) VALUES ($1,$2,ARRAY['*'])`, [id, sha256(key)]);
  await pool.query(`INSERT INTO credit_balance (tenant_id, so_du, da_tang) VALUES ($1,1000,1000)`, [id]);
  const doc = await pool.query(
    `INSERT INTO kb_document (tenant_id, ten_file, loai, kich_thuoc, checksum) VALUES ($1,'e2e.txt','txt',10,$2) RETURNING id`,
    [id, "chk_" + id.slice(0, 8)]
  );
  const emb = await taoVectorEmbedding(chunkText);
  await pool.query(
    `INSERT INTO kb_chunk (tenant_id, document_id, noi_dung, embedding, meta) VALUES ($1,$2,$3,$4::vector,'{}')`,
    [id, doc.rows[0].id, chunkText, JSON.stringify(emb)]
  );
}

async function startSession(key: string, visitorId: string) {
  const res = await request(app)
    .post("/v1/chat/session")
    .set("X-Chatbot-Key", key)
    .send({ visitorId, currencyCode: "VND", locale: "vi-VN" });
  return res;
}

// Endpoint /message gọi res.end() TRƯỚC khi COMMIT (commit ngay sau khi trả lời khách).
// Poll để chờ side-effect DB commit xong, tránh race trong test.
async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, tries = 30, delay = 60): Promise<T> {
  let v = await fn();
  for (let i = 0; i < tries && !ok(v); i++) {
    await new Promise((r) => setTimeout(r, delay));
    v = await fn();
  }
  return v;
}
const convState = (id: string) =>
  pool.query(`SELECT mode, ly_do_leo_thang FROM conversation WHERE id = $1`, [id]).then((r) => r.rows[0]);

beforeAll(async () => {
  await seedFirewallTenant(T_PRICE, K_PRICE, "thoi_trang", "Giá tham khảo cho combo là khoảng $29 USD tùy thời điểm.");
  await seedFirewallTenant(T_CLAIM, K_CLAIM, "thuc_pham", "Sản phẩm men vi sinh này giúp chữa bệnh tiểu đường rất hiệu quả.");

  // Từ 28/07/2026 mỗi shop có bot Telegram riêng: `/v1/auth/tg-login` duyệt
  // danh sách bot đọc từ `tenant_setting.telegram_bot_token`. Không shop nào
  // cấu hình token thì danh sách ứng viên RỖNG, vòng lặp kiểm chữ ký không
  // chạy lần nào và mọi lần đăng nhập Mini App trả 401 — kể cả đường bypass
  // dưới Jest. Vì vậy fixture phải cấp cho một shop một token.
  //
  // Giá trị token không quan trọng: dưới Jest `verifyTelegramSignature` chấp
  // nhận initData bắt đầu bằng "bypass_tg_" mà không đụng tới token thật.
  await pool.query(
    `INSERT INTO tenant_setting (tenant_id, telegram_bot_token, telegram_bot_username)
     VALUES ($1, 'e2e_token_gia_khong_dung_that', 'E2E_Test_Bot')
     ON CONFLICT (tenant_id) DO UPDATE
       SET telegram_bot_token = EXCLUDED.telegram_bot_token,
           telegram_bot_username = EXCLUDED.telegram_bot_username`,
    [T_PRICE]
  );

  // TC-165 đăng nhập Mini App bằng telegram_id 123456789. Bản seed hiện tại
  // chỉ có 3 nick thật của shop Ẩm Thực Xứ Huế (5829502136, 8666546209,
  // 1287523218), nên nick kiểm thử phải do fixture tự tạo — không dựa vào dữ
  // liệu seed vốn thay đổi theo từng đợt onboard shop.
  await pool.query(
    `INSERT INTO admin_user (tenant_id, username, password_hash, email, telegram_id)
     VALUES ($1, $2, 'x', $3, '123456789')
     ON CONFLICT (telegram_id) DO NOTHING`,
    [T_PRICE, `e2e_tma_${T_PRICE.slice(0, 8)}`, `e2e_tma_${T_PRICE.slice(0, 8)}@example.com`]
  );
});

afterAll(async () => {
  for (const t of [T_PRICE, T_CLAIM]) {
    await pool.query(`DELETE FROM tenant WHERE id = $1`, [t]).catch(() => {});
  }
  await pool.end().catch(() => {});
});

describe("NHÓM 1 — Session & Auth (HTTP)", () => {
  test("TC-009: thiếu X-Chatbot-Key -> 400", async () => {
    const res = await request(app).post("/v1/chat/session").send({ visitorId: "v1" });
    expect(res.status).toBe(400);
  });
  test("TC-010: API key sai -> 401", async () => {
    const res = await request(app).post("/v1/chat/session").set("X-Chatbot-Key", "pk_wrong_key").send({ visitorId: "v1" });
    expect(res.status).toBe(401);
  });
  test("TC-001: session hợp lệ -> trả session_token + conversation_id", async () => {
    const res = await startSession(SEED_KEY, "visitor_tc001");
    expect(res.status).toBe(200);
    expect(res.body.session_token).toBeTruthy();
    expect(res.body.conversation_id).toBeTruthy();
  });
  test("TC-025: currency_code mặc định = VND khi không truyền", async () => {
    const res = await request(app).post("/v1/chat/session").set("X-Chatbot-Key", SEED_KEY).send({ visitorId: "visitor_tc025" });
    expect(res.status).toBe(200);
    expect(res.body.tenant.currency_code).toBe("VND");
  });
  test("TC-012/TC-013: token sai/giả mạo -> 401", async () => {
    const res = await request(app).post("/v1/chat/message").set("Authorization", "Bearer not.a.valid.token").send({ text: "hi" });
    expect(res.status).toBe(401);
  });
  test("TC-019: tin nhắn rỗng -> 400", async () => {
    const s = await startSession(SEED_KEY, "visitor_tc019");
    const res = await request(app).post("/v1/chat/message").set("Authorization", `Bearer ${s.body.session_token}`).send({ text: "" });
    expect(res.status).toBe(400);
  });
});

describe("NHÓM 2/7 — Chat, kịch bản cứng, trừ credit & sổ cái", () => {
  test("TC-029/TC-143: kịch bản cứng 'giờ mở cửa' -> model 'cung', 0 credit", async () => {
    const s = await startSession(SEED_KEY, "visitor_hard");
    const res = await request(app).post("/v1/chat/message").set("Authorization", `Bearer ${s.body.session_token}`).send({ text: "cho hỏi giờ mở cửa shop?" });
    expect(res.text).toContain('"model":"cung"');
    expect(res.text).toContain('"credit_da_tru":0');
  });
  test("TC-026/TC-028/TC-041/TC-141: câu thường -> SSE 'xong', trừ 0.2 credit, ghi message + ledger", async () => {
    const s = await startSession(SEED_KEY, "visitor_paid");
    const convId = s.body.conversation_id;
    const res = await request(app).post("/v1/chat/message").set("Authorization", `Bearer ${s.body.session_token}`).send({ text: "Áo thun size L còn hàng không ạ?" });
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.text).toContain('"type":"xong"');
    expect(res.text).toContain('"credit_da_tru":0.2');
    const ledN = await waitFor(
      () => pool.query(`SELECT COUNT(*)::int AS n FROM credit_ledger WHERE conversation_id = $1 AND loai_hanh_dong='chat'`, [convId]).then((r) => r.rows[0].n),
      (n) => n >= 1
    );
    expect(ledN).toBeGreaterThanOrEqual(1);
    const msgN = await waitFor(
      () => pool.query(`SELECT COUNT(*)::int AS n FROM message WHERE conversation_id = $1 AND vai_tro='bot'`, [convId]).then((r) => r.rows[0].n),
      (n) => n >= 1
    );
    expect(msgN).toBeGreaterThanOrEqual(1);
  });
  test("TC-017: lấy lịch sử chat theo token hợp lệ", async () => {
    const s = await startSession(SEED_KEY, "visitor_hist");
    await request(app).post("/v1/chat/message").set("Authorization", `Bearer ${s.body.session_token}`).send({ text: "chào shop" });
    const res = await request(app).get("/v1/chat/history").set("Authorization", `Bearer ${s.body.session_token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
  });
});

describe("NHÓM 4/5 — E2E chặn tường lửa (Price Checker & Claim Guard)", () => {
  test("TC-089/090: bot lỡ nêu $USD trong kênh VND -> CHẶN, escalate 'bot_quy_doi_tien'", async () => {
    const s = await startSession(K_PRICE, "visitor_price");
    const convId = s.body.conversation_id;
    const res = await request(app).post("/v1/chat/message").set("Authorization", `Bearer ${s.body.session_token}`).send({ text: "cho mình hỏi giá combo bao nhiêu" });
    expect(res.text).toContain("chan_tien");
    const conv = await waitFor(() => convState(convId), (r) => r?.mode === "CHO_NGUOI");
    expect(conv.mode).toBe("CHO_NGUOI");
    expect(conv.ly_do_leo_thang).toBe("bot_quy_doi_tien");
  });
  test("TC-096/109/111: bot lỡ nói 'chữa bệnh' -> CHẶN claim, escalate 'claim_guard_chan'", async () => {
    const s = await startSession(K_CLAIM, "visitor_claim");
    const convId = s.body.conversation_id;
    const res = await request(app).post("/v1/chat/message").set("Authorization", `Bearer ${s.body.session_token}`).send({ text: "sản phẩm này có tác dụng gì" });
    expect(res.text).toContain("chan_claims");
    const conv = await waitFor(() => convState(convId), (r) => r?.mode === "CHO_NGUOI");
    expect(conv.mode).toBe("CHO_NGUOI");
    expect(conv.ly_do_leo_thang).toBe("claim_guard_chan");
  });
});

describe("NHÓM 6 — Tiếp quản người thật (Human Takeover)", () => {
  test("TC-117: tiếp quản qua API -> mode NGUOI", async () => {
    const s = await startSession(SEED_KEY, "visitor_takeover1");
    const convId = s.body.conversation_id;
    const res = await request(app).post(`/v1/admin/conversations/${convId}/takeover`).send({ tenantId: SEED_TENANT, operatorId: "op_A" });
    expect(res.status).toBe(200);
    const conv = await pool.query(`SELECT mode, assigned_to FROM conversation WHERE id = $1`, [convId]);
    expect(conv.rows[0].mode).toBe("NGUOI");
    expect(conv.rows[0].assigned_to).toBe("op_A");
  });
  test("TC-118: nhân viên thứ 2 tiếp quản cùng phiên -> 409 (khóa lạc quan)", async () => {
    const s = await startSession(SEED_KEY, "visitor_takeover2");
    const convId = s.body.conversation_id;
    await request(app).post(`/v1/admin/conversations/${convId}/takeover`).send({ tenantId: SEED_TENANT, operatorId: "op_A" });
    const res2 = await request(app).post(`/v1/admin/conversations/${convId}/takeover`).send({ tenantId: SEED_TENANT, operatorId: "op_B" });
    expect(res2.status).toBe(409);
  });
  test("TC-120/TC-023: nhân viên reply + khách nhắn khi mode NGUOI bị chặn AI", async () => {
    const s = await startSession(SEED_KEY, "visitor_takeover3");
    const convId = s.body.conversation_id;
    await request(app).post(`/v1/admin/conversations/${convId}/takeover`).send({ tenantId: SEED_TENANT, operatorId: "op_A" });
    const reply = await request(app).post(`/v1/admin/conversations/${convId}/reply`).send({ tenantId: SEED_TENANT, text: "Nhân viên đây ạ" });
    expect(reply.status).toBe(200);
    // Khách gửi tin khi mode=NGUOI -> bị chặn AI
    const msg = await request(app).post("/v1/chat/message").set("Authorization", `Bearer ${s.body.session_token}`).send({ text: "còn ai không" });
    expect(msg.status).toBe(400);
  });
  test("TC-121: trả phiên về Bot -> mode BOT", async () => {
    const s = await startSession(SEED_KEY, "visitor_takeover4");
    const convId = s.body.conversation_id;
    await request(app).post(`/v1/admin/conversations/${convId}/takeover`).send({ tenantId: SEED_TENANT, operatorId: "op_A" });
    const res = await request(app).post(`/v1/admin/conversations/${convId}/release`).send({ tenantId: SEED_TENANT });
    expect(res.status).toBe(200);
    const conv = await pool.query(`SELECT mode, assigned_to FROM conversation WHERE id = $1`, [convId]);
    expect(conv.rows[0].mode).toBe("BOT");
    expect(conv.rows[0].assigned_to).toBeNull();
  });
});

describe("NHÓM 3 — Cấu hình Medusa (mã hóa AES-256)", () => {
  test("TC-069: bật Medusa thiếu baseUrl/apiToken -> 400", async () => {
    const res = await request(app).post(`/v1/admin/tenants/${SEED_TENANT}/platform/medusa`).send({ enabled: true });
    expect(res.status).toBe(400);
  });
  test("TC-066: bật Medusa hợp lệ -> lưu mã hóa, hoạt động", async () => {
    const res = await request(app).post(`/v1/admin/tenants/${SEED_TENANT}/platform/medusa`).send({ enabled: true, baseUrl: "http://localhost:9000", apiToken: "sk_medusa_test", defaultCarrier: "ghn" });
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
  });
  test("TC-068: đọc cấu hình Medusa -> KHÔNG lộ raw token", async () => {
    const res = await request(app).get(`/v1/admin/tenants/${SEED_TENANT}/platform/medusa`);
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain("sk_medusa_test");
  });
  test("TC-067: tắt Medusa -> enabled false", async () => {
    const res = await request(app).post(`/v1/admin/tenants/${SEED_TENANT}/platform/medusa`).send({ enabled: false });
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
  });
});

describe("NHÓM 9 — Admin, Multi-tenant, KB upload", () => {
  test("TC-176: đăng nhập admin đúng mật khẩu -> token + role super_admin", async () => {
    const res = await request(app).post("/v1/auth/login").send({ username: "admin", password: "admin123" });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe("super_admin");
  });
  test("TC-177: đăng nhập sai mật khẩu -> 401", async () => {
    const res = await request(app).post("/v1/auth/login").send({ username: "admin", password: "sai_mat_khau" });
    expect(res.status).toBe(401);
  });
  test("TC-182/TC-147/TC-151: tạo tenant -> nạp credit -> xem sổ cái", async () => {
    const create = await request(app).post("/v1/admin/tenants").send({ ten: "Shop QA", nganh: "wellness", bac_du_lieu: 1, initialCredits: 500 });
    expect(create.status).toBe(200);
    const tid = create.body.tenant_id;
    const topup = await request(app).post(`/v1/admin/tenants/${tid}/credits`).send({ amount: 250 });
    expect(topup.status).toBe(200);
    const led = await request(app).get(`/v1/admin/tenants/${tid}/ledgers`);
    expect(led.status).toBe(200);
    expect(led.body.some((r: any) => r.action === "nap")).toBe(true);
    await pool.query(`DELETE FROM tenant WHERE id=$1`, [tid]).catch(() => {});
  });
  test("TC-185/TC-186: nạp KB -> queued; nạp trùng nội dung -> 409", async () => {
    const content = "SKU,Ten,Gia\nSKU1,Ba Lọc,30000\n# run-" + crypto.randomUUID();
    const up1 = await request(app).post("/v1/admin/kb/upload").send({ tenantId: SEED_TENANT, filename: "qa_kb.csv", content });
    expect(up1.status).toBe(200);
    expect(up1.body.status).toBe("queued");
    const up2 = await request(app).post("/v1/admin/kb/upload").send({ tenantId: SEED_TENANT, filename: "qa_kb.csv", content });
    expect(up2.status).toBe(409);
  });
});

describe("NHÓM 1/8 — Auth nâng cao & Telegram Mini App", () => {
  test("TC-165/TC-163: TMA login bypass dev + user hợp lệ -> token", async () => {
    const initData = "bypass_tg_1&user=" + encodeURIComponent(JSON.stringify({ id: 123456789, first_name: "QA" }));
    const res = await request(app).post("/v1/auth/tg-login").send({ initData });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
  });
  test("TC-164: TMA login chữ ký HMAC sai -> 401", async () => {
    const initData = "user=" + encodeURIComponent(JSON.stringify({ id: 1 })) + "&hash=deadbeef";
    const res = await request(app).post("/v1/auth/tg-login").send({ initData });
    expect(res.status).toBe(401);
  });
  test("TC-166: TMA login Telegram ID chưa liên kết -> 404", async () => {
    const initData = "bypass_tg_1&user=" + encodeURIComponent(JSON.stringify({ id: 999000111 }));
    const res = await request(app).post("/v1/auth/tg-login").send({ initData });
    expect(res.status).toBe(404);
  });
  test("TC-179: quên mật khẩu (email không tồn tại) -> không tiết lộ, vẫn success", async () => {
    const res = await request(app).post("/v1/auth/forgot-password").send({ email: "khong-ton-tai@example.com" });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
  test("TC-181: reset mật khẩu token sai/hết hạn -> 400", async () => {
    const res = await request(app).post("/v1/auth/reset-password").send({ token: "token_khong_hop_le", newPassword: "newpass123" });
    expect(res.status).toBe(400);
  });
});
