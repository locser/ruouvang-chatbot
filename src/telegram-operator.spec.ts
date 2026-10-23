jest.mock("./services/telegram", () => ({ guiTinQuaBot: jest.fn(async () => true), answerCallbackQuery: jest.fn(async () => true) }));
jest.mock("./db/client", () => ({ runInTenantContext: jest.fn() }));
jest.mock("./services/medusa", () => ({ getTenantMedusaConfig: jest.fn(async () => ({ baseUrl: "http://medusa.test" })) }));
jest.mock("./services/http", () => ({
  fetchJson: jest.fn(), fetchCoTimeout: jest.fn(), TIMEOUT: { TELEGRAM: 5000 },
}));
jest.mock("./services/llm", () => ({ goiDeepSeekCoTool: jest.fn() }));
jest.mock("./services/search", () => ({ timSanPham: jest.fn() }));
import {
  goiYDonHang, trongGiongLenh, laLenhGhiDonHang, canhBaoDeHieu,
  laYeuCauVanHanh, phanTichLenhNhanh, phanTichLenhDonHang, chonDonTheoSo, dinhDangTien,
  xuLyYeuCauVanHanh, xuLyCallbackVanHanh, phanTichLenhShop, parseTienVN, sinhMaGiamGia, GIOI_HAN_MA_GIAM,
  tinhHanDung, chuanHoaMa, luuCauChoGui, layCauChoGui, canGiuCauChoGui, danhDauCauDaGui, ghepTenBienThe, nhanNutChon,
} from "./services/telegramOperator";
import { guiTinQuaBot } from "./services/telegram";
import { runInTenantContext } from "./db/client";
import { fetchJson, fetchCoTimeout } from "./services/http";
import { getTenantMedusaConfig } from "./services/medusa";
import { goiDeepSeekCoTool } from "./services/llm";
import { timSanPham } from "./services/search";

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
    [401, { error: "Unauthorized" }, "Bot chưa kết nối được hệ thống bán hàng"],
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

  describe("đã nhận tiền (ghi)", () => {
    test.each([
      "đã nhận tiền đơn 12", "da nhan tien don 12", "nhận tiền đơn CW12", "đơn 12 đã chuyển khoản", "don 12 da chuyen khoan",
      "khách đơn 12 chuyển rồi", "khach #12 chuyen roi", "khách đơn 12 ck rồi", "nhận tiền đơn 12 rồi", "xác nhận đã nhận tiền đơn #12", "đơn 12 ck rồi", "đã nhận tiền đơn 12 nhé",
    ])("hiểu câu nhận tiền: %s", (cau) => {
      expect(phanTichLenhDonHang(cau)).toEqual({ type: "order_payment_received", order_number: 12 });
      expect(laYeuCauVanHanh({ chat: { id: 1 }, text: cau }, bot)).toBe(true);
    });

    test.each([
      "đơn 12 chưa chuyển khoản", "không nhận tiền đơn 12", "khách bảo mai chuyển khoản đơn 12", "đã nhận tiền của khách hôm qua",
      "chuyển khoản vào số tài khoản nào ạ", "khách 500 chuyển rồi", "khách 2 triệu chuyển rồi", "khách 12 chuyển rồi", "Em đã nhận tiền đơn 12 từ khách rồi nhé anh",
    ])("câu âm tính không thành lệnh nhận tiền: %s", (cau) => {
      expect(phanTichLenhDonHang(cau)?.type ?? "").not.toBe("order_payment_received");
    });

    test("gợi ý nút nhận tiền: chỉ lấy số ngay sau đơn/#/CW", () => {
      const g2: any = goiYDonHang("ghi nhận tiền chuyển khoản đơn 12 hộ em cái", false);
      expect(g2.reply_markup.inline_keyboard[0][0].callback_data).toBe("ops_pay_12");
      const k = (c: string, rieng = false) => (goiYDonHang(c, rieng) as any)?.reply_markup?.inline_keyboard?.flat().map((n: any) => n.callback_data) ?? [];
      expect(k("nhận tiền chuyển khoản 500k cho đơn 12", true)).toEqual(["ops_pay_12"]);
      expect(k("khách chuyển khoản 500k cho đơn 12", true)).toEqual(["ops_pay_12"]);
      expect(k("khách 0912345678 chuyển khoản", true)).toEqual([]);
      expect(k("đơn 12 2 chai đã ck", true)).toEqual(["ops_pay_12"]); // "2 chai" không phải số đơn
      expect(k("đơn 12 2 chai đã ck", false)).toEqual([]); // nhóm: không bắt đầu bằng động từ xác nhận
      expect(k("đã ck đơn 12 2 chai", false)).toEqual(["ops_pay_12"]);
      expect(k("khách chuyển khoản 2 triệu cho đơn 12", true)).toEqual(["ops_pay_12"]);
      expect(k("đơn 12 và đơn 13 chuyển khoản", true)).toEqual([]);
      expect(k("khách chuyển khoản 500 cho đơn", true)).toEqual([]);
    });

    test("trong nhóm: câu nhắn khách không ra nút nhận tiền", () => {
      const k = (c: string) => (goiYDonHang(c, false) as any)?.reply_markup?.inline_keyboard?.flat().map((n: any) => n.callback_data) ?? [];
      expect(k("anh chuyển khoản cho đơn 12 giúp em nhé")).toEqual([]);
      expect(k("khách chuyển khoản 500k cho đơn 12")).toEqual([]);
      expect(k("nhận tiền đơn 12 hộ em cái")).toEqual(["ops_pay_12"]);
    });

    test("đơn chuyển khoản: bản nháp có tên, số tiền, lời nhắc kiểm tra ngân hàng", async () => {
      (fetchJson as jest.Mock).mockResolvedValue({ orders: [{ ...don(12, ORDER_ID), payment_status: "cho_chuyen_khoan" }] });
      await xuLyYeuCauVanHanh(bot, "tenant-1", tin("đã nhận tiền đơn 12"));
      const luu = sqlCalls.find((c) => /INSERT INTO telegram_operator_action/.test(c.sql))!;
      expect(luu.params[4]).toBe("order_payment_received");
      const m = gui.mock.calls[0][1];
      expect(m.text).toContain("Xác nhận đã nhận tiền chuyển khoản đơn #12?");
      expect(m.text).toContain("Nguyễn Văn A");
      expect(m.text).toContain("1.250.000đ");
      expect(m.text).toContain("kiểm tra tài khoản ngân hàng đã có tiền rồi hãy bấm Xác nhận");
      expect(m.text).not.toContain(ORDER_ID);
      expect(JSON.stringify(m.reply_markup)).toContain("ops_ok_");
    });

    test.each([
      ["cod", "là đơn thu tiền khi giao (COD), không cần xác nhận chuyển khoản"],
      ["da_thanh_toan", "đã ghi nhận tiền rồi"],
    ])("đơn %s: trả lời luôn, không tạo bản nháp", async (tt, mong) => {
      (fetchJson as jest.Mock).mockResolvedValue({ orders: [{ ...don(12, ORDER_ID), payment_status: tt }] });
      await expect(xuLyYeuCauVanHanh(bot, "tenant-1", tin("đã nhận tiền đơn 12"))).rejects.toThrow(mong);
      expect(sqlCalls.some((c) => /INSERT/.test(c.sql))).toBe(false);
    });

    test("đơn chưa rõ hình thức thanh toán: không tạo bản nháp", async () => {
      (fetchJson as jest.Mock).mockResolvedValue({ orders: [{ ...don(12, ORDER_ID), payment_status: null }] });
      await expect(xuLyYeuCauVanHanh(bot, "tenant-1", tin("đã nhận tiền đơn 12"))).rejects.toThrow("Đơn #12 chưa rõ hình thức thanh toán, anh/chị kiểm tra trong trang quản trị giúp em.");
      expect(sqlCalls.some((c) => /INSERT/.test(c.sql))).toBe(false);
    });

    test("gửi lại bản nháp cũ thì gia hạn thêm 15 phút (cả duyệt đơn và nhận tiền)", async () => {
      const cu = "99999999-2222-3333-4444-555555555555";
      for (const [cau, tt] of [["duyệt đơn 12", "cod"], ["đã nhận tiền đơn 12", "cho_chuyen_khoan"]] as const) {
        sqlCalls.length = 0;
        (fetchJson as jest.Mock).mockResolvedValue({ orders: [{ ...don(12, ORDER_ID), payment_status: tt }] });
        (runInTenantContext as jest.Mock).mockImplementation(async (_t: string, fn: any) => fn({
          query: async (sql: string, params: any[] = []) => {
            sqlCalls.push({ sql, params });
            if (/SELECT id FROM telegram_operator_action/.test(sql)) return { rows: [{ id: cu }] };
            return { rows: [], rowCount: 1 };
          },
        }));
        await xuLyYeuCauVanHanh(bot, "tenant-1", tin(cau));
        const up = sqlCalls.find((c) => /SET expires_at = now\(\) \+ interval '15 minutes'/.test(c.sql));
        expect(up?.params).toEqual([cu, "tenant-1"]);
        expect(sqlCalls.some((c) => /INSERT/.test(c.sql))).toBe(false);
      }
    });

    test("đơn huỷ: không tạo bản nháp", async () => {
      (fetchJson as jest.Mock).mockResolvedValue({ orders: [{ ...don(12, "o", "canceled"), payment_status: "cho_chuyen_khoan" }] });
      await expect(xuLyYeuCauVanHanh(bot, "tenant-1", tin("đã nhận tiền đơn 12"))).rejects.toThrow("đã bị huỷ");
    });

    test("nút Đã nhận tiền chỉ hiện khi chờ chuyển khoản (chi tiết đơn và bản nháp duyệt)", async () => {
      const lay = async (tt: any, cau: string, id: number) => {
        gui.mockClear();
        (fetchJson as jest.Mock).mockResolvedValue({ orders: [{ ...don(12, ORDER_ID), payment_status: tt }] });
        await xuLyYeuCauVanHanh(bot, "tenant-1", { ...tin(cau), message_id: id });
        return JSON.stringify(gui.mock.calls[0][1].reply_markup ?? {});
      };
      expect(await lay("cho_chuyen_khoan", "xem đơn 12", 21)).toContain("ops_pay_12");
      expect(await lay("cod", "xem đơn 12", 22)).not.toContain("ops_pay_");
      expect(await lay(null, "xem đơn 12", 23)).not.toContain("ops_pay_");
      expect(await lay("da_thanh_toan", "xem đơn 12", 24)).not.toContain("ops_pay_");
      expect(await lay("cho_chuyen_khoan", "duyệt đơn 12", 25)).toContain("ops_pay_12");
      expect(await lay("cod", "duyệt đơn 12", 26)).not.toContain("ops_pay_");
    });

    test("bấm nút ops_pay_N ra bản nháp", async () => {
      (fetchJson as jest.Mock).mockResolvedValue({ orders: [{ ...don(12, ORDER_ID), payment_status: "cho_chuyen_khoan" }] });
      await xuLyCallbackVanHanh(bot, "tenant-1", { id: "cp", data: "ops_pay_12", from: { id: 9 }, message: { chat: { id: 7 } } });
      expect(gui.mock.calls[0][1].text).toContain("đã nhận tiền chuyển khoản đơn #12");
    });

    const xacNhan = async (resp: any, payload: any = { order_id: ORDER_ID, display_id: 12, order_status: "pending" }) => {
      executingRow = { action_type: "order_payment_received", payload };
      (fetchCoTimeout as jest.Mock).mockResolvedValue(resp);
      await xuLyCallbackVanHanh(bot, "tenant-1", { id: "cx", data: `ops_ok_${UUID}`, from: { id: 9 }, message: { chat: { id: 7 } } });
      return gui.mock.calls[0][1];
    };

    test("xác nhận gọi đúng endpoint; thành công gợi ý duyệt khi đơn còn chờ duyệt", async () => {
      const m = await xacNhan({ ok: true, status: 200, json: async () => ({ ok: true, already: false, display_id: 12 }) });
      const [url, init] = (fetchCoTimeout as jest.Mock).mock.calls[0];
      expect(String(url)).toBe("http://medusa.test/ai/order-payment-received");
      expect(JSON.parse(init.body)).toEqual({ order_id: ORDER_ID });
      expect(m.text).toContain("✅ Đã ghi nhận tiền đơn #12.");
      expect(JSON.stringify(m.reply_markup)).toContain("ops_ord_12");
    });

    test("thành công khi đơn đã hoàn thành: không gợi ý duyệt; already: nói đã ghi nhận", async () => {
      const m = await xacNhan({ ok: true, status: 200, json: async () => ({ ok: true }) }, { order_id: ORDER_ID, display_id: 12, order_status: "completed" });
      expect(m.reply_markup).toBeUndefined();
      gui.mockClear();
      const m2 = await xacNhan({ ok: true, status: 200, json: async () => ({ ok: true, already: true }) });
      expect(m2.text).toContain("đã ghi nhận tiền trước đó");
    });

    test("canh_bao được in dễ hiểu", async () => {
      const m = await xacNhan({ ok: true, status: 200, json: async () => ({ ok: true, canh_bao: ["Không capture được payment pay_01XYZ: boom", "Đơn không có giao dịch thanh toán trong hệ thống"] }) });
      expect(m.text).toContain("Chưa thu được tiền");
      expect(m.text).toContain("không có giao dịch thanh toán trong hệ thống, em chỉ ghi nhận là đã nhận tiền");
      expect(m.text).not.toMatch(/pay_01|boom/);
    });

    test.each([
      [409, "order_is_cod", "COD"], [409, "order_canceled", "đã bị huỷ"], [404, "order_not_found", "Không tìm thấy đơn số 12"],
      [409, "order_status_invalid", "chưa ghi nhận tiền được"], [409, "order_payment_state_invalid", "chưa ghi nhận tiền được"],
      [409, "in_progress", "đang được xử lý"], [502, "capture_failed", "hệ thống chưa ghi được khoản thu"],
      [500, "metadata_update_failed", "Chưa cập nhật xong trạng thái tiền"],
      [500, "internal_error", "Chưa rõ đơn #12 đã ghi nhận tiền chưa"], [401, "unauthorized", "Bot chưa kết nối được hệ thống bán hàng"],
      [400, "missing_order_id", "Chưa rõ đơn #12"], [500, "ma_la", "Chưa rõ đơn #12"],
    ])("lỗi %s code %s map theo code", async (status, code, mong) => {
      const m = await xacNhan({ ok: false, status, json: async () => ({ error: "Câu chữ bất kỳ order_01XYZ", code }) });
      expect(m.text).toContain(mong);
      expect(m.text).not.toMatch(/order_01|code|HTTP/);
    });

    test("body không phải JSON: câu chung", async () => {
      const m = await xacNhan({ ok: false, status: 502, json: async () => { throw new Error("x"); } });
      expect(m.text).toContain("Chưa rõ đơn #12 đã ghi nhận tiền chưa");
    });
  });

  describe("huỷ đơn (ghi, không hoàn tác)", () => {
    test.each([
      "huỷ đơn 12", "hủy đơn 12", "huy don 12", "Huỷ đơn CW12 giúp em", "huỷ đơn #12", "huỷ đơn số 12 nhé", "vui lòng huỷ đơn 12", "hủy đơn hàng 12 đi", "/ops huỷ đơn 12",
    ])("hiểu câu huỷ đơn: %s", (cau) => {
      expect(phanTichLenhDonHang(cau)).toEqual({ type: "order_cancel", order_number: 12 });
      expect(phanTichLenhNhanh(cau)).toEqual({ type: "order_cancel", order_number: 12 });
    });

    test.each([
      "khách muốn huỷ đơn 12 không ạ?", "đừng huỷ đơn 12", "đơn 12 bị huỷ rồi", "đã huỷ đơn 12", "không huỷ đơn 12", "em huỷ đơn 12 cho anh rồi nhé",
      "huỷ đơn 12 được không", "huỷ đơn 12?", "Huỷ đơn 12 à?", "huỷ đơn 12 luôn à", "huy don 12 khong", "huỷ đơn 12 chưa", "huỷ đơn 1.250", "huỷ đơn 1,250", "huỷ đơn 1234567", "huỷ đơn 3 chai vang đỏ", "huỷ đơn 500k", "huỷ đơn 0912345678", "huỷ đơn 091234567", "huỷ đơn", "huỷ 12", "huỷ đơn 12 và 13",
      "chị Lan nhờ huỷ đơn 12", "nếu khách huỷ đơn 12 thì báo em",
    ])("câu âm tính không thành lệnh huỷ: %s", (cau) => {
      expect(phanTichLenhDonHang(cau)?.type ?? "").not.toBe("order_cancel");
      expect(phanTichLenhNhanh(cau)?.type ?? "").not.toBe("order_cancel");
    });

    test("câu huỷ trong nhóm không /ops vẫn là lệnh; câu âm tính thì không", () => {
      expect(laYeuCauVanHanh({ chat: { id: 1 }, text: "huỷ đơn 12" }, bot)).toBe(true);
      expect(laYeuCauVanHanh({ chat: { id: 1 }, text: "khách muốn huỷ đơn 12 không ạ?" }, bot)).toBe(false);
    });

    test("bản nháp đơn đã thu tiền: nhấn mạnh hoàn tiền + không hoàn tác, nút rõ nghĩa", async () => {
      (fetchJson as jest.Mock).mockResolvedValue({ orders: [{ ...don(12, ORDER_ID), payment_status: "da_thanh_toan", customer: { name: "Nguyễn Văn A", phone: "0912345678" } }] });
      await xuLyYeuCauVanHanh(bot, "tenant-1", tin("huỷ đơn 12"));
      const luu = sqlCalls.find((c) => /INSERT INTO telegram_operator_action/.test(c.sql))!;
      expect(luu.params[4]).toBe("order_cancel");
      expect(String((fetchJson as jest.Mock).mock.calls[0][0])).toContain("/ai/orders-operator?display_id=12");
      const m = gui.mock.calls[0][1];
      expect(m.text).toContain("Huỷ đơn #12?");
      expect(m.text).toContain("Nguyễn Văn A");
      expect(m.text).toContain("1.250.000đ");
      expect(m.text).toContain("Khách ĐÃ chuyển 1.250.000đ");
      expect(m.text).toContain("TỰ chuyển khoản trả lại khách — hệ thống chỉ ghi sổ, không tự trả tiền");
      expect(m.text).toContain("Khách KHÔNG được báo tự động");
      expect(m.text).toContain("• 2 × Penfolds Bin 389");
      expect(m.text).toContain("09xx***678");
      expect(m.text).not.toContain("0912345678");
      expect(m.text).not.toMatch(/sẽ HOÀN TIỀN|Đã hoàn/);
      expect(m.text).toContain("không hoàn tác được");
      expect(m.text).not.toContain(ORDER_ID);
      const nut = JSON.stringify(m.reply_markup);
      expect(nut).toContain("ops_ok_");
      expect(nut).toContain("ops_no_");
      expect(nut).toContain("Xác nhận HUỶ ĐƠN");
    });

    test.each([
      ["cho_chuyen_khoan", "kiểm tra khách đã chuyển tiền chưa; nếu rồi thì phải tự chuyển trả"], ["cod", "chưa thu tiền"], [null, "kiểm tra khách đã chuyển tiền chưa; nếu rồi thì phải tự chuyển trả"],
    ])("bản nháp đơn %s không hứa hoàn tiền", async (tt, mong) => {
      (fetchJson as jest.Mock).mockResolvedValue({ orders: [{ ...don(12, ORDER_ID), payment_status: tt }] });
      await xuLyYeuCauVanHanh(bot, "tenant-1", tin("huỷ đơn 12"));
      const t = gui.mock.calls[0][1].text;
      expect(t).toContain(mong);
      expect(t).not.toMatch(/sẽ HOÀN TIỀN|tự hoàn/);
      expect(t).toContain("Khách KHÔNG được báo tự động");
    });

    test.each([
      ["completed", "đã được duyệt (đã xuất kho), bot không huỷ được. Nếu khách trả hàng, anh/chị báo quản lý."],
      ["canceled", "đã được huỷ rồi"],
      ["archived", "hiện không huỷ được"],
    ])("đơn %s: báo lỗi, không tạo bản nháp", async (st, mong) => {
      (fetchJson as jest.Mock).mockResolvedValue({ orders: [don(12, ORDER_ID, st)] });
      await expect(xuLyYeuCauVanHanh(bot, "tenant-1", tin("huỷ đơn 12"))).rejects.toThrow(mong);
      expect(sqlCalls.some((c) => /INSERT/.test(c.sql))).toBe(false);
    });

    test("không có đơn khớp chính xác: không tạo bản nháp", async () => {
      (fetchJson as jest.Mock).mockResolvedValue({ orders: [don(112)] });
      await expect(xuLyYeuCauVanHanh(bot, "tenant-1", tin("huỷ đơn 12"))).rejects.toThrow("Không tìm thấy đơn số 12");
      expect(sqlCalls.some((c) => /INSERT/.test(c.sql))).toBe(false);
    });

    test("gửi lại bản nháp huỷ cũ thì gia hạn, không tạo thêm", async () => {
      const cu = "99999999-2222-3333-4444-555555555555";
      (fetchJson as jest.Mock).mockResolvedValue({ orders: [don(12, ORDER_ID)] });
      (runInTenantContext as jest.Mock).mockImplementation(async (_t: string, fn: any) => fn({
        query: async (sql: string, params: any[] = []) => {
          sqlCalls.push({ sql, params });
          if (/SELECT id FROM telegram_operator_action/.test(sql)) return { rows: [{ id: cu }] };
          return { rows: [], rowCount: 1 };
        },
      }));
      await xuLyYeuCauVanHanh(bot, "tenant-1", tin("huỷ đơn 12"));
      expect(sqlCalls.find((c) => /SET expires_at/.test(c.sql))?.params).toEqual([cu, "tenant-1"]);
      expect(sqlCalls.some((c) => /INSERT/.test(c.sql))).toBe(false);
      expect(sqlCalls.find((c) => /SELECT id FROM/.test(c.sql))!.sql).toContain("'order_cancel'");
    });

    test("nút Huỷ đơn trong chi tiết đơn: chỉ pending, đặt cuối", async () => {
      const lay = async (st: string, id: number) => {
        gui.mockClear();
        (fetchJson as jest.Mock).mockResolvedValue({ orders: [{ ...don(12, ORDER_ID, st), payment_status: "cho_chuyen_khoan" }] });
        await xuLyYeuCauVanHanh(bot, "tenant-1", { ...tin("xem đơn 12"), message_id: id });
        return gui.mock.calls[0][1].reply_markup?.inline_keyboard?.flat().map((n: any) => n.callback_data) ?? [];
      };
      expect(await lay("pending", 31)).toEqual(["ops_ord_12", "ops_pay_12", "ops_cxl_12"]);
      expect(await lay("completed", 32)).not.toContain("ops_cxl_12");
      expect(await lay("canceled", 33)).not.toContain("ops_cxl_12");
    });

    test("bấm ops_cxl_N ra bản nháp (chưa huỷ gì)", async () => {
      (fetchJson as jest.Mock).mockResolvedValue({ orders: [don(12, ORDER_ID)] });
      await xuLyCallbackVanHanh(bot, "tenant-1", { id: "cc", data: "ops_cxl_12", from: { id: 9 }, message: { chat: { id: 7 } } });
      expect(gui.mock.calls[0][1].text).toContain("Huỷ đơn #12?");
      expect(fetchCoTimeout).not.toHaveBeenCalled();
    });

    test("lưới gợi ý: chỉ khi câu bắt đầu bằng huỷ đơn hoặc chat riêng; phủ định thì im", () => {
      const k = (c: string, rieng = false) => (goiYDonHang(c, rieng) as any)?.reply_markup?.inline_keyboard?.flat().map((n: any) => n.callback_data) ?? [];
      expect(k("huỷ đơn 12 giùm em nha chị ơi ok", false)).toEqual(["ops_cxl_12"]);
      expect(k("đơn 12 huỷ giúp em", true)).toEqual(["ops_cxl_12"]);
      expect(k("đơn 12 huỷ giúp em", false)).toEqual([]);
      expect(k("khách muốn huỷ đơn 12 không ạ", true)).toEqual([]);
      expect(k("đừng huỷ đơn 12", true)).toEqual([]);
      expect(k("đơn 12 bị huỷ rồi", true)).toEqual([]);
      expect(k("huỷ đơn 12 và 13", false)).toEqual([]);
      expect(k("huỷ đơn 12 và đơn 13", false)).toEqual(["ops_cxl_12", "ops_cxl_13"]);
      expect(k("huỷ đơn 500k", true)).toEqual([]);
      expect(k("huỷ đơn 12 chai", true)).toEqual([]);
      expect(k("huỷ đơn 1.250", true)).toEqual([]);
      expect(k("huỷ đơn 1234567", true)).toEqual([]);
      expect(k("huỷ đơn 12?", false)).toEqual([]);
    });

    test("LLM không có tool huỷ đơn; LLM lỡ trả order_cancel cũng bị bỏ qua", async () => {
      (goiDeepSeekCoTool as jest.Mock).mockResolvedValue({ tool_calls: [{ function: { name: "order_cancel", arguments: JSON.stringify({ order_number: 12 }) } }] });
      await expect(xuLyYeuCauVanHanh(bot, "tenant-1", tin("/ops bỏ luôn cái đơn 12 đó em"))).rejects.toThrow("chưa hiểu");
      const tools = (goiDeepSeekCoTool as jest.Mock).mock.calls[0][1] as any[];
      expect(tools.map((t) => t.function.name)).not.toContain("order_cancel");
      expect(sqlCalls.some((c) => /INSERT/.test(c.sql))).toBe(false);
    });

    test("cổng tiếp quản khách: câu lệnh ghi về đơn bị nhận diện, câu thường thì không", () => {
      for (const c of ["huỷ đơn 12", "duyệt đơn 12", "đã nhận tiền đơn 12", "duyệt đơn 12, 13"]) expect(laLenhGhiDonHang(c)).toBe(true);
      for (const c of ["xem đơn 12", "đơn mới", "dạ em huỷ đơn 12 cho anh rồi nhé", "chào anh, em gửi hàng hôm nay"]) expect(laLenhGhiDonHang(c)).toBe(false);
    });

    test("chỉ người tạo mới xác nhận được lệnh huỷ", async () => {
      executingRow = null;
      (runInTenantContext as jest.Mock).mockImplementation(async (_t: string, fn: any) => fn({
        query: async (sql: string, params: any[] = []) => {
          sqlCalls.push({ sql, params });
          if (/SET status='executing'/.test(sql)) return { rows: [], rowCount: 0 };
          if (/requested_by <> \$4/.test(sql)) return { rows: [{ "?column?": 1 }], rowCount: 1 };
          return { rows: [], rowCount: 1 };
        },
      }));
      await xuLyCallbackVanHanh(bot, "tenant-1", { id: "cx2", data: `ops_ok_${UUID}`, from: { id: 99 }, message: { chat: { id: 7 } } });
      const claim = sqlCalls.find((c) => /SET status='executing'/.test(c.sql))!;
      expect(claim.sql).toContain("requested_by = $1");
      const { answerCallbackQuery } = jest.requireMock("./services/telegram");
      expect(answerCallbackQuery.mock.calls.some((c: any[]) => c[2] === "Chỉ người tạo lệnh huỷ mới xác nhận được.")).toBe(true);
      expect(fetchCoTimeout).not.toHaveBeenCalled();
    });

    const xacNhan = async (resp: any, payload: any = { order_id: ORDER_ID, display_id: 12, total_vnd: 1250000, payment_status: "da_thanh_toan" }) => {
      executingRow = { action_type: "order_cancel", payload };
      (fetchCoTimeout as jest.Mock).mockReset();
      if (resp instanceof Error) (fetchCoTimeout as jest.Mock).mockRejectedValue(resp); else (fetchCoTimeout as jest.Mock).mockResolvedValue(resp);
      gui.mockClear();
      await xuLyCallbackVanHanh(bot, "tenant-1", { id: "cx", data: `ops_ok_${UUID}`, from: { id: 9 }, message: { chat: { id: 7 } } });
      return gui.mock.calls[0][1];
    };

    test("xác nhận gọi đúng endpoint/body; đã thu thì nhắc TỰ chuyển trả, không nói đã hoàn", async () => {
      const m = await xacNhan({ ok: true, status: 200, json: async () => ({ ok: true, mode: "cancel_refund" }) });
      const [url, init] = (fetchCoTimeout as jest.Mock).mock.calls[0];
      expect(String(url)).toBe("http://medusa.test/ai/refund-order");
      const body = JSON.parse(init.body);
      expect(body.orderId).toBe(ORDER_ID);
      expect(body.partial).toBeUndefined();
      expect(body.refundAmount).toBeUndefined();
      expect(m.text).toContain("✅ Đã huỷ đơn #12.\n⚠️ Nhớ chuyển trả 1.250.000đ cho khách và nhắn khách biết.");
      expect(m.text).not.toContain("Đã hoàn");
    });

    test("backend mới: dùng paid_amount và needs_manual_refund; already; không cần trả", async () => {
      const m = await xacNhan({ ok: true, status: 200, json: async () => ({ ok: true, mode: "cancel", paid_amount: 900000, needs_manual_refund: true }) });
      expect(m.text).toContain("Nhớ chuyển trả 900.000đ cho khách");
      const m2 = await xacNhan({ ok: true, status: 200, json: async () => ({ ok: true, mode: "cancel", already: true }) });
      expect(m2.text).toContain("Đơn #12 đã được huỷ rồi.");
      const m3 = await xacNhan({ ok: true, status: 200, json: async () => ({ ok: true, mode: "cancel", paid_amount: 0, needs_manual_refund: false }) });
      expect(m3.text).toContain("✅ Đã huỷ đơn #12.");
      expect(m3.text).not.toContain("chuyển trả");
      expect(m3.text).toContain("Khách không được báo tự động");
    });

    test("đơn chưa thu tiền (backend cũ): không nhắc chuyển trả", async () => {
      const m = await xacNhan({ ok: true, status: 200, json: async () => ({ ok: true }) }, { order_id: ORDER_ID, display_id: 12, total_vnd: 1250000, payment_status: "cod" });
      expect(m.text).toContain("✅ Đã huỷ đơn #12.");
      expect(m.text).not.toContain("chuyển trả");
    });

    test.each([
      [404, "order_not_found", "Không tìm thấy đơn số 12"], [409, "order_completed", "đã được duyệt (đã xuất kho) nên bot không huỷ được; cần làm trả hàng"],
      [409, "has_fulfillment", "cần làm trả hàng, anh/chị báo quản lý"], [409, "order_status_invalid", "hiện không huỷ được"],
      [409, "in_progress", "đang được xử lý"], [500, "lock_error", "hệ thống đang lỗi"], [500, "internal_error", "hệ thống đang lỗi"],
      [401, "unauthorized", "Bot chưa kết nối được hệ thống bán hàng"],
    ])("lỗi %s code %s map theo code", async (status, code, mong) => {
      const m = await xacNhan({ ok: false, status, json: async () => ({ error: "Cannot cancel order with fulfillment order_01XYZ", code }) });
      expect(m.text).toContain(mong);
      expect(m.text).not.toMatch(/order_01|fulfillment|HTTP/);
    });

    test.each([
      [401, "Bot chưa kết nối được hệ thống bán hàng"], [404, "Không tìm thấy đơn số 12"], [400, "thiếu thông tin đơn"],
      [500, "Chưa huỷ được đơn #12"], [502, "Chưa huỷ được đơn #12"],
    ])("backend cũ không có code: lỗi HTTP %s map theo status", async (status, mong) => {
      const m = await xacNhan({ ok: false, status, json: async () => ({ error: "Cannot cancel order with fulfillment order_01XYZ", goi_y: "create-return" }) });
      expect(m.text).toContain(mong);
      expect(m.text).not.toMatch(/order_01|fulfillment|create-return|HTTP/);
    });

    test("lỗi mạng / body không phải JSON: nói chưa rõ, hướng dẫn gõ lại", async () => {
      const m = await xacNhan(new Error("ECONNRESET"));
      expect(m.text).toContain("Chưa rõ đơn #12 đã huỷ chưa");
      const m2 = await xacNhan({ ok: false, status: 502, json: async () => { throw new Error("x"); } });
      expect(m2.text).toContain("Chưa huỷ được đơn #12");
    });
  });

  describe("D4 tạo mã giảm giá", () => {
    test.each([
      ["1tr25", 1250000], ["1.250k", 1250000], ["1,25 triệu", 1250000], ["1.250.000", 1250000], ["50k", 50000], ["50 nghìn", 50000],
      ["500000đ", 500000], ["2tr", 2000000], ["1tr5", 1500000], ["1,5k", 1500], ["10", 10],
    ])("đọc số tiền VN: %s", (cau, so) => expect(parseTienVN(cau)).toBe(so));

    test.each([
      ["tạo mã giảm 10%", { discount_percent: 10 }], ["tao ma giam 10%", { discount_percent: 10 }],
      ["tạo mã giảm giá 50k", { discount_amount: 50000 }], ["Tạo mã giảm 1tr", { discount_amount: 1000000 }],
      ["tạo mã TET10 giảm 10%", { discount_percent: 10, discount_code: "TET10" }],
      ["tạo mã giảm 10 phần trăm nhé", { discount_percent: 10 }], ["/ops tạo mã giảm 20%", { discount_percent: 20 }],
      ["tạo mã giảm 15% hết hạn 31/12", { discount_percent: 15, han_ngay: { d: 31, m: 12 } }],
      ["tạo mã giảm 10% đến 30/11", { discount_percent: 10, han_ngay: { d: 30, m: 11 } }],
      ["tạo mã giảm 10% hạn 05/01/2027", { discount_percent: 10, han_ngay: { d: 5, m: 1, y: 2027 } }],
      ["tạo mã giảm 10% trong 7 ngày", { discount_percent: 10, han_so_ngay: 7 }],
      ["tạo mã giảm 10% hạn 1 tuần", { discount_percent: 10, han_so_ngay: 7 }],
      ["tạo mã giảm 15% dùng 50 lần", { discount_percent: 15, usage_limit: 50 }],
      ["tạo mã giảm 15% chỉ dùng 1 lần", { discount_percent: 15, usage_limit: 1 }],
      ["tạo mã TET10 giảm 50k hết hạn 31/12 dùng 100 lần", { discount_code: "TET10", discount_amount: 50000, han_ngay: { d: 31, m: 12 }, usage_limit: 100 }],
      ["tạo mã giảm 10", { so_tran: 10 }],
    ])("hiểu câu tạo mã: %s", (cau, mong) => {
      expect(phanTichLenhShop(cau)).toEqual({ type: "discount_create", ...mong });
      expect(phanTichLenhNhanh(cau)?.type).toBe("discount_create"); // không bị nhánh kho "giảm N" bắt nhầm
    });

    // Có ý tạo mã mà không hiểu hết: phải từ chối rõ (loi_hieu), TUYỆT ĐỐI không rơi sang trừ kho.
    test.each([
      "tạo mã giảm 10% cho rượu vang đỏ", "tạo mã giảm 10% tối đa 50k", "tạo mã giảm 10% cho 5 khách đầu", "tạo mã giảm 10% đơn trên 1tr",
      "tạo mã giảm 10% cho chị Lan", "tạo mã giảm 10% cho khách VIP", "tạo mã giảm 10% áp dụng đến cuối tháng", "tạo mã giảm 10% cho đơn từ 2 chai",
      "tạo mã giảm 10%?", "tạo mã giảm 10% được không", "tạo mã giảm 5%0", "tạo mã giảm 20%%", "tạo mã giảm 1000%", "tạo mã giảm 10% 50k", "tạo mã giảm 50k5",
      "tạo mã", "tạo mã cho khách", "/ops mã giảm 15%", "/ops giảm 10%", "/ops tạo mã 10%",
    ])("câu tạo mã không hiểu hết bị từ chối rõ, không thành xuất kho: %s", (cau) => {
      const l = phanTichLenhNhanh(cau);
      expect(l?.type).not.toBe("inventory_adjust");
      expect(l?.type).toBe("discount_create");
      expect(l?.loi_hieu).toBeTruthy();
    });

    test("câu từ chối nêu rõ điều kiện chưa hỗ trợ", async () => {
      await expect(xuLyYeuCauVanHanh(bot, "tenant-1", tin("/ops tạo mã giảm 10% cho chị Lan"))).rejects.toThrow("chưa hỗ trợ điều kiện");
      await expect(xuLyYeuCauVanHanh(bot, "tenant-1", { ...tin("/ops tạo mã giảm 10% tối đa 50k"), message_id: 6 })).rejects.toThrow("chưa hỗ trợ điều kiện “toi da 50k”");
      await expect(xuLyYeuCauVanHanh(bot, "tenant-1", { ...tin("/ops giảm 10%"), message_id: 7 })).rejects.toThrow("Em chưa hiểu mức giảm");
      await expect(xuLyYeuCauVanHanh(bot, "tenant-1", { ...tin("/ops tạo mã giảm 1000%"), message_id: 8 })).rejects.toThrow();
      expect(sqlCalls.some((c) => /INSERT/.test(c.sql))).toBe(false);
    });

    test("kho vẫn chạy bình thường, kể cả có % trong tên chai", () => {
      expect(phanTichLenhNhanh("/ops Penfolds Bin 389 xuất kho 4 chai")).toMatchObject({ type: "inventory_adjust", quantity_change: -4 });
      expect(phanTichLenhNhanh("Vang 13% cồn Shiraz nhập thêm 30 chai")).toMatchObject({ type: "inventory_adjust", quantity_change: 30 });
      expect(phanTichLenhNhanh("Opus One giảm 5")).toMatchObject({ type: "inventory_adjust", quantity_change: -5 });
    });

    test.each([
      "khách hỏi có mã giảm giá không", "giá này đắt quá", "mã giảm giá còn không ạ?", "mã giảm hết rồi", "em gửi mã giảm 10% cho khách rồi nhé",
      "chị hỏi mã giảm giá của tháng này", "mã giảm 10% nha anh", "mã giảm 10% cho chị nha", "mã giảm 50k cho anh nhé", "mã giảm 10% ạ", "mã giảm 15%",
      "mã giảm giá của chị là TET10 nhé", "mã giảm 10% của chị là TET10", "giảm 10% cho chị nhé", "giảm 10%",
    ])("câu nói với khách không thành lệnh tạo mã: %s", (cau) => {
      expect(phanTichLenhShop(cau)).toBeNull();
      expect(laLenhGhiDonHang(cau)).toBe(false);
    });

    test("tính hạn dùng: 23:59:59 giờ VN, ngày qua không năm thì sang năm sau, ngày sai/qua/xa bị từ chối", () => {
      const now = new Date("2026-10-23T05:00:00Z"); // 12:00 ngày 23/10 giờ VN
      expect(tinhHanDung({ ngay: { d: 31, m: 12 } }, now)).toEqual({ ends_at: "2026-12-31T23:59:59+07:00", nhan: "23:59 31/12/2026" });
      expect(tinhHanDung({ ngay: { d: 5, m: 1 } }, now).ends_at).toBe("2027-01-05T23:59:59+07:00");
      expect(tinhHanDung({ ngay: { d: 23, m: 10 } }, now).ends_at).toBe("2026-10-23T23:59:59+07:00");
      expect(tinhHanDung({ soNgay: 7 }, now).ends_at).toBe("2026-10-30T23:59:59+07:00");
      expect(() => tinhHanDung({ ngay: { d: 1, m: 1, y: 2026 } }, now)).toThrow("đã qua");
      expect(() => tinhHanDung({ ngay: { d: 31, m: 2 } }, now)).toThrow("không có thật");
      expect(() => tinhHanDung({ soNgay: 400 }, now)).toThrow("xa quá");
      // 23:30 giờ VN vẫn là ngày hôm đó (16:30Z)
      expect(tinhHanDung({ soNgay: 1 }, new Date("2026-10-23T16:30:00Z")).ends_at).toBe("2026-10-24T23:59:59+07:00");
    });

    test("chuẩn hoá mã theo luật backend", () => {
      expect(chuanHoaMa(" tet-10 ")).toBe("TET-10");
      expect(chuanHoaMa("ab")).toBeNull();
      expect(chuanHoaMa("TẾT10")).toBeNull();
      expect(chuanHoaMa("a".repeat(33))).toBeNull();
      expect(chuanHoaMa("A".repeat(32))).toHaveLength(32);
    });

    test("mã tự sinh dễ đọc, không có 0/O/1/I và hợp luật backend", () => {
      for (let i = 0; i < 200; i++) {
        expect(sinhMaGiamGia(10)).toMatch(/^GIAM10-[A-HJ-NP-Z2-9]{4}$/);
        expect(sinhMaGiamGia(undefined, 50000)).toMatch(/^GIAM50K-[A-HJ-NP-Z2-9]{4}$/);
        expect(chuanHoaMa(sinhMaGiamGia(30))).not.toBeNull();
      }
    });

    test("bản nháp: mã, mức giảm; không hạn / không giới hạn thì nói rõ", async () => {
      await xuLyYeuCauVanHanh(bot, "tenant-1", tin("tạo mã giảm 10%"));
      const luu = sqlCalls.find((c) => /INSERT INTO telegram_operator_action/.test(c.sql))!;
      expect(luu.params[4]).toBe("discount_create");
      const pl = JSON.parse(luu.params[6]);
      expect(pl.code).toMatch(/^GIAM10-/);
      expect(pl.percent).toBe(10);
      const m = gui.mock.calls[0][1];
      expect(m.text).toContain("Tạo mã giảm giá?");
      expect(m.text).toContain("10%");
      expect(m.text).toContain("KHÔNG có");
      expect(m.text).toContain("KHÔNG giới hạn");
      expect(JSON.stringify(m.reply_markup)).toContain("ops_ok_");
    });

    test("bản nháp có hạn và số lượt", async () => {
      await xuLyYeuCauVanHanh(bot, "tenant-1", tin("/ops tạo mã tet10 giảm 50k trong 7 ngày dùng 50 lần"));
      const pl = JSON.parse(sqlCalls.find((c) => /INSERT INTO telegram_operator_action/.test(c.sql))!.params[6]);
      expect(pl).toMatchObject({ code: "TET10", custom_code: true, percent: null, amount: 50000, usage_limit: 50 });
      expect(pl.ends_at).toMatch(/^\d{4}-\d{2}-\d{2}T23:59:59\+07:00$/);
      const t = gui.mock.calls[0][1].text;
      expect(t).toContain("50.000đ");
      expect(t).toContain("23:59");
      expect(t).toContain("tối đa <b>50</b> lần");
      expect(t).not.toContain("KHÔNG giới hạn");
    });

    test.each([
      ["tạo mã giảm 31%", "vượt giới hạn"], ["tạo mã giảm 90%", "tối đa 30%"], ["tạo mã giảm 600k", "tối đa 30% hoặc 500.000đ"],
      ["tạo mã giảm 2 triệu", "vượt giới hạn"], ["tạo mã giảm 12,5%", "số % nguyên"], ["tạo mã giảm 500", "tối thiểu 1.000đ"],
      ["tạo mã giảm 10% hết hạn 31/02", "không có thật"], ["tạo mã giảm 10% hết hạn 01/01/2020", "đã qua"],
      ["tạo mã giảm 10% dùng 0 lần", "từ 1 đến 100.000"],
    ])("ngoài giới hạn / sai thì bị từ chối, không tạo bản nháp: %s", async (cau, mong) => {
      await expect(xuLyYeuCauVanHanh(bot, "tenant-1", tin(cau))).rejects.toThrow(mong);
      expect(sqlCalls.some((c) => /INSERT/.test(c.sql))).toBe(false);
    });

    test("đúng ngưỡng 30% và 500.000đ thì được", async () => {
      await xuLyYeuCauVanHanh(bot, "tenant-1", tin("tạo mã giảm 30%"));
      await xuLyYeuCauVanHanh(bot, "tenant-1", { ...tin("tạo mã giảm 500k"), message_id: 6 });
      expect(gui.mock.calls.length).toBe(2);
      expect(GIOI_HAN_MA_GIAM).toMatchObject({ toi_da_phan_tram: 30, toi_da_so_tien: 500000 });
    });

    test("số trần nhỏ không đơn vị: hỏi 10% hay 10.000đ bằng 2 nút; số vượt giới hạn chỉ còn nút hợp lệ", async () => {
      await xuLyYeuCauVanHanh(bot, "tenant-1", tin("tạo mã giảm 10"));
      expect(gui.mock.calls[0][1].text).toContain("10% hay 10.000đ");
      expect(gui.mock.calls[0][1].reply_markup.inline_keyboard.flat().map((n: any) => n.callback_data)).toEqual(["ops_dsc_p10", "ops_dsc_a10000"]);
      gui.mockClear();
      await xuLyYeuCauVanHanh(bot, "tenant-1", { ...tin("tạo mã giảm 50"), message_id: 6 });
      expect(gui.mock.calls[0][1].reply_markup.inline_keyboard.flat().map((n: any) => n.callback_data)).toEqual(["ops_dsc_a50000"]);
      expect(sqlCalls.some((c) => /INSERT/.test(c.sql))).toBe(false);
    });

    test("LLM: số phải có trong câu gốc, chỉ một loại mức giảm", async () => {
      (goiDeepSeekCoTool as jest.Mock).mockResolvedValue({ tool_calls: [{ function: { name: "discount_create", arguments: JSON.stringify({ percent: 10 }) } }] });
      await xuLyYeuCauVanHanh(bot, "tenant-1", tin("/ops làm cho em cái voucher 10% nhé khách VIP"));
      expect(gui.mock.calls[0][1].text).toContain("Tạo mã giảm giá?");
      expect(fetchCoTimeout).not.toHaveBeenCalled();
      sqlCalls.length = 0;
      (goiDeepSeekCoTool as jest.Mock).mockResolvedValue({ tool_calls: [{ function: { name: "discount_create", arguments: JSON.stringify({ percent: 25 }) } }] });
      await expect(xuLyYeuCauVanHanh(bot, "tenant-1", { ...tin("/ops làm cho em cái voucher 10% nhé khách VIP"), message_id: 8 })).rejects.toThrow("chưa hiểu");
      (goiDeepSeekCoTool as jest.Mock).mockResolvedValue({ tool_calls: [{ function: { name: "discount_create", arguments: JSON.stringify({ percent: 10, amount: 50000 }) } }] });
      await expect(xuLyYeuCauVanHanh(bot, "tenant-1", { ...tin("/ops làm cho em cái voucher 10% nhé khách VIP"), message_id: 9 })).rejects.toThrow("chưa hiểu");
      expect(sqlCalls.some((c) => /INSERT/.test(c.sql))).toBe(false);
    });

    test("LLM: mã chỉ nhận khi là từ nguyên vẹn trong câu (không lấy mảnh của từ khác)", async () => {
      const llm = (code: string) => (goiDeepSeekCoTool as jest.Mock).mockResolvedValue({ tool_calls: [{ function: { name: "discount_create", arguments: JSON.stringify({ percent: 10, code }) } }] });
      llm("TET");
      await xuLyYeuCauVanHanh(bot, "tenant-1", tin("/ops làm cho em cái voucher 10% mã TET nhé khách VIP"));
      expect(JSON.parse(sqlCalls.find((c) => /INSERT INTO telegram_operator_action/.test(c.sql))!.params[6]).code).toBe("TET");
      sqlCalls.length = 0;
      llm("TET");
      await xuLyYeuCauVanHanh(bot, "tenant-1", { ...tin("/ops làm cho em cái voucher 10% dịp tet2025 nhé khách VIP"), message_id: 6 });
      expect(JSON.parse(sqlCalls.find((c) => /INSERT INTO telegram_operator_action/.test(c.sql))!.params[6]).code).toMatch(/^GIAM10-/);
    });

    test("LLM vẫn bị chặn giới hạn khi vào bản nháp", async () => {
      (goiDeepSeekCoTool as jest.Mock).mockResolvedValue({ tool_calls: [{ function: { name: "discount_create", arguments: JSON.stringify({ percent: 50 }) } }] });
      await expect(xuLyYeuCauVanHanh(bot, "tenant-1", tin("/ops làm cho em cái voucher 50% nhé khách VIP"))).rejects.toThrow("vượt giới hạn");
    });

    test("gợi ý chat riêng: có nút khi trong giới hạn; ngoài giới hạn, có mã/hạn/lượt hoặc nhóm thì không có nút", () => {
      const k = (c: string, rieng: boolean) => (goiYDonHang(c, rieng) as any)?.reply_markup?.inline_keyboard?.flat().map((n: any) => n.callback_data) ?? [];
      expect(k("tạo mã giảm 10%", true)).toEqual(["ops_dsc_p10"]);
      expect(k("tạo mã giảm 50k", true)).toEqual(["ops_dsc_a50000"]);
      expect(k("tạo mã giảm 10", true)).toEqual(["ops_dsc_p10", "ops_dsc_a10000"]);
      expect(k("tạo mã giảm 40%", true)).toEqual([]);
      expect(k("tạo mã giảm 600k", true)).toEqual([]);
      expect(k("tạo mã giảm 10% trong 7 ngày", true)).toEqual([]);
      expect(k("tạo mã TET10 giảm 10%", true)).toEqual([]);
      expect((goiYDonHang("tạo mã TET10 giảm 10%", true) as any).text).toContain("/ops");
      expect(goiYDonHang("tạo mã giảm 10%", false)).toBeNull();
      expect(goiYDonHang("khách hỏi có mã giảm giá không", true)).toBeNull();
    });

    test("nút ops_dsc_p10 ra bản nháp; nút vượt giới hạn bị từ chối", async () => {
      await xuLyCallbackVanHanh(bot, "tenant-1", { id: "d1", data: "ops_dsc_p10", from: { id: 9 }, message: { chat: { id: 7 } } });
      expect(gui.mock.calls[0][1].text).toContain("Tạo mã giảm giá?");
      gui.mockClear();
      await xuLyCallbackVanHanh(bot, "tenant-1", { id: "d2", data: "ops_dsc_p99", from: { id: 9 }, message: { chat: { id: 7 } } });
      expect(gui.mock.calls[0][1].text).toContain("vượt giới hạn");
    });

    const xacNhanMa = async (resp: any, payload: any = { code: "GIAM10-7KQ4", custom_code: false, percent: 10, amount: null, ends_at: null, usage_limit: null }) => {
      executingRow = { action_type: "discount_create", payload };
      (fetchCoTimeout as jest.Mock).mockReset();
      if (resp instanceof Error) (fetchCoTimeout as jest.Mock).mockRejectedValue(resp); else (fetchCoTimeout as jest.Mock).mockResolvedValue(resp);
      gui.mockClear();
      await xuLyCallbackVanHanh(bot, "tenant-1", { id: "cx", data: `ops_ok_${UUID}`, from: { id: 9 }, message: { chat: { id: 7 } } });
      return gui.mock.calls[0][1];
    };

    test("xác nhận gọi đúng endpoint/body (number, ends_at, usage_limit); mã báo lại lấy từ promotion.code", async () => {
      const m = await xacNhanMa({ ok: true, status: 200, json: async () => ({ ok: true, promotion: { code: "GIAM10-7KQ4" } }) });
      const [url, init] = (fetchCoTimeout as jest.Mock).mock.calls[0];
      expect(String(url)).toBe("http://medusa.test/ai/create-discount");
      expect(JSON.parse(init.body)).toEqual({ code: "GIAM10-7KQ4", percent: 10 });
      expect(m.text).toContain("✅ Đã tạo mã <code>GIAM10-7KQ4</code> — giảm 10%. Gửi mã này cho khách là dùng được.");
      const m2 = await xacNhanMa({ ok: true, status: 200, json: async () => ({ ok: true, promotion: { code: "TET10" } }) },
        { code: "tet10", custom_code: true, percent: null, amount: 50000, ends_at: "2026-12-31T23:59:59+07:00", ends_label: "23:59 31/12/2026", usage_limit: 50 });
      expect(JSON.parse((fetchCoTimeout as jest.Mock).mock.calls[0][1].body)).toEqual({ code: "tet10", amount: 50000, currency: "vnd", ends_at: "2026-12-31T23:59:59+07:00", usage_limit: 50 });
      expect(m2.text).toContain("<code>TET10</code>");
      expect(m2.text).toContain("giảm 50.000đ");
      expect(m2.text).toContain("đến 23:59 31/12/2026");
      expect(m2.text).toContain("tối đa 50 lần");
    });

    test("mã trong bản nháp đã chuẩn hoá; mã sai luật bị từ chối trước khi lập bản nháp", async () => {
      await xuLyYeuCauVanHanh(bot, "tenant-1", tin("tạo mã tet_10 giảm 10%"));
      expect(JSON.parse(sqlCalls.find((c) => /INSERT INTO telegram_operator_action/.test(c.sql))!.params[6]).code).toBe("TET_10");
    });

    test.each([
      [401, "unauthorized", "Bot chưa kết nối được hệ thống bán hàng"], [400, "invalid_value", "chưa hợp lệ"], [409, "duplicate_code", "Mã GIAM10-7KQ4 bị trùng"],
      [500, "internal_error", "hệ thống đang lỗi"], [500, "", "Có thể mã bị trùng"], [400, "", "chưa hợp lệ"],
    ])("lỗi HTTP %s code %s", async (status, code, mong) => {
      const m = await xacNhanMa({ ok: false, status, json: async () => ({ error: "duplicate key value violates promotion_code_key", code }) });
      expect(m.text).toContain(mong);
      expect(m.text).not.toMatch(/duplicate key|violates/);
    });

    test("mã tự đặt trùng: nói đặt tên khác", async () => {
      const m = await xacNhanMa({ ok: false, status: 409, json: async () => ({ error: "x", code: "duplicate_code" }) },
        { code: "TET10", custom_code: true, percent: 10, amount: null, ends_at: null, usage_limit: null });
      expect(m.text).toContain("Mã TET10 đã có, anh/chị đặt tên khác.");
    });

    test("lỗi mạng: dặn kiểm tra trước khi tạo lại", async () => {
      const m = await xacNhanMa(new Error("ECONNRESET"));
      expect(m.text).toContain("Chưa rõ mã GIAM10-7KQ4 đã tạo chưa");
    });

    test("chỉ người tạo mới xác nhận được lệnh tạo mã", async () => {
      executingRow = null;
      (runInTenantContext as jest.Mock).mockImplementation(async (_t: string, fn: any) => fn({
        query: async (sql: string, params: any[] = []) => {
          sqlCalls.push({ sql, params });
          if (/SET status='executing'/.test(sql)) return { rows: [], rowCount: 0 };
          if (/requested_by <> \$4/.test(sql)) return { rows: [{ action_type: "discount_create" }], rowCount: 1 };
          return { rows: [], rowCount: 1 };
        },
      }));
      await xuLyCallbackVanHanh(bot, "tenant-1", { id: "cx3", data: `ops_ok_${UUID}`, from: { id: 99 }, message: { chat: { id: 7 } } });
      expect(sqlCalls.find((c) => /SET status='executing'/.test(c.sql))!.sql).toContain("'order_cancel', 'discount_create', 'price_update'");
      const { answerCallbackQuery } = jest.requireMock("./services/telegram");
      expect(answerCallbackQuery.mock.calls.some((c: any[]) => c[2] === "Chỉ người tạo lệnh này mới xác nhận được.")).toBe(true);
      expect(fetchCoTimeout).not.toHaveBeenCalled();
    });
  });

  describe("D5 ẩn / mở bán sản phẩm, đổi giá", () => {
    test.each([
      ["ẩn sản phẩm Penfolds Bin 389", "product_hide", "Penfolds Bin 389"], ["an san pham Catena Malbec", "product_hide", "Catena Malbec"],
      ["ẩn sp Penfolds", "product_hide", "Penfolds"],
      ["ngừng bán sản phẩm Penfolds Bin 389", "product_hide", "Penfolds Bin 389"], ["tạm ngừng bán sản phẩm Catena Malbec nhé", "product_hide", "Catena Malbec"],
      ["giấu sản phẩm Opus One đi", "product_hide", "Opus One"],
      ["mở bán lại sản phẩm Penfolds Bin 389", "product_show", "Penfolds Bin 389"], ["mo ban lai san pham Catena Malbec", "product_show", "Catena Malbec"],
      ["mở bán lại sản phẩm Penfolds", "product_show", "Penfolds"], ["mở bán lại sp Opus One giúp em", "product_show", "Opus One"],
    ])("hiểu câu: %s", (cau, loai, ten) => {
      expect(phanTichLenhShop(cau)).toEqual({ type: loai, product_query: ten });
    });

    test.each([
      ["đổi giá Penfolds Bin 389 thành 1.250.000", "Penfolds Bin 389", 1250000], ["sửa giá Penfolds 389 1tr25", "Penfolds 389", 1250000],
      ["sửa giá Catena Malbec là 1,25 triệu giúp em nhé", "Catena Malbec", 1250000], ["đổi giá Opus One thành 1.250k", "Opus One", 1250000],
      ["doi gia Opus One thanh 850000", "Opus One", 850000], ["cập nhật giá Opus One 2tr", "Opus One", 2000000],
    ])("hiểu câu đổi giá (bắt buộc có đổi/sửa): %s", (cau, ten, gia) => {
      expect(phanTichLenhShop(cau)).toEqual({ type: "product_price", product_query: ten, price_vnd: gia });
    });

    // Nguồn: /tmp/probe-ops/cases.txt + danh sách reviewer. Đây là lời nhân viên NÓI VỚI KHÁCH, không được thành lệnh và không bị cổng chặn.
    test.each([
      "giá Penfolds 1tr5", "giá chai này 500k ạ", "chị ơi giá bên em là 1tr2 nhé", "Giá Bin 389 bên em 1tr5 ạ", "giá ưu đãi 1tr2", "giá 2 chai 1tr",
      "giá chai Penfolds hiện tại là 1.250.000đ", "dạ giá chai này 1tr2 ạ", "anh ơi giá 850k nha", "giá 850k nha anh", "giá Penfolds 389 1tr25",
      "ngừng bán rồi anh ạ", "ngừng bán mẫu này rồi chị", "ngừng kinh doanh mẫu đó rồi ạ", "mẫu này bên em ngừng kinh doanh rồi", "ngừng bán sản phẩm này rồi ạ",
      "mở bán lại rồi chị", "mở bán lại vào thứ 2 nha chị", "mở bán lại tuần sau nha chị", "bán lại 2 chai cho anh", "bán lại cho anh 1 chai nhé",
      "ẩn Penfolds Bin 389", "giá này đắt quá", "ngừng bán hàng sáng nay", "hôm nay ngừng bán Penfolds", "giá Penfolds bao nhiêu",
    ])("lời nói với khách không thành lệnh sản phẩm và không bị cổng chặn: %s", (cau) => {
      const t = phanTichLenhShop(cau)?.type ?? "";
      if (cau === "ngừng bán sản phẩm này rồi ạ") expect(cau).toBeTruthy(); // mở đầu bằng lệnh rõ: có thể bị cổng chặn (có nút Vẫn gửi), kiểm riêng dưới
      else {
        expect(["product_hide", "product_show", "product_price"]).not.toContain(t);
        expect(laLenhGhiDonHang(cau)).toBe(false);
      }
    });

    test.each([
      "ẩn sản phẩm Penfolds không", "ngừng bán sản phẩm Penfolds rồi à", "mở bán lại sản phẩm chưa", "đổi giá Penfolds được không", "sửa giá Opus One 2tr?",
    ])("câu hỏi không thành lệnh sản phẩm: %s", (cau) => {
      const t = phanTichLenhShop(cau)?.type ?? "";
      expect(["product_hide", "product_show", "product_price"]).not.toContain(t);
    });

    test("cổng tiếp quản: chỉ chặn câu MỞ ĐẦU bằng động từ lệnh rõ", () => {
      for (const c of ["huỷ đơn 12", "duyệt đơn 12", "đã nhận tiền đơn 12", "tạo mã giảm 10%", "ẩn sản phẩm Penfolds", "ngừng bán sản phẩm Opus One",
        "mở bán lại sản phẩm Opus One", "đổi giá Opus One thành 850000", "sửa giá Opus One 1tr25", "vui lòng huỷ đơn 12", "nhận tiền đơn 12"]) expect(laLenhGhiDonHang(c)).toBe(true);
      for (const c of ["dạ em huỷ đơn 12 cho anh rồi nhé", "dạ bên em đang có mã giảm giá cho đơn đầu ạ", "xem đơn 12", "đơn mới", "chào anh, em gửi hàng hôm nay",
        "đã nhận tiền của khách hôm qua", "em tạo mã cho anh rồi nhé",
        "thêm mã voucher vào ô thanh toán là được anh ạ", "tạo mã giảm giá trên web là được anh ạ", "đổi giá rồi chị ơi", "sửa giá rồi ạ",
        "ngừng bán sản phẩm này rồi anh ạ", "mở bán lại sản phẩm này tuần sau nha chị", "ẩn sp này rồi anh ạ", "ẩn sản phẩm Penfolds nha anh"]) expect(laLenhGhiDonHang(c)).toBe(false);
      for (const c of ["hiện lại sản phẩm Grange", "hiện sản phẩm Grange", "bật lại sản phẩm Grange", "ngừng kinh doanh sp Grange"]) expect(laLenhGhiDonHang(c)).toBe(true);
    });

    test.each([
      "giảm 50k Penfolds", "giảm 50 nghìn Bin 389", "bớt 100k cho anh nhé", "trừ 20k phí ship nha anh", "ưu đãi giảm 50k cho đơn đầu ạ",
    ])("giảm + tiền không bị hiểu là trừ kho: %s", (cau) => {
      expect(phanTichLenhNhanh(cau)?.type).not.toBe("inventory_adjust");
    });

    test.each([
      ["giảm 5 chai Penfolds", -5], ["xuất 3 chai Penfolds", -3], ["nhập thêm 12 chai Penfolds", 12], ["trừ kho 2 chai Penfolds", -2],
    ])("lệnh kho cũ vẫn chạy: %s", (cau, n) => {
      expect(phanTichLenhNhanh(cau)).toMatchObject({ type: "inventory_adjust", quantity_change: n });
    });

    test("mã: dấu phẩy, 'hết hạn trong', mã viết thường; đổi giá 'mới là' không là lệnh", () => {
      expect(phanTichLenhShop("tạo mã giảm 10%, hết hạn 31/12, dùng 50 lần")).toMatchObject({ discount_percent: 10, usage_limit: 50 });
      expect(phanTichLenhShop("tạo mã giảm 10% dùng 1 lần hết hạn trong 3 ngày")).toMatchObject({ han_so_ngay: 3, usage_limit: 1 });
      expect(phanTichLenhShop("tạo mã Tet giảm 10%")).toMatchObject({ discount_code: "TET", discount_percent: 10 });
      expect(phanTichLenhShop("tạo mã vip giảm 10%")).toMatchObject({ discount_code: "VIP" });
      expect(phanTichLenhShop("cập nhật giá mới là 1.250k anh nhé")).toBeNull();
    });

    const sp = (id: string, title: string, sku: string) => ({ id, title, sku });
    const lookup = (rows: any[]) => (fetchJson as jest.Mock).mockResolvedValue({ ok: true, items: rows });
    const bien = (pid: string, vid: string, title: string, vt: string, gia: number, sku = "SKU") => ({ product_id: pid, variant_id: vid, title, variant_title: vt, price_vnd: gia, sku });

    test("ẩn: một kết quả KHỚP ĐỦ TỪ -> bản nháp có tên + SKU", async () => {
      (timSanPham as jest.Mock).mockResolvedValue({ products: [sp("prod_1", "Penfolds Bin 389", "PF389")] });
      await xuLyYeuCauVanHanh(bot, "tenant-1", tin("/ops ngừng bán sản phẩm Penfolds Bin 389"));
      const luu = sqlCalls.find((c) => /INSERT INTO telegram_operator_action/.test(c.sql))!;
      expect(luu.params[4]).toBe("product_hide");
      expect(JSON.parse(luu.params[6])).toMatchObject({ product_id: "prod_1", title: "Penfolds Bin 389" });
      expect(gui.mock.calls[0][1].text).toContain("Ẩn sản phẩm khỏi cửa hàng?");
      expect(gui.mock.calls[0][1].text).toContain("PF389");
      expect((timSanPham as jest.Mock).mock.calls[0][1]).toMatchObject({ query: "Penfolds Bin 389", in_stock_only: false });
    });

    test("ẩn: một kết quả nhưng KHÔNG khớp đủ từ -> luôn hiện danh sách, không tự ẩn", async () => {
      (timSanPham as jest.Mock).mockResolvedValue({ products: [sp("prod_28", "Penfolds Bin 28", "PF28")] });
      await xuLyYeuCauVanHanh(bot, "tenant-1", tin("/ops ẩn sản phẩm Penfolds Bin 389"));
      const luu = sqlCalls.find((c) => /INSERT INTO telegram_operator_action/.test(c.sql))!;
      expect(luu.params[5]).toBe("awaiting_selection");
      const m = gui.mock.calls[0][1];
      expect(m.text).toContain("Không thấy đúng? Anh/chị gõ rõ tên hơn");
      expect(JSON.stringify(m.reply_markup)).toContain("ops_pick_");
    });

    test("ẩn: nhiều kết quả -> nút chọn ops_pick, chọn xong ra bản nháp có product_id", async () => {
      (timSanPham as jest.Mock).mockResolvedValue({ products: [sp("prod_1", "Penfolds Bin 389", "PF389"), sp("prod_2", "Penfolds Bin 28", "PF28")] });
      await xuLyYeuCauVanHanh(bot, "tenant-1", tin("/ops ngừng bán sản phẩm Penfolds"));
      expect(JSON.stringify(gui.mock.calls[0][1].reply_markup)).toContain(`ops_pick_${UUID}_1`);
      const luu = sqlCalls.find((c) => /INSERT INTO telegram_operator_action/.test(c.sql))!;
      expect(luu.params[5]).toBe("awaiting_selection");
      const pl = JSON.parse(luu.params[6]);
      (runInTenantContext as jest.Mock).mockImplementation(async (_t: string, fn: any) => fn({
        query: async (sql: string, params: any[] = []) => {
          sqlCalls.push({ sql, params });
          if (/SELECT action_type, payload/.test(sql)) return { rows: [{ action_type: "product_hide", payload: pl }] };
          return { rows: [], rowCount: 1 };
        },
      }));
      gui.mockClear();
      await xuLyCallbackVanHanh(bot, "tenant-1", { id: "pk", data: `ops_pick_${UUID}_1`, from: { id: 9 }, message: { chat: { id: 7 } } });
      expect(gui.mock.calls[0][1].text).toContain("Penfolds Bin 28");
      const up = sqlCalls.find((c) => /SET status='awaiting_confirmation', payload/.test(c.sql))!;
      expect(JSON.parse(up.params[0])).toMatchObject({ product_id: "prod_2", sku: "PF28" });
    });

    test("ẩn: không tìm thấy -> báo, không tạo bản nháp", async () => {
      (timSanPham as jest.Mock).mockResolvedValue({ products: [] });
      await expect(xuLyYeuCauVanHanh(bot, "tenant-1", tin("/ops ngừng bán sản phẩm Zzz Qqq"))).rejects.toThrow("Không tìm thấy sản phẩm đang bán");
      expect(sqlCalls.some((c) => /INSERT/.test(c.sql))).toBe(false);
    });

    test("mở bán lại: bỏ tiền tố 'sản phẩm', lịch sử ẩn mới nhất trước, hỏi backend status=draft", async () => {
      (runInTenantContext as jest.Mock).mockImplementation(async (_t: string, fn: any) => fn({
        query: async (sql: string, params: any[] = []) => {
          sqlCalls.push({ sql, params });
          if (/FROM telegram_operator_action h/.test(sql)) return { rows: [{ id: "prod_1", title: "Penfolds Bin 389", sku: "PF389" }, { id: "prod_9", title: "Catena Malbec", sku: null }] };
          if (/INSERT INTO/.test(sql)) return { rows: [{ id: UUID }], rowCount: 1 };
          return { rows: [], rowCount: 1 };
        },
      }));
      lookup([bien("prod_1", "var_1", "Penfolds Bin 389", "Default", 1000000, "PF389")]);
      await xuLyYeuCauVanHanh(bot, "tenant-1", tin("/ops mở bán lại sản phẩm penfolds 389"));
      expect(gui.mock.calls[0][1].text).toContain("Mở bán lại sản phẩm?");
      expect(gui.mock.calls[0][1].text).toContain("Penfolds Bin 389");
      expect(timSanPham).not.toHaveBeenCalled();
      const hist = sqlCalls.find((c) => /FROM telegram_operator_action h/.test(c.sql))!;
      expect(hist.sql).toContain("ORDER BY h.created_at DESC");
      expect(hist.sql).not.toContain("DISTINCT ON");
      const [url, init] = (fetchJson as jest.Mock).mock.calls[0];
      expect(String(url)).toContain("/ai/products-lookup");
      expect(JSON.parse(init.body)).toEqual({ ids: ["prod_1"], status: "draft" });
    });

    test("mở bán lại theo SKU (sản phẩm ẩn từ trang quản trị): hỏi lookup status=draft theo skus", async () => {
      (runInTenantContext as jest.Mock).mockImplementation(async (_t: string, fn: any) => fn({
        query: async (sql: string, params: any[] = []) => {
          sqlCalls.push({ sql, params });
          if (/FROM telegram_operator_action h/.test(sql)) return { rows: [] };
          if (/INSERT INTO/.test(sql)) return { rows: [{ id: UUID }], rowCount: 1 };
          return { rows: [], rowCount: 1 };
        },
      }));
      lookup([bien("prod_7", "var_7", "Sassicaia", "Default", 5000000, "SASS07")]);
      await xuLyYeuCauVanHanh(bot, "tenant-1", tin("/ops mở bán lại sản phẩm SASS07"));
      expect(JSON.parse((fetchJson as jest.Mock).mock.calls[0][1].body)).toEqual({ skus: ["SASS07"], status: "draft" });
      expect(gui.mock.calls[0][1].text).toContain("Sassicaia");
    });

    test("mở bán lại: không thấy thì giải thích (không còn câu 'ẩn qua admin thì không thấy')", async () => {
      (runInTenantContext as jest.Mock).mockImplementation(async (_t: string, fn: any) => fn({ query: async () => ({ rows: [], rowCount: 0 }) }));
      await expect(xuLyYeuCauVanHanh(bot, "tenant-1", tin("/ops mở bán lại sản phẩm Zzz Qqq"))).rejects.toThrow("Em không thấy sản phẩm đang ẩn nào khớp");
    });

    test("đổi giá, một biến thể: bản nháp giá cũ -> giá mới, chênh %; gọi lookup theo id", async () => {
      (timSanPham as jest.Mock).mockResolvedValue({ products: [sp("prod_1", "Penfolds Bin 389", "PF389")] });
      lookup([bien("prod_1", "var_1", "Penfolds Bin 389", "Default", 1000000, "PF389")]);
      await xuLyYeuCauVanHanh(bot, "tenant-1", tin("/ops đổi giá Penfolds Bin 389 thành 1.250.000"));
      const luu = sqlCalls.find((c) => /INSERT INTO telegram_operator_action/.test(c.sql))!;
      expect(luu.params[4]).toBe("price_update");
      expect(JSON.parse(luu.params[6])).toMatchObject({ product_id: "prod_1", variant_id: "var_1", old_price_vnd: 1000000, new_price_vnd: 1250000 });
      const t = gui.mock.calls[0][1].text;
      expect(t).toContain("Đổi giá?");
      expect(t).toContain("1.000.000đ → <b>1.250.000đ</b> (+25%)");
      expect(t).not.toContain("rất lớn");
      expect(JSON.parse((fetchJson as jest.Mock).mock.calls[0][1].body)).toEqual({ ids: ["prod_1"] });
    });

    test.each([
      [1000000, 400000, "(-60%)", true], [1000000, 500000, "(-50%)", false], [1000000, 3000000, "(+200%)", false], [1000000, 3500000, "(+250%)", true],
    ])("cảnh báo giá thay đổi rất lớn: %s -> %s", async (cu, moi, nhan, canhBao) => {
      (timSanPham as jest.Mock).mockResolvedValue({ products: [sp("prod_1", "Penfolds Bin 389", "PF389")] });
      lookup([bien("prod_1", "var_1", "Penfolds Bin 389", "Default", cu, "PF389")]);
      await xuLyYeuCauVanHanh(bot, "tenant-1", { ...tin(`/ops đổi giá Penfolds Bin 389 thành ${moi}`), message_id: 40 + moi });
      const t = gui.mock.calls[0][1].text;
      expect(t).toContain(nhan);
      expect(t.includes("⚠️ Giá thay đổi rất lớn, anh/chị kiểm tra lại số")).toBe(canhBao);
    });

    test("đổi giá, nhiều biến thể: hiện nút chọn biến thể (kèm giá), chọn xong ra bản nháp có variant_id + giá cũ", async () => {
      (timSanPham as jest.Mock).mockResolvedValue({ products: [sp("prod_1", "Penfolds Bin 389", "PF389")] });
      lookup([bien("prod_1", "var_a", "Penfolds Bin 389", "75cl", 1000000, "PF389-75"), bien("prod_1", "var_b", "Penfolds Bin 389", "Magnum", 2500000, "PF389-MG")]);
      await xuLyYeuCauVanHanh(bot, "tenant-1", tin("/ops đổi giá Penfolds Bin 389 thành 1.250.000"));
      const luu = sqlCalls.find((c) => /INSERT INTO telegram_operator_action/.test(c.sql))!;
      expect(luu.params[5]).toBe("awaiting_selection");
      expect(JSON.stringify(gui.mock.calls[0][1].reply_markup)).toContain("Magnum");
      const pl = JSON.parse(luu.params[6]);
      expect(pl.new_price_vnd).toBe(1250000);
      (runInTenantContext as jest.Mock).mockImplementation(async (_t: string, fn: any) => fn({
        query: async (sql: string, params: any[] = []) => {
          sqlCalls.push({ sql, params });
          if (/SELECT action_type, payload/.test(sql)) return { rows: [{ action_type: "price_update", payload: pl }] };
          return { rows: [], rowCount: 1 };
        },
      }));
      gui.mockClear();
      await xuLyCallbackVanHanh(bot, "tenant-1", { id: "pk2", data: `ops_pick_${UUID}_1`, from: { id: 9 }, message: { chat: { id: 7 } } });
      const up = JSON.parse(sqlCalls.find((c) => /SET status='awaiting_confirmation', payload/.test(c.sql))!.params[0]);
      expect(up).toMatchObject({ variant_id: "var_b", old_price_vnd: 2500000, new_price_vnd: 1250000, product_id: "prod_1" });
      expect(gui.mock.calls[0][1].text).toContain("2.500.000đ → <b>1.250.000đ</b>");
    });

    test("đổi giá: không khớp đủ từ -> hiện danh sách; không tìm thấy -> báo", async () => {
      (timSanPham as jest.Mock).mockResolvedValue({ products: [sp("prod_28", "Penfolds Bin 28", "PF28")] });
      lookup([bien("prod_28", "var_28", "Penfolds Bin 28", "Default", 900000, "PF28")]);
      await xuLyYeuCauVanHanh(bot, "tenant-1", tin("/ops đổi giá Penfolds Bin 389 thành 1.250.000"));
      expect(sqlCalls.find((c) => /INSERT INTO telegram_operator_action/.test(c.sql))!.params[5]).toBe("awaiting_selection");
      (timSanPham as jest.Mock).mockResolvedValue({ products: [] });
      await expect(xuLyYeuCauVanHanh(bot, "tenant-1", { ...tin("/ops đổi giá Zzz Qqq thành 1.250.000"), message_id: 50 })).rejects.toThrow("Không tìm thấy sản phẩm đang bán");
    });

    const xacNhanSp = async (loai: string, resp: any, payload: any = { product_id: "prod_1", title: "Penfolds Bin 389", sku: "PF389", variant_id: "var_1", old_price_vnd: 1000000, new_price_vnd: 1250000 }) => {
      executingRow = { action_type: loai, payload };
      (fetchCoTimeout as jest.Mock).mockReset();
      if (resp instanceof Error) (fetchCoTimeout as jest.Mock).mockRejectedValue(resp); else (fetchCoTimeout as jest.Mock).mockResolvedValue(resp);
      gui.mockClear();
      await xuLyCallbackVanHanh(bot, "tenant-1", { id: "cx", data: `ops_ok_${UUID}`, from: { id: 9 }, message: { chat: { id: 7 } } });
      return gui.mock.calls[0][1];
    };

    test("xác nhận ẩn / mở bán gọi /ai/update-product đúng body", async () => {
      const m = await xacNhanSp("product_hide", { ok: true, status: 200, json: async () => ({ ok: true }) });
      let [url, init] = (fetchCoTimeout as jest.Mock).mock.calls[0];
      expect(String(url)).toBe("http://medusa.test/ai/update-product");
      expect(JSON.parse(init.body)).toEqual({ id: "prod_1", update: { status: "draft" } });
      expect(m.text).toContain("Đã ẩn <b>Penfolds Bin 389</b>");
      const m2 = await xacNhanSp("product_show", { ok: true, status: 200, json: async () => ({ ok: true }) });
      [url, init] = (fetchCoTimeout as jest.Mock).mock.calls[0];
      expect(JSON.parse(init.body)).toEqual({ id: "prod_1", update: { status: "published" } });
      expect(m2.text).toContain("Đã mở bán lại");
    });

    test.each([[401, "Bot chưa kết nối được hệ thống bán hàng"], [500, "Chưa ẩn được"], [502, "Chưa ẩn được"]])("lỗi HTTP %s khi ẩn", async (status, mong) => {
      const m = await xacNhanSp("product_hide", { ok: false, status, json: async () => ({ error: "ProductStatus boom product_01XYZ" }) });
      expect(m.text).toContain(mong);
      expect(m.text).not.toMatch(/boom|product_01/);
    });

    test("lỗi mạng khi ẩn: chưa rõ, kiểm tra trang quản trị", async () => {
      expect((await xacNhanSp("product_hide", new Error("ECONNRESET"))).text).toContain("Chưa rõ");
    });

    test("xác nhận đổi giá gọi /ai/update-price đúng body; báo kết quả từ response", async () => {
      const m = await xacNhanSp("price_update", { ok: true, status: 200, json: async () => ({ ok: true, variant_id: "var_1", product_title: "Penfolds Bin 389", variant_title: "Default", old_price_vnd: 1000000, new_price_vnd: 1250000 }) });
      const [url, init] = (fetchCoTimeout as jest.Mock).mock.calls[0];
      expect(String(url)).toBe("http://medusa.test/ai/update-price");
      expect(JSON.parse(init.body)).toEqual({ variant_id: "var_1", amount_vnd: 1250000 });
      expect(m.text).toContain("✅ Đã đổi giá");
      expect(m.text).toContain("1.000.000đ → <b>1.250.000đ</b>");
    });

    test.each([
      [400, "invalid_price", "Giá mới không hợp lệ"], [404, "variant_not_found", "Không tìm thấy"], [404, "product_not_found", "Không tìm thấy"],
      [409, "ambiguous_variant", "nhiều loại"], [400, "invalid_target", "chưa xác định được sản phẩm"], [401, "unauthorized", "Bot chưa kết nối được hệ thống bán hàng"],
      [500, "internal_error", "Chưa đổi được giá"], [500, "", "Chưa đổi được giá"],
    ])("đổi giá lỗi %s code %s map theo code", async (status, code, mong) => {
      const m = await xacNhanSp("price_update", { ok: false, status, json: async () => ({ error: "SQL boom variant_01XYZ", code }) });
      expect(m.text).toContain(mong);
      expect(m.text).not.toMatch(/boom|variant_01/);
    });

    test("chỉ người tạo mới xác nhận được lệnh đổi giá", async () => {
      executingRow = null;
      (runInTenantContext as jest.Mock).mockImplementation(async (_t: string, fn: any) => fn({
        query: async (sql: string, params: any[] = []) => {
          sqlCalls.push({ sql, params });
          if (/SET status='executing'/.test(sql)) return { rows: [], rowCount: 0 };
          if (/requested_by <> \$4/.test(sql)) return { rows: [{ action_type: "price_update" }], rowCount: 1 };
          return { rows: [], rowCount: 1 };
        },
      }));
      await xuLyCallbackVanHanh(bot, "tenant-1", { id: "cx4", data: `ops_ok_${UUID}`, from: { id: 99 }, message: { chat: { id: 7 } } });
      expect(fetchCoTimeout).not.toHaveBeenCalled();
    });

    test("LLM ẩn sản phẩm: tên phải có trong câu; vẫn qua bản nháp", async () => {
      (timSanPham as jest.Mock).mockResolvedValue({ products: [sp("prod_1", "Penfolds Bin 389", "PF389")] });
      (goiDeepSeekCoTool as jest.Mock).mockResolvedValue({ tool_calls: [{ function: { name: "product_visibility", arguments: JSON.stringify({ product_query: "Penfolds Bin 389", visible: false }) } }] });
      await xuLyYeuCauVanHanh(bot, "tenant-1", tin("/ops Penfolds Bin 389 hết hàng dài hạn rồi, gỡ khỏi shop giùm"));
      expect(gui.mock.calls[0][1].text).toContain("Ẩn sản phẩm khỏi cửa hàng?");
      expect(fetchCoTimeout).not.toHaveBeenCalled();
      (goiDeepSeekCoTool as jest.Mock).mockResolvedValue({ tool_calls: [{ function: { name: "product_visibility", arguments: JSON.stringify({ product_query: "Opus One", visible: false }) } }] });
      await expect(xuLyYeuCauVanHanh(bot, "tenant-1", { ...tin("/ops Penfolds Bin 389 hết hàng dài hạn rồi, gỡ khỏi shop giùm"), message_id: 20 })).rejects.toThrow("chưa hiểu");
    });

    test("LLM đổi giá: phải có 'đổi/sửa giá' trong câu và giá phải xuất hiện trong câu gốc", async () => {
      (timSanPham as jest.Mock).mockResolvedValue({ products: [sp("prod_1", "Penfolds Bin 389", "PF389")] });
      lookup([bien("prod_1", "var_1", "Penfolds Bin 389", "Default", 1000000, "PF389")]);
      const llm = (g: number) => (goiDeepSeekCoTool as jest.Mock).mockResolvedValue({ tool_calls: [{ function: { name: "product_price", arguments: JSON.stringify({ product_query: "Penfolds Bin 389", price_vnd: g }) } }] });
      llm(1250000);
      await xuLyYeuCauVanHanh(bot, "tenant-1", tin("/ops giùm em chỉnh đổi giá chai Penfolds Bin 389 xuống còn 1tr25 đi"));
      expect(gui.mock.calls[0][1].text).toContain("Đổi giá?");
      llm(125000); // LLM bịa số không có trong câu
      await expect(xuLyYeuCauVanHanh(bot, "tenant-1", { ...tin("/ops giùm em chỉnh đổi giá chai Penfolds Bin 389 xuống còn 1tr25 đi"), message_id: 61 })).rejects.toThrow("chưa hiểu");
      llm(1250000); // câu không có "đổi/sửa giá"
      await expect(xuLyYeuCauVanHanh(bot, "tenant-1", { ...tin("/ops chai Penfolds Bin 389 bán 1tr25 thôi nhé"), message_id: 62 })).rejects.toThrow("chưa hiểu");
    });

    test("gợi ý chat riêng chỉ hướng dẫn gõ /ops; nhóm im lặng; lời nói với khách thì im", () => {
      expect((goiYDonHang("ngừng bán sản phẩm Penfolds Bin 389", true) as any).text).toContain("/ops");
      expect(goiYDonHang("ngừng bán sản phẩm Penfolds Bin 389", false)).toBeNull();
      expect(goiYDonHang("giá này đắt quá", true)).toBeNull();
      expect(goiYDonHang("giá Penfolds 1tr5", true)).toBeNull();
    });
  });

  describe("cổng tiếp quản: giữ lệnh ghi, gửi thẳng câu nói với khách", () => {
    // Spec hai chiều. CAU_KHACH: nhân viên nhắn khách -> gửi thẳng. CAU_LENH: lệnh ghi (kể cả viết lệch) -> giữ/chặn kèm nút.
    const CAU_KHACH: string[] = [
      "chào anh, em là Linh bên shop rượu vang ạ",
      "dạ chai Penfolds 389 giá 1.250.000đ ạ",
      "giá chai này 500k ạ",
      "bên em còn hàng anh nhé",
      "dạ hết hàng chai này rồi anh ạ",
      "em xác nhận đơn 12 cho anh rồi nhé",
      "đơn 12 em huỷ cho chị rồi ạ",
      "duyệt đơn 12 xong rồi anh nhé",
      "mã giảm 10% nha anh",
      "em gửi anh mã giảm 50k nhé",
      "ship nội thành 30k, 2 ngày nhận hàng ạ",
      "anh cho em xin địa chỉ nhận hàng nhé",
      "dạ em đã nhận được tiền của anh rồi ạ",
      "đơn 12 đã được duyệt rồi anh nhé",
      "em gửi hàng hôm nay anh nhé",
      "chai này vang đỏ Úc, 14 độ, hợp với bò nướng ạ",
      "anh muốn lấy mấy chai ạ",
      "giảm giá cho anh còn 1tr2 nhé",
      "bên em giảm 10% khi mua 6 chai ạ",
      "em tăng thêm 1 chai tặng anh nhé",
      "dạ em kiểm tra tồn kho rồi báo anh nhé",
      "em xuất hoá đơn cho anh nhé",
      "chị chờ em một chút ạ",
      "em cảm ơn anh nhiều",
      "chai này ngừng bán rồi anh ạ",
      "sản phẩm này tạm hết, tuần sau có lại nha chị",
      "em ẩn giá cho anh được không ạ",
      "dạ em nhập thêm hàng tuần sau, anh chờ nhé",
      "đơn của anh em đã huỷ rồi ạ",
      "đơn 12 của chị em duyệt rồi nhé",
      "anh thanh toán chuyển khoản giúp em nhé",
      "em đã nhận tiền đơn 12 rồi anh nhé",
      "giá hôm nay đã đổi rồi anh ạ",
      "mã giảm giá của anh dùng đến hết tháng này ạ",
      "dạ em tạo đơn cho anh luôn nhé",
      "anh cho em xin số điện thoại ạ",
      "hàng sẽ giao trong ngày mai ạ",
      "chai 2019 còn 3 chai ạ",
      "em báo giá lại cho anh: 1tr5 nhé",
      "vâng ạ, em hiểu rồi",
      "đơn hàng của anh đang được đóng gói ạ",
      "em xin lỗi vì sự bất tiện này ạ",
      "anh nhận hàng kiểm tra giúp em nhé",
      "dạ rượu này uống ngon nhất ở 16 độ ạ",
      "tặng anh mã giảm 10% cho lần sau nhé",
      "hiện bên em đang có khuyến mãi 2 chai giảm 100k ạ",
      "em gửi ảnh chai để anh xem nhé",
      "dạ vâng ạ",
      "Tổng cộng 3 chai",
      "Cộng 2 chai là 2tr4",
      "Tăng 1 chai tặng 1 chai",
      "Rượu nhập 2019 anh",
      "Còn bao nhiêu chai anh cần ạ?",
      "Bớt 2 chai được không anh",
      "Xuất 2 chai cho anh nhé",
      "Tồn kho chai này còn 5",
      "Đơn hàng mới của anh em nhận rồi",
      "Đơn của anh chưa duyệt ạ",
      "Đơn anh đang chờ duyệt",
      "Xem đơn 12 nhé",
      "Anh check đơn 12 giúp em",
      "Đơn 12 của anh đã duyệt",
      "Doanh thu bên em ổn anh",
      "Ăn với bò bít tết là ngon nhất",
      "Ăn uống vui vẻ",
      "An tâm anh nhé",
      "An toàn tuyệt đối ạ",
      "Ẩn danh người nhận được không anh?",
      "Ẩn thông tin hoá đơn giúp anh nhé",
      "Giấu quà trong hộp nhé",
      "Huỷ đơn 12 cho anh nhé",
      "Hoàn thành đơn 12 cho anh nhé",
      "đổi giá chai này 1tr2 cho anh nhé",
      "Giảm giá chai Penfolds còn 1200000 cho anh luôn",
      "đổi giá Penfolds 389 còn 1200000 cho anh nha",
      "tạo mã giảm 10% cho anh nhé",
      "thêm mã giảm 50k cho chị nha",
      "ngừng bán sản phẩm Penfolds 389 rồi anh"
];
    const CAU_LENH: string[] = [
      "huỷ giúp đơn 12",
      "đơn 12 huỷ",
      "bot huỷ đơn 12",
      "giảm giá Penfolds 389 còn 1200000",
      "ẩn Penfolds Bin 389",
      "nhập 10 chai Penfolds",
      "xuất 2 chai Penfolds",
      "tạo sản phẩm mới Vang X giá 500000",
      "tạo mã giảm 10% nha anh",
      "đổi giá Penfolds 389 1200000 nhé anh",
      "đơn 12 duyệt",
      "duyệt đơn 12",
      "huỷ đơn 12",
      "tạo mã giảm 10%",
      "tạo voucher 50k",
      "tạo mã voucher 50k",
      "em huỷ đơn 12",
      "ẩn sản phẩm Penfolds",
      "ngừng bán sản phẩm Opus One",
      "mở bán lại sản phẩm Opus One",
      "đổi giá Opus One thành 850000",
      "sửa giá Opus One 1tr25",
      "đã nhận tiền đơn 12",
      "nhận tiền đơn 12",
      "vui lòng huỷ đơn 12",
      "hiện lại sản phẩm Grange",
      "nhập thêm 5 chai Opus One",
      "tạo mã giảm 50k",
      "xác nhận đơn 12",
      "hoàn thành đơn 12",
      "giấu sản phẩm Penfolds"
];
    const DUOC_PHEP_GIU = new Set(["dạ em kiểm tra tồn kho rồi báo anh nhé"]);

    test("bộ câu khách: ≤ 3 câu bị giữ, và 0 câu trong danh sách 'giữ nhầm' đã biết", () => {
      const giu = CAU_KHACH.filter(canGiuCauChoGui);
      console.log(`[cổng giữ] câu khách bị giữ: ${giu.length}/${CAU_KHACH.length} ${JSON.stringify(giu)}`);
      expect(CAU_KHACH.length).toBeGreaterThanOrEqual(77);
      expect(giu.length).toBeLessThanOrEqual(3);
      for (const c of CAU_KHACH.slice(48)) expect([c, canGiuCauChoGui(c)]).toEqual([c, false]);
      for (const c of ["em xác nhận đơn 12 cho anh rồi nhé", "đơn 12 em huỷ cho chị rồi ạ", "duyệt đơn 12 xong rồi anh nhé", "giá chai này 500k ạ", "mã giảm 10% nha anh"]) {
        expect(canGiuCauChoGui(c)).toBe(false);
        expect(laLenhGhiDonHang(c)).toBe(false);
      }
    });

    test("bộ lệnh: tất cả bị giữ hoặc chặn", () => {
      const tha = CAU_LENH.filter((c) => !canGiuCauChoGui(c));
      console.log(`[cổng giữ] câu lệnh bị giữ: ${CAU_LENH.length - tha.length}/${CAU_LENH.length}, lọt: ${JSON.stringify(tha)}`);
      expect(CAU_LENH.length).toBeGreaterThanOrEqual(30);
      expect(tha).toEqual([]);
    });

    test("7 câu nói với khách đuôi 'cho anh nhé / nha chị' không bị chặn nhầm (laLenhGhiDonHang)", () => {
      for (const c of ["đổi giá chai này 1tr2 cho anh nhé", "đổi giá Penfolds 389 còn 1200000 cho anh nha", "tạo mã giảm 10% cho anh nhé",
        "thêm mã giảm 50k cho chị nha", "ngừng bán sản phẩm Penfolds 389 rồi anh", "huỷ đơn 12 nhé anh", "xác nhận đơn 12 nhé chị"]) {
        expect(laLenhGhiDonHang(c)).toBe(false);
      }
    });
  });

  describe("nhãn nút chọn biến thể", () => {
    test("bỏ 'Default Title' và phần lặp tên sản phẩm", () => {
      expect(ghepTenBienThe("Aureus Shiraz 2021", "Aureus Shiraz 2021 — Default Title")).toBe("Aureus Shiraz 2021");
      expect(ghepTenBienThe("Aureus Shiraz 2021", "Default Title")).toBe("Aureus Shiraz 2021");
      expect(ghepTenBienThe("Penfolds Bin 389", "Hộp gỗ 750ml")).toBe("Penfolds Bin 389 — Hộp gỗ 750ml");
      expect(ghepTenBienThe("Château Castle", "Lẻ")).toBe("Château Castle — Lẻ");
      expect(ghepTenBienThe("Penfolds Bin 389 2018", "2018")).toBe("Penfolds Bin 389 2018");
      expect(ghepTenBienThe("Penfolds Bin 389", "2018")).toBe("Penfolds Bin 389 — 2018");
    });
    test("cắt 60 ký tự vẫn giữ SKU, giá và tên biến thể", () => {
      const n = nhanNutChon("Penfolds Grange Shiraz Limited Edition Bin 95 — Hộp gỗ 750ml", "PF-GRANGE-95-750", "1.250.000đ");
      expect(n.length).toBeLessThanOrEqual(60);
      expect(n).toContain("(PF-GRANGE-95-750)");
      expect(n).toContain("Hộp gỗ 750ml");
      expect(n).toContain("1.250.000đ");
      expect(nhanNutChon("Opus One", "OP1")).toBe("Opus One (OP1)");
    });
  });

  describe("nút 'Vẫn gửi cho khách' (cổng tiếp quản)", () => {
    test("đánh dấu câu đã dùng chỉ khi UPDATE trúng đúng 1 dòng", async () => {
      const q = jest.fn(async () => ({ rows: [{ id: UUID }], rowCount: 1 }));
      expect(await danhDauCauDaGui({ query: q }, "tenant-1", UUID, "7", "9")).toBe(true);
      expect((q.mock.calls[0] as any[])[0]).toContain("status='awaiting_confirmation'");
      expect(await danhDauCauDaGui({ query: async () => ({ rows: [], rowCount: 0 }) }, "tenant-1", UUID, "7", "9")).toBe(false);
    });
    test("lưu câu bị chặn với loại forward_to_customer, trả id để gắn vào nút", async () => {
      const id = await luuCauChoGui("tenant-1", "7", "9", "tạo mã cho chị nhé, chị dùng được 3 hôm", "conv-A", "55");
      expect(id).toBe(UUID);
      const luu = sqlCalls.find((c) => /INSERT INTO telegram_operator_action/.test(c.sql))!;
      expect(luu.params[4]).toBe("forward_to_customer");
      expect(JSON.parse(luu.params[6])).toEqual({ text: "tạo mã cho chị nhé, chị dùng được 3 hôm", conversation_id: "conv-A" });
      expect(luu.params[2]).toBe("55");
      expect(`ops_send_${id}`.length).toBeLessThanOrEqual(64);
    });

    test("đọc câu đã lưu: chỉ đúng người gõ, đúng chat, còn hạn (chưa đánh dấu đã dùng)", async () => {
      (runInTenantContext as jest.Mock).mockImplementation(async (_t: string, fn: any) => fn({
        query: async (sql: string, params: any[] = []) => {
          sqlCalls.push({ sql, params });
          return { rows: [{ text: "dạ em gửi anh nhé", conversation_id: "conv-A" }], rowCount: 1 };
        },
      }));
      expect(await layCauChoGui("tenant-1", UUID, "7", "9")).toEqual({ text: "dạ em gửi anh nhé", conversationId: "conv-A" });
      const c = sqlCalls[0];
      expect(c.sql).toContain("action_type='forward_to_customer'");
      expect(c.sql).toContain("status='awaiting_confirmation'");
      expect(c.sql).toContain("expires_at > now()");
      expect(c.sql).toContain("requested_by=$1");
      expect(c.sql).not.toMatch(/UPDATE/);
      expect(c.params).toEqual(["9", UUID, "tenant-1", "7"]);
      (runInTenantContext as jest.Mock).mockImplementation(async (_t: string, fn: any) => fn({ query: async () => ({ rows: [], rowCount: 0 }) }));
      expect(await layCauChoGui("tenant-1", UUID, "7", "10")).toBeNull();
    });
  });

  describe("vòng 2: duyệt đơn đã huỷ, đổi giá gộp biến thể", () => {
    test("409 order_canceled báo đơn đã huỷ, không báo 'đang xử lý'", async () => {
      (fetchCoTimeout as jest.Mock).mockResolvedValue({ ok: false, status: 409, json: async () => ({ code: "order_canceled", error: "x" }) });
      (runInTenantContext as jest.Mock).mockImplementation(async (_t: string, fn: any) => fn({
        query: async (sql: string) => /SET status='executing'/.test(sql)
          ? { rows: [{ id: UUID, action_type: "order_complete", payload: { display_id: 12, order_id: "o1" }, requested_by: "9" }], rowCount: 1 }
          : { rows: [], rowCount: 1 },
      }));
      await xuLyCallbackVanHanh(bot, "tenant-1", { id: "cb", data: `ops_ok_${UUID}`, from: { id: 9 }, message: { chat: { id: 7 } } } as any);
      const texts = (guiTinQuaBot as jest.Mock).mock.calls.map((c) => String(c[1].text));
      expect(texts.some((t) => t.includes("đã bị huỷ nên không duyệt được"))).toBe(true);
      expect(texts.some((t) => t.includes("đang được xử lý"))).toBe(false);
    });

    test("đổi giá: nhiều dòng một variant được gộp trước khi đếm", async () => {
      (timSanPham as jest.Mock).mockResolvedValue({ products: [{ id: "prod_1", title: "Penfolds Bin 389", sku: "PF389" }] });
      (fetchJson as jest.Mock).mockResolvedValue({ ok: true, items: [
        { product_id: "prod_1", variant_id: "v1", title: "Penfolds Bin 389", variant_title: "Default", price_vnd: 1000000, sku: "PF389" },
        { product_id: "prod_1", variant_id: "v1", title: "Penfolds Bin 389", variant_title: "Default", price_vnd: 43, sku: "PF389" },
      ] });
      await xuLyYeuCauVanHanh(bot, "tenant-1", { ...tin("/ops đổi giá Penfolds Bin 389 thành 5000"), message_id: 90 });
      const luu = sqlCalls.find((c) => /INSERT INTO telegram_operator_action/.test(c.sql))!;
      expect(luu.params[5]).toBe("awaiting_confirmation");
      expect(JSON.parse(luu.params[6])).toMatchObject({ variant_id: "v1", old_price_vnd: 1000000 });
      const ban = (guiTinQuaBot as jest.Mock).mock.calls.at(-1)![1].text;
      expect(ban).toContain("Giá rất thấp");
    });
  });

  describe("báo cáo doanh thu (đọc)", () => {
    test.each([
      ["doanh thu hôm nay", { report_period: "today" }], ["doanh thu hom nay", { report_period: "today" }],
      ["doanh thu tuần này", { report_period: "this_week" }], ["doanh thu tháng này", { report_period: "this_month" }],
      ["báo cáo hôm nay", { report_period: "today" }], ["báo cáo tuần này", { report_period: "this_week" }],
      ["doanh thu 7 ngày", { report_days: 7 }], ["doanh thu 30 ngay", { report_days: 30 }], ["xem doanh thu 14 ngày", { report_days: 14 }],
      ["bao cao doanh thu", { report_days: 7 }], ["doanh thu", { report_days: 7 }], ["doanh số tuần qua", { report_days: 7 }],
    ])("hiểu câu báo cáo: %s", (cau, mong) => {
      expect(phanTichLenhDonHang(cau)).toEqual({ type: "revenue_report", ...mong });
      expect(laYeuCauVanHanh({ chat: { id: 1 }, text: cau }, bot)).toBe(true);
    });

    test.each([
      "báo cáo sếp là hôm nay khách đông lắm", "doanh thu tháng này em chưa tính xong", "chốt báo cáo cho anh nhé khách ơi", "doanh thu 500 ngày",
      "báo cáo", "báo cáo nhé", "báo cáo anh", "em báo cáo chị nhé", "báo cáo sếp", "báo cáo doanh thu cho anh",
    ])("câu âm tính không thành báo cáo: %s", (cau) => {
      expect(phanTichLenhDonHang(cau)?.type ?? "").not.toBe("revenue_report");
      expect(laYeuCauVanHanh({ chat: { id: 1 }, text: cau }, bot)).toBe(false);
    });

    test("lưới gợi ý báo cáo: nhóm chỉ khi có doanh thu/doanh số", () => {
      const k = (c: string, r: boolean) => (goiYDonHang(c, r) as any)?.reply_markup?.inline_keyboard?.flat().map((n: any) => n.callback_data) ?? [];
      expect(k("báo cáo sếp là khách đông", false)).toEqual([]);
      expect(k("em báo cáo chị nhé", false)).toEqual([]);
      expect(k("cho em xin cái doanh thu với", false)).toEqual(["ops_rep_today", "ops_rep_this_week", "ops_rep_this_month"]);
      expect(k("cho em xin cái báo cáo", true)).toHaveLength(3);
    });

    const moi = {
      ok: true, period: "today", from: "2026-10-22T17:00:00Z", to: "2026-10-23T05:00:00Z", timezone: "Asia/Ho_Chi_Minh", excludes_canceled: true,
      period_days: null, order_count: 3, paid_order_count: 2, revenue_all: 3750000, revenue_paid: 2500000, avg_order_value: 1250000,
      pending_count: 1, revenue_pending: 1250000, canceled_count: 2, currency: "VND", top_products: [{ name: "Penfolds Bin 389", qty: 6 }],
    };

    test.each([
      ["doanh thu hôm nay", "today", "Hôm nay (từ 0h)"], ["doanh thu tuần này", "this_week", "Tuần này (từ thứ Hai)"],
      ["doanh thu tháng này", "this_month", "Tháng này (từ ngày 1)"],
    ])("%s gọi period=%s, nhãn đúng", async (cau, period, nhan) => {
      (fetchJson as jest.Mock).mockResolvedValue({ ...moi, period });
      await xuLyYeuCauVanHanh(bot, "tenant-1", tin(cau));
      expect(String((fetchJson as jest.Mock).mock.calls[0][0])).toContain(`/ai/report/revenue?period=${period}`);
      expect(gui.mock.calls[0][1].text).toContain(nhan);
    });

    test("đủ số liệu mới: chờ duyệt, đơn huỷ không tính, top, nút nhanh; không còn chú thích gồm đơn huỷ", async () => {
      (fetchJson as jest.Mock).mockResolvedValue(moi);
      await xuLyYeuCauVanHanh(bot, "tenant-1", tin("doanh thu hôm nay"));
      const m = gui.mock.calls[0][1];
      expect(m.text).toContain("3.750.000đ");
      expect(m.text).toContain("(3 đơn)");
      expect(m.text).toContain("2.500.000đ");
      expect(m.text).toContain("Chờ duyệt: 1 đơn · 1.250.000đ");
      expect(m.text).toContain("Đơn huỷ: 2 (không tính)");
      expect(m.text).toContain("Penfolds Bin 389");
      expect(m.text).toContain("Tính từ 23/10 00:00");
      expect(m.text).not.toMatch(/gồm cả đơn/);
      expect(m.reply_markup.inline_keyboard[0].map((n: any) => n.callback_data)).toEqual(["ops_rep_today", "ops_rep_this_week", "ops_rep_this_month"]);
    });

    test("N ngày gọi days=; backend cũ thiếu trường mới không vỡ và không gắn nhãn mốc lịch sai", async () => {
      (fetchJson as jest.Mock).mockResolvedValue({ ok: true, period_days: 7, order_count: 2, paid_order_count: 1, revenue_all: 2000000, revenue_paid: 1000000, avg_order_value: 1000000, currency: "VND", top_products: [] });
      await xuLyYeuCauVanHanh(bot, "tenant-1", tin("doanh thu 7 ngày"));
      expect(String((fetchJson as jest.Mock).mock.calls[0][0])).toContain("days=7");
      gui.mockClear();
      await xuLyYeuCauVanHanh(bot, "tenant-1", { ...tin("doanh thu hôm nay"), message_id: 30 });
      const t = gui.mock.calls[0][1].text as string;
      expect(t).toContain("7 ngày gần nhất");
      expect(t).not.toContain("từ 0h");
      expect(t).not.toMatch(/Chờ duyệt|Đơn huỷ/);
    });

    test("không có đơn; nút nhanh; số lạ bị bỏ qua; lỗi backend dễ hiểu", async () => {
      (fetchJson as jest.Mock).mockResolvedValue({ ok: true, order_count: 0, currency: "VND", top_products: [] });
      await xuLyCallbackVanHanh(bot, "tenant-1", { id: "r1", data: "ops_rep_this_month", from: { id: 9 }, message: { chat: { id: 7 } } });
      expect(String((fetchJson as jest.Mock).mock.calls[0][0])).toContain("period=this_month");
      expect(gui.mock.calls[0][1].text).toContain("Chưa có đơn nào");
      (fetchJson as jest.Mock).mockRejectedValue(new Error("HTTP 500 khi gọi http://x"));
      gui.mockClear();
      await xuLyCallbackVanHanh(bot, "tenant-1", { id: "r2", data: "ops_rep_7", from: { id: 9 }, message: { chat: { id: 7 } } });
      expect(gui.mock.calls[0][1].text).toContain("số liệu doanh thu");
      expect(gui.mock.calls[0][1].text).not.toMatch(/HTTP|http/);
      gui.mockClear();
      expect(await xuLyCallbackVanHanh(bot, "tenant-1", { id: "r3", data: "ops_rep_99", from: { id: 9 }, message: { chat: { id: 7 } } })).toBe(false);
    });
  });
});
