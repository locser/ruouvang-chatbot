/**
 * Test domain guard (services/scope.ts) và các quy tắc prompt cho luồng hỏi AI
 * gửi sẵn từ storefront: chọn chai, tra đơn, chuyển khoản.
 */
import { danhGiaPhamVi, CAU_NGOAI_PHAM_VI, chuanHoaKhongDau } from "./services/scope";
import { PROMPT_CO_DINH } from "./services/tools/prompt";

describe("domain guard — ngoài phạm vi", () => {
  it.each([
    "Viết code python tính dãy fibonacci giúp mình",
    "Giải phương trình x^2 - 4 = 0",
    "Tin tức bóng đá hôm nay thế nào?",
    "Dự báo thời tiết cuối tuần",
    "Giá bitcoin hôm nay bao nhiêu",
  ])("chặn: %s", (cau) => {
    const kq = danhGiaPhamVi(cau);
    expect(kq).toEqual({ loai: "ngoai_pham_vi", traLoi: CAU_NGOAI_PHAM_VI });
  });

  it("bắt được không dấu và chữ hoa", () => {
    expect(danhGiaPhamVi("LAP TRINH giup minh").loai).toBe("ngoai_pham_vi");
    expect(danhGiaPhamVi("giai bai toan nay").loai).toBe("ngoai_pham_vi");
  });
});

describe("domain guard — người chưa đủ tuổi", () => {
  it.each(["Tôi 16 tuổi, mua rượu được không?", "con tôi học sinh cấp 3, mua cho nó", "em 17 tuổi muốn đặt"])(
    "chặn: %s",
    (cau) => {
      expect(danhGiaPhamVi(cau).loai).toBe("chua_du_tuoi");
    }
  );

  it("người đủ 18 tuổi đi qua", () => {
    expect(danhGiaPhamVi("Tôi 25 tuổi, muốn tìm quà sinh nhật").loai).toBe("trong_pham_vi");
  });
});

describe("domain guard — sức khỏe, pháp lý chuyển nhân viên", () => {
  it.each(["Bị đau bụng uống rượu được không?", "Tôi đang uống thuốc huyết áp", "Rượu này có chữa bệnh tiểu đường không", "Cho tôi hỏi về pháp lý của shop"])(
    "chuyển người: %s",
    (cau) => {
      expect(danhGiaPhamVi(cau)).toEqual({ loai: "chuyen_nguoi" });
    }
  );

  it("từ 'đâu' (ở đâu) không bị coi là đau", () => {
    expect(danhGiaPhamVi("Shop ở đâu vậy?").loai).toBe("trong_pham_vi");
  });
});

describe("domain guard — các câu gửi sẵn từ storefront phải đi qua", () => {
  it.each([
    "Chưa biết chọn chai nào? Bạn tư vấn giúp mình chọn rượu phù hợp nhé.",
    "Đơn CW100484 của mình đang ở bước nào và mình cần làm gì tiếp theo?",
    "Mình đang thanh toán cho đơn CW100484 (nội dung chuyển khoản CW100484). Bạn hướng dẫn mình bước tiếp theo giúp nhé.",
    "Xin chào",
    "Vang đỏ dưới 1 triệu đi với bò",
  ])("trong phạm vi: %s", (cau) => {
    expect(danhGiaPhamVi(cau).loai).toBe("trong_pham_vi");
  });
});

describe("chuẩn hoá không dấu", () => {
  it("đổi đ và bỏ dấu", () => {
    expect(chuanHoaKhongDau("Đơn Hàng Đẹp")).toBe("don hang dep");
  });
});

describe("prompt — quy tắc đơn hàng và chuyển khoản", () => {
  it("bắt buộc hỏi đủ mã đơn và SĐT trước khi gọi get_order_status", () => {
    expect(PROMPT_CO_DINH).toContain("get_order_status");
    expect(PROMPT_CO_DINH).toContain("HỎI ĐỦ CẢ HAI");
  });

  it("cấm xác nhận đã nhận chuyển khoản và chuyển nhân viên đối soát", () => {
    expect(PROMPT_CO_DINH).toContain("KHÔNG BAO GIỜ khẳng định");
    expect(PROMPT_CO_DINH).toContain("escalate_to_human");
  });

  it("có quy tắc người chưa đủ tuổi và lái xe", () => {
    expect(PROMPT_CO_DINH).toContain("chưa đủ tuổi");
    expect(PROMPT_CO_DINH).toContain("lái xe");
  });
});
