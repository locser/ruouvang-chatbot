/**
 * Test cho LỚP KIỂM CHỨNG TOOL — chốt chặn cuối cùng trước khi chạm vào
 * Medusa (tạo đơn thật, trừ tồn kho thật, đòi tiền thật).
 *
 * Mỗi nhóm test dưới đây tương ứng một sự cố ĐÃ XẢY RA trong production.
 * Ai sửa validate.ts đều phải giữ bộ test này xanh.
 */
import {
  kiemTraTenTool,
  chuanHoaSoLuong,
  kiemTraDinhDangSku,
  kiemTraSkuCoThat,
  kiemTraTonKho,
  chuanHoaSoDienThoai,
  kiemTraDuDieuKienChotDon,
  kiemTraSoLuongToolCall,
  kiemTraDanhSachSoSanh,
  GIOI_HAN,
  TrangThaiDonHang,
} from "./services/tools/validate";

describe("Tên tool", () => {
  it("chấp nhận tool hợp lệ", () => {
    expect(kiemTraTenTool("search_products").hopLe).toBe(true);
    expect(kiemTraTenTool("checkout").hopLe).toBe(true);
  });
  it("từ chối tool lạ (mô hình bịa tên)", () => {
    const r = kiemTraTenTool("delete_all_orders");
    expect(r.hopLe).toBe(false);
    if (!r.hopLe) expect(r.maLoi).toBe("TOOL_KHONG_HOP_LE");
  });
});

describe("Số lượng — sự cố 'thêm 2 hộp nữa' làm giỏ tụt từ 5 xuống 2", () => {
  it("số nguyên dương hợp lệ", () => {
    const r = chuanHoaSoLuong(7);
    expect(r.hopLe).toBe(true);
    if (r.hopLe) expect(r.duLieu).toEqual({ soLuong: 7, laXoaMon: false });
  });

  it("số 0 nghĩa là XOÁ MÓN, không phải 1 món", () => {
    // Bản cũ dùng `Number(x) || 1` nên 0 biến thành 1: khách muốn bỏ món
    // lại thành đặt 1 món.
    const r = chuanHoaSoLuong(0);
    expect(r.hopLe).toBe(true);
    if (r.hopLe) expect(r.duLieu).toEqual({ soLuong: 0, laXoaMon: true });
  });

  it("từ chối số âm thay vì để lọt", () => {
    // -5 là truthy nên `|| 1` không bắt được, số âm đi thẳng xuống Medusa.
    const r = chuanHoaSoLuong(-5);
    expect(r.hopLe).toBe(false);
    if (!r.hopLe) expect(r.maLoi).toBe("SO_LUONG_AM");
  });

  it("từ chối chuỗi không phải số thay vì đoán thành 1", () => {
    const r = chuanHoaSoLuong("hai");
    expect(r.hopLe).toBe(false);
    if (!r.hopLe) expect(r.maLoi).toBe("SO_LUONG_KHONG_HOP_LE");
  });

  it("từ chối số thập phân", () => {
    expect(chuanHoaSoLuong(2.5).hopLe).toBe(false);
  });

  it("chặn số lượng vượt trần (chống làm cạn kho ảo)", () => {
    const r = chuanHoaSoLuong(9999);
    expect(r.hopLe).toBe(false);
    if (!r.hopLe) expect(r.maLoi).toBe("SO_LUONG_VUOT_TRAN");
    expect(chuanHoaSoLuong(GIOI_HAN.SO_LUONG_TOI_DA).hopLe).toBe(true);
  });
});

describe("SKU — chặn mô hình bịa mã", () => {
  const coThat = new Set(["banh-nam-chay-hue-def-9934", "tre-hue-def-1123"]);

  it("chấp nhận SKU có thật", () => {
    expect(kiemTraSkuCoThat("tre-hue-def-1123", coThat).hopLe).toBe(true);
  });

  it("từ chối SKU bịa theo đúng pattern của prompt", () => {
    // Prompt hệ thống có ví dụ chứa SKU thật nên mô hình rất dễ sinh mã
    // cùng dạng nhưng không tồn tại.
    const r = kiemTraSkuCoThat("banh-loc-chay-def-9934", coThat);
    expect(r.hopLe).toBe(false);
    if (!r.hopLe) expect(r.maLoi).toBe("SKU_BIA");
  });

  it("từ chối SKU rỗng hoặc sai định dạng", () => {
    expect(kiemTraDinhDangSku("").hopLe).toBe(false);
    expect(kiemTraDinhDangSku("sku có dấu cách").hopLe).toBe(false);
    expect(kiemTraDinhDangSku("a".repeat(80)).hopLe).toBe(false);
    expect(kiemTraDinhDangSku("tre-hue-def-1123").hopLe).toBe(true);
  });
});

describe("Tồn kho", () => {
  it("chặn khi vượt tồn kho và nói đúng số còn lại", () => {
    const r = kiemTraTonKho(10, 3);
    expect(r.hopLe).toBe(false);
    if (!r.hopLe) {
      expect(r.maLoi).toBe("VUOT_TON_KHO");
      expect(r.thongDiepChoKhach).toContain("3");
    }
  });

  it("từ chối khi KHÔNG đọc được tồn kho thật, thay vì đoán còn hàng", () => {
    const r = kiemTraTonKho(1, null);
    expect(r.hopLe).toBe(false);
    if (!r.hopLe) expect(r.maLoi).toBe("THIEU_DU_LIEU_TON_KHO");
  });

  it("cho qua khi đủ hàng", () => {
    expect(kiemTraTonKho(2, 45).hopLe).toBe(true);
  });
});

