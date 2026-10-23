import {
  formatRevenueReport, formatLowStockAlert, formatPaymentErrorAlert, formatOutboxItem,
  formatVnd, chayMotVongOutbox, DispatcherDeps, ALLOWED_OUTBOX_TYPES, resetLogOutbox,
} from "./services/outboxDispatcher";

jest.mock("./db/client", () => ({ pool: { query: jest.fn() }, runInTenantContext: jest.fn() }));
jest.mock("./services/telegram", () => ({ guiThongBaoDonMoi: jest.fn() }));

const cfg: any = { enabled: true, baseUrl: "http://m", apiToken: "x" };
const NOW = new Date("2026-10-23T11:00:00.000Z").getTime(); // 18:00 giờ VN
const FRESH = new Date(NOW - 60_000).toISOString();
beforeEach(() => { resetLogOutbox(); jest.spyOn(console, "error").mockImplementation(() => undefined); jest.spyOn(console, "warn").mockImplementation(() => undefined); });

function makeDeps(over: Partial<DispatcherDeps> = {}) {
  const seen = new Set<string>();
  const deps: any = {
    listTenantIds: jest.fn(async () => ["t1"]),
    getConfig: jest.fn(async () => cfg),
    claim: jest.fn(async () => []),
    ack: jest.fn(async () => undefined),
    send: jest.fn(async () => 1),
    dedupeGet: jest.fn(async (k: string) => (seen.has(k) ? "1" : null)),
    dedupeSet: jest.fn(async (k: string) => { seen.add(k); }),
    now: () => NOW,
    ...over,
  };
  return deps as DispatcherDeps & Record<string, jest.Mock>;
}

