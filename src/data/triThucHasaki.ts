/**
 * BỘ TRI THỨC — SHOP HASAKI
 *
 * Nạp bằng: npx ts-node src/scripts/napTriThuc.ts --shop "Hasaki"
 *
 * ═══ NGUỒN DỮ LIỆU ═══
 *
 * Toàn bộ chính sách dưới đây lấy từ chính hotro.hasaki.vn ngày 04/08/2026:
 *   /doi-tra-hoan-tien.html · /phi-van-chuyen.html · /huong-dan-dat-hang.html
 *   /huong-dan-dat-hang-2h.html · /huong-dan-xuat-hoa-don.html
 *   /quy-trinh-giao-hang.html · /tri-an-khach-hang.html
 * KHÔNG có câu nào do người viết tự nghĩ ra. Chính sách đổi thì phải cào lại
 * và sửa file này, đừng sửa thẳng trong CSDL.
 *
 * ═══ NGUYÊN TẮC BIÊN SOẠN (giống triThucFarmersMarket.ts) ═══
 *
 * 1. CHỈ viết điều BIẾT CHẮC. Điều gì hotro.hasaki.vn không nói rõ thì chuyển
 *    nhân viên, không suy đoán.
 *
 * 2. KHÔNG nhồi giá sản phẩm vào kịch bản cứng. Giá đổi hằng ngày; viết cứng
 *    là hôm sau bot nói dối. Giá luôn để bot tra thời gian thực từ Medusa.
 *
 * 3. Mẫu khớp KHÔNG được chứa từ đơn phổ thông đứng riêng ở cấp ngoài cùng.
 *    Luôn viết CỤM TỪ đầy đủ.
 *
 * 4. ⚠️ MẪU KHỚP CHẠY BẰNG REGEX CỦA POSTGRESQL, KHÔNG PHẢI JAVASCRIPT.
 *    Ranh giới từ là `\\y`, KHÔNG phải `\\b` — trong PostgreSQL `\\b` là ký tự
 *    backspace nên mẫu sẽ KHÔNG BAO GIỜ khớp, im lặng, không lỗi nào báo ra.
 *
 * 5. ⚠️ SHOP NÀY NGÀNH `my_pham` NÊN TƯỜNG LỬA CÔNG BỐ Y TẾ TỰ BẬT.
 *    Tuyệt đối không có câu nào nói sản phẩm trị mụn, trị nám, chữa bệnh da,
 *    làm trắng vĩnh viễn… Mỹ phẩm KHÔNG phải thuốc (Nghị định 15/2018/NĐ-CP và
 *    quy định quảng cáo mỹ phẩm). Câu hỏi kiểu "kem này trị mụn được không" bắt
 *    buộc chuyển nhân viên hoặc khuyên gặp bác sĩ da liễu.
 */

export interface KichBan {
  /** Regex PostgreSQL, không phân biệt hoa thường. Dùng | gộp các cách hỏi. */
  mauKhop: string;
  traLoi: string;
  /** Số lớn khớp trước. Câu cụ thể phải ưu tiên cao hơn câu chung. */
  uuTien: number;
  /**
   * true = sau khi trả lời thì THỰC SỰ chuyển hội thoại cho nhân viên.
   * Bắt buộc bật cho mọi kịch bản có câu chữ hứa chuyển người.
   */
  chuyenNguoi?: boolean;
  /** Ghi chú cho người bảo trì — không gửi cho khách. */
  ghiChu?: string;
}

export interface TaiLieu {
  ten: string;
  noiDung: string;
}