describe("Số điện thoại Việt Nam", () => {
  it.each([
    ["0905123456", "0905123456"],
    ["+84905123456", "0905123456"],
    ["84905123456", "0905123456"],
    ["090 512 3456", "0905123456"],
    ["0905.123.456", "0905123456"],
  ])("chuẩn hoá %s", (vao, ra) => {
    const r = chuanHoaSoDienThoai(vao);
    expect(r.hopLe).toBe(true);
    if (r.hopLe) expect(r.duLieu).toBe(ra);
  });

  it.each(["123", "0123456789", "abcxyz", ""])("từ chối %s", (vao) => {
    expect(chuanHoaSoDienThoai(vao).hopLe).toBe(false);
  });
});

describe("Điều kiện chốt đơn — sự cố tự tạo đơn khi khách hỏi 'shop ở đâu?'", () => {
  const dayDu: TrangThaiDonHang = {
    soMonTrongGio: 2,
    coSoDienThoai: true,
    coDiaChi: true,
    coTenNguoiNhan: true,
    khachDaXacNhan: true,
    shopCoTaiKhoanNganHang: true,
    monHetHang: [],
    lechTien: 0,
  };

  it("cho chốt khi đủ toàn bộ điều kiện", () => {
    expect(kiemTraDuDieuKienChotDon(dayDu).hopLe).toBe(true);
  });

  it("KHÔNG chốt khi khách chưa xác nhận rõ ràng", () => {
    // Đây chính là sự cố 28/07: guard đoán ý bằng regex khớp cả chữ "đâu"
    // nên câu "shop ở đâu vậy em?" tạo đơn hàng thật.
    const r = kiemTraDuDieuKienChotDon({ ...dayDu, khachDaXacNhan: false });
    expect(r.hopLe).toBe(false);
    if (!r.hopLe) expect(r.maLoi).toBe("CHUA_XAC_NHAN");
  });

  it("KHÔNG chốt khi giỏ trống", () => {
    const r = kiemTraDuDieuKienChotDon({ ...dayDu, soMonTrongGio: 0 });
    expect(r.hopLe).toBe(false);
    if (!r.hopLe) expect(r.maLoi).toBe("GIO_TRONG");
  });

  it.each([
    ["coSoDienThoai", "THIEU_SDT"],
    ["coDiaChi", "THIEU_DIA_CHI"],
    ["coTenNguoiNhan", "THIEU_TEN"],
  ])("KHÔNG chốt khi thiếu %s", (truong, maLoi) => {
    const r = kiemTraDuDieuKienChotDon({ ...dayDu, [truong]: false } as TrangThaiDonHang);
    expect(r.hopLe).toBe(false);
    if (!r.hopLe) expect(r.maLoi).toBe(maLoi);
  });

  it("KHÔNG chốt khi giá đã thay đổi so với lúc báo khách", () => {
    const r = kiemTraDuDieuKienChotDon({ ...dayDu, lechTien: 15000 });
    expect(r.hopLe).toBe(false);
    if (!r.hopLe) expect(r.maLoi).toBe("LECH_GIA");
  });

  it("KHÔNG chốt khi shop chưa cấu hình tài khoản ngân hàng", () => {
    // Bản cũ fallback về STK VP Holding — tiền khách của shop khác chảy nhầm ví.
    const r = kiemTraDuDieuKienChotDon({ ...dayDu, shopCoTaiKhoanNganHang: false });
    expect(r.hopLe).toBe(false);
    if (!r.hopLe) expect(r.maLoi).toBe("SHOP_CHUA_CAU_HINH_NGAN_HANG");
  });

  it("KHÔNG chốt khi có món hết hàng", () => {
    const r = kiemTraDuDieuKienChotDon({ ...dayDu, monHetHang: ["Tré Huế"] });
    expect(r.hopLe).toBe(false);
    if (!r.hopLe) expect(r.thongDiepChoKhach).toContain("Tré Huế");
  });
});

describe("Chống vòng lặp và so sánh", () => {
  it("chặn khi mô hình gọi quá nhiều tool trong một lượt", () => {
    expect(kiemTraSoLuongToolCall(GIOI_HAN.TOOL_CALL_MOI_LUOT).hopLe).toBe(true);
    expect(kiemTraSoLuongToolCall(GIOI_HAN.TOOL_CALL_MOI_LUOT + 1).hopLe).toBe(false);
  });

  it("so sánh cần 2-3 sản phẩm", () => {
    expect(kiemTraDanhSachSoSanh(["a"]).hopLe).toBe(false);
    expect(kiemTraDanhSachSoSanh(["a", "b"]).hopLe).toBe(true);
    expect(kiemTraDanhSachSoSanh(["a", "b", "c", "d"]).hopLe).toBe(false);
    expect(kiemTraDanhSachSoSanh(["a", 123]).hopLe).toBe(false);
  });
});