describe("định dạng", () => {
  it("tiền", () => expect(formatVnd(1250000)).toBe("1.250.000đ"));

  it("doanh thu", () => {
    const t = formatRevenueReport({
      order_count: 5, revenue_all: 6250000, paid_order_count: 3, revenue_paid: 3000000,
      pending_count: 2, revenue_pending: 1250000, canceled_count: 1,
      from: "2026-10-22T17:00:00.000Z", to: "2026-10-23T11:00:00.000Z",
      top_products: [{ name: "A & B", qty: 4 }, { name: "C", qty: 3 }, { name: "D", qty: 2 }, { name: "E", qty: 1 }],
    }, { now: NOW });
    expect(t).toContain("Doanh thu hôm nay 23/10</b> (từ 0h đến 18:00)");
    expect(t).toContain("6.250.000đ (5 đơn)");
    expect(t).toContain("Đã thu tiền: 3.000.000đ");
    expect(t).toContain("Chờ duyệt: 1.250.000đ (2 đơn)");
    expect(t).toContain("Đơn huỷ: 1");
    expect(t).toContain("A &amp; B");
    expect(t).not.toContain("4. E");
  });

  it("báo cáo của ngày khác ghi rõ ngày", () => {
    const t = formatRevenueReport({ from: "2026-10-21T17:00:00.000Z", to: "2026-10-22T11:00:00.000Z" }, { now: NOW });
    expect(t).toContain("Doanh thu ngày 22/10");
    expect(t).not.toContain("hôm nay");
  });

  it("doanh thu thiếu trường thì bỏ dòng", () => {
    const t = formatRevenueReport({ order_count: 0, revenue_all: 0 });
    expect(t).not.toContain("huỷ");
    expect(t).not.toContain("Bán chạy");
  });

  it("hết hàng: tối đa 10 dòng + hướng dẫn", () => {
    const items = Array.from({ length: 20 }, (_, i) => ({ sku: `SKU${i}`, available: i }));
    const t = formatLowStockAlert({ count: 20, items });
    expect(t).toContain("Sắp hết hàng: 20 sản phẩm");
    expect(t.split("\n").filter((l) => l.startsWith("• ")).length).toBe(10);
    expect(t).toContain("• SKU0 — còn 0");
    expect(t).toContain("nhập thêm 12 chai");
  });

  it("lỗi thanh toán", () => {
    const t = formatPaymentErrorAlert({ count: 4, window_minutes: 10, sample: [{ display_id: 12 }, { display_id: 15 }] });
    expect(t).toContain("Có 4 đơn gặp lỗi thanh toán trong 10 phút qua");
    expect(t).toContain("#12, #15");
    expect(t).toContain("xem đơn");
    expect(t).not.toMatch(/requires_action|\{/);
  });

  it("loại lạ trả null", () => expect(formatOutboxItem({ loai: "chot_don", du_lieu: {} })).toBeNull());
});

describe("dispatcher", () => {
  it("chỉ xin 3 loại cho phép", () => {
    expect([...ALLOWED_OUTBOX_TYPES]).toEqual(["bao_cao_doanh_thu", "canh_bao_het_hang", "canh_bao_loi_thanh_toan"]);
  });

  it("gửi ok thì ack ok", async () => {
    const d = makeDeps({ claim: jest.fn(async () => [{ id: "1", loai: "canh_bao_loi_thanh_toan", tao_luc: FRESH, claimed_at: "C1", du_lieu: { count: 4, sample: [] } }]) });
    expect(await chayMotVongOutbox(d)).toBe(1);
    expect(d.send).toHaveBeenCalledTimes(1);
    expect(d.ack).toHaveBeenCalledWith(cfg, "1", true, undefined, "C1");
  });

  it("gửi lỗi thì ack false", async () => {
    const d = makeDeps({
      claim: jest.fn(async () => [{ id: "1", loai: "canh_bao_het_hang", tao_luc: FRESH, du_lieu: { items: [] } }]),
      send: jest.fn(async () => { throw new Error("boom"); }),
    });
    await chayMotVongOutbox(d);
    expect(d.ack).toHaveBeenCalledWith(cfg, "1", false, expect.stringContaining("boom"), undefined);
  });

  it("không có nơi nhận (gửi 0) thì ack false", async () => {
    const d = makeDeps({
      claim: jest.fn(async () => [{ id: "1", loai: "canh_bao_het_hang", tao_luc: FRESH, du_lieu: { items: [] } }]),
      send: jest.fn(async () => 0),
    });
    await chayMotVongOutbox(d);
    expect(d.ack).toHaveBeenCalledWith(cfg, "1", false, "no_recipient", undefined);
  });

  it("loại cấm/lạ: không gửi, ack unsupported_type", async () => {
    const d = makeDeps({ claim: jest.fn(async () => [{ id: "9", loai: "gui_email_marketing", du_lieu: { email: "a@b" } }]) });
    await chayMotVongOutbox(d);
    expect(d.send).not.toHaveBeenCalled();
    expect(d.ack).toHaveBeenCalledWith(cfg, "9", false, "unsupported_type", undefined);
  });

  it("dedupe: tin đã gửi không gửi lại nhưng vẫn ack ok", async () => {
    const item = { id: "7", loai: "canh_bao_het_hang", tao_luc: FRESH, du_lieu: { items: [] } };
    const d = makeDeps({ claim: jest.fn(async () => [item]) });
    await chayMotVongOutbox(d);
    await chayMotVongOutbox(d);
    expect(d.send).toHaveBeenCalledTimes(1);
    expect(d.ack).toHaveBeenCalledTimes(2);
    expect(d.ack).toHaveBeenLastCalledWith(cfg, "7", true, undefined, undefined);
  });

  it("tenant chưa cấu hình bị bỏ qua êm; tenant lỗi không chặn tenant khác", async () => {
    const cfgOf = (t: string): any => ({ enabled: true, baseUrl: `http://${t}`, apiToken: "x" });
    const d = makeDeps({
      listTenantIds: jest.fn(async () => ["a", "b", "c"]),
      getConfig: jest.fn(async (t: string) => (t === "a" ? null : cfgOf(t))),
      claim: jest.fn(async () => {
        if ((d.claim as jest.Mock).mock.calls.length === 1) throw new Error("medusa down");
        return [{ id: "5", loai: "canh_bao_het_hang", tao_luc: FRESH, du_lieu: { items: [] } }];
      }),
    });
    expect(await chayMotVongOutbox(d)).toBe(1);
    expect(d.claim).toHaveBeenCalledTimes(2);
    expect(d.send).toHaveBeenCalledWith("c", expect.any(String));
  });

  it("nhiều tenant chung baseUrl (khác hoa thường, dấu / cuối): bỏ qua cả nhóm, log một lần", async () => {
    const urls: Record<string, string> = { a: "http://Localhost:9000/", b: "http://localhost:9000", c: "http://other:9000" };
    const d = makeDeps({
      listTenantIds: jest.fn(async () => ["a", "b", "c"]),
      getConfig: jest.fn(async (t: string) => ({ enabled: true, baseUrl: urls[t], apiToken: "x" } as any)),
      claim: jest.fn(async () => []),
    });
    await chayMotVongOutbox(d);
    await chayMotVongOutbox(d);
    expect(d.claim).toHaveBeenCalledTimes(2); // chỉ tenant c, hai vòng
    expect((d.claim as jest.Mock).mock.calls.every((c) => c[0].baseUrl === "http://other:9000")).toBe(true);
    expect((console.error as jest.Mock).mock.calls.filter((c) => /dùng chung Medusa/.test(String(c[0]))).length).toBe(1);
  });

  it("tin quá hạn không gửi, ack ok", async () => {
    const cu = (h: number) => new Date(NOW - h * 3600_000).toISOString();
    const d = makeDeps({
      claim: jest.fn(async () => [
        { id: "r", loai: "bao_cao_doanh_thu", tao_luc: cu(37), claimed_at: "X", du_lieu: {} },
        { id: "s", loai: "canh_bao_het_hang", tao_luc: cu(13), du_lieu: { items: [] } },
        { id: "p", loai: "canh_bao_loi_thanh_toan", tao_luc: cu(3), du_lieu: { count: 4 } },
      ]),
    });
    await chayMotVongOutbox(d);
    expect(d.send).not.toHaveBeenCalled();
    expect(d.ack).toHaveBeenCalledWith(cfg, "r", true, undefined, "X");
    expect(d.ack).toHaveBeenCalledWith(cfg, "s", true, undefined, undefined);
    expect(d.ack).toHaveBeenCalledWith(cfg, "p", true, undefined, undefined);
  });

  it("tin còn hạn (doanh thu 35h, lỗi thanh toán 1h) vẫn gửi", async () => {
    const cu = (h: number) => new Date(NOW - h * 3600_000).toISOString();
    const d = makeDeps({
      claim: jest.fn(async () => [
        { id: "r", loai: "bao_cao_doanh_thu", tao_luc: cu(35), du_lieu: {} },
        { id: "p", loai: "canh_bao_loi_thanh_toan", tao_luc: cu(1), du_lieu: { count: 4 } },
      ]),
    });
    await chayMotVongOutbox(d);
    expect(d.send).toHaveBeenCalledTimes(2);
  });

  it("no_recipient chỉ log một lần mỗi giờ mỗi tenant", async () => {
    let t = NOW;
    const d = makeDeps({
      now: () => t,
      claim: jest.fn(async () => [{ id: String(Math.random()), loai: "canh_bao_het_hang", tao_luc: new Date(t).toISOString(), du_lieu: { items: [] } }]),
      send: jest.fn(async () => 0),
    });
    const dem = () => (console.error as jest.Mock).mock.calls.filter((c) => /chưa có người nhận/.test(String(c[0]))).length;
    await chayMotVongOutbox(d);
    t += 60_000;
    await chayMotVongOutbox(d);
    expect(dem()).toBe(1);
    t += 3600_000;
    await chayMotVongOutbox(d);
    expect(dem()).toBe(2);
  });

  it("không chạy chồng", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const d = makeDeps({ listTenantIds: jest.fn(async () => { await gate; return []; }) });
    const p1 = chayMotVongOutbox(d);
    expect(await chayMotVongOutbox(d)).toBe(-1);
    release();
    await p1;
    expect(d.listTenantIds).toHaveBeenCalledTimes(1);
  });
});
