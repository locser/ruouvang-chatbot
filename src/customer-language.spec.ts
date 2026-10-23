import { detectCustomerLanguage, dungPromptDong } from "./services/tools/prompt";

describe("detectCustomerLanguage", () => {
  it.each([
    ["Do you have red wine under 500k?", "tiếng Anh"],
    ["有50万越南盾以下的红酒吗？", "tiếng Trung"],
    ["50万ドン以下の赤ワインはありますか？", "tiếng Nhật"],
    ["50만동 이하 레드와인 있어요?", "tiếng Hàn"],
  ])("%s → %s", (text, lang) => {
    expect(detectCustomerLanguage(text)).toBe(lang);
  });

  it.each(["Shiraz dưới 500 nghìn", "Cho anh lấy 2 chai", "ok", "Shiraz", "1", ""])("không chèn khi là tiếng Việt / không chắc: %s", (text) => {
    expect(detectCustomerLanguage(text)).toBeNull();
  });

  it("nhắc ngôn ngữ ở cuối prompt động", () => {
    const p = dungPromptDong({ customerMessage: "有红酒吗？" });
    expect(p.trim().endsWith("Giữ nguyên tên sản phẩm và giá VND.")).toBe(true);
    expect(p).toContain("tiếng Trung");
    expect(dungPromptDong({ customerMessage: "Có vang đỏ không em" })).not.toContain("NGÔN NGỮ CỦA LƯỢT NÀY");
  });
});
