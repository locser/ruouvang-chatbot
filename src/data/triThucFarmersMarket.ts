/**
 * BỘ TRI THỨC — SHOP FARMERS MARKET
 *
 * Nạp bằng: npx ts-node src/scripts/napTriThuc.ts --shop "Farmers Market"
 *
 * ═══ NGUYÊN TẮC BIÊN SOẠN ═══
 *
 * 1. CHỈ viết câu trả lời cho điều BIẾT CHẮC. Phí ship, chính sách đổi trả,
 *    địa chỉ cửa hàng, hotline — chưa ai cung cấp nên KHÔNG bịa. Những câu đó
 *    chuyển nhân viên. Thà chậm một nhịp còn hơn hứa sai với khách.
 *
 * 2. KHÔNG nhồi giá vào kịch bản cứng. Giá đổi hằng ngày; viết cứng là hôm sau
 *    bot nói dối. Giá luôn để bot đi tra thời gian thực.
 *
 * 3. Mẫu khớp KHÔNG được chứa từ đơn phổ thông. Regex chứa nhánh `|đâu` đứng
 *    một mình đã từng khiến câu "shop ở đâu vậy em?" tạo ra đơn hàng thật.
 *    Luôn viết CỤM TỪ đầy đủ.
 *
 * 4. ⚠️ MẪU KHỚP CHẠY BẰNG REGEX CỦA POSTGRESQL, KHÔNG PHẢI JAVASCRIPT.
 *    Ranh giới từ là `\\y`, KHÔNG phải `\\b` — trong PostgreSQL `\\b` nghĩa là
 *    ký tự backspace nên mẫu sẽ KHÔNG BAO GIỜ khớp. Sai chỗ này không có lỗi
 *    nào báo ra, chỉ là kịch bản im lặng không hoạt động và mọi câu đều rơi
 *    xuống AI, tốn credit. Đã vấp ngày 29/07/2026 với câu "chào em".
 *
 * 5. Shop này ngành `thuc_pham` nên tường lửa công bố y tế TỰ BẬT. Tuyệt đối
 *    không có câu nào nói sản phẩm chữa/trị/phòng bệnh — vi phạm Nghị định
 *    15/2018/NĐ-CP.
 */

export interface KichBan {
  /** Regex, không phân biệt hoa thường. Dùng | để gộp các cách hỏi khác nhau. */
  mauKhop: string;
  traLoi: string;
  /** Số lớn khớp trước. Câu cụ thể phải ưu tiên cao hơn câu chung. */
  uuTien: number;
  /**
   * true = sau khi trả lời thì THỰC SỰ chuyển hội thoại cho nhân viên.
   * Bắt buộc bật cho mọi kịch bản có câu chữ hứa chuyển người — nói mà không
   * làm là bỏ rơi khách chờ một nhân viên không bao giờ tới.
   */
  chuyenNguoi?: boolean;
  /** Ghi chú cho người bảo trì — không gửi cho khách. */
  ghiChu?: string;
}

export interface TaiLieu {
  ten: string;
  noiDung: string;
}

// ---------------------------------------------------------------------------
// A. KỊCH BẢN CỨNG — trả lời tức thì, tốn 0 credit
// ---------------------------------------------------------------------------

