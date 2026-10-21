/**
 * Test cho bảng app_settings: sinh chuỗi, kiểm tra giá trị, phân quyền API, mã hoá khoá bí mật.
 * Không cần PostgreSQL: `pool` được thay bằng mock.
 */
import request from "supertest";
import express from "express";

jest.mock("./db/client", () => ({
  pool: { query: jest.fn() },
  runCentralAdmin: jest.fn(),
}));

import { pool, runCentralAdmin } from "./db/client";
import { routerCaiDat, routerCongKhai } from "./routes/caiDat";
import { sinhChuoi, kiemTraCaiDat, cheBiMat, datCaiDatChoTest, layCaiDat, LoiCaiDat } from "./services/caiDat";
import { encrypt, decrypt } from "./services/encryption";

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const query = () => pool.query as jest.Mock;

function appVoiNguoiDung(u: { role: string; tenantId: string | null }) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.adminUser = { username: "tester", ...u };
    next();
  });
  app.use("/settings", routerCaiDat);
  app.use("/public", routerCongKhai);
  return app;
}
const sup = () => appVoiNguoiDung({ role: "super_admin", tenantId: null });
const shop = () => appVoiNguoiDung({ role: "tenant_admin", tenantId: T1 });

describe("sinhChuoi", () => {
  it("hex theo số byte", () => {
    expect(sinhChuoi("hex", { soByte: 16 })).toMatch(/^[0-9a-f]{32}$/);
    expect(sinhChuoi("hex")).toMatch(/^[0-9a-f]{64}$/);
  });
  it("jwt_secret đủ 32 ký tự mà config/env yêu cầu", () => {
    expect(sinhChuoi("jwt_secret").length).toBeGreaterThanOrEqual(32);
  });
  it("encryption_key đúng 32 ký tự", () => {
    expect(sinhChuoi("encryption_key")).toMatch(/^[0-9a-f]{32}$/);
  });
  it("widget_key bắt đầu bằng pk_ và qua kiểm tra định dạng widget_key", () => {
    const k = sinhChuoi("widget_key");
    expect(k).toMatch(/^pk_[0-9a-f]{24}$/);
    expect(() => kiemTraCaiDat("widget_key", k)).not.toThrow();
  });
  it("api_key có tiền tố, uuid đúng dạng, hai lần gọi khác nhau", () => {
    expect(sinhChuoi("api_key", { tienTo: "svc" })).toMatch(/^svc_[0-9a-f]{64}$/);
    expect(sinhChuoi("uuid")).toMatch(/^[0-9a-f-]{36}$/);
    expect(sinhChuoi("hex")).not.toBe(sinhChuoi("hex"));
  });
  it("từ chối số byte ngoài 8–128", () => {
    expect(() => sinhChuoi("hex", { soByte: 4 })).toThrow(LoiCaiDat);
    expect(() => sinhChuoi("hex", { soByte: 500 })).toThrow(LoiCaiDat);
  });
});

describe("kiemTraCaiDat / cheBiMat", () => {
  it("khoá lạ bị từ chối — gồm các khoá đã chuyển sang Medusa (mỗi khoá một nơi)", () => {
    expect(() => kiemTraCaiDat("khong_co", "x")).toThrow(/không hợp lệ/);
    for (const k of ["hotline", "zalo_phone", "bank_name", "bank_account", "bank_bin", "shipping_provider"]) {
      expect(() => kiemTraCaiDat(k, "x")).toThrow(/không hợp lệ/);
    }
  });
  it("kiểm tra từng định dạng", () => {
    expect(() => kiemTraCaiDat("smtp_port", "70000")).toThrow();
    expect(() => kiemTraCaiDat("smtp_port", "587")).not.toThrow();
    expect(() => kiemTraCaiDat("widget_key", "khong_co_pk")).toThrow();
    expect(() => kiemTraCaiDat("widget_key", "pk_live_abcdef123456")).not.toThrow();
    expect(() => kiemTraCaiDat("telegram_webhook_secret", "ngan")).toThrow();
  });
  it("che bí mật, chỉ lộ 4 ký tự cuối", () => {
    expect(cheBiMat("sk-1234567890abcd")).toBe("••••abcd");
    expect(cheBiMat("ngan")).toBe("••••");
    expect(cheBiMat("")).toBe("");
  });
});

