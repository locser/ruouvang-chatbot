/**
 * Test tool save_lead: khách để lại tên + SĐT để nhân viên gọi tư vấn.
 * CSDL và Telegram được thay bằng bản giả.
 */
import { xuLySaveLead, NguCanhTool } from "./services/tools/handlers";
import { kiemTraTenTool } from "./services/tools/validate";
import { SCHEMA_THEO_TEN } from "./services/tools/schemas";
import { PROMPT_CO_DINH } from "./services/tools/prompt";

jest.mock("./services/telegram", () => ({ guiThongBaoDonMoi: jest.fn(async () => 1) }));
import { guiThongBaoDonMoi } from "./services/telegram";

function nguCanh(dong: Record<string, unknown>) {
  const query = jest.fn(async (sql: string, _p?: unknown[]) =>
    sql.includes("INSERT INTO khach_tiem_nang") ? { rows: [dong] } : { rows: [] }
  );
  const chuyen = jest.fn();
  const nc = {
    tenantId: "t", conversationId: "c", client: { query }, medusa: null, cartId: null,
    tinNhanKhach: "", ghiNhanCartId() {}, yeuCauChuyenNguoi: chuyen,
  } as unknown as NguCanhTool;
  return { nc, query, chuyen };
}

describe("save_lead", () => {
  beforeEach(() => (guiThongBaoDonMoi as jest.Mock).mockClear());

  it("được đăng ký tool và có trong prompt", () => {
    expect(kiemTraTenTool("save_lead").hopLe).toBe(true);
    expect(SCHEMA_THEO_TEN.has("save_lead")).toBe(true);
    expect(PROMPT_CO_DINH).toContain("save_lead");
  });

  it("SĐT sai thì từ chối, không ghi DB, không báo nhân viên", async () => {
    const { nc, query } = nguCanh({});
    const kq: any = await xuLySaveLead(nc, { phone: "123" });
    expect(kq.ok).toBe(false);
    expect(query).not.toHaveBeenCalled();
    expect(guiThongBaoDonMoi).not.toHaveBeenCalled();
  });

  it("lead mới: chuẩn hoá SĐT, ghi DB, báo nhân viên, KHÔNG chuyển hội thoại", async () => {
    const { nc, query, chuyen } = nguCanh({ id: "L1", ten: "Lan", nhu_cau: "vang đỏ quà tặng", da_bao_nhan_vien: false });
    const kq: any = await xuLySaveLead(nc, { name: "Lan", phone: "+84 931-482-756", need: "vang đỏ quà tặng" });
    expect(kq.ok).toBe(true);
    expect((query.mock.calls[0] as any)[1][3]).toBe("0931482756");
    expect(guiThongBaoDonMoi).toHaveBeenCalledTimes(1);
    expect((guiThongBaoDonMoi as jest.Mock).mock.calls[0][1]).toContain("0931482756");
    expect(chuyen).not.toHaveBeenCalled();
  });

  it("đã báo rồi và số không đổi thì không báo lại", async () => {
    const { nc } = nguCanh({ id: "L1", ten: "Lan", nhu_cau: null, da_bao_nhan_vien: true });
    await xuLySaveLead(nc, { phone: "0931482756" });
    expect(guiThongBaoDonMoi).not.toHaveBeenCalled();
  });

  it("Telegram lỗi thì lead vẫn được lưu và tool vẫn ok", async () => {
    (guiThongBaoDonMoi as jest.Mock).mockRejectedValueOnce(new Error("telegram down"));
    const { nc } = nguCanh({ id: "L1", ten: null, nhu_cau: null, da_bao_nhan_vien: false });
    const kq: any = await xuLySaveLead(nc, { phone: "0931482756" });
    expect(kq.ok).toBe(true);
  });

  it("escape HTML trong tên/nhu cầu do khách nhập", async () => {
    const { nc } = nguCanh({ id: "L1", ten: "<b>x</b>", nhu_cau: "a&b", da_bao_nhan_vien: false });
    await xuLySaveLead(nc, { name: "<b>x</b>", phone: "0931482756", need: "a&b" });
    const noiDung = (guiThongBaoDonMoi as jest.Mock).mock.calls[0][1] as string;
    expect(noiDung).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(noiDung).toContain("a&amp;b");
  });
});

describe("save_lead → backend Medusa", () => {
  const MEDUSA = { enabled: true, baseUrl: "http://medusa.test", apiToken: "x" };
  afterEach(() => { (global as any).fetch = undefined; });

  it("đẩy sang /ai/leads rồi đánh dấu đã đồng bộ", async () => {
    const f = jest.fn(async () => ({ ok: true, status: 200, text: async () => "" }));
    (global as any).fetch = f;
    const { nc, query } = nguCanh({ id: "L1", ten: "Lan", nhu_cau: "vang đỏ", da_bao_nhan_vien: true });
    (nc as any).medusa = MEDUSA;
    await xuLySaveLead(nc, { name: "Lan", phone: "0931482756" });
    const [url, init] = f.mock.calls[0] as any;
    expect(url).toBe("http://medusa.test/ai/leads");
    expect(JSON.parse(init.body)).toMatchObject({ conversation_id: "c", phone: "0931482756" });
    expect(query.mock.calls.some((c: any) => String(c[0]).includes("da_dong_bo_backend = true"))).toBe(true);
  });

  it("backend lỗi thì lead vẫn lưu, KHÔNG đánh dấu đã đồng bộ", async () => {
    (global as any).fetch = jest.fn(async () => ({ ok: false, status: 502, text: async () => "bad gateway" }));
    const { nc, query } = nguCanh({ id: "L1", ten: null, nhu_cau: null, da_bao_nhan_vien: true });
    (nc as any).medusa = MEDUSA;
    const kq: any = await xuLySaveLead(nc, { phone: "0931482756" });
    expect(kq.ok).toBe(true);
    expect(query.mock.calls.some((c: any) => String(c[0]).includes("da_dong_bo_backend = true"))).toBe(false);
  });
});