export const KICH_BAN: KichBan[] = [
  // ───────────────── Chào hỏi & điều hướng ─────────────────
  {
    uuTien: 90,
    mauKhop: "^\\s*(chào|xin chào|hello|hi|alo|có ai (ở đó|không))\\y",
    traLoi:
      "Dạ em chào anh/chị ạ! 🌿\n\n" +
      "Em là trợ lý của **Farmers Market**. Shop mình có hơn 4.000 mặt hàng: trái cây nhập & Việt, bánh kẹo, hạt sấy, cà phê trà, sữa chua, đồ chăm sóc cá nhân…\n\n" +
      "Anh/chị đang tìm gì để em gợi ý ạ?",
  },
  {
    uuTien: 85,
    mauKhop: "(shop|cửa hàng|bên (mình|em)) (bán|có) (gì|những gì|hàng gì)|có những (loại|mặt hàng|sản phẩm) gì",
    traLoi:
      "Dạ shop mình có hơn **4.000 sản phẩm**, các nhóm chính ạ:\n\n" +
      "🍎 Trái cây nhập khẩu & trái cây Việt\n" +
      "🎁 Giỏ quà & hộp trái cây biếu tặng\n" +
      "🍪 Bánh · Kẹo · Socola\n" +
      "🥜 Hạt & trái cây sấy\n" +
      "☕ Cà phê & trà\n" +
      "🥛 Sữa chua · Bơ sữa\n" +
      "🥬 Rau củ quả\n" +
      "🧴 Chăm sóc cá nhân · Đồ dùng gia đình\n\n" +
      "Anh/chị quan tâm nhóm nào ạ? Hoặc gõ thẳng tên món em tìm giúp!",
  },

  // ───────────────── Thanh toán — DỮ KIỆN THẬT ─────────────────
  {
    uuTien: 80,
    mauKhop:
      "(thanh toán|trả tiền|chuyển khoản) (thế nào|ra sao|kiểu gì|bằng cách nào|như thế nào)|" +
      "(hình thức|phương thức|cách) thanh toán|có (nhận|hỗ trợ) (thẻ|visa|momo|ví điện tử)",
    traLoi:
      "Dạ shop mình nhận **chuyển khoản ngân hàng** ạ:\n\n" +
      "🏦 Ngân hàng: **MB Bank**\n" +
      "💳 Số tài khoản: **0941000093**\n" +
      "👤 Chủ tài khoản: **VP HOLDING**\n\n" +
      "Anh/chị đặt hàng xong, em gửi luôn **mã QR** — quét bằng app ngân hàng là xong, không cần gõ số tài khoản ạ. Nội dung chuyển khoản em điền sẵn trong mã QR.",
    ghiChu: "Số tài khoản lấy từ MEDUSA_BANK_* của Medusa. Đổi bên đó thì sửa cả kịch bản này.",
  },

  // ───────────────── Cách đặt hàng ─────────────────
  {
    uuTien: 78,
    mauKhop:
      "(đặt|mua) hàng (thế nào|ra sao|kiểu gì|như thế nào|ở đâu)|" +
      "(cách|hướng dẫn) (đặt|mua) hàng|làm sao để (đặt|mua)",
    traLoi:
      "Dạ đặt hàng ngay trong khung chat này luôn ạ, 4 bước:\n\n" +
      "**1.** Nói tên món anh/chị muốn — em tra giá và tồn kho thật rồi báo lại\n" +
      "**2.** Chốt số lượng, em thêm vào giỏ\n" +
      "**3.** Cho em xin **số điện thoại, địa chỉ, tên người nhận**\n" +
      "**4.** Anh/chị xác nhận, em gửi **mã QR thanh toán**\n\n" +
      "Anh/chị bắt đầu luôn nhé — đang cần món gì ạ?",
  },

  // ───────────────── Giờ làm việc — DỮ KIỆN THẬT ─────────────────
  {
    uuTien: 75,
    mauKhop:
      "(giờ|mấy giờ) (mở cửa|làm việc|đóng cửa)|" +
      "(mở cửa|làm việc) (lúc mấy giờ|từ mấy giờ|đến mấy giờ|những ngày nào)|" +
      "(chủ nhật|cuối tuần) có (làm|mở|bán)",
    traLoi:
      "Dạ nhân viên shop trực từ **8h00 – 18h00, Thứ 2 đến Thứ 7** ạ.\n\n" +
      "Ngoài giờ đó em vẫn ở đây tư vấn và nhận đơn bình thường 24/7 nhé — nhân viên sẽ liên hệ lại với anh/chị vào giờ làm việc gần nhất ạ!",
    ghiChu: "Khớp tenant_setting.gio_lam_viec. Đổi giờ trong CSDL thì sửa cả câu này.",
  },

  // ───────────────── Tra đơn ─────────────────
  {
    uuTien: 72,
    mauKhop:
      "(kiểm tra|tra|xem|check) (đơn|đơn hàng|tình trạng đơn)|" +
      "đơn (hàng )?(của (em|anh|chị|tôi) )?(tới đâu|đến đâu|sao rồi|thế nào rồi)",
    traLoi:
      "Dạ anh/chị cho em xin **mã đơn hàng** (dạng `VPH` + 8 ký tự, nằm trong tin nhắn xác nhận lúc đặt) để em tra ngay ạ!\n\n" +
      "Nếu anh/chị không tìm thấy mã, em chuyển nhân viên tra giúp bằng số điện thoại đặt hàng nhé.",
  },

  // ───────────────── Những câu KHÔNG BIẾT → chuyển người ─────────────────
  {
    uuTien: 70,
    // ⚠️ `.{0,24}?` cho phép có chữ chen giữa: khách viết "ship VỀ HUẾ mất bao
    // lâu", "giao hàng ĐẾN ĐÀ NẴNG bao nhiêu tiền". Bản đầu đòi hai vế liền
    // nhau nên trượt hết những câu đó — kiểm hồi quy trong napTriThuc.ts bắt được.
    // Giới hạn 24 ký tự để không vắt sang mệnh đề khác của câu dài.
    mauKhop:
      "(phí|tiền|giá|cước).{0,12}?(ship|giao hàng|vận chuyển)|" +
      "(ship|giao hàng|vận chuyển).{0,24}?(bao nhiêu|bao lâu|mấy ngày|thế nào|ra sao|khi nào)|" +
      "(có|hỗ trợ|nhận).{0,12}?(ship|giao).{0,12}?(cod|tận nơi|toàn quốc|tỉnh|nhà)|" +
      "(free|miễn phí|freeship) ?ship",
    traLoi:
      "Dạ về **phí và thời gian giao hàng**, em xin phép chuyển anh/chị tới nhân viên để báo chính xác theo khu vực của mình ạ — em không muốn báo áng chừng rồi sai.\n\n" +
      "Anh/chị cứ chọn hàng trước, nhân viên sẽ xác nhận phí ship ngay ạ! 🚚",
    ghiChu:
      "CHƯA CÓ chính sách vận chuyển thật. Khi shop cung cấp, thay câu này bằng " +
      "biểu phí cụ thể — đây là câu khách hỏi nhiều nhất, trả lời được là giảm tải nhân viên đáng kể.",
    chuyenNguoi: true,
  },
  {
    uuTien: 70,
    mauKhop:
      "(đổi|trả|hoàn) (hàng|trả|tiền) (thế nào|ra sao|được không|trong bao lâu)|" +
      "chính sách (đổi trả|hoàn tiền|bảo hành)|" +
      "(hàng|sản phẩm) (bị )?(hỏng|lỗi|dập|héo|hết hạn)",
    traLoi:
      "Dạ trường hợp này em chuyển anh/chị tới nhân viên xử lý trực tiếp để bảo đảm quyền lợi ạ.\n\n" +
      "Anh/chị chuẩn bị giúp em **mã đơn hàng** và **ảnh chụp sản phẩm** để nhân viên xử lý nhanh nhất nhé! 🙏",
    ghiChu: "CHƯA CÓ chính sách đổi trả thật. Chuyển người là lựa chọn đúng cho tới khi có.",
    chuyenNguoi: true,
  },
  {
    uuTien: 68,
    mauKhop:
      "(shop|cửa hàng|bên mình) (ở|nằm ở) đâu|" +
      "địa chỉ (shop|cửa hàng|bên mình)|" +
      "(có|còn) (cửa hàng|chi nhánh|showroom) (nào |ở )?(không|đâu)|" +
      "(số|sđt) (hotline|điện thoại) (của )?(shop|cửa hàng)",
    traLoi:
      "Dạ để em chuyển anh/chị tới nhân viên để cung cấp **địa chỉ và số hotline** chính xác ạ.\n\n" +
      "Trong lúc chờ, anh/chị cứ đặt hàng ngay trong khung chat này nhé — shop giao tận nơi ạ! 😊",
    ghiChu:
      "CHƯA CÓ địa chỉ/hotline thật. ⚠️ Mẫu khớp phải là CỤM TỪ đầy đủ. " +
      "Tuyệt đối KHÔNG thêm nhánh `|đâu` đứng một mình — chính lỗi đó từng khiến " +
      "câu 'shop ở đâu vậy em?' tạo đơn hàng thật.",
    chuyenNguoi: true,
  },
  {
    uuTien: 66,
    mauKhop:
      "(xuất|có) (hoá đơn|hóa đơn|vat|đỏ)|" +
      "(mua|đặt) (sỉ|số lượng lớn|nguyên thùng|nguyên kiện)|" +
      "(giá )?(sỉ|buôn|đại lý|chiết khấu|hợp tác)",
    traLoi:
      "Dạ nội dung này em xin phép chuyển nhân viên kinh doanh trao đổi trực tiếp với anh/chị ạ — sẽ có báo giá và điều kiện cụ thể nhất! 🤝",
    chuyenNguoi: true,
  },

  // ───────────────── Chặn mặc cả & vòi giảm giá ─────────────────
  {
    uuTien: 64,
    // Khách nói kiểu "giảm giá CHO ANH chút được không" — có chữ chen giữa hai
    // vế. Bản đầu đòi liền nhau nên trượt; kiểm hồi quy bắt được.
    mauKhop:
      "(giảm|bớt).{0,6}?(giá|tiền).{0,20}?(được không|đi ạ|đi em|nhé|chút|tí)|" +
      "(mặc cả|trả giá|bớt chút|bớt giá|giá chót|giá cuối)|" +
      "có (mã |code )?(giảm giá|khuyến mãi|voucher|coupon)",
    traLoi:
      "Dạ giá trên hệ thống đã là giá tốt nhất shop áp dụng chung cho tất cả khách rồi ạ 🙏\n\n" +
      "Các chương trình khuyến mãi shop luôn để sẵn trong giá hiển thị — anh/chị cứ xem giá là giá cuối cùng nhé. Em không tự giảm thêm được ạ!",
    ghiChu:
      "Chốt chặn quan trọng: nếu để AI tự thương lượng, khách sẽ ép giá và mô hình " +
      "có thể hứa mức giảm mà hệ thống không thực hiện được.",
  },

  // ───────────────── Câu hỏi sức khoẻ — TUÂN THỦ NGHỊ ĐỊNH 15 ─────────────────
  {
    uuTien: 95,
    mauKhop:
      "(chữa|trị|khỏi|phòng) (được )?(bệnh|ung thư|tiểu đường|huyết áp|covid|xương khớp|dạ dày|gan|tim)|" +
      "(có )?(tác dụng|công dụng) (chữa|trị|điều trị)|" +
      "(giảm cân|tăng cân|đẹp da|trắng da) (được )?(không|hiệu quả)|" +
      "(bà bầu|trẻ sơ sinh|người bệnh|tiểu đường) (ăn|dùng|uống) (được )?không",
    traLoi:
      "Dạ về vấn đề **sức khoẻ và dinh dưỡng**, em xin phép chuyển anh/chị tới nhân viên tư vấn ạ.\n\n" +
      "Sản phẩm của shop là **thực phẩm thông thường**, không phải thuốc và không có tác dụng chữa bệnh. Với nhu cầu sức khoẻ cụ thể, anh/chị nên hỏi ý kiến bác sĩ hoặc chuyên gia dinh dưỡng giúp em nhé! 🙏",
    ghiChu:
      "⚠️ ƯU TIÊN CAO NHẤT (95) — phải khớp TRƯỚC mọi kịch bản khác. " +
      "Nghị định 15/2018/NĐ-CP cấm quảng cáo thực phẩm có tác dụng chữa bệnh. " +
      "Đây là tuyến phòng thủ thứ nhất; Claim Guard ở đầu ra là tuyến thứ hai.",
    chuyenNguoi: true,
  },

  // ───────────────── Gặp người thật ─────────────────
  {
    uuTien: 88,
    mauKhop:
      "(gặp|nói chuyện với|chuyển) (nhân viên|người thật|người|tư vấn viên|admin)|" +
      "(không muốn|đừng) (nói chuyện với )?(bot|máy|ai)|" +
      "(cho|em) (xin |gọi )?(người|nhân viên)",
    traLoi:
      "Dạ em chuyển anh/chị tới nhân viên ngay ạ! Anh/chị chờ em một chút nhé 🙏",
    ghiChu: "Bộ phát hiện leo thang trong index.ts cũng bắt các cụm này — kịch bản là lớp thứ hai.",
    chuyenNguoi: true,
  },

  // ───────────────── Kết thúc ─────────────────
  {
    uuTien: 60,
    // Cho phép đuôi lịch sự: "cảm ơn EM", "cảm ơn shop NHIỀU NHÉ".
    // Vẫn neo ^ và $ để không khớp giữa câu dài — "cảm ơn nhưng anh muốn đổi
    // món khác" phải để AI xử lý, không được coi là kết thúc hội thoại.
    mauKhop:
      "^\\s*(cảm ơn|cám ơn|thanks|thank you|ok em|okie|được rồi|oke)" +
      "( (em|shop|bạn|nhiều|nha|nhé|ạ|nhiều nhé|nhiều ạ))*\\s*[.!]*\\s*$",
    traLoi:
      "Dạ em cảm ơn anh/chị đã ghé Farmers Market ạ! 🌿\n\nCần gì anh/chị cứ nhắn em bất cứ lúc nào nhé!",
  },
];