export const KICH_BAN: KichBan[] = [
  // ───────────────── Tường lửa công bố y tế (ưu tiên cao nhất) ─────────────
  {
    uuTien: 100,
    mauKhop:
      "(chữa|trị|điều trị|hết|khỏi) (được )?(mụn|nám|thâm|sẹo|tàn nhang|viêm da|dị ứng|chàm|vảy nến|rụng tóc)" +
      "|(chữa|trị|điều trị) (được )?(bệnh|ung thư|tiểu đường|huyết áp|covid|dạ dày|gan|tim)" +
      "|(có )?(tác dụng|công dụng) (trị|chữa|điều trị)" +
      "|(trắng da|trắng bật tông) (vĩnh viễn|cấp tốc|sau [0-9]+ ngày)" +
      "|(thay thế|thay cho) (thuốc|toa thuốc|bác sĩ)" +
      "|(bà bầu|phụ nữ có thai|cho con bú|trẻ sơ sinh) (dùng|bôi|thoa) (được )?không",
    traLoi:
      "Dạ về **hiệu quả điều trị và an toàn cho da**, em xin phép không tự tư vấn ạ. 🌿\n\n" +
      "Mỹ phẩm là sản phẩm chăm sóc, **không phải thuốc** và không thay thế chỉ định của bác sĩ. " +
      "Tình trạng da mỗi người mỗi khác nên cần người có chuyên môn xem trực tiếp.\n\n" +
      "Em chuyển anh/chị tới nhân viên tư vấn ngay ạ. Anh/chị cũng có thể đặt lịch khám tại **Hasaki Clinic & Spa** " +
      "hoặc gọi **1800 6324** (miễn phí) để được bác sĩ da liễu hỗ trợ.",
    chuyenNguoi: true,
    ghiChu:
      "Ngành my_pham nên tuong_lua_claim tự bật. Kịch bản này là lớp chặn đầu " +
      "tiên, ưu tiên cao hơn mọi kịch bản khác để câu hỏi y tế không bao giờ " +
      "rơi xuống AI trả lời tự do.",
  },

  // ───────────────── Chào hỏi & điều hướng ─────────────────
  {
    uuTien: 90,
    mauKhop: "^\\s*(chào|xin chào|hello|hi|alo|có ai (ở đó|không))\\y",
    traLoi:
      "Dạ em chào anh/chị ạ! 💚\n\n" +
      "Em là trợ lý của **Hasaki** — mỹ phẩm chính hãng 100%. Shop mình có gần **8.000 sản phẩm**: " +
      "chăm sóc da mặt, trang điểm, chăm sóc tóc, chăm sóc cơ thể, nước hoa, thời trang và đồ cho bé.\n\n" +
      "Anh/chị đang tìm sản phẩm gì để em gợi ý ạ?",
  },
  {
    uuTien: 88,
    mauKhop:
      "(gặp|nói chuyện với|chuyển) (nhân viên|người thật|người|tư vấn viên|admin)" +
      "|(không muốn|đừng) (nói chuyện với )?(bot|máy|ai)" +
      "|(cho|em) (xin |gọi )?(người|nhân viên) (hỗ trợ|tư vấn)",
    traLoi:
      "Dạ em chuyển anh/chị tới nhân viên ngay ạ! Anh/chị chờ em một chút nhé.\n\n" +
      "Hoặc anh/chị gọi **1800 6324** (miễn phí) — mỹ phẩm 08:00–22:00, Clinic & Spa 09:00–20:00.",
    chuyenNguoi: true,
  },

  // ───────────────── Chính sách đổi trả ─────────────────
  {
    uuTien: 80,
    mauKhop:
      "(chính sách |quy định )?(đổi trả|đổi hàng|trả hàng|hoàn tiền|refund)" +
      "|(đổi|trả) (được )?(hàng|sản phẩm) (không|trong|sau)" +
      "|(bao lâu|mấy ngày|thời hạn) (thì )?(được )?(đổi|trả)",
    traLoi:
      "Dạ Hasaki áp dụng chính sách **đổi trả trong vòng 30 ngày** (từ 01/06/2024) ạ:\n\n" +
      "✅ **Được đổi trả** khi:\n" +
      "• Sản phẩm lỗi từ nhà sản xuất (hỏng hóc, đổ vỡ, lỗi kỹ thuật)\n" +
      "• Hư hỏng, trầy xước do quá trình vận chuyển\n" +
      "• Đã hết hoặc gần hết hạn sử dụng\n" +
      "• Giao sai sản phẩm, sai tông màu so với đơn đặt\n" +
      "• Sản phẩm còn nguyên vỏ hộp, tem nhãn và **chưa qua sử dụng**\n\n" +
      "❌ **Không áp dụng** với:\n" +
      "• Sản phẩm quà tặng, hàng thuộc chương trình giảm giá đặc biệt\n" +
      "• Quá hạn đổi trả (từ ngày thứ 31)\n" +
      "• Đã bóc tem nhãn, seal\n" +
      "• Đã thử hoặc sử dụng từ 1 lần trở lên\n\n" +
      "Anh/chị cần đổi trả đơn cụ thể thì cho em xin **mã đơn hàng** để em chuyển nhân viên xử lý nhé ạ!",
  },

  // ───────────────── Phí vận chuyển ─────────────────
  {
    uuTien: 80,
    mauKhop:
      "(phí|tiền|cước) (giao hàng|vận chuyển|ship)" +
      "|(giao hàng|vận chuyển) (mất |hết )?(bao lâu|bao nhiêu|mấy ngày)" +
      "|ship (về|đi|tới|đến) [^ ]+ (mất |hết )?(bao lâu|bao nhiêu|mấy ngày)" +
      "|(ship|giao hàng) (bao nhiêu|mất bao nhiêu|hết bao nhiêu|tính sao)" +
      "|(miễn phí|free) (ship|vận chuyển|giao hàng)" +
      "|(có )?(mất|tính) (phí )?ship (không|ko)",
    traLoi:
      "Dạ phí vận chuyển tại Hasaki như sau ạ:\n\n" +
      "📍 **Tỉnh/thành CÓ cửa hàng Hasaki**\n" +
      "• Đơn từ **90.000đ** trở lên: **miễn phí vận chuyển**\n" +
      "• Đơn dưới 90.000đ: phí **10.000đ**\n\n" +
      "📍 **Tỉnh/thành CHƯA có cửa hàng Hasaki**\n" +
      "• Đơn từ **249.000đ** trở lên: **miễn phí vận chuyển**\n\n" +
      "Anh/chị cho em xin khu vực nhận hàng, em kiểm tra giúp mức phí cụ thể nhé ạ!",
  },

  // ───────────────── Giao nhanh 2H / NowFree ─────────────────
  {
    uuTien: 78,
    mauKhop:
      "(giao|ship) (nhanh )?(trong )?2h" +
      "|nowfree" +
      "|(giao hàng|nhận hàng) (trong )?(bao lâu|mấy ngày|khi nào)" +
      "|(có )?giao (hàng )?(nhanh|hoả tốc|trong ngày)",
    traLoi:
      "Dạ Hasaki có dịch vụ **NowFree — giao nhanh 2H** ạ! ⚡\n\n" +
      "• Áp dụng cho khách ở **nội thành TP.HCM và Hà Nội**\n" +
      "• Sản phẩm phải có **icon giao 2H** ở trang chi tiết, và khu vực nhận hàng nằm trong vùng hỗ trợ\n\n" +
      "Anh/chị cho em xin địa chỉ nhận hàng và sản phẩm muốn mua, em kiểm tra giúp có áp dụng được không nhé ạ!",
  },

  // ───────────────── Thanh toán ─────────────────
  {
    uuTien: 76,
    mauKhop:
      "(thanh toán|trả tiền|chuyển khoản) (thế nào|ra sao|kiểu gì|bằng cách nào|như thế nào)" +
      "|(hình thức|phương thức|cách) thanh toán" +
      "|(có )?(nhận|hỗ trợ) (thẻ|visa|momo|ví điện tử|cod)",
    traLoi:
      "Dạ khi đặt hàng qua khung chat này, shop mình nhận **chuyển khoản ngân hàng** ạ:\n\n" +
      "🏦 Ngân hàng: **MB Bank**\n" +
      "🔢 Số tài khoản: **0941000093**\n" +
      "👤 Chủ tài khoản: **VP HOLDING**\n\n" +
      "Sau khi anh/chị chốt đơn, hệ thống sinh **mã QR** kèm nội dung chuyển khoản điền sẵn — anh/chị chỉ cần quét bằng app ngân hàng, không phải gõ tay ạ.",
    ghiChu:
      "Số tài khoản khớp giá trị mặc định trong apps/backend/src/api/ai/" +
      "payment-info/route.ts. Đổi tài khoản ở đó thì phải sửa cả câu này.",
  },

  // ───────────────── Hoá đơn VAT ─────────────────
  {
    uuTien: 74,
    mauKhop:
      "(xuất |lấy |có )?(hoá đơn|hóa đơn) (đỏ|vat|gtgt)" +
      "|(xuất|lấy) (được )?(hoá đơn|hóa đơn)",
    traLoi:
      "Dạ Hasaki có xuất **hoá đơn VAT** ạ:\n\n" +
      "• **Đơn online**: nhập thông tin xuất hoá đơn khi đơn chuyển trạng thái *Giao hàng thành công*\n" +
      "• **Đơn tại cửa hàng**: nhờ thu ngân hỗ trợ, hoặc quét mã QR trên hoá đơn để tự nhập\n\n" +
      "⏰ **Thời hạn nhập thông tin: tối đa 30 phút** kể từ thời điểm trên. Quá hạn thì không xuất được nữa ạ.\n\n" +
      "Anh/chị cần xuất hoá đơn cho đơn cụ thể thì cho em xin mã đơn để em chuyển nhân viên hỗ trợ nhé!",
  },

  // ───────────────── Hàng chính hãng ─────────────────
  {
    uuTien: 72,
    mauKhop:
      "(có )?(hàng |là )?(chính hãng|hàng thật|auth|authentic) (không|ko|chứ)" +
      "|(sợ|lo) (hàng )?(giả|nhái|fake)" +
      "|(cam kết|đảm bảo) (hàng )?(chính hãng|thật)",
    traLoi:
      "Dạ Hasaki cam kết **100% hàng chính hãng** ạ! 💚\n\n" +
      "Toàn bộ sản phẩm được nhập trực tiếp từ nhà sản xuất hoặc nhà phân phối uỷ quyền chính thức tại Việt Nam, " +
      "có đầy đủ tem nhãn phụ tiếng Việt và hoá đơn chứng từ.\n\n" +
      "Anh/chị yên tâm mua sắm nhé ạ!",
  },

  // ───────────────── Hệ thống cửa hàng & Clinic ─────────────────
  {
    uuTien: 70,
    mauKhop:
      "(shop|cửa hàng|chi nhánh|showroom|bên (mình|em)) (ở đâu|nào|gần|tại)" +
      "|(có )?(cửa hàng|chi nhánh) (ở |tại )?(hà nội|hồ chí minh|hcm|đà nẵng|sài gòn)" +
      "|(địa chỉ|hệ thống) (cửa hàng|chi nhánh)" +
      "|(đặt lịch|book) (clinic|spa|khám)",
    traLoi:
      "Dạ Hasaki có hệ thống cửa hàng trên toàn quốc và **Hasaki Clinic & Spa** ạ.\n\n" +
      "📞 Hotline **1800 6324** (miễn phí)\n" +
      "• Mỹ phẩm: 08:00 – 22:00\n" +
      "• Clinic & Spa: 09:00 – 20:00\n\n" +
      "Anh/chị cho em xin khu vực mình ở, em chuyển nhân viên tra cứu cửa hàng gần nhất và hỗ trợ đặt lịch nhé ạ!",
    chuyenNguoi: true,
    ghiChu:
      "Danh sách cửa hàng cụ thể thay đổi liên tục nên KHÔNG viết cứng địa chỉ. " +
      "Chuyển nhân viên là đúng — thà chậm một nhịp còn hơn chỉ sai địa chỉ.",
  },

  // ───────────────── Đặt hàng ─────────────────
  {
    uuTien: 68,
    mauKhop:
      "(đặt|mua) hàng (thế nào|ra sao|kiểu gì|như thế nào|ở đâu)" +
      "|(cách|hướng dẫn) (đặt|mua) hàng" +
      "|làm sao để (đặt|mua)",
    traLoi:
      "Dạ anh/chị đặt hàng ngay trong khung chat này luôn ạ, 4 bước:\n\n" +
      "1️⃣ Nói tên sản phẩm muốn mua — em tra giá và tình trạng hàng thật rồi báo lại\n" +
      "2️⃣ Chốt số lượng — em thêm vào giỏ\n" +
      "3️⃣ Cho em xin **tên, số điện thoại, địa chỉ** nhận hàng\n" +
      "4️⃣ Xác nhận chốt đơn — em gửi **mã QR thanh toán** kèm mã đơn\n\n" +
      "Anh/chị bắt đầu bằng việc cho em biết đang tìm sản phẩm gì nhé! 😊",
  },

  // ───────────────── Tra cứu đơn hàng ─────────────────
  {
    uuTien: 66,
    mauKhop:
      "(tra cứu|kiểm tra|tra|check|xem) (tình trạng |trạng thái )?(đơn hàng|đơn|order)" +
      "|(đơn hàng|đơn) (của (anh|chị|tôi|em) )?(tới đâu|đến đâu|giao chưa|đâu rồi)" +
      "|(khi nào|bao giờ) (thì )?(nhận|giao) (được )?(hàng|đơn)",
    traLoi:
      "Dạ anh/chị cho em xin **mã đơn hàng** (dạng `VPH` kèm 8 ký tự, có trong tin nhắn xác nhận đơn) " +
      "để em chuyển nhân viên tra cứu giúp ạ.\n\n" +
      "Hoặc anh/chị gọi **1800 6324** (miễn phí) để được hỗ trợ ngay nhé!",
    chuyenNguoi: true,
  },

  // ───────────────── Tích điểm ─────────────────
  {
    uuTien: 64,
    mauKhop:
      "(tích|tích luỹ|tích lũy|đổi) điểm" +
      "|(chương trình|thẻ) (thành viên|tri ân|khách hàng thân thiết)" +
      "|(đổi|nhận) quà",
    traLoi:
      "Dạ Hasaki có **chương trình tri ân khách hàng thân thiết** với tích điểm đổi quà ạ.\n\n" +
      "Anh/chị vui lòng tới trực tiếp cửa hàng Hasaki để nhân viên tra cứu điểm khả dụng và hỗ trợ đổi quà, " +
      "hoặc gọi **1800 6324** (miễn phí) để được hướng dẫn chi tiết nhé ạ!",
    ghiChu:
      "hotro.hasaki.vn ghi hệ thống điểm đang trong giai đoạn bảo trì và phải " +
      "ra cửa hàng tra cứu. Không hứa tra điểm qua chat.",
  },

  // ───────────────── Giới thiệu ngành hàng ─────────────────
  {
    uuTien: 71,
    mauKhop:
      "(shop|cửa hàng|bên (mình|em)) (bán|có) (gì|những gì|hàng gì|sản phẩm gì|mặt hàng gì)" +
      "|có những (loại|mặt hàng|sản phẩm|dòng) gì",
    traLoi:
      "Dạ Hasaki có gần **8.000 sản phẩm** chính hãng ạ, các nhóm chính:\n\n" +
      "🧴 **Chăm sóc da mặt** — tẩy trang, sữa rửa mặt, toner, serum, kem dưỡng, chống nắng\n" +
      "💄 **Trang điểm** — kem nền, cushion, che khuyết điểm, phấn phủ, son, mascara\n" +
      "💇 **Chăm sóc tóc** — dầu gội, dầu xả, ủ tóc, serum dưỡng tóc, thuốc nhuộm\n" +
      "🧼 **Chăm sóc cơ thể** — sữa tắm, dưỡng thể, chống nắng body\n" +
      "🪥 **Chăm sóc cá nhân & răng miệng**\n" +
      "🌸 **Nước hoa** — nữ, nam, xịt thơm toàn thân\n" +
      "👶 **Sản phẩm cho bé** · 👗 **Thời trang** · 🏠 **Gia dụng**\n\n" +
      "Anh/chị quan tâm nhóm nào để em gợi ý cụ thể ạ?",
    ghiChu:
      "Mẫu bắt buộc có cụm chủ ngữ (shop|cửa hàng|bên mình) đứng trước, nếu " +
      "không sẽ nuốt cả câu 'có xoài không em' vốn phải để AI đi tìm sản phẩm.",
  },

  // ───────────────── Giờ làm việc ─────────────────
  {
    uuTien: 69,
    mauKhop:
      "(mấy giờ|giờ nào|lúc nào) (thì )?(mở cửa|đóng cửa)" +
      "|(giờ|thời gian) (mở cửa|đóng cửa|làm việc|hoạt động)" +
      "|(mở cửa|đóng cửa) (lúc |từ )?(mấy giờ|khi nào)" +
      "|(làm việc|hoạt động) (đến |tới )?(mấy giờ|khi nào)",
    traLoi:
      "Dạ giờ hỗ trợ của Hasaki ạ:\n\n" +
      "📞 Hotline **1800 6324** (miễn phí)\n" +
      "• **Mỹ phẩm**: 08:00 – 22:00\n" +
      "• **Clinic & Spa**: 09:00 – 20:00\n\n" +
      "Riêng khung chat này thì em trực **24/7**, anh/chị cứ nhắn bất cứ lúc nào ạ! 😊",
  },

  // ───────────────── Chặn mặc cả ─────────────────
  {
    uuTien: 67,
    mauKhop:
      "(giảm|bớt) (giá |tiền )?(cho|được|chút|thêm|nữa)" +
      "|(mặc cả|trả giá|deal giá)" +
      "|(có )?(giảm|bớt) (thêm )?(được )?(không|ko)",
    traLoi:
      "Dạ giá trên hệ thống là **giá niêm yết chính thức**, đã gồm các chương trình khuyến mãi đang chạy nên em không giảm thêm được ạ. 🙏\n\n" +
      "Bù lại anh/chị được:\n" +
      "• **Miễn phí vận chuyển** với đơn từ 90.000đ (tỉnh/thành có cửa hàng Hasaki)\n" +
      "• **Đổi trả 30 ngày** nếu sản phẩm lỗi\n" +
      "• Cam kết **100% chính hãng**\n\n" +
      "Em xem giúp anh/chị có sản phẩm nào đang khuyến mãi phù hợp nhé?",
    ghiChu:
      "Bot KHÔNG được tự ý giảm giá — giá chốt đơn phải khớp giá Medusa, lệch " +
      "là hệ thống chặn ở bước kiểm chứng.",
  },

  // ───────────────── Kết thúc hội thoại ─────────────────
  {
    uuTien: 60,
    mauKhop: "^\\s*(cảm ơn|cám ơn|thanks|thank you|tks|ok cảm ơn)\\y",
    traLoi:
      "Dạ em cảm ơn anh/chị đã ghé Hasaki ạ! 💚\n\n" +
      "Anh/chị cần tư vấn thêm gì cứ nhắn em bất cứ lúc nào nhé. Chúc anh/chị một ngày tốt lành! 🌿",
  },

  // ───────────────── Cảnh báo lừa đảo ─────────────────
  {
    uuTien: 62,
    mauKhop:
      "(lừa đảo|scam|giả mạo) (hasaki)?" +
      "|(có phải|đúng là) (kênh|trang|page) (chính thức|của hasaki)" +
      "|(ai đó|người lạ) (gọi|nhắn) (nói|bảo) (là )?hasaki",
    traLoi:
      "Dạ anh/chị cẩn thận với các trang giả mạo ạ! ⚠️\n\n" +
      "Hasaki **chỉ** liên hệ khách qua hotline chính thức **1800 6324** (miễn phí).\n\n" +
      "Hasaki **không bao giờ** yêu cầu khách chuyển tiền vào tài khoản cá nhân, " +
      "không yêu cầu cung cấp mã OTP, mật khẩu hay thông tin thẻ qua điện thoại.\n\n" +
      "Nếu anh/chị nghi ngờ bị lừa đảo, em chuyển nhân viên hỗ trợ ngay ạ.",
    chuyenNguoi: true,
  },
];