describe("layCaiDat trong môi trường test", () => {
  it("không đọc DB; lấy giá trị ghi đè hoặc mặc định", async () => {
    expect(await layCaiDat("deepseek_api_key")).toBe("");
    expect(await layCaiDat("smtp_port")).toBe("587");
    datCaiDatChoTest("deepseek_api_key", "sk-test");
    expect(await layCaiDat("deepseek_api_key")).toBe("sk-test");
    datCaiDatChoTest("deepseek_api_key", null);
    expect(query()).not.toHaveBeenCalled();
  });
});

describe("API /settings", () => {
  it("tenant_admin KHÔNG sửa được cấu hình nền tảng", async () => {
    const r = await request(shop()).put("/settings/deepseek_api_key").send({ value: "sk-abc" });
    expect(r.status).toBe(403);
    expect(query()).not.toHaveBeenCalled();
  });

  it("tenant_admin không thao tác được tenant khác", async () => {
    const r = await request(shop()).put(`/settings/widget_key?tenant_id=${T2}`).send({ value: "pk_live_abcdef123456" });
    expect(r.status).toBe(403);
  });

  it("super_admin: khoá lạ → 404, giá trị sai → 400, shop thiếu tenant_id → 400", async () => {
    expect((await request(sup()).put("/settings/khong_co").send({ value: "x" })).status).toBe(404);
    expect((await request(sup()).put("/settings/smtp_port").send({ value: "abc" })).status).toBe(400);
    expect((await request(sup()).put("/settings/widget_key").send({ value: "pk_live_abcdef123456" })).status).toBe(400);
    expect((await request(sup()).put("/settings/smtp_port").send({ value: 587 })).status).toBe(400);
  });

  it("khoá bí mật được MÃ HOÁ trước khi ghi DB", async () => {
    query().mockResolvedValue({ rows: [], rowCount: 1 });
    const r = await request(sup()).put("/settings/deepseek_api_key").send({ value: "sk-that-su-bi-mat" });
    expect(r.status).toBe(200);
    const [sql, params] = query().mock.calls[0];
    expect(sql).toMatch(/INSERT INTO app_settings/);
    expect(params[0]).toBeNull();
    expect(params[2]).not.toContain("sk-that-su-bi-mat");
    expect(decrypt(params[2])).toBe("sk-that-su-bi-mat");
    expect(params[3]).toBe(true);
  });

  it("khoá thường lưu nguyên văn, kèm tenant", async () => {
    query().mockResolvedValue({ rows: [], rowCount: 1 });
    query().mockResolvedValue({ rows: [{ "?column?": 1 }], rowCount: 1 });
    (runCentralAdmin as jest.Mock).mockImplementation(async (fn: any) => fn({ query: query() }));
    const r = await request(shop()).put("/settings/widget_key").send({ value: " pk_live_abcdef123456 " });
    expect(r.status).toBe(200);
    const ghi = query().mock.calls.find((c: any[]) => /INSERT INTO app_settings/.test(c[0]));
    expect(ghi[1]).toEqual([T1, "widget_key", "pk_live_abcdef123456", false, "tester"]);
  });

  it("giá trị rỗng = xoá", async () => {
    query().mockResolvedValue({ rows: [], rowCount: 1 });
    const r = await request(shop()).put("/settings/widget_key").send({ value: "" });
    expect(r.body.trang_thai).toBe("da_xoa");
    expect(query().mock.calls[0][0]).toMatch(/DELETE FROM app_settings/);
  });

  it("PUT hàng loạt: một khoá sai thì không ghi khoá nào", async () => {
    const r = await request(shop()).put("/settings").send({ settings: { widget_key: "pk_live_abcdef123456", smtp_port: "sai" } });
    expect(r.status).toBe(400);
    expect(query()).not.toHaveBeenCalled();
  });

  it("GET liệt kê che khoá bí mật và không lộ bản mã", async () => {
    query().mockResolvedValue({
      rows: [{ key: "deepseek_api_key", value: encrypt("sk-1234567890wxyz"), is_secret: true, updated_at: new Date(), updated_by: "a" }],
    });
    const r = await request(sup()).get("/settings?scope=platform");
    expect(r.status).toBe(200);
    const m = r.body.settings.find((x: any) => x.key === "deepseek_api_key");
    expect(m.gia_tri).toBe("••••wxyz");
    expect(m.da_dat).toBe(true);
    expect(JSON.stringify(r.body)).not.toContain("sk-1234567890wxyz");
    expect(r.body.settings.find((x: any) => x.key === "smtp_port")).toMatchObject({ da_dat: false, nguon: "mac_dinh", gia_tri: "587" });
  });

  it("tenant_admin không xem được scope=platform; schema ẩn khoá nền tảng", async () => {
    expect((await request(shop()).get("/settings?scope=platform")).status).toBe(403);
    const r = await request(shop()).get("/settings/schema");
    expect(r.body.settings.every((s: any) => s.pham_vi === "shop")).toBe(true);
  });
});

