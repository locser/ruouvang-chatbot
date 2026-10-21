import { botDangQuyDoi } from "./services/priceCheck";
import { assertSafeTranslation } from "./services/claimGuard";
import { quyetDinhTraBot, ConversationData, TenantSettingData } from "./services/reaper";
import { routeModel } from "./services/llm";

describe("1. Price Checker Service ('Bộ soi tiền')", () => {
  // Test cases that must be BLOCKED (contain unauthorized currencies/conversion symbols)
  const blockCases = [
    { text: "Khoảng 780.000đ ạ", currency: "EUR" },
    { text: "Giá $29 ạ", currency: "VND" },
    { text: "29 EUR, tức là khoảng 780k VND", currency: "EUR" },
    { text: "Tương đương 2.500.000 đồng", currency: "JPY" },
    { text: "Sản phẩm này có giá 50 USD và 1.200.000đ ạ", currency: "VND" },
    { text: "Giá tầm 1000 đồng", currency: "USD" },
    { text: "Chỉ khoảng 20₫ thôi ạ", currency: "EUR" },
  ];

  // Test cases that must be ALLOWED (matching channel currency or no pricing reference)
  const allowCases = [
    { text: "Giá niêm yết là 29 EUR ạ.", currency: "EUR" },
    { text: "Giá 290.000₫ ạ.", currency: "VND" },
    { text: "Giá 290.000đ ạ.", currency: "VND" },
    { text: "Giá 290 nghìn đồng ạ.", currency: "VND" },
    { text: "Size M còn 12 cái ạ.", currency: "VND" },
    { text: "Đơn hàng đã được giao rồi ạ", currency: "VND" }, // Checks false positive on 'được'
    { text: "Sản phẩm đã đặt thành công", currency: "VND" }, // Checks false positive on 'đặt'
    { text: "Hôm nay trời đẹp quá", currency: "VND" },
  ];

  test("Should correctly BLOCK invalid currency references / estimations", () => {
    for (const testCase of blockCases) {
      const isBlocked = botDangQuyDoi(testCase.text, testCase.currency);
      expect(isBlocked).toBe(true);
    }
  });

  test("Should ALLOW correct currency references or non-price messages", () => {
    for (const testCase of allowCases) {
      const isBlocked = botDangQuyDoi(testCase.text, testCase.currency);
      expect(isBlocked).toBe(false);
    }
  });
});

describe("2. Claim Firewall Service ('Tường lửa công bố')", () => {
  test("Should BLOCK medical or longevity claims in Vietnamese (vi-VN)", () => {
    const text1 = "Sản phẩm này giúp chữa bệnh tiểu đường.";
    const text2 = "Đây là sản phẩm đặc trị đau bao tử.";
    const text3 = "Men vi sinh này giúp điều trị táo bón.";
    const text4 = "Dùng sản phẩm này giúp bạn sống tới 120 tuổi.";
    const text5 = "Nó có thể thay thế thuốc tây.";

    expect(assertSafeTranslation("vi-VN", text1).some(f => f.level === "BLOCK")).toBe(true);
    expect(assertSafeTranslation("vi-VN", text2).some(f => f.level === "BLOCK")).toBe(true);
    expect(assertSafeTranslation("vi-VN", text3).some(f => f.level === "BLOCK")).toBe(true);
    expect(assertSafeTranslation("vi-VN", text4).some(f => f.level === "BLOCK")).toBe(true);
    expect(assertSafeTranslation("vi-VN", text5).some(f => f.level === "BLOCK")).toBe(true);
  });

  test("Should BLOCK probiotic or gut health references in EU (en-IE)", () => {
    const text1 = "Our yogurt contains live probiotics.";
    const text2 = "This product supports your gut health.";
    const text3 = "Contains live cultures to boost immune system.";

    expect(assertSafeTranslation("en-IE", text1).some(f => f.level === "BLOCK")).toBe(true);
    expect(assertSafeTranslation("en-IE", text2).some(f => f.level === "BLOCK")).toBe(true);
    expect(assertSafeTranslation("en-IE", text3).some(f => f.level === "BLOCK")).toBe(true);
  });

  test("Should BLOCK FDA claims but allow/REVIEW probiotic claims in US (en-US)", () => {
    const curesClaim = "This cures cancer.";
    const fdaClaim = "This is FDA approved.";
    const probioticClaim = "This contains active probiotics.";

    // cures claims are blocked
    expect(assertSafeTranslation("en-US", curesClaim).some(f => f.level === "BLOCK")).toBe(true);
    // fda approved is blocked
    expect(assertSafeTranslation("en-US", fdaClaim).some(f => f.level === "BLOCK")).toBe(true);
    // probiotic claims in US are REVIEW, not BLOCK
    const probioticResults = assertSafeTranslation("en-US", probioticClaim);
    expect(probioticResults.some(f => f.level === "BLOCK")).toBe(false);
    expect(probioticResults.some(f => f.level === "REVIEW")).toBe(true);
  });

  test("Should fallback to strict EU rules (en-IE) for unrecognized locales", () => {
    const text = "Contains active probiotics.";
    const results = assertSafeTranslation("fr-FR", text); // French locale (not defined)
    expect(results.some(f => f.level === "BLOCK")).toBe(true); // Should apply en-IE and block probiotic
  });
});