export const TAI_LIEU: TaiLieu[] = [
  {
    ten: "Chính sách đổi trả và hoàn tiền",
    noiDung: `Chính sách đổi trả, trả hàng, hoàn tiền tại Hasaki.

Từ ngày 01/06/2024, Hasaki áp dụng chính sách đổi trả trong vòng 30 ngày kể từ khi nhận hàng.

Các trường hợp được đổi trả: sản phẩm mắc lỗi từ phía nhà sản xuất như hỏng hóc, đổ vỡ, lỗi kỹ thuật. Sản phẩm bị hư hỏng, trầy xước do quá trình vận chuyển của nhân viên giao hàng. Sản phẩm đã hết hoặc gần hết thời hạn sử dụng. Sản phẩm không đúng như yêu cầu của khách hàng do Hasaki soạn sai sản phẩm hoặc lấy nhầm tông màu, loại sản phẩm. Sản phẩm còn nguyên vỏ hộp, tem nhãn và chưa qua sử dụng.

Các trường hợp không áp dụng đổi trả: sản phẩm quà tặng và các sản phẩm trong chương trình giảm giá đặc biệt. Sản phẩm đã quá hạn đổi trả, tính từ ngày thứ 31 trở đi. Sản phẩm đã bị bóc tem nhãn hoặc seal nếu có. Sản phẩm khách đã thử hoặc đã qua sử dụng từ 1 lần trở lên.

Khách hàng cần đổi trả cung cấp mã đơn hàng để nhân viên kiểm tra và xử lý. Hotline hỗ trợ 1800 6324 miễn phí.`,
  },
  {
    ten: "Phí vận chuyển và giao hàng nhanh 2H",
    noiDung: `Phí vận chuyển, phí ship, phí giao hàng tại Hasaki.

Đối với các tỉnh và thành phố có cửa hàng của Hasaki: miễn phí vận chuyển cho đơn hàng từ 90.000đ trở lên. Các đơn hàng dưới 90.000đ chịu phí vận chuyển 10.000đ.

Đối với các tỉnh và thành phố chưa có cửa hàng của Hasaki: miễn phí vận chuyển cho đơn hàng từ 249.000đ trở lên.

Dịch vụ NowFree giao nhanh trong 2 giờ áp dụng cho khách hàng ở khu vực nội thành Thành phố Hồ Chí Minh và Hà Nội. Điều kiện áp dụng: sản phẩm có biểu tượng giao hàng 2H ở trang chi tiết sản phẩm, và khu vực nhận hàng của khách thuộc vùng hỗ trợ dịch vụ giao hàng 2H.

Hotline hỗ trợ 1800 6324 miễn phí. Giờ làm việc mảng mỹ phẩm từ 08:00 đến 22:00, mảng Clinic và Spa từ 09:00 đến 20:00.`,
  },
  {
    ten: "Hướng dẫn đặt hàng và thanh toán qua khung chat",
    noiDung: `Đặt hàng, mua hàng, order tại Hasaki qua khung chat.

Khách hàng nói tên sản phẩm muốn mua. Trợ lý tra giá và tình trạng hàng thật từ hệ thống, báo lại con số chính xác tại thời điểm đó. Giá hiển thị là giá cuối cùng đang áp dụng.

Sau khi khách chốt số lượng, trợ lý thêm sản phẩm vào giỏ hàng. Khách cung cấp tên người nhận, số điện thoại và địa chỉ nhận hàng. Chỉ cần số nhà, tên đường và thành phố.

Khách xác nhận chốt đơn, hệ thống sinh mã QR thanh toán. Thanh toán, trả tiền, chuyển khoản qua ngân hàng MB Bank, số tài khoản 0941000093, chủ tài khoản VP HOLDING. Quét mã QR bằng ứng dụng ngân hàng, nội dung chuyển khoản đã điền sẵn, không cần gõ tay.

Mỗi đơn hàng có một mã đơn dạng VPH kèm 8 ký tự. Giữ mã này để tra cứu tình trạng đơn về sau.

Ngoài ra khách có thể đặt hàng trực tuyến trên website Hasaki.vn theo các bước cơ bản: tìm sản phẩm theo ô tìm kiếm hoặc theo danh mục, mở trang chi tiết sản phẩm, kiểm tra lại giá và quà tặng kèm, chọn số lượng, bấm Mua ngay hoặc thêm vào Giỏ hàng rồi tiếp tục chọn thêm sản phẩm khác.`,
  },
  {
    ten: "Hoá đơn VAT",
    noiDung: `Xuất hoá đơn VAT, hoá đơn đỏ, hoá đơn giá trị gia tăng tại Hasaki.

Đối với đơn hàng online: khách nhập thông tin xuất hoá đơn khi đơn hàng được cập nhật trạng thái Giao hàng thành công.

Đối với đơn mua tại cửa hàng: khách nhờ thu ngân hỗ trợ, hoặc quét mã QR trên hoá đơn bán lẻ để tự nhập thông tin.

Thời hạn nhập thông tin xuất hoá đơn là tối đa 30 phút, tính từ khi đơn online chuyển trạng thái Giao hàng thành công, hoặc từ khi hệ thống in hoá đơn bán lẻ tại cửa hàng. Quá thời hạn này sẽ không xuất được hoá đơn.`,
  },
  {
    ten: "Cam kết hàng chính hãng và cảnh báo lừa đảo",
    noiDung: `Hasaki cam kết bán 100% hàng chính hãng.

Sản phẩm được nhập trực tiếp từ nhà sản xuất hoặc nhà phân phối được uỷ quyền chính thức tại Việt Nam, có đầy đủ tem nhãn phụ tiếng Việt và hoá đơn chứng từ hợp lệ.

Cảnh báo lừa đảo, giả mạo Hasaki. Hasaki chỉ liên hệ khách hàng qua hotline chính thức 1800 6324 miễn phí. Hasaki không bao giờ yêu cầu khách hàng chuyển tiền vào tài khoản cá nhân, không yêu cầu cung cấp mã OTP, mật khẩu hoặc thông tin thẻ ngân hàng qua điện thoại. Khách hàng nghi ngờ bị lừa đảo cần liên hệ ngay hotline để được hỗ trợ.`,
  },
  {
    ten: "Nhóm sản phẩm đang bán",
    noiDung: `Hasaki bán gần 8.000 sản phẩm mỹ phẩm và hàng tiêu dùng, chia thành các nhóm chính.

Chăm sóc da mặt: tẩy trang mặt, sữa rửa mặt, tẩy tế bào chết da mặt, toner và nước cân bằng da, serum và tinh chất, xịt khoáng, lotion và sữa dưỡng, kem gel dầu dưỡng, dưỡng mắt, dưỡng môi, chống nắng da mặt.

Trang điểm: kem lót, kem nền, phấn nền, phấn nước cushion, che khuyết điểm, má hồng, phấn phủ, xịt khoá makeup, kẻ mày, kẻ mắt, phấn mắt, mascara, son dưỡng môi, son kem và tint, son thỏi, son bóng, bông tẩy trang, cọ trang điểm, giấy thấm dầu.

Chăm sóc tóc và da đầu: dầu gội, dầu xả, dầu gội khô, bộ gội xả, tẩy tế bào chết da đầu, mặt nạ và kem ủ tóc, serum và dầu dưỡng tóc, xịt dưỡng tóc, thuốc nhuộm tóc, sản phẩm tạo kiểu tóc, lược, máy tạo kiểu tóc.

Chăm sóc cơ thể: sữa tắm, xà phòng, tẩy tế bào chết body, dưỡng thể, dưỡng da tay và chân, chống nắng cơ thể.

Chăm sóc cá nhân: băng vệ sinh, khăn giấy và khăn ướt, khử mùi và làm thơm phòng, dao cạo râu, bọt cạo râu, nước rửa tay diệt khuẩn, dung dịch vệ sinh, chống muỗi.

Chăm sóc răng miệng: bàn chải đánh răng, kem đánh răng, nước súc miệng, tăm nước và chỉ nha khoa, bàn chải điện.

Nước hoa: nước hoa nữ, nước hoa nam, xịt thơm toàn thân, nước hoa cao cấp.

Ngoài ra còn có mỹ phẩm high-end, thực phẩm chức năng, gia dụng và đời sống, thời trang nam nữ và trẻ em, balo túi xách, sản phẩm cho bé, và dịch vụ Hasaki Clinic & Spa.`,
  },
];