// ---------------------------------------------------------------------------
// B. TÀI LIỆU TRI THỨC — cho câu hỏi dài, không cố định
// ---------------------------------------------------------------------------
//
// ⚠️ Tầng tìm tài liệu hiện SO KHỚP TỪ, chưa hiểu nghĩa (xem NO_KY_THUAT.md
// N-06). Vì vậy mỗi đoạn cố ý viết NHIỀU CÁCH NÓI của cùng một ý — "đổi trả,
// hoàn trả, trả hàng, đổi hàng" — để khách hỏi kiểu nào cũng khớp.

export const TAI_LIEU: TaiLieu[] = [
  {
    ten: "Hướng dẫn đặt hàng và thanh toán",
    noiDung: `Đặt hàng, mua hàng, order tại Farmers Market qua khung chat.

Khách hàng nói tên sản phẩm muốn mua. Trợ lý tra giá và tồn kho thật từ hệ thống, báo lại con số chính xác tại thời điểm đó. Giá hiển thị là giá cuối cùng, đã bao gồm các chương trình khuyến mãi đang chạy.

Sau khi khách chốt số lượng, trợ lý thêm vào giỏ hàng. Khách cung cấp số điện thoại, địa chỉ nhận hàng và tên người nhận. Chỉ cần số nhà, tên đường và thành phố, không cần khai phường xã quận huyện.

Khách xác nhận chốt đơn, hệ thống sinh mã QR thanh toán. Thanh toán, trả tiền, chuyển khoản qua ngân hàng MB Bank, số tài khoản 0941000093, chủ tài khoản VP HOLDING. Quét mã QR bằng ứng dụng ngân hàng, nội dung chuyển khoản đã điền sẵn, không cần gõ tay.

Mỗi đơn hàng có một mã đơn dạng VPH kèm 8 ký tự. Giữ mã này để tra cứu tình trạng đơn về sau.`,
  },
  {
    ten: "Các nhóm hàng đang bán",
    noiDung: `Farmers Market bán hơn 4.000 sản phẩm thực phẩm và hàng tiêu dùng.

Trái cây: trái cây nhập khẩu, trái cây Việt Nam, trái cây cắt sẵn, hộp trái cây, giỏ trái cây biếu tặng.

Bánh kẹo và đồ ngọt: bánh quy, bánh ngọt, kẹo, socola, các loại bánh nhập khẩu.

Hạt và đồ sấy: hạt dinh dưỡng, hạt điều, hạnh nhân, trái cây sấy dẻo, trái cây sấy giòn.

Đồ uống: cà phê, trà, các loại nước.

Sữa và chế phẩm: sữa chua, bơ, phô mai.

Rau củ quả: rau ăn lá, củ quả, rau hữu cơ, rau đạt chuẩn VietGAP.

Hàng gia dụng: đồ dùng gia đình, sản phẩm chăm sóc cá nhân, chăm sóc nhà cửa.

Giỏ quà, hộp quà tặng cho các dịp lễ Tết, 8/3, Trung thu, Noel.`,
  },
  {
    ten: "Bảo quản thực phẩm sau khi nhận hàng",
    noiDung: `Hướng dẫn bảo quản, giữ tươi, cất giữ sản phẩm sau khi nhận hàng.

Rau ăn lá và rau củ tươi: để ngăn mát tủ lạnh, nên dùng trong vài ngày đầu để giữ độ tươi ngon.

Trái cây tươi: phần lớn để ngăn mát. Một số loại như chuối, bơ, xoài nên để nhiệt độ phòng cho chín đều rồi mới cho vào tủ lạnh.

Trái cây cắt sẵn: để ngăn mát và dùng trong ngày.

Sữa chua và chế phẩm từ sữa: luôn giữ trong ngăn mát, không để ngoài nhiệt độ phòng lâu.

Bánh kẹo, socola, hạt sấy: để nơi khô ráo thoáng mát, tránh ánh nắng trực tiếp. Socola nên tránh nơi nóng để không chảy.

Cà phê và trà: đậy kín sau khi mở, để nơi khô ráo, tránh ẩm.

Luôn xem hạn sử dụng in trên bao bì sản phẩm. Thông tin bảo quản chi tiết của từng mặt hàng được in trên nhãn.`,
  },
];
