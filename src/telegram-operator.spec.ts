import { laYeuCauVanHanh, phanTichLenhNhanh } from "./services/telegramOperator";

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
