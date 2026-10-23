/**
 * Test tool get_store_locations: gọi đúng endpoint, lọc area không dấu, cache, lỗi backend.
 */
import { xuLyGetStoreLocations, NguCanhTool } from "./services/tools/handlers";
import { kiemTraTenTool } from "./services/tools/validate";
import { SCHEMA_THEO_TEN } from "./services/tools/schemas";
import { PROMPT_CO_DINH } from "./services/tools/prompt";
import { cache } from "./services/cache";

const STORES = [
  { id: "1", name: "Chi nhánh Quận 1", address: "12 Lê Lợi, Quận 1, TP.HCM", phone: "0901234567", opening_hours: "8h-22h", maps_url: "https://maps/1" },
  { id: "2", name: "Chi nhánh Thủ Đức", address: "5 Võ Văn Ngân, Thủ Đức", phone: null, opening_hours: null, maps_url: null },
];

function nc(tenantId = "t1", medusa: any = { baseUrl: "http://medusa" }) {
  return { tenantId, conversationId: "c", client: {}, medusa, cartId: null, tinNhanKhach: "",
    ghiNhanCartId() {}, yeuCauChuyenNguoi() {} } as unknown as NguCanhTool;
}

const fetchMock = jest.fn();
beforeEach(async () => {
  await cache.flush();
  fetchMock.mockReset();
  (global as any).fetch = fetchMock;
});

const ok = (stores: unknown) => ({ ok: true, status: 200, json: async () => ({ stores }) });

describe("get_store_locations", () => {
  it("được đăng ký, schema không có tham số bắt buộc, có trong prompt", () => {
    expect(kiemTraTenTool("get_store_locations").hopLe).toBe(true);
    expect((SCHEMA_THEO_TEN.get("get_store_locations")!.function.parameters as any).required).toEqual([]);
    expect(PROMPT_CO_DINH).toContain("get_store_locations");
  });

  it("gọi GET /ai/store-locations kèm secret và trả các trường gọn", async () => {
    fetchMock.mockResolvedValue(ok(STORES));
    const kq: any = await xuLyGetStoreLocations(nc("tA"), {});
    expect(fetchMock.mock.calls[0][0]).toBe("http://medusa/ai/store-locations");
    expect(fetchMock.mock.calls[0][1].method).toBe("GET");
    expect(fetchMock.mock.calls[0][1].headers["x-ai-secret-key"]).toBeTruthy();
    expect(kq.ok).toBe(true);
    expect(kq.stores).toHaveLength(2);
    expect(Object.keys(kq.stores[0]).sort()).toEqual(["address", "maps_url", "name", "opening_hours", "phone"]);
  });

  it("lọc area không dấu, không phân biệt hoa thường", async () => {
    fetchMock.mockResolvedValue(ok(STORES));
    const kq: any = await xuLyGetStoreLocations(nc("tB"), { area: "thu duc" });
    expect(kq.stores.map((s: any) => s.name)).toEqual(["Chi nhánh Thủ Đức"]);
    const kq2: any = await xuLyGetStoreLocations(nc("tB"), { area: "QUẬN 1" });
    expect(kq2.stores).toHaveLength(1);
  });

  it("area khớp theo ranh giới từ: quận 1 không khớp quận 10/12; q1, q.1 khớp quận 1", async () => {
    fetchMock.mockResolvedValue(ok([
      ...STORES,
      { id: "3", name: "CN Quận 10", address: "1 Ba Tháng Hai, Quận 10", phone: null, opening_hours: null, maps_url: null },
      { id: "4", name: "CN Quận 12", address: "2 Tô Ký, Quận 12", phone: null, opening_hours: null, maps_url: null },
    ]));
    for (const a of ["quận 1", "Q1", "q.1"]) {
      const kq: any = await xuLyGetStoreLocations(nc("tL"), { area: a });
      expect(kq.stores.map((s: any) => s.name)).toEqual(["Chi nhánh Quận 1"]);
    }
  });

  it("bỏ phần tử address rỗng; cache hỏng (không phải mảng) thì gọi lại backend", async () => {
    fetchMock.mockResolvedValue(ok([{ ...STORES[0], id: "x", address: "  " }, STORES[1]]));
    const kq: any = await xuLyGetStoreLocations(nc("tM"), {});
    expect(kq.stores).toHaveLength(1);
    await cache.set("tenant:tN:store-locations:all", JSON.stringify({ bad: 1 }), 60);
    const kq2: any = await xuLyGetStoreLocations(nc("tN"), {});
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(kq2.ok).toBe(true);
  });

  it("area không khớp: trả đủ danh sách kèm lưu ý", async () => {
    fetchMock.mockResolvedValue(ok(STORES));
    const kq: any = await xuLyGetStoreLocations(nc("tC"), { area: "Hà Nội" });
    expect(kq.stores).toHaveLength(2);
    expect(kq.luu_y).toContain("Hà Nội");
  });

  it("cache theo tenant: lần 2 không gọi lại backend, tenant khác thì gọi", async () => {
    fetchMock.mockResolvedValue(ok(STORES));
    await xuLyGetStoreLocations(nc("tD"), {});
    await xuLyGetStoreLocations(nc("tD"), { area: "quan 1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await xuLyGetStoreLocations(nc("tE"), {});
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("danh sách rỗng: báo chưa có thông tin, không cache", async () => {
    fetchMock.mockResolvedValue(ok([]));
    const kq: any = await xuLyGetStoreLocations(nc("tF"), {});
    expect(kq.ok).toBe(false);
    expect(kq.ma_loi).toBe("NO_STORE_INFO");
    expect(kq.thong_diep_cho_khach).toContain("chuyển nhân viên");
    expect(kq.thong_diep_cho_khach).not.toMatch(/gọi hotline/i);
    await xuLyGetStoreLocations(nc("tF"), {});
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("backend lỗi (HTTP 500 hoặc ném lỗi): không bịa, không ném exception", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
    const a: any = await xuLyGetStoreLocations(nc("tG"), {});
    expect(a.ok).toBe(false);
    expect(a.stores).toBeUndefined();
    fetchMock.mockRejectedValueOnce(new Error("network"));
    const b: any = await xuLyGetStoreLocations(nc("tG"), {});
    expect(b.ma_loi).toBe("NO_STORE_INFO");
  });

  it("tenant chưa cấu hình Medusa: báo chưa có thông tin, không gọi mạng", async () => {
    const kq: any = await xuLyGetStoreLocations(nc("tH", null), {});
    expect(kq.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
