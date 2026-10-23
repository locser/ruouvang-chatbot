jest.mock("./services/telegram", () => ({ guiTinQuaBot: jest.fn(async () => true), answerCallbackQuery: jest.fn(async () => true) }));
jest.mock("./db/client", () => ({ runInTenantContext: jest.fn() }));
jest.mock("./services/medusa", () => ({ getTenantMedusaConfig: jest.fn(async () => ({ baseUrl: "http://medusa.test" })) }));
jest.mock("./services/http", () => ({
  fetchJson: jest.fn(), fetchCoTimeout: jest.fn(), TIMEOUT: { TELEGRAM: 5000 },
}));
import {
  goiYDonHang, trongGiongLenh, canhBaoDeHieu,
  laYeuCauVanHanh, phanTichLenhNhanh, phanTichLenhDonHang, chonDonTheoSo, dinhDangTien,
  xuLyYeuCauVanHanh, xuLyCallbackVanHanh,
} from "./services/telegramOperator";
import { guiTinQuaBot } from "./services/telegram";
import { runInTenantContext } from "./db/client";
import { fetchJson, fetchCoTimeout } from "./services/http";
import { getTenantMedusaConfig } from "./services/medusa";

describe("Telegram operator", () => {
  const bot: any = { username: "cwwines_bot" };

  test("phân tích câu nhập kho tự nhiên", () => {
    expect(phanTichLenhNhanh("/ops Chateau Margaux 2018 mới nhập thêm 30 chai")).toEqual({
      type: "inventory_adjust",
      product_query: "Chateau Margaux 2018",
      quantity_change: 30,
    });
  });

  test("phân tích câu xuất kho thành số âm", () => {
    expect(phanTichLenhNhanh("Penfolds Bin 389 xuất kho 4 chai")).toEqual({
      type: "inventory_adjust",
      product_query: "Penfolds Bin 389",
      quantity_change: -4,
    });
  });

  test("tách giá và tồn đầu khỏi tên sản phẩm mới", () => {
    expect(phanTichLenhNhanh("/ops tạo sản phẩm mới Catena Malbec 2022 nhập 12 chai giá 1200000")).toEqual({
      type: "create_product",
      title: "Catena Malbec 2022",
      price_vnd: 1200000,
      initial_quantity: 12,
    });
  });

  test("nhận diện lệnh bằng mention trong group", () => {
    expect(laYeuCauVanHanh({ chat: { id: -100, type: "supergroup" }, text: "@cwwines_bot kiểm tra kho chai A" }, bot)).toBe(true);
    expect(laYeuCauVanHanh({ chat: { id: -100, type: "supergroup" }, text: "mọi người họp lúc 3 giờ" }, bot)).toBe(false);
  });

  test("ảnh luôn vào luồng bản nháp vận hành", () => {
    expect(laYeuCauVanHanh({ chat: { id: -100 }, photo: [{ file_id: "f1" }] }, bot)).toBe(true);
  });
});