describe("POST /settings/generate", () => {
  it("chỉ sinh, không lưu", async () => {
    const r = await request(sup()).post("/settings/generate").send({ type: "hex", bytes: 16 });
    expect(r.status).toBe(200);
    expect(r.body.value).toMatch(/^[0-9a-f]{32}$/);
    expect(r.body.saved).toBe(false);
    expect(query()).not.toHaveBeenCalled();
  });
  it("type lạ → 400", async () => {
    expect((await request(sup()).post("/settings/generate").send({ type: "abc" })).status).toBe(400);
  });
  it("save_as telegram_webhook_secret lưu mã hoá", async () => {
    query().mockResolvedValue({ rows: [], rowCount: 1 });
    const r = await request(sup()).post("/settings/generate").send({ type: "hex", save_as: "telegram_webhook_secret" });
    expect(r.status).toBe(200);
    expect(r.body.saved).toBe(true);
    expect(decrypt(query().mock.calls[0][1][2])).toBe(r.body.value);
  });
  it("save_as khoá shop mà thiếu tenant → 400; tenant_admin sinh khoá nền tảng → 403", async () => {
    expect((await request(sup()).post("/settings/generate").send({ type: "widget_key", save_as: "widget_key" })).status).toBe(400);
    expect((await request(shop()).post("/settings/generate").send({ type: "hex", save_as: "smtp_pass" })).status).toBe(403);
  });
});

describe("GET /public/config", () => {
  it("tenant_id sai → 400", async () => {
    expect((await request(sup()).get("/public/config?tenant_id=abc")).status).toBe(400);
  });
  it("chỉ trả khoá công khai, không có khoá bí mật hay khoá nền tảng", async () => {
    datCaiDatChoTest("widget_key", "pk_live_abcdef123456", T1);
    datCaiDatChoTest("deepseek_api_key", "sk-nope");
    const r = await request(sup()).get(`/public/config?tenant_id=${T1}`);
    expect(r.status).toBe(200);
    expect(r.body.settings.widget_key).toBe("pk_live_abcdef123456");
    expect(Object.keys(r.body.settings)).toEqual(["widget_key"]);
    expect(JSON.stringify(r.body)).not.toContain("sk-nope");
    expect(r.headers["cache-control"]).toMatch(/max-age=30/);
    datCaiDatChoTest("widget_key", null, T1);
    datCaiDatChoTest("deepseek_api_key", null);
  });
});
