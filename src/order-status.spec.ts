/**
 * Test cho luồng khách hỏi trạng thái đơn: handler get_order_status
 * -> medusaTraCuuDonHang -> POST /ai/order-status.
 *
 * Backend được thay bằng fetch giả, nên test không cần Medusa, Postgres hay Docker.
 */
import { xuLyGetOrderStatus, NguCanhTool } from "./services/tools/handlers";
import { kiemTraTenTool } from "./services/tools/validate";

const MEDUSA = { enabled: true, baseUrl: "http://medusa.test", apiToken: "x" };

function nguCanh(medusa: any = MEDUSA): NguCanhTool {
  return {
    tenantId: "t",
    conversationId: "c",
    client: {} as any,
    medusa,
    cartId: null,
    tinNhanKhach: "",
    ghiNhanCartId() {},
    yeuCauChuyenNguoi() {},
  } as unknown as NguCanhTool;
}

function traLoiFetch(status: number, body: unknown) {
  return jest.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  })) as unknown as jest.Mock;
}

describe("get_order_status: kiểm tra đầu vào", () => {
  it("thiếu mã đơn thì hỏi lại mã đơn, không gọi backend", async () => {
    const fetchMock = traLoiFetch(200, { ok: true, found: false });
    global.fetch = fetchMock as any;
    const kq = await xuLyGetOrderStatus(nguCanh(), { phone: "0912345678" });
    expect(kq.ok).toBe(false);
    expect(kq.ma_loi).toBe("THIEU_MA_DON");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("thiếu số điện thoại thì hỏi lại SĐT, không gọi backend", async () => {
    const fetchMock = traLoiFetch(200, { ok: true, found: false });
    global.fetch = fetchMock as any;
    const kq = await xuLyGetOrderStatus(nguCanh(), { order_code: "CW12" });
    expect(kq.ma_loi).toBe("THIEU_SO_DIEN_THOAI");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("SĐT chỉ toàn ký tự không phải số coi như thiếu", async () => {
    const fetchMock = traLoiFetch(200, { ok: true, found: false });
    global.fetch = fetchMock as any;
    const kq = await xuLyGetOrderStatus(nguCanh(), { order_code: "CW12", phone: "abc" });
    expect(kq.ma_loi).toBe("THIEU_SO_DIEN_THOAI");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("tenant chưa nối Medusa thì chuyển nhân viên", async () => {
    const kq = await xuLyGetOrderStatus(nguCanh(null), { order_code: "CW12", phone: "0912345678" });
    expect(kq.ma_loi).toBe("CHUA_CAU_HINH_MEDUSA");
  });
});

describe("get_order_status: gọi backend", () => {
  afterEach(() => jest.restoreAllMocks());

  it("gửi POST /ai/order-status với SĐT đã bỏ ký tự thừa", async () => {
    const fetchMock = traLoiFetch(200, { ok: true, found: false });
    global.fetch = fetchMock as any;
    await xuLyGetOrderStatus(nguCanh(), { order_code: " CW12 ", phone: "+84 912-345-678" });
    const [url, init] = (fetchMock as jest.Mock).mock.calls[0] as any;
    expect(url).toBe("http://medusa.test/ai/order-status");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ order_code: "CW12", phone: "84912345678" });
  });

  it("đơn tìm thấy thì trả thông tin trạng thái cho mô hình", async () => {
    const order = {
      ma_don: "CW12",
      trang_thai_don: "Đang xử lý",
      trang_thai_thanh_toan: "Đã thanh toán",
      trang_thai_giao_hang: "Đang giao",
      ma_van_don: "GHN123",
      link_theo_doi: "https://ghn.test/GHN123",
    };
    global.fetch = traLoiFetch(200, { ok: true, found: true, order }) as any;
    const kq = await xuLyGetOrderStatus(nguCanh(), { order_code: "CW12", phone: "0912345678" });
    expect(kq.ok).toBe(true);
    expect(kq.order).toEqual(order);
  });

  it("không khớp mã hoặc SĐT thì báo không tìm thấy, không tiết lộ lý do", async () => {
    global.fetch = traLoiFetch(200, { ok: true, found: false }) as any;
    const kq = await xuLyGetOrderStatus(nguCanh(), { order_code: "CW999", phone: "0900000000" });
    expect(kq.ok).toBe(false);
    expect(kq.ma_loi).toBe("KHONG_TIM_THAY_DON");
    expect(String(kq.thong_diep_cho_khach)).not.toMatch(/mã đơn không|số điện thoại không/i);
  });

  it("backend lỗi HTTP thì xin khách thử lại sau", async () => {
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    global.fetch = traLoiFetch(500, "boom") as any;
    const kq = await xuLyGetOrderStatus(nguCanh(), { order_code: "CW12", phone: "0912345678" });
    expect(kq.ok).toBe(false);
    expect(kq.ma_loi).toBe("TRA_DON_LOI");
  });

  it("mạng đứt (fetch ném lỗi) thì không làm sập lượt trả lời", async () => {
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    global.fetch = jest.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as any;
    const kq = await xuLyGetOrderStatus(nguCanh(), { order_code: "CW12", phone: "0912345678" });
    expect(kq.ma_loi).toBe("TRA_DON_LOI");
  });
});

describe("get_order_status: lớp kiểm chứng tên tool", () => {
  it("tool được phép gọi", () => {
    expect(kiemTraTenTool("get_order_status").hopLe).toBe(true);
  });
});