describe("Telegram operator: đơn hàng", () => {
  const bot: any = { username: "cwwines_bot", token: "t" };
  const UUID = "11111111-2222-3333-4444-555555555555";
  const ORDER_ID = "order_01JXLONGSECRETID";
  const gui = guiTinQuaBot as jest.Mock;
  let sqlCalls: Array<{ sql: string; params: any[] }>;
  let executingRow: any;

  beforeEach(() => {
    jest.clearAllMocks();
    (getTenantMedusaConfig as jest.Mock).mockResolvedValue({ baseUrl: "http://medusa.test" });
    gui.mockResolvedValue(true);
    sqlCalls = [];
    executingRow = null;
    (runInTenantContext as jest.Mock).mockImplementation(async (_t: string, fn: any) => fn({
      query: async (sql: string, params: any[] = []) => {
        sqlCalls.push({ sql, params });
        if (/INSERT INTO telegram_operator_action/.test(sql)) return { rows: [{ id: UUID }], rowCount: 1 };
        if (/SET status='executing'/.test(sql)) return { rows: executingRow ? [executingRow] : [], rowCount: executingRow ? 1 : 0 };
        return { rows: [], rowCount: 1 };
      },
    }));
  });

  const don = (display_id: number, id = `ord_${display_id}`, status = "pending") => ({
    id, status, display_id, total_vnd: 1250000, customer: { name: "Nguyễn Văn A", phone: "0900" },
    items: [{ title: "Penfolds Bin 389", quantity: 2, unit_price_vnd: 625000 }],
  });
  const tin = (text: string) => ({ chat: { id: 7 }, from: { id: 9 }, message_id: 5, text });

  test.each([
    ["đơn mới", "order_list_pending"],
    ["don moi", "order_list_pending"],
    ["Có đơn nào chưa duyệt không?", "order_list_pending"],
    ["co don nao chua duyet", "order_list_pending"],
    ["đơn hàng chờ duyệt", "order_list_pending"],
    ["/ops đơn mới", "order_list_pending"],
  ])("hiểu câu xem đơn: %s", (cau, loai) => {
    expect(phanTichLenhNhanh(cau)).toEqual({ type: loai });
  });

  test.each([
    ["duyệt đơn 12", 12], ["duyet don 12", 12], ["xác nhận đơn CW12", 12], ["xac nhan don cw12", 12],
    ["Duyệt đơn #12", 12], ["duyệt giúp em đơn số 7", 7], ["đơn 15 duyệt đi", 15],
    ["duyệt #30", 30], ["hoàn thành đơn 8", 8],
  ])("hiểu câu duyệt đơn: %s", (cau, so) => {
    const kq = phanTichLenhDonHang(cau);
    if (so === null) expect(kq).toBeNull(); else expect(kq).toEqual({ type: "order_complete", order_number: so });
  });

  test("không bắt nhầm câu khác, giữ nguyên 3 lệnh kho", () => {
    expect(phanTichLenhDonHang("mọi người họp lúc 3 giờ")).toBeNull();
    expect(phanTichLenhDonHang("nhập thêm 30 chai")).toBeNull();
    expect(phanTichLenhNhanh("kiểm tra kho Penfolds Bin 389")).toEqual({ type: "inventory_lookup", product_query: "Penfolds Bin 389" });
    expect(phanTichLenhNhanh("tạo sản phẩm mới Catena Malbec 2022 nhập 12 chai giá 1200000")).toMatchObject({ type: "create_product" });
  });

  test("câu thường về đơn vào luồng vận hành không cần /ops", () => {
    expect(laYeuCauVanHanh({ chat: { id: 1 }, text: "duyệt đơn 12" }, bot)).toBe(true);
    expect(laYeuCauVanHanh({ chat: { id: 1 }, text: "chào shop, cho mình hỏi giá" }, bot)).toBe(false);
  });

  test("định dạng tiền", () => {
    expect(dinhDangTien(1250000)).toBe("1.250.000đ");
    expect(dinhDangTien(0)).toBe("0đ");
  });

  test("chọn đơn theo số đơn chính xác, không lấy khớp chuỗi con", () => {
    const ds: any[] = [don(112), don(21), don(12, ORDER_ID)];
    expect(chonDonTheoSo(ds, 12)?.id).toBe(ORDER_ID);
    expect(chonDonTheoSo(ds, 1)).toBeNull();
  });

  test("duyệt đơn 12: bản nháp đúng đơn, không lộ mã dài, có nút Xác nhận/Huỷ", async () => {
    (fetchJson as jest.Mock).mockResolvedValue({ orders: [don(112), don(12, ORDER_ID)] });
    await xuLyYeuCauVanHanh(bot, "tenant-1", tin("duyệt đơn 12"));
    const url = String((fetchJson as jest.Mock).mock.calls[0][0]);
    expect(url).toContain("/ai/orders-operator?");
    expect(url).toContain("display_id=12");
    const luu = sqlCalls.find((c) => /INSERT INTO telegram_operator_action/.test(c.sql))!;
    expect(luu.params[4]).toBe("order_complete");
    expect(JSON.parse(luu.params[6]).order_id).toBe(ORDER_ID);
    const msg = gui.mock.calls[0][1];
    expect(msg.text).toContain("#12");
    expect(msg.text).toContain("Nguyễn Văn A");
    expect(msg.text).toContain("2 × Penfolds Bin 389");
    expect(msg.text).toContain("1.250.000đ");
    expect(msg.text).not.toContain(ORDER_ID);
    expect(msg.text).not.toMatch(/order_id|uuid|json/i);
    expect(JSON.stringify(msg.reply_markup)).toContain(`ops_ok_${UUID}`);
    expect(JSON.stringify(msg.reply_markup)).toContain(`ops_no_${UUID}`);
  });

  test("không có đơn khớp chính xác: báo dễ hiểu, không tạo bản nháp", async () => {
    (fetchJson as jest.Mock).mockResolvedValue({ orders: [don(112)] });
    await expect(xuLyYeuCauVanHanh(bot, "tenant-1", tin("duyệt đơn 12"))).rejects.toThrow(
      "Không tìm thấy đơn số 12. Anh/chị kiểm tra lại số đơn giúp em nhé."
    );
    expect(sqlCalls.some((c) => /INSERT/.test(c.sql))).toBe(false);
  });

  test("đơn đã duyệt trước đó thì nói rõ", async () => {
    (fetchJson as jest.Mock).mockResolvedValue({ orders: [don(12, "o", "completed")] });
    await expect(xuLyYeuCauVanHanh(bot, "tenant-1", tin("duyệt đơn 12"))).rejects.toThrow("đã được duyệt trước đó");
  });

  test("đơn đã huỷ thì không tạo bản nháp", async () => {
    (fetchJson as jest.Mock).mockResolvedValue({ orders: [don(12, "o", "canceled")] });
    await expect(xuLyYeuCauVanHanh(bot, "tenant-1", tin("duyệt đơn 12"))).rejects.toThrow("Đơn #12 đã bị huỷ, không duyệt được.");
    expect(sqlCalls.some((c) => /INSERT/.test(c.sql))).toBe(false);
  });

  test("bấm Duyệt đơn nhiều lần: gửi lại bản nháp cũ, không tạo mới", async () => {
    (fetchJson as jest.Mock).mockResolvedValue({ orders: [don(12, ORDER_ID)] });
    const cu = "99999999-2222-3333-4444-555555555555";
    (runInTenantContext as jest.Mock).mockImplementation(async (_t: string, fn: any) => fn({
      query: async (sql: string, params: any[] = []) => {
        sqlCalls.push({ sql, params });
        if (/SELECT id FROM telegram_operator_action/.test(sql)) return { rows: [{ id: cu }] };
        return { rows: [], rowCount: 0 };
      },
    }));
    await xuLyCallbackVanHanh(bot, "tenant-1", { id: "cb9", data: "ops_ord_12", from: { id: 9 }, message: { chat: { id: 7 } } });
    expect(sqlCalls.some((c) => /INSERT/.test(c.sql))).toBe(false);
    expect(JSON.stringify(gui.mock.calls[0][1].reply_markup)).toContain(`ops_ok_${cu}`);
  });

  test("nhiều số đơn: hỏi lại bằng nút, không lấy số đầu", async () => {
    await xuLyYeuCauVanHanh(bot, "tenant-1", tin("duyệt đơn 12, 13"));
    const msg = gui.mock.calls[0][1];
    expect(msg.text).toBe("Anh/chị muốn duyệt đơn nào trước: #12 hay #13?");
    expect(msg.reply_markup.inline_keyboard.map((h: any) => h[0].callback_data)).toEqual(["ops_ord_12", "ops_ord_13"]);
    expect(fetchJson).not.toHaveBeenCalled();
  });

  test("danh sách chờ duyệt lấy đơn chờ lâu nhất trước", async () => {
    (fetchJson as jest.Mock).mockResolvedValue({ orders: [don(1)] });
    await xuLyYeuCauVanHanh(bot, "tenant-1", tin("đơn mới"));
    expect(String((fetchJson as jest.Mock).mock.calls[0][0])).toContain("order=asc");
  });

  test.each([
    "Anh muốn đặt đơn nào ạ?",
    "Dạ đơn mới của anh đã tạo rồi ạ",
    "Em chốt đơn 2 chai cho anh nhé",
    "Em xác nhận đơn 12 cho anh rồi nhé",
    "ok đơn 3 chai vang đỏ",
    "không duyệt đơn 12",
    "đừng duyệt đơn 12 nhé",
    "chưa duyệt đơn 12 đâu",
    "duyệt đơn 3 chai vang đỏ",
  ])("không hiểu nhầm lời nói với khách: %s", (cau) => {
    expect(phanTichLenhDonHang(cau)).toBeNull();
    expect(phanTichLenhNhanh(cau)?.type ?? "").not.toMatch(/^order_/);
    expect(laYeuCauVanHanh({ chat: { id: 1 }, text: cau }, bot)).toBe(false);
  });

  test("backend đọc đơn lỗi: không lộ URL hay mã HTTP", async () => {
    (fetchJson as jest.Mock).mockRejectedValue(new Error("HTTP 500 khi gọi http://medusa.test/ai/orders-operator: boom"));
    const loi: any = await xuLyYeuCauVanHanh(bot, "tenant-1", tin("duyệt đơn 12")).catch((e) => e);
    expect(loi.message).toMatch(/thử lại/);
    expect(loi.message).not.toMatch(/HTTP|http|boom/);
  });

  test("đơn mới: liệt kê tối đa 10 đơn, mỗi đơn một nút", async () => {
    (fetchJson as jest.Mock).mockResolvedValue({ orders: Array.from({ length: 11 }, (_, i) => don(i + 1)) });
    await xuLyYeuCauVanHanh(bot, "tenant-1", tin("đơn mới"));
    const msg = gui.mock.calls[0][1];
    expect(msg.reply_markup.inline_keyboard).toHaveLength(10);
    expect(msg.reply_markup.inline_keyboard[0][0]).toEqual({ text: "Duyệt đơn #1", callback_data: "ops_ord_1" });
    expect(msg.text).toContain("#1 · Nguyễn Văn A · 1.250.000đ");
    expect(msg.text).not.toContain("ord_1");
  });

  test("không có đơn chờ duyệt", async () => {
    (fetchJson as jest.Mock).mockResolvedValue({ orders: [] });
    await xuLyYeuCauVanHanh(bot, "tenant-1", tin("đơn mới"));
    expect(gui.mock.calls[0][1].text).toContain("không có đơn nào chờ duyệt");
  });

  test("bấm nút Duyệt đơn #12 ra bản nháp xác nhận", async () => {
    (fetchJson as jest.Mock).mockResolvedValue({ orders: [don(12, ORDER_ID)] });
    const xong = await xuLyCallbackVanHanh(bot, "tenant-1", { id: "cb1", data: "ops_ord_12", from: { id: 9 }, message: { chat: { id: 7 } } });
    expect(xong).toBe(true);
    const msg = gui.mock.calls[0][1];
    expect(msg.text).toContain("Duyệt đơn #12");
    expect(JSON.stringify(msg.reply_markup)).toContain("ops_ok_");
  });

  test("bấm Xác nhận gọi đúng /ai/order-complete rồi báo đã trừ kho", async () => {
    executingRow = { action_type: "order_complete", payload: { order_id: ORDER_ID, display_id: 12 } };
    (fetchCoTimeout as jest.Mock).mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) });
    await xuLyCallbackVanHanh(bot, "tenant-1", { id: "cb2", data: `ops_ok_${UUID}`, from: { id: 9 }, message: { chat: { id: 7 } } });
    const [url, init] = (fetchCoTimeout as jest.Mock).mock.calls[0];
    expect(String(url)).toBe("http://medusa.test/ai/order-complete");
    expect(JSON.parse(init.body)).toEqual({ order_id: ORDER_ID });
    expect(gui.mock.calls[0][1].text).toBe("✅ Đã duyệt đơn #12, kho đã trừ.");
  });

  test.each([
    [409, { error: "Đơn này đang được xử lý, vui lòng đợi vài giây rồi thử lại." }, "đang được xử lý"],
    [500, { error: "Đơn hàng đã bị huỷ — không thể duyệt hoàn thành." }, "đã bị huỷ"],
    [500, { error: "Insufficient inventory for item variant_01ABC", buoc_da_xong: { created_fulfillment: false } }, "kho chưa bị trừ"],
    [502, "<html>bad gateway</html>", "Chưa rõ đơn #12 đã duyệt xong chưa"],
    [401, { error: "Unauthorized" }, "Chưa rõ đơn #12 đã duyệt xong chưa"],
    [500, { error: "boom" }, "Chưa rõ đơn #12 đã duyệt xong chưa"],
    [500, { error: "boom", buoc_da_xong: { created_fulfillment: true } }, "Kho đã trừ nhưng đơn #12 chưa đóng"],
  ])("lỗi backend %s thành lời nhắn dễ hiểu", async (status, body, mongDoi) => {
    executingRow = { action_type: "order_complete", payload: { order_id: ORDER_ID, display_id: 12 } };
    (fetchCoTimeout as jest.Mock).mockResolvedValue({ ok: false, status, json: async () => { if (typeof body === "string") throw new Error("not json"); return body; } });
    await xuLyCallbackVanHanh(bot, "tenant-1", { id: "cb3", data: `ops_ok_${UUID}`, from: { id: 9 }, message: { chat: { id: 7 } } });
    const text = gui.mock.calls[0][1].text as string;
    expect(text).toContain(mongDoi);
    expect(text).not.toMatch(/Insufficient|variant_|order_01|HTTP|JSON|\{/);
  });

  test.each([
    "duyệt giùm em đơn 12 với", "duyệt đơn 12 luôn nha", "duyệt đơn 12 giúp em", "duyệt đơn 12 với",
    "duyệt đơn 12 đi em", "duyệt đơn 12 nhé chị", "ok duyệt đơn 12", "đơn 12 ok",
    "anh ơi đơn mới", "đơn mới đâu",
  ])("câu thật của nhân viên không bị im lặng: %s", (cau) => {
    const hieu = phanTichLenhDonHang(cau);
    const goiY = goiYDonHang(cau, true);
    expect(hieu !== null || (goiY !== null && Boolean((goiY.reply_markup as any)?.inline_keyboard))).toBe(true);
    if (hieu) expect(hieu).toMatchObject({ type: cau.includes("mới") ? "order_list_pending" : "order_complete" });
  });

  test("lưới gợi ý: có nút, ở nhóm thì im khi chỉ nhắc chữ đơn", () => {
    const g: any = goiYDonHang("anh duyệt hộ em đơn 12 cái", false);
    expect(g.text).toBe("Anh/chị muốn duyệt đơn #12 phải không?");
    expect(g.reply_markup.inline_keyboard[0][0].callback_data).toBe("ops_ord_12");
    const nhieu: any = goiYDonHang("duyệt hộ đơn 12 với 13", false);
    expect(nhieu.reply_markup.inline_keyboard).toHaveLength(2);
    const ds: any = goiYDonHang("đơn mới về chưa nhỉ, chưa duyệt", false);
    expect(ds.reply_markup.inline_keyboard[0][0]).toEqual({ text: "📋 Xem đơn chờ duyệt", callback_data: "ops_list" });
    expect(goiYDonHang("khách hỏi về đơn hàng của họ", false)).toBeNull();
    expect(goiYDonHang("khách hỏi về đơn hàng của họ", true)?.text).toContain("đơn mới");
  });

  test("lưới gợi ý không bắt câu phủ định hay lời nói với khách", () => {
    for (const cau of ["không duyệt đơn 12", "đừng duyệt đơn 12 nhé", "chưa duyệt đơn 12 đâu", "Em xác nhận đơn 12 cho anh rồi nhé", "Em chốt đơn 2 chai cho anh nhé"]) {
      const g: any = goiYDonHang(cau, false);
      expect(g?.reply_markup?.inline_keyboard?.some((h: any) => /ops_ord_/.test(h[0].callback_data)) ?? false).toBe(false);
    }
  });

  test("trông giống lệnh để nhắc gõ /ops", () => {
    expect(trongGiongLenh("duyệt đơn 12")).toBe(true);
    expect(trongGiongLenh("dạ anh cứ yên tâm ạ")).toBe(false);
  });

  test("nút Xem đơn chờ duyệt mở danh sách", async () => {
    (fetchJson as jest.Mock).mockResolvedValue({ orders: [don(3)] });
    await xuLyCallbackVanHanh(bot, "tenant-1", { id: "cb7", data: "ops_list", from: { id: 9 }, message: { chat: { id: 7 } } });
    expect(gui.mock.calls[0][1].reply_markup.inline_keyboard[0][0].callback_data).toBe("ops_ord_3");
  });

  test.each([
    ["cod", "💵 Thu tiền khi giao (COD)"],
    ["cho_chuyen_khoan", "kiểm tra đã nhận tiền chưa rồi hãy duyệt"],
    ["da_thanh_toan", "✅ Đã nhận tiền"],
  ])("bản nháp và danh sách hiện trạng thái tiền: %s", async (tt, mong) => {
    (fetchJson as jest.Mock).mockResolvedValue({ orders: [{ ...don(12, ORDER_ID), payment_status: tt }] });
    await xuLyYeuCauVanHanh(bot, "tenant-1", tin("duyệt đơn 12"));
    expect(gui.mock.calls[0][1].text).toContain(mong);
    gui.mockClear();
    await xuLyYeuCauVanHanh(bot, "tenant-1", { ...tin("đơn mới"), message_id: 6 });
    expect(gui.mock.calls[0][1].text).toMatch(/1\.250\.000đ [💵⏳✅]/u);
  });

  test("payment_status null thì không có dòng tiền", async () => {
    (fetchJson as jest.Mock).mockResolvedValue({ orders: [{ ...don(12, ORDER_ID), payment_status: null }] });
    await xuLyYeuCauVanHanh(bot, "tenant-1", tin("duyệt đơn 12"));
    expect(gui.mock.calls[0][1].text).not.toMatch(/COD|chuyển khoản|Đã nhận tiền/);
  });

  test("duyệt thành công có cảnh báo: in câu dễ hiểu, bỏ ghi chú vô hại", async () => {
    executingRow = { action_type: "order_complete", payload: { order_id: ORDER_ID, display_id: 12 } };
    (fetchCoTimeout as jest.Mock).mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, ket_qua: { canh_bao: [
      "Không capture được payment pay_01XYZ: boom", "Payment đã được thu từ trước.", "Đơn đã xuất kho đủ từ trước — không tạo thêm.",
    ] } }) });
    await xuLyCallbackVanHanh(bot, "tenant-1", { id: "cb8", data: `ops_ok_${UUID}`, from: { id: 9 }, message: { chat: { id: 7 } } });
    const t = gui.mock.calls[0][1].text as string;
    expect(t).toContain("✅ Đã duyệt đơn #12, kho đã trừ.");
    expect(t).toContain("Chưa thu được tiền");
    expect(t).not.toMatch(/pay_01|boom|từ trước/);
    expect(canhBaoDeHieu(["Đơn đã ở trạng thái completed từ trước."])).toEqual([]);
  });

  describe("tra thông tin đơn (chỉ đọc)", () => {
    test.each([
      ["xem đơn 12", { order_number: 12 }], ["xem don 12", { order_number: 12 }], ["kiểm tra đơn CW12", { order_number: 12 }],
      ["kiem tra don cw12", { order_number: 12 }], ["tra đơn #12", { order_number: 12 }], ["đơn 12 sao rồi", { order_number: 12 }],
      ["don 12 sao roi", { order_number: 12 }], ["xem đơn 12 giúp em", { order_number: 12 }], ["đơn 12 xong chưa", { order_number: 12 }],
      ["đơn của 0912345678", { lookup_kind: "phone", lookup_text: "0912345678" }],
      ["tra đơn 0912 345 678", { lookup_kind: "phone", lookup_text: "0912345678" }],
      ["xem đơn của khách 0912345678", { lookup_kind: "phone", lookup_text: "0912345678" }],
      ["tra đơn chị Lan", { lookup_kind: "name", lookup_text: "Lan" }],
      ["/ops tìm đơn Nguyễn Văn A", { lookup_kind: "name", lookup_text: "Nguyễn Văn A" }],
      ["/ops tim don nguyen van a", { lookup_kind: "name", lookup_text: "nguyen van a" }],
      ["/ops đơn của anh Hùng", { lookup_kind: "name", lookup_text: "Hùng" }],
    ])("hiểu câu tra đơn: %s", (cau, mong) => {
      expect(phanTichLenhDonHang(cau)).toEqual({ type: "order_lookup", ...mong });
      expect(laYeuCauVanHanh({ chat: { id: 1 }, text: cau }, bot)).toBe(true);
    });

    test.each([
      ["tra đơn chị Lan?", "Lan"], ["tra đơn chị Lan ?", "Lan"], ["/ops xem đơn của Nguyễn Văn A.", "Nguyễn Văn A"],
      ["tra đơn anh Hùng giao chưa", "Hùng"], ["tìm đơn khách Lan sao rồi", "Lan"], ["kiểm tra đơn chị Lan nhé", "Lan"],
    ])("tách tên sạch: %s", (cau, ten) => {
      expect(phanTichLenhDonHang(cau)).toEqual({ type: "order_lookup", lookup_kind: "name", lookup_text: ten });
    });

    test.each([
      "đơn của em bị lỗi", "đơn của shop mình hôm nay nhiều quá", "xem đơn đã duyệt", "kiểm tra đơn hàng hôm nay",
      "tìm đơn Nguyễn Văn A", "đơn của anh Hùng", "/ops xem đơn đã duyệt", "/ops đơn của shop mình",
    ])("không bắt nhầm chuyện phiếm thành tra tên: %s", (cau) => {
      expect(phanTichLenhDonHang(cau)?.type ?? "").not.toBe("order_lookup");
    });

    test("xem đơn không bao giờ thành lệnh duyệt; xem đơn mới vẫn là danh sách", () => {
      for (const c of ["xem đơn 12", "đơn 12 sao rồi", "kiểm tra đơn CW12", "tra đơn chị Lan"]) {
        expect(phanTichLenhNhanh(c)?.type).toBe("order_lookup");
      }
      expect(phanTichLenhNhanh("xem đơn mới")).toEqual({ type: "order_list_pending" });
      expect(phanTichLenhNhanh("xem đơn")).toEqual({ type: "order_list_pending" });
      expect(phanTichLenhNhanh("duyệt đơn 12")?.type).toBe("order_complete");
    });

    test("lưới gợi ý: xem/tra đơn + số ra nút chỉ đọc", () => {
      const g: any = goiYDonHang("anh xem hộ em đơn 12 cái", false);
      expect(g.reply_markup.inline_keyboard[0][0].callback_data).toBe("ops_view_12");
    });

    test("tra theo số: hiện đủ thông tin, có nút duyệt khi đang chờ", async () => {
      const o = { ...don(12, ORDER_ID), created_at: "2026-10-22T07:05:00Z", payment_status: "cho_chuyen_khoan", tracking_code: "VD123",
        customer: { name: "Nguyễn Văn A", phone: "0912345678", address: "1 Lê Lợi, HCM" } };
      (fetchJson as jest.Mock).mockResolvedValue({ orders: [don(112), o] });
      await xuLyYeuCauVanHanh(bot, "tenant-1", tin("xem đơn 12"));
      expect(String((fetchJson as jest.Mock).mock.calls[0][0])).toContain("display_id=12");
      const m = gui.mock.calls[0][1];
      expect(m.text).toContain("Đơn #12");
      expect(m.text).toContain("Chờ duyệt");
      expect(m.text).toContain("22/10 14:05");
      expect(m.text).toContain("0912345678");
      expect(m.text).toContain("1 Lê Lợi, HCM");
      expect(m.text).toContain("1.250.000đ");
      expect(m.text).toContain("Chờ chuyển khoản");
      expect(m.text).toContain("VD123");
      expect(m.text).not.toContain(ORDER_ID);
      expect(m.reply_markup.inline_keyboard[0][0].callback_data).toBe("ops_ord_12");
      expect(sqlCalls.some((c) => /INSERT/.test(c.sql))).toBe(false);
    });

    test("đơn đã hoàn thành/huỷ: có trạng thái chữ, không có nút duyệt", async () => {
      (fetchJson as jest.Mock).mockResolvedValue({ orders: [don(12, "o", "completed")] });
      await xuLyYeuCauVanHanh(bot, "tenant-1", tin("xem đơn 12"));
      expect(gui.mock.calls[0][1].text).toContain("Đã hoàn thành");
      expect(gui.mock.calls[0][1].reply_markup).toBeUndefined();
      gui.mockClear();
      (fetchJson as jest.Mock).mockResolvedValue({ orders: [don(12, "o", "canceled")] });
      await xuLyYeuCauVanHanh(bot, "tenant-1", { ...tin("xem đơn 12"), message_id: 8 });
      expect(gui.mock.calls[0][1].text).toContain("Đã huỷ");
    });

    test("không thấy đơn theo số", async () => {
      (fetchJson as jest.Mock).mockResolvedValue({ orders: [] });
      await expect(xuLyYeuCauVanHanh(bot, "tenant-1", tin("xem đơn 99"))).rejects.toThrow("Không tìm thấy đơn số 99.");
    });

    test("tra theo SĐT: gọi q= cho từng trạng thái, lọc đúng số", async () => {
      (fetchJson as jest.Mock).mockImplementation(async (u: string) => ({
        orders: u.includes("status=pending")
          ? [{ ...don(5), customer: { name: "A", phone: "+84912345678" } }, { ...don(6), customer: { name: "B", phone: "0999999999" } }]
          : [],
      }));
      await xuLyYeuCauVanHanh(bot, "tenant-1", tin("đơn của 0912345678"));
      const urls = (fetchJson as jest.Mock).mock.calls.map((c) => String(c[0]));
      expect(urls).toHaveLength(3);
      expect(urls.some((u) => u.includes("q="))).toBe(false);
      expect(gui.mock.calls[0][1].text).toContain("Đơn #5");
    });

    test("tra theo tên: lọc phía bot (không dấu), nhiều kết quả có nút Xem đơn", async () => {
      const tenLan = (id: number, st: string) => ({ ...don(id, `o${id}`, st), customer: { name: "Trần Thị Lan", phone: "0900" } });
      (fetchJson as jest.Mock).mockImplementation(async (u: string) => ({
        orders: u.includes("status=pending") ? [tenLan(1, "pending"), don(2)] : u.includes("status=completed") ? [tenLan(3, "completed")] : [],
      }));
      await xuLyYeuCauVanHanh(bot, "tenant-1", tin("tra đơn chị lan"));
      const m = gui.mock.calls[0][1];
      expect(m.text).toContain("Có 2 đơn khớp");
      expect(m.text).not.toContain("#2 ");
      expect(m.reply_markup.inline_keyboard.map((h: any) => h[0].callback_data).sort()).toEqual(["ops_view_1", "ops_view_3"]);
    });

    test("tra theo tên: chỉ hiện 5 đơn và không thấy thì gợi ý", async () => {
      (fetchJson as jest.Mock).mockImplementation(async (u: string) => ({
        orders: u.includes("status=pending") ? Array.from({ length: 7 }, (_, i) => ({ ...don(i + 1), customer: { name: "Lan" } })) : [],
      }));
      await xuLyYeuCauVanHanh(bot, "tenant-1", tin("tra đơn chị Lan"));
      expect(gui.mock.calls[0][1].reply_markup.inline_keyboard).toHaveLength(5);
      (fetchJson as jest.Mock).mockResolvedValue({ orders: [] });
      await expect(xuLyYeuCauVanHanh(bot, "tenant-1", { ...tin("tra đơn chị Xyz"), message_id: 9 })).rejects.toThrow(/Em chỉ tìm được trong các đơn gần đây và chưa thấy đơn nào của “Xyz”.*xem đơn 12/);
    });

    test("tra SĐT có dấu cách trong dữ liệu vẫn khớp", async () => {
      (fetchJson as jest.Mock).mockImplementation(async (u: string) => ({
        orders: u.includes("status=completed") ? [{ ...don(8, "o8", "completed"), customer: { name: "B", phone: "0912 345 678" } }] : [],
      }));
      await xuLyYeuCauVanHanh(bot, "tenant-1", tin("đơn của 0912345678"));
      expect(gui.mock.calls[0][1].text).toContain("Đơn #8");
    });

    test("khớp tên theo từ: An không khớp Lan", async () => {
      (fetchJson as jest.Mock).mockImplementation(async (u: string) => ({
        orders: u.includes("status=pending") ? [{ ...don(1), customer: { name: "Trần Thị Lan" } }, { ...don(2), customer: { name: "Lê Anh" } }] : [],
      }));
      await xuLyYeuCauVanHanh(bot, "tenant-1", tin("tra đơn chị An"));
      expect(gui.mock.calls[0][1].text).toContain("Đơn #2");
      expect(gui.mock.calls[0][1].text).not.toContain("#1 ");
    });

    test("nút Xem đơn #N chỉ đọc, không tạo action", async () => {
      (fetchJson as jest.Mock).mockResolvedValue({ orders: [don(12, ORDER_ID)] });
      await xuLyCallbackVanHanh(bot, "tenant-1", { id: "cv", data: "ops_view_12", from: { id: 9 }, message: { chat: { id: 7 } } });
      expect(gui.mock.calls[0][1].text).toContain("Đơn #12");
      expect(sqlCalls.some((c) => /INSERT/.test(c.sql))).toBe(false);
    });

    test("cổng nhân viên: webhook chỉ cho ops_* sau khi kiểm tra whitelist (callback ops_view_ cùng tiền tố)", () => {
      // Phân quyền nằm ở src/index.ts (dataStr.startsWith("ops_") -> laNhanVienCuaShop), dùng chung cho ops_view_.
      const fs = require("fs");
      const src: string = fs.readFileSync(require("path").join(__dirname, "index.ts"), "utf8");
      expect(src).toMatch(/startsWith\("ops_"\)\) \{\s*if \(!\(await laNhanVienCuaShop/);
    });
  });
});