describe("3. Takeover Sweep Reaper Logic", () => {
  const defaultSettings: TenantSettingData = {
    tu_dong_tra_bot: true,
    nguong_cho_nguoi_nhan_ms: 5 * 60 * 1000, // 5m
    nguong_nguoi_im_lang_ms: 10 * 60 * 1000, // 10m
    canh_bao_nguoi_truoc_ms: 2 * 60 * 1000, // 2m warning
    ly_do_khong_tra_bot: ["khach_yeu_cau", "tien_bac", "claim_guard", "suc_khoe", "phap_ly"],
    hanh_dong_khi_het_gio: "bot_tiep",
    bao_khach_khi_doi_vai: true,
    dong_hoi_thoai_sau_ms: 30 * 60 * 1000,
  };

  const now = new Date("2026-07-16T12:00:00Z");

  test("Should ignore conversations not in human operator mode", () => {
    const conv: ConversationData = {
      id: "c1",
      tenant_id: "t1",
      mode: "BOT",
      ly_do_leo_thang: null,
      last_human_msg_at: null,
      last_customer_msg_at: null,
      da_canh_bao_nguoi: false,
    };

    const res = quyetDinhTraBot(conv, defaultSettings, now);
    expect(res.hanh_dong).toBe("khong_lam_gi");
  });

  test("Should warnings operators before auto-takeover", () => {
    const conv: ConversationData = {
      id: "c2",
      tenant_id: "t1",
      mode: "NGUOI",
      ly_do_leo_thang: "bot_bi",
      last_human_msg_at: new Date("2026-07-16T11:49:00Z"),
      last_customer_msg_at: new Date("2026-07-16T11:51:00Z"), // Waiting for 9m (remaining time = 1m which is <= warning limit of 2m)
      da_canh_bao_nguoi: false,
    };

    const res = quyetDinhTraBot(conv, defaultSettings, now);
    expect(res.hanh_dong).toBe("canh_bao_nguoi");
  });

  test("Should trigger automatic takeover after idle threshold", () => {
    const conv: ConversationData = {
      id: "c3",
      tenant_id: "t1",
      mode: "NGUOI",
      ly_do_leo_thang: "bot_bi",
      last_human_msg_at: new Date("2026-07-16T11:40:00Z"),
      last_customer_msg_at: new Date("2026-07-16T11:45:00Z"), // Customer waiting for 15m (exceeds 10m limit)
      da_canh_bao_nguoi: true,
    };

    const res = quyetDinhTraBot(conv, defaultSettings, now);
    expect(res.hanh_dong).toBe("tra_bot");
  });

  test("Should NOT return to bot if escalation reason belongs to a hard-block rule (e.g. payments)", () => {
    const conv: ConversationData = {
      id: "c4",
      tenant_id: "t1",
      mode: "NGUOI",
      ly_do_leo_thang: "tien_bac",
      last_human_msg_at: new Date("2026-07-16T11:40:00Z"),
      last_customer_msg_at: new Date("2026-07-16T11:45:00Z"), // Customer waiting for 15m
      da_canh_bao_nguoi: true,
    };

    const res = quyetDinhTraBot(conv, defaultSettings, now);
    // Since 'tien_bac' is a hard block, we escalate to other operator instead of returning to bot!
    expect(res.hanh_dong).toBe("reo_lai");
  });
});

describe("4. LLM Routing & Intent Recognition", () => {
  test("Should route normal queries to deepseek-flash", () => {
    expect(routeModel("Áo thun có size L không?")).toBe("deepseek-flash");
    expect(routeModel("Shop có ship COD không ạ?")).toBe("deepseek-flash");
  });

  test("Should route complex or risk-prone queries to claude-sonnet", () => {
    expect(routeModel("Tôi muốn hoàn tiền đơn hàng bị hỏng.")).toBe("claude-sonnet");
    expect(routeModel("Sản phẩm này uống vào trị dứt tiểu đường không?")).toBe("claude-sonnet");
  });
});
