/**
 * SĐT khách tiềm năng: dễ tính với số thật, chặn số rác rõ ràng.
 * Khác SĐT giao hàng (chuanHoaSoDienThoai) — hàm đó giữ nguyên.
 */
import { chuanHoaSdtKhachTiemNang, chuanHoaSoDienThoai } from "./services/tools/validate";

const hopLe = (v: unknown) => {
  const kq = chuanHoaSdtKhachTiemNang(v);
  return kq.hopLe ? kq.duLieu : null;
};

describe("chuanHoaSdtKhachTiemNang — nhận số thật", () => {
  it.each([
    ["0931482756", "0931482756"],
    ["0931 482 756", "0931482756"],
    ["093.148.2756", "0931482756"],
    ["093-148-2756", "0931482756"],
    ["(093) 148 2756", "0931482756"],
    ["+84 931 482 756", "0931482756"],
    ["84931482756", "0931482756"],
    ["  0768203915  ", "0768203915"],
    ["0356 718 249", "0356718249"],
    ["0586 903 417", "0586903417"],
    ["0828 275 094", "0828275094"],
  ])("di động %s", (vao, ra) => expect(hopLe(vao)).toBe(ra));

  it("nhận số máy bàn 11 số (Hà Nội, TP.HCM)", () => {
    expect(hopLe("024 3825 6914")).toBe("02438256914");
    expect(hopLe("028 3822 7096")).toBe("02838227096");
  });

  it("số đẹp nhưng có thật thì không bị chặn nhầm (lặp ngắn, đuôi đẹp, xen kẽ 4 số)", () => {
    expect(hopLe("0903 123 888")).toBe("0903123888");
    expect(hopLe("0988 668 866")).toBe("0988668866");
    expect(hopLe("0912 345 111")).toBe("0912345111"); // chỉ 5 số liền kề: chưa tới ngưỡng rác
  });
});

describe("chuanHoaSdtKhachTiemNang — chặn số rác", () => {
  it.each([
    ["số lặp một chữ số", "0900000000"],
    ["số lặp một chữ số 2", "0911111111"],
    ["dãy tăng dần", "0912345678"],
    ["dãy giảm dần", "0987654321"],
    ["dãy tăng 0123456789", "0123456789"],
    ["lặp một cặp số", "0909090909"],
    ["lặp một cặp số 2", "0919191919"],
  ])("%s: %s", (_ten, so) => expect(hopLe(so)).toBeNull());

  it.each([
    ["quá ngắn", "09314827"],
    ["quá dài", "093148275612"],
    ["đầu số không tồn tại", "0131482756"],
    ["chữ thay vì số", "không có"],
    ["rỗng", ""],
    ["mã đơn", "CW12"],
    ["số nước ngoài", "+1 415 555 0132"],
  ])("sai định dạng: %s", (_ten, so) => expect(hopLe(so)).toBeNull());

  it.each([[undefined], [null], [931482756], [{}]])("không phải chuỗi: %p", (v) =>
    expect(hopLe(v)).toBeNull()
  );

  it("khi từ chối vẫn trả câu nhẹ nhàng cho khách, không bắt ép", () => {
    const kq = chuanHoaSdtKhachTiemNang("0900000000");
    expect(kq.hopLe).toBe(false);
    if (!kq.hopLe) {
      expect(kq.maLoi).toBe("SDT_KHONG_HOP_LE");
      expect(kq.thongDiepChoKhach).toContain("tiếp tục");
    }
  });
});

describe("không ảnh hưởng SĐT giao hàng", () => {
  it("chuanHoaSoDienThoai vẫn chỉ nhận di động như cũ", () => {
    expect(chuanHoaSoDienThoai("0931482756").hopLe).toBe(true);
    expect(chuanHoaSoDienThoai("02438256914").hopLe).toBe(false);
  });
});
