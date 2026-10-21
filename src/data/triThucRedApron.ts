/**
 * BỘ TRI THỨC — SHOP RED APRON (rượu vang & rượu mạnh)
 *
 * Nạp bằng: npx ts-node src/scripts/napTriThuc.ts --shop "Red Apron"
 * Xem trước, không ghi: thêm cờ --thu
 *
 * ═══ NGUỒN DỮ LIỆU ═══
 *
 * Chính sách và thông tin cửa hàng lấy từ chính redapron.vn ngày 07/08/2026
 * (trang `/pages/he-thong-cua-hang`, chân trang, và bộ trang tĩnh đã dựng lại
 * ở `apps/storefront-redapron/src/lib/trang-tinh.ts`). Chính sách đổi thì sửa
 * file này rồi nạp lại, đừng sửa thẳng trong CSDL.
 *
 * ═══ NGUYÊN TẮC BIÊN SOẠN ═══
 *
 * 1. CHỈ viết điều BIẾT CHẮC. Điều gì không chắc thì chuyển nhân viên.
 *
 * 2. KHÔNG nhồi giá hay niên vụ vào kịch bản cứng. Danh mục 3.554 chai, giá và
 *    niên vụ đổi liên tục; viết cứng là hôm sau bot nói dối. Giá, tồn kho,
 *    niên vụ luôn để bot tra thời gian thực từ Medusa.
 *
 * 3. Mẫu khớp KHÔNG được chứa từ đơn phổ thông đứng riêng ở cấp ngoài cùng.
 *    Luôn viết CỤM TỪ đầy đủ. `napTriThuc.ts` sẽ chặn nếu vi phạm.
 *
 * 4. ⚠️ MẪU KHỚP CHẠY BẰNG REGEX CỦA POSTGRESQL, KHÔNG PHẢI JAVASCRIPT.
 *    Ranh giới từ là `\\y`, KHÔNG phải `\\b` — trong PostgreSQL `\\b` là ký tự
 *    backspace nên mẫu sẽ KHÔNG BAO GIỜ khớp, im lặng, không lỗi nào báo ra.
 *
 * ═══ HAI TƯỜNG LỬA RIÊNG CỦA NGÀNH RƯỢU ═══
 *
 * A. **Tuổi.** Luật Phòng, chống tác hại của rượu, bia 2019 cấm bán và quảng
 *    cáo rượu cho người dưới 18 tuổi. Bot tuyệt đối không được tư vấn mua bán
 *    khi khách nói mình chưa đủ tuổi, hoặc mua hộ cho người chưa đủ tuổi.
 *
 * B. **Công bố sức khoẻ.** Shop khai ngành `thuc_pham` nên `tuong_lua_claim`
 *    tự bật. Với rượu thì rủi ro còn cao hơn mỹ phẩm: "vang đỏ tốt cho tim
 *    mạch", "uống mỗi ngày một ly sống thọ", "giúp giảm cholesterol" là những
 *    câu khách hỏi rất nhiều và tuyệt đối KHÔNG được khẳng định. Cùng nhóm:
 *    lái xe sau khi uống, phụ nữ mang thai, người đang dùng thuốc.
 *
 * ═══ SAI LẦM TƯ VẤN PHẢI TRÁNH (đúc từ các đợt nghiệm thu trước) ═══
 *
 *   · Bịa niên vụ, điểm số Robert Parker/Wine Spectator, hay giải thưởng.
 *   · Khẳng định "chai này ngon nhất" — khẩu vị là chủ quan, và câu đó biến
 *     mọi chai khác thành hàng kém.
 *   · Tự chế giá hoặc quy đổi khuyến mãi. Giá chỉ đọc từ Medusa.
 *   · Nhận là chuyên gia thẩm định để định giá chai khách đang có.
 *   · Trả lời câu hỏi thông tin ("shop ở đâu") mà lại tạo đơn hàng.
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

const HOTLINE = "1900 0245";

export const KICH_BAN: KichBan[] = [
  // ═══════════════ TƯỜNG LỬA A — TUỔI (ưu tiên tuyệt đối) ═══════════════
  {
    uuTien: 110,
    mauKhop:
      "(em|con|cháu|tôi|mình|anh|chị) (mới |vừa )?(1[0-7]|dưới 18|chưa (đủ )?18) (tuổi)?" +
      "|(chưa|không) (đủ |đến )?(tuổi|18)" +
      "|(mua|đặt) (hộ|giùm|giúp) (cho )?(em|đứa|thằng|con) (trai|gái|em)? ?(1[0-7]|học sinh|cấp 3|lớp 1[0-2])" +
      "|(học sinh|cấp 3|lớp 1[0-2]) (mua|uống|đặt) (được )?không",
    traLoi:
      "Dạ em xin phép **không tư vấn hay bán rượu cho người dưới 18 tuổi** ạ. 🚫\n\n" +
      "Đây là quy định của **Luật Phòng, chống tác hại của rượu, bia 2019**, Red Apron " +
      "tuân thủ nghiêm ngặt — nhân viên giao hàng cũng sẽ kiểm tra giấy tờ và từ chối " +
      "giao nếu người nhận chưa đủ tuổi.\n\n" +
      "Em rất mong anh/chị thông cảm ạ.",
    ghiChu:
      "Ưu tiên 110 — CAO NHẤT, cao hơn cả tường lửa y tế. Câu này phải chặn " +
      "trước mọi kịch bản khác, kể cả chào hỏi, để không bao giờ rơi xuống AI " +
      "trả lời tự do. KHÔNG chuyển nhân viên: chuyển người ở đây nghĩa là để " +
      "nhân viên tiếp tục bán cho trẻ vị thành niên.",
  },

  // ═══════════════ TƯỜNG LỬA B — CÔNG BỐ SỨC KHOẺ ═══════════════
  {
    uuTien: 100,
    mauKhop:
      "(chữa|trị|điều trị|hết|khỏi|phòng) (được )?(bệnh|ung thư|tiểu đường|huyết áp|tim mạch|cholesterol|mỡ máu|covid|dạ dày|gan|xương khớp|mất ngủ|đột quỵ)" +
      "|(tốt|lợi|có lợi) (cho )?(tim|tim mạch|sức khoẻ|sức khỏe|gan|máu|tiêu hoá|tiêu hóa)" +
      "|(giảm|hạ) (được )?(cholesterol|mỡ máu|huyết áp|cân|béo)" +
      "|(chống|ngăn) (lão hoá|lão hóa|ung thư|oxy hoá|oxy hóa)" +
      "|(sống (lâu|thọ)|trẻ lâu|đẹp da) (hơn )?(khi |nếu )?(uống|nhờ)" +
      "|(uống|dùng) (được )?(khi|lúc) (đang )?(uống thuốc|dùng thuốc|điều trị|mang thai|có thai|cho con bú)" +
      "|(bà bầu|phụ nữ có thai|mang thai|cho con bú|người bệnh|người tiểu đường) (uống|dùng) (được )?không",
    traLoi:
      "Dạ về **tác động của rượu tới sức khoẻ**, em xin phép không tư vấn ạ. 🍷\n\n" +
      "Rượu vang là **đồ uống có cồn, không phải thực phẩm chức năng và không phải thuốc**. " +
      "Red Apron không đưa ra bất kỳ công bố nào về tác dụng chữa bệnh hay bồi bổ sức khoẻ.\n\n" +
      "Với các trường hợp **đang mang thai, cho con bú, đang dùng thuốc hoặc có bệnh nền**, " +
      "anh/chị vui lòng hỏi ý kiến bác sĩ trước ạ.\n\n" +
      "Em chuyển anh/chị sang nhân viên để được hỗ trợ các nội dung khác nhé.",
    chuyenNguoi: true,
    ghiChu:
      "Ngành thuc_pham nên tuong_lua_claim tự bật. Đây là lớp chặn thứ hai, " +
      "ưu tiên cao hơn mọi kịch bản bán hàng.",
  },
  {
    uuTien: 99,
    mauKhop:
      "(uống rượu|uống bia|uống xong|nhậu) (rồi )?(mà )?(lái xe|chạy xe|lái ô tô|chạy grab|về nhà bằng xe)" +
      "|(lái xe|chạy xe|cầm lái) (sau khi |xong )?(uống|nhậu)" +
      "|(nồng độ cồn|thổi nồng độ) (bao nhiêu|thế nào|có sao)" +
      "|uống (bao nhiêu|mấy ly) (thì )?(không bị )?(phạt|thổi|bắt)",
    traLoi:
      "Dạ em xin phép không tư vấn nội dung này ạ.\n\n" +
      "Việt Nam áp dụng quy định **nồng độ cồn bằng 0 khi điều khiển phương tiện giao thông** — " +
      "đã uống rượu bia thì **không lái xe**, không có ngưỡng an toàn nào cả.\n\n" +
      "Anh/chị vui lòng đi taxi hoặc nhờ người khác lái giúp ạ. 🚕",
    ghiChu:
      "Không chuyển nhân viên — không có câu trả lời nào khác đúng, và chuyển " +
      "người chỉ tạo cơ hội cho một câu tư vấn sai.",
  },

  // ═══════════════ CHÀO HỎI & ĐIỀU HƯỚNG ═══════════════
  {
    uuTien: 90,
    mauKhop: "^\\s*(chào|xin chào|hello|hi|alo|có ai (ở đó|không))\\y",
    traLoi:
      "Dạ em chào anh/chị ạ! 🍷\n\n" +
      "Em là trợ lý của **Red Apron Fine Wines & Spirits** — chuỗi 16 cửa hàng rượu vang " +
      "tại Hà Nội, TP. Hồ Chí Minh, Đà Nẵng, Hội An, Nha Trang và Phú Quốc, với hơn " +
      "**3.000 dòng vang và rượu mạnh** nhập khẩu chính ngạch.\n\n" +
      "Anh/chị đang tìm rượu cho dịp nào để em gợi ý ạ?",
  },
  {
    uuTien: 88,
    mauKhop:
      "(gặp|nói chuyện với|chuyển) (nhân viên|người thật|người|tư vấn viên|admin|chuyên gia)" +
      "|(không muốn|đừng) (nói chuyện với )?(bot|máy|ai)" +
      "|(cho|em) (xin |gọi )?(người|nhân viên) (hỗ trợ|tư vấn)",
    traLoi:
      "Dạ em chuyển anh/chị sang **chuyên gia rượu vang** của Red Apron ngay ạ. 🍇\n\n" +
      `Anh/chị cũng có thể gọi tổng đài **${HOTLINE}** hoặc ghé bất kỳ cửa hàng nào ` +
      "trong hệ thống để được tư vấn trực tiếp.",
    chuyenNguoi: true,
  },
  {
    uuTien: 71,
    mauKhop:
      "(shop|cửa hàng|bên (mình|em)) (bán|có) (gì|những gì|hàng gì|sản phẩm gì|mặt hàng gì|rượu gì)" +
      "|có những (loại|mặt hàng|sản phẩm|dòng) gì",
    traLoi:
      "Dạ Red Apron bán **rượu vang và rượu mạnh nhập khẩu chính ngạch** ạ, hơn 3.000 dòng:\n\n" +
      "🍷 **Rượu vang** — vang đỏ, vang trắng, vang hồng, vang nổ, vang ngọt, vang cường hoá, vang không cồn\n" +
      "🥂 **Champagne** và các dòng vang nổ Pháp, Ý, Tây Ban Nha\n" +
      "🏆 **Fine wines** — Bordeaux Grand Cru Classé, Bourgogne Premier & Grand Cru\n" +
      "🥃 **Rượu mạnh** — whisky, cognac, rhum, grappa, calvados, rượu mùi\n" +
      "🎁 **Quà tặng** — hộp quà, set quà, giỏ quà Tết, e-gift voucher\n\n" +
      "Anh/chị muốn xem nhóm nào để em tra hàng đang có và giá cụ thể ạ?",
  },

  // ═══════════════ TƯ VẤN CHỌN RƯỢU — chỗ dễ tư vấn sai nhất ═══════════════
  {
    uuTien: 87,
    mauKhop:
      "(chai|loại|rượu) nào (là )?(ngon|tốt|hay|đỉnh) nhất" +
      "|(ngon|tốt) nhất (shop|cửa hàng|ở đây|bên mình)" +
      "|(rượu|vang) (nào|gì) (đắt|mắc|xịn) nhất",
    traLoi:
      "Dạ câu này em không dám trả lời gọn một chai ạ, vì **rượu ngon hay không phụ thuộc " +
      "vào khẩu vị và món ăn đi kèm** — chai được người này khen nhất lại không hợp người kia. 🍷\n\n" +
      "Để em gợi ý trúng, anh/chị cho em biết ba điều nhé:\n" +
      "1️⃣ **Uống dịp gì?** — bữa cơm hằng ngày, tiếp khách, hay làm quà?\n" +
      "2️⃣ **Ăn kèm món gì?** — món Việt, món Âu, hay uống không kèm đồ ăn?\n" +
      "3️⃣ **Tầm giá khoảng bao nhiêu?**\n\n" +
      "Anh/chị không cần biết trước giống nho hay vùng trồng đâu ạ, phần đó để em lo.",
    ghiChu:
      "Kịch bản QUAN TRỌNG. Đây đúng là chỗ bot các đợt trước bịa ra 'chai X " +
      "ngon nhất' kèm điểm số và niên vụ không có thật. Chặn cứng, và lái sang " +
      "ba câu hỏi để AI có đủ dữ kiện tra hàng thật ở lượt sau.",
  },
  {
    uuTien: 86,
    mauKhop:
      "(mấy|bao nhiêu) điểm (robert )?parker" +
      "|(điểm|chấm) (của )?(wine spectator|james suckling|decanter|vinous|wine advocate)" +
      "|(đạt|được) (giải|huy chương) (gì|nào)" +
      "|(niên vụ|vintage) nào (là )?(ngon|tốt|đẹp) nhất",
    traLoi:
      "Dạ điểm số của các nhà phê bình và giải thưởng thì **khác nhau theo từng niên vụ**, " +
      "em không dám đọc theo trí nhớ vì rất dễ nhầm ạ. 📋\n\n" +
      "Em chuyển anh/chị sang chuyên gia rượu vang của Red Apron — bên em tra đúng hồ sơ " +
      "của chai đó rồi trả lời chính xác cho anh/chị.\n\n" +
      `Hoặc anh/chị gọi tổng đài **${HOTLINE}** để được hỗ trợ ngay ạ.`,
    chuyenNguoi: true,
    ghiChu:
      "Bịa điểm Parker/Suckling là lỗi tư vấn nguy hiểm nhất của ngành rượu: " +
      "khách tra lại được ngay, và sai một điểm là mất uy tín cả shop.",
  },
  {
    uuTien: 85,
    mauKhop:
      "(định giá|thẩm định|xem giúp|đánh giá) (chai|rượu|giúp) (này|em|anh|tôi)" +
      "|chai (này|em đang có|nhà anh) (đáng |giá )?(bao nhiêu|khoảng bao nhiêu)" +
      "|(mua lại|thu mua|bán lại) (rượu|chai|vang)",
    traLoi:
      "Dạ Red Apron **không thẩm định và không thu mua lại rượu** ạ.\n\n" +
      "Giá một chai rượu phụ thuộc vào niên vụ, tình trạng bảo quản, nguồn gốc và " +
      "cả tem nhãn — không nhìn qua ảnh hay nghe mô tả mà kết luận được.\n\n" +
      "Em chuyển anh/chị sang nhân viên để được tư vấn thêm nhé ạ.",
    chuyenNguoi: true,
  },

  // ═══════════════ CHÍNH SÁCH ═══════════════
  {
    uuTien: 80,
    mauKhop:
      "(chính sách |quy định )?(đổi trả|đổi hàng|trả hàng|hoàn tiền|refund)" +
      "|(đổi|trả) (được )?(hàng|chai|rượu|sản phẩm) (không|trong|sau)" +
      "|(bao lâu|mấy ngày|thời hạn) (thì )?(được )?(đổi|trả)" +
      "|chai (bị )?(vỡ|nứt|rò rỉ|hỏng) (khi nhận|lúc giao)",
    traLoi:
      "Dạ **chính sách đổi trả của Red Apron** ạ: 📦\n\n" +
      "**Được đổi/hoàn tiền khi:**\n" +
      "• Giao sai sản phẩm hoặc sai số lượng\n" +
      "• Chai **vỡ, nứt, rò rỉ** trong quá trình vận chuyển\n" +
      "• Rượu **lỗi chất lượng** (nút bần hỏng, rượu bị oxy hoá — gọi là *corked*)\n\n" +
      "**Thời hạn:**\n" +
      "• Vỡ hoặc sai hàng: báo trong **24 giờ** kể từ khi nhận, kèm ảnh chụp kiện hàng\n" +
      "• Lỗi chất lượng rượu: trong **7 ngày**, chai còn ít nhất **3/4 dung tích** để kiểm định\n\n" +
      "**Không áp dụng:** chai đã khui/đã dùng (trừ lỗi chất lượng), hàng không mua tại Red Apron, " +
      "và trường hợp khách đổi ý về khẩu vị — rượu là mặt hàng cảm quan, mỗi người một gu ạ.\n\n" +
      "Lỗi thuộc về Red Apron thì **bên em chịu toàn bộ** chi phí đổi trả và vận chuyển.",
  },
  {
    uuTien: 80,
    mauKhop:
      "(phí|tiền|cước) (giao hàng|vận chuyển|ship)" +
      "|(giao hàng|vận chuyển) (mất |hết )?(bao lâu|bao nhiêu|mấy ngày)" +
      // ⚠️ Nơi nhận phải cho phép TÊN NHIỀU CHỮ.
      //
      // Bản đầu viết `[^ ]+` (đúng một từ) nên khớp "ship về Huế mất bao lâu"
      // nhưng TRƯỢT "ship về Nha Trang mất bao lâu" — và phần lớn địa danh
      // Việt Nam là hai chữ trở lên: Nha Trang, Hà Nội, Đà Nẵng, Hội An, Phú
      // Quốc, Cần Thơ, Hồ Chí Minh. Bot rơi xuống AI rồi chuyển nhân viên,
      // trong khi câu trả lời đã nằm sẵn ở đây. Bộ kiểm thử bắt được ca này.
      "|ship (về|đi|tới|đến) (\\S+ ){1,4}?(mất |hết )?(bao lâu|bao nhiêu|mấy ngày)" +
      "|(ship|giao hàng) (toàn quốc|tỉnh|xa)" +
      "|(có )?giao (hàng )?(tận nơi|tại nhà|trong ngày)",
    traLoi:
      "Dạ **giao hàng Red Apron** ạ: 🚚\n\n" +
      "• **Nội thành Hà Nội và TP. Hồ Chí Minh:** trong ngày hoặc ngày hôm sau\n" +
      "• **Các tỉnh thành khác:** 2 – 5 ngày làm việc\n" +
      "• Rượu được **đóng gói chống sốc**; đơn giá trị cao do nhân viên Red Apron giao trực tiếp\n\n" +
      "⚠️ Nhân viên giao hàng **có quyền yêu cầu giấy tờ tuỳ thân** và từ chối giao nếu " +
      "người nhận chưa đủ 18 tuổi ạ.\n\n" +
      "Anh/chị cho em biết địa chỉ nhận hàng để em báo phí và thời gian cụ thể nhé.",
  },
  {
    uuTien: 76,
    mauKhop:
      "(thanh toán|trả tiền|chuyển khoản) (thế nào|ra sao|kiểu gì|bằng cách nào|như thế nào)" +
      "|(hình thức|phương thức|cách) thanh toán" +
      "|(có )?(nhận|hỗ trợ) (thẻ|visa|momo|ví điện tử|cod|tiền mặt)",
    traLoi:
      "Dạ Red Apron nhận **các hình thức thanh toán** sau ạ: 💳\n\n" +
      "• **Tiền mặt khi nhận hàng (COD)**\n" +
      "• **Chuyển khoản ngân hàng**\n" +
      "• **Thẻ tín dụng / thẻ ghi nợ** tại cửa hàng\n" +
      "• **Ví điện tử**\n\n" +
      "Giá niêm yết **đã bao gồm thuế VAT**. Anh/chị cần xuất hoá đơn VAT thì báo em " +
      "thông tin doanh nghiệp lúc đặt hàng nhé ạ.",
  },
  {
    uuTien: 74,
    mauKhop:
      "(xuất |lấy |có )?(hoá đơn|hóa đơn) (đỏ|vat|gtgt)" +
      "|(xuất|lấy) (được )?(hoá đơn|hóa đơn)" +
      "|(bán sỉ|bán buôn|giá sỉ|số lượng lớn|nhà hàng|khách sạn) (không|được không|thế nào)",
    traLoi:
      "Dạ **có ạ**. Red Apron xuất **hoá đơn VAT điện tử** — anh/chị cung cấp thông tin " +
      "doanh nghiệp khi đặt hàng là được ạ. 🧾\n\n" +
      "Red Apron cũng **bán buôn cho nhà hàng, khách sạn và doanh nghiệp**, có báo giá riêng " +
      "và chương trình quà tặng doanh nghiệp.\n\n" +
      `Anh/chị gọi tổng đài **${HOTLINE}** hoặc để lại số điện thoại, bên em liên hệ báo giá ngay ạ.`,
  },
  {
    uuTien: 72,
    mauKhop:
      "(có )?(hàng |rượu |là )?(chính hãng|hàng thật|auth|authentic|nhập khẩu chính ngạch) (không|ko|chứ)" +
      "|(sợ|lo) (hàng |rượu )?(giả|nhái|fake|pha)" +
      "|(cam kết|đảm bảo) (hàng |rượu )?(chính hãng|thật)" +
      "|(có )?(tem|giấy tờ|chứng từ) (nhập khẩu|hải quan)",
    traLoi:
      "Dạ **100% rượu tại Red Apron là hàng nhập khẩu chính ngạch** ạ. 🛃\n\n" +
      "• Bên em làm việc **trực tiếp với nhà sản xuất và nhà phân phối được uỷ quyền**, " +
      "không mua qua thị trường thứ cấp\n" +
      "• Mỗi chai đều có **chứng từ nhập khẩu** và **tem nhãn phụ tiếng Việt** theo quy định\n" +
      "• Red Apron có **Giấy phép bán buôn rượu số 33/GP-SCT** do Sở Công Thương TP Hà Nội cấp\n\n" +
      "Anh/chị mua trực tiếp tại 16 cửa hàng hoặc trên website chính thức để đảm bảo nguồn gốc ạ.",
  },
  {
    uuTien: 70,
    mauKhop:
      "(shop|cửa hàng|chi nhánh|showroom|bên (mình|em)) (ở đâu|nào|gần|tại)" +
      "|(có )?(cửa hàng|chi nhánh) (ở |tại )?(hà nội|hồ chí minh|hcm|đà nẵng|sài gòn|nha trang|phú quốc|hội an)" +
      "|(địa chỉ|hệ thống) (cửa hàng|chi nhánh)",
    traLoi:
      "Dạ Red Apron có **16 cửa hàng** tại 6 tỉnh thành ạ: 📍\n\n" +
      "• **Hà Nội** — 8 cửa hàng (Ngọc Thuỵ, E05 Ciputra, 83 Linh Lang, 91 Xuân Diệu, " +
      "18 Yên Thế, 61 Lý Thái Tổ, 94 Xuân Diệu, 10 Dã Tượng)\n" +
      "• **TP. Hồ Chí Minh** — 4 cửa hàng (9A Thảo Điền, 85 Pasteur, 2 Chu Mạnh Trinh, 67 Hà Huy Tập)\n" +
      "• **Đà Nẵng** · **Hội An** · **Nha Trang** · **Phú Quốc** — mỗi nơi 1 cửa hàng\n\n" +
      "Địa chỉ chi tiết, số điện thoại và bản đồ từng cửa hàng có ở trang " +
      "**Hệ thống cửa hàng** trên website ạ.\n\n" +
      "Anh/chị ở khu vực nào để em chỉ cửa hàng gần nhất?",
  },
  {
    uuTien: 69,
    mauKhop:
      "(mấy giờ|giờ nào|lúc nào) (thì )?(mở cửa|đóng cửa)" +
      "|(giờ|thời gian) (mở cửa|đóng cửa|làm việc|hoạt động)" +
      "|(mở cửa|đóng cửa) (lúc |từ )?(mấy giờ|khi nào)" +
      "|(làm việc|hoạt động) (đến |tới )?(mấy giờ|chủ nhật|cuối tuần)",
    traLoi:
      "Dạ **giờ mở cửa** của các cửa hàng Red Apron thay đổi theo từng chi nhánh ạ. ⏰\n\n" +
      `Anh/chị gọi trực tiếp cửa hàng gần nhất, hoặc tổng đài **${HOTLINE}** để em xác nhận ` +
      "chính xác giờ hoạt động hôm nay nhé.\n\n" +
      "Website và khung chat này thì nhận đơn **24/7** ạ — anh/chị đặt lúc nào cũng được.",
    ghiChu:
      "KHÔNG viết cứng khung giờ. redapron.vn không công bố giờ mở cửa thống " +
      "nhất cho 16 cửa hàng, bịa ra là khách tới nơi thấy đóng.",
  },
  {
    uuTien: 68,
    mauKhop:
      "(đặt|mua) hàng (thế nào|ra sao|kiểu gì|như thế nào|ở đâu)" +
      "|(cách|hướng dẫn) (đặt|mua) hàng" +
      "|làm sao để (đặt|mua)",
    traLoi:
      "Dạ anh/chị **đặt hàng** theo 3 cách ạ: 🛒\n\n" +
      "1️⃣ **Ngay trong khung chat này** — anh/chị nói tên rượu và số lượng, em tra hàng, " +
      "báo giá rồi lên đơn giúp\n" +
      `2️⃣ **Gọi tổng đài ${HOTLINE}**\n` +
      "3️⃣ **Ghé trực tiếp** một trong 16 cửa hàng Red Apron\n\n" +
      "Đơn hàng được xác lập sau khi bên em xác nhận qua điện thoại hoặc email ạ.\n\n" +
      "⚠️ Red Apron chỉ bán cho khách **từ 18 tuổi trở lên**.",
  },
  {
    uuTien: 66,
    mauKhop:
      "(tra cứu|kiểm tra|tra|check|xem) (tình trạng |trạng thái )?(đơn hàng|đơn|order)" +
      "|(đơn hàng|đơn) (của (anh|chị|tôi|em) )?(tới đâu|đến đâu|giao chưa|đâu rồi)" +
      "|(khi nào|bao giờ) (thì )?(nhận|giao) (được )?(hàng|đơn)",
    traLoi:
      "Dạ em **kiểm tra đơn hàng** giúp anh/chị ngay ạ. 🔎\n\n" +
      "Anh/chị cho em xin **mã đơn hàng** hoặc **số điện thoại đặt hàng** nhé.\n\n" +
      `Hoặc gọi tổng đài **${HOTLINE}** để được tra nhanh hơn ạ.`,
  },
  {
    uuTien: 67,
    mauKhop:
      "(giảm|bớt) (giá |tiền )?(cho|được|chút|thêm|nữa)" +
      "|(mặc cả|trả giá|deal giá)" +
      "|(có )?(giảm|bớt) (thêm )?(được )?(không|ko)",
    traLoi:
      "Dạ giá trên website là **giá niêm yết đã bao gồm VAT**, bên em không giảm thêm ngoài " +
      "chương trình đang chạy ạ. 🙏\n\n" +
      "Nhưng anh/chị có thể dùng:\n" +
      "• Mã **RA15%OFF** cho đơn hàng đầu tiên — giảm tối đa **300.000đ**, đơn tối thiểu **1.500.000đ**\n" +
      "• Các chương trình khuyến mại rượu vang đang chạy trên website\n\n" +
      "Với đơn **số lượng lớn hoặc mua buôn**, bên em có báo giá riêng — anh/chị để lại số " +
      "điện thoại để nhân viên liên hệ nhé ạ.",
    ghiChu:
      "Mã và mức giảm lấy từ khối coupon thật trên trang chủ redapron.vn. Đổi " +
      "chương trình thì sửa cả ở đây và ở redapron-theme.json.",
  },
  {
    uuTien: 64,
    mauKhop:
      "(bảo quản|cất|để) (rượu|vang|chai) (thế nào|ra sao|ở đâu|như thế nào)" +
      "|(chưa có|không có) (tủ rượu|tủ bảo quản)" +
      "|(rượu|vang) (để|giữ) (được )?(bao lâu|mấy năm)",
    traLoi:
      "Dạ **bảo quản rượu vang ở Việt Nam** ạ, bốn điều theo thứ tự quan trọng: 🌡️\n\n" +
      "1️⃣ **Nhiệt độ ổn định** quan trọng hơn nhiệt độ thấp — 22°C không đổi vẫn tốt hơn " +
      "18–28°C dao động mỗi ngày\n" +
      "2️⃣ **Tránh ánh sáng** — tia UV phá cấu trúc rượu\n" +
      "3️⃣ **Đặt nằm ngang** với chai nút bần, để nút luôn tiếp xúc rượu\n" +
      "4️⃣ **Độ ẩm 60–80%**\n\n" +
      "❌ Không để **trên nóc tủ lạnh** (nóng + rung), cạnh bếp, hay cạnh cửa sổ hướng tây.\n\n" +
      "Chưa có tủ rượu thì **ngăn dưới cùng tủ quần áo trong phòng máy lạnh** là đủ tốt ạ. " +
      "Anh/chị đọc thêm bài *Bảo quản rượu vang trong khí hậu nóng ẩm* trên blog của bên em nhé.",
  },
  {
    uuTien: 63,
    mauKhop:
      "(khoá|khóa|lớp) học (rượu|vang|wine)" +
      "|wine school" +
      "|(học|tìm hiểu) (về )?(rượu vang|vang) (ở đâu|thế nào)",
    traLoi:
      "Dạ Red Apron có **Red Apron Wine School** ạ — các khoá học có lộ trình từ nhập môn " +
      "tới chuyên sâu, dành cho cả người yêu rượu lẫn người làm nghề. 🎓\n\n" +
      "Anh/chị xem lịch khai giảng và đăng ký tại **wineschool.redapron.vn** ạ.\n\n" +
      "Ngoài ra bên em còn tổ chức **tiệc thử vang** cùng các nhà rượu quốc tế tại nhà hàng " +
      "và khách sạn trên cả nước — anh/chị để lại email để nhận thư mời nhé.",
  },
  {
    uuTien: 62,
    mauKhop:
      "(lừa đảo|scam|giả mạo) (red apron)?" +
      "|(có phải|đúng là) (kênh|trang|page|web) (chính thức|của red apron)" +
      "|(ai đó|người lạ) (gọi|nhắn) (nói|bảo) (là )?red apron",
    traLoi:
      "Dạ anh/chị cẩn thận giúp em ạ. ⚠️\n\n" +
      "Kênh **chính thức duy nhất** của Red Apron:\n" +
      `• Tổng đài: **${HOTLINE}**\n` +
      "• Email: **info@redapron.vn**\n" +
      "• Website chính thức và 16 cửa hàng trong hệ thống\n\n" +
      "Red Apron **không bao giờ** yêu cầu khách chuyển tiền vào tài khoản cá nhân, " +
      "không yêu cầu cung cấp mã OTP, và không nhờ khách tải ứng dụng lạ.\n\n" +
      "Anh/chị nghi ngờ thì gọi thẳng tổng đài để bên em xác minh ạ.",
  },
  {
    uuTien: 60,
    mauKhop: "^\\s*(cảm ơn|cám ơn|thanks|thank you|tks|ok cảm ơn)\\y",
    traLoi:
      "Dạ em cảm ơn anh/chị ạ! 🍷\n\n" +
      "Anh/chị cần tư vấn thêm về rượu vang hay muốn đặt hàng thì nhắn em bất cứ lúc nào nhé.\n\n" +
      `Chúc anh/chị có những ly rượu ngon! Tổng đài **${HOTLINE}** luôn sẵn sàng hỗ trợ ạ.`,
  },
];

/**
 * TÀI LIỆU cho tìm kiếm ngữ nghĩa (RAG).
 *
 * Khác kịch bản cứng ở chỗ: kịch bản trả nguyên văn khi khớp mẫu, còn tài liệu
 * được cắt đoạn, tạo vector, rồi AI đọc để tự soạn câu trả lời. Dùng cho những
 * thứ khách hỏi trăm kiểu khác nhau mà không viết hết mẫu khớp được — nhất là
 * phần tư vấn kết hợp món ăn và kiến thức rượu.
 *
 * ⚠️ TUYỆT ĐỐI KHÔNG đưa GIÁ, NIÊN VỤ hay ĐIỂM SỐ vào đây. Vector không có
 * hạn dùng: một con số viết hôm nay sẽ được AI đọc lại và nói với khách sau
 * sáu tháng, lúc giá đã đổi. Giá và tồn kho luôn tra thời gian thực từ Medusa.
 */
export const TAI_LIEU: TaiLieu[] = [
  {
    ten: "Giới thiệu Red Apron và hệ thống 16 cửa hàng",
    noiDung: `Red Apron Fine Wines & Spirits là chuỗi cửa hàng rượu vang nhập khẩu tại Việt Nam, với 16 cửa hàng ở sáu tỉnh thành: Hà Nội (8 cửa hàng), Thành phố Hồ Chí Minh (4 cửa hàng), Đà Nẵng, Hội An, Nha Trang và Phú Quốc.

Danh mục có hơn 3.000 dòng rượu, từ vang uống hằng ngày tới Bordeaux Grand Cru Classé và Bourgogne Premier Cru. Toàn bộ hàng hoá nhập khẩu chính ngạch, có đầy đủ chứng từ và tem nhãn phụ tiếng Việt.

Red Apron làm việc trực tiếp với nhà sản xuất và nhà nhập khẩu được uỷ quyền, không mua qua thị trường thứ cấp. Mỗi dòng rượu vào danh mục đều được đội ngũ chuyên gia nếm thử và đánh giá trước.

Ngoài bán lẻ, Red Apron tổ chức tiệc thử vang cùng các nhà rượu quốc tế tại khách sạn và nhà hàng trên khắp cả nước, và vận hành Red Apron Wine School đào tạo kiến thức rượu vang cho người mới bắt đầu lẫn người làm nghề.

Trụ sở: số 91 Xuân Diệu, Tây Hồ, Hà Nội. Tổng đài ${HOTLINE}. Email info@redapron.vn.

Giấy ĐKKD số 0105228065 do Sở Kế hoạch và Đầu tư thành phố Hà Nội cấp lần đầu ngày 30/03/2011. Giấy phép bán buôn rượu số 33/GP-SCT ngày 17/04/2024 do Sở Công Thương TP Hà Nội cấp.

Địa chỉ các cửa hàng Hà Nội: 36 Gia Thượng Bồ Đề; E05 Khu đô thị Ciputra Tây Hồ; 83 Linh Lang Giảng Võ; 91 Xuân Diệu Tây Hồ; 18 Yên Thế Văn Miếu Quốc Tử Giám (showroom); 61 Lý Thái Tổ Hoàn Kiếm; 94 Xuân Diệu Tây Hồ; 10 Dã Tượng Cửa Nam.

Địa chỉ các cửa hàng Thành phố Hồ Chí Minh: 9A Thảo Điền An Khánh; 85 Pasteur Sài Gòn; 2 Chu Mạnh Trinh Sài Gòn; 67 Hà Huy Tập Tân Hưng.

Đà Nẵng: 46 Phan Châu Trinh Hải Châu. Hội An: 69 Trần Hưng Đạo. Nha Trang: 126A Hồng Bàng. Phú Quốc: 213 Nguyễn Trung Trực.`,
  },
  {
    ten: "Nhóm sản phẩm đang bán",
    noiDung: `Red Apron phân loại hàng theo năm cách để khách dễ tìm.

Theo loại rượu: rượu vang đỏ, rượu vang trắng, rượu vang hồng, Champagne, rượu vang nổ, rượu vang ngọt, rượu vang cam, rượu vang cường hoá, rượu vang không cồn, rượu vang xanh.

Theo quốc gia: Pháp, Ý, Chile, Tây Ban Nha, Mỹ, Úc, Argentina, New Zealand, Đức, Nam Phi, Hungary, Bồ Đào Nha, Áo.

Theo giống nho: Cabernet Sauvignon, Merlot, Pinot Noir, Syrah hay Shiraz, Sauvignon Blanc, Chardonnay, Pinot Gris hay Pinot Grigio, Riesling, Chenin Blanc, Malbec, Primitivo, Sangiovese, Zinfandel, Barbera, Negroamaro, Moscato.

Theo vùng rượu: Bordeaux chia bờ trái (Médoc, Pauillac, Margaux, Saint-Julien, Saint-Estèphe, Graves, Pessac-Léognan, Sauternes và Barsac) và bờ phải (Saint-Émilion, Pomerol, Lalande de Pomerol). Bourgogne gồm Chablis, Côte de Nuits, Côte de Beaune, Côte Chalonnaise, Maconnais. Vùng khác của Pháp: Rhône Valley, Loire Valley, Alsace, Languedoc Roussillon. Vùng của Ý: Tuscany, Piedmonte, Sicilia, Veneto, Puglia, Alto Adige.

Rượu mạnh: whisky, cognac, rhum, calvados, grappa, vermouth, rượu mùi.

Quà tặng: hộp quà, set quà rượu vang, giỏ quà Tết, combo rượu vang, e-gift voucher.

Theo tầm giá: dưới 500.000đ; từ 500.000đ đến 1.000.000đ; từ 1.000.000đ đến 3.000.000đ; từ 3.000.000đ đến 10.000.000đ; trên 10.000.000đ.

Giá cụ thể của từng chai phải tra thời gian thực trong hệ thống, không đọc theo trí nhớ.`,
  },
  {
    ten: "Tư vấn chọn rượu theo dịp và ngân sách",
    noiDung: `Nguyên tắc tư vấn của Red Apron: hỏi trước khi gợi ý. Ba câu hỏi giúp chọn trúng là uống dịp gì, ăn kèm món gì, và ngân sách khoảng bao nhiêu. Khách không cần biết trước giống nho hay vùng trồng.

Người mới uống vang nên bắt đầu từ vang đỏ nhẹ như Pinot Noir hoặc Merlot, hoặc vang trắng thơm như Sauvignon Blanc. Các dòng này ít tannin, dễ uống, không cần thời gian làm quen.

Rượu đắt hơn không có nghĩa là hợp khẩu vị hơn. Giá phản ánh độ hiếm, danh tiếng vùng trồng và chi phí sản xuất. Nhiều chai tầm dưới một triệu đồng phù hợp với bữa ăn hằng ngày hơn hẳn chai gấp ba lần giá đó.

Chọn quà tặng nên cân nhắc người nhận có uống rượu thường xuyên không. Người mới thì chọn dòng dễ uống hoặc hộp quà có nhiều loại để thử; người sành thì chọn theo vùng hoặc nhà rượu mà họ thích.

Uống một mình hoặc hai người nên cân nhắc chai 375ml hoặc vang có nút vặn, vì chai 750ml đã khui thì nên uống trong 2 đến 3 ngày.

Tiệc đông người nên ưu tiên vang nổ hoặc vang trắng dễ uống làm khai vị, rồi mới tới vang đỏ cho món chính.

Không bao giờ khẳng định một chai là ngon nhất. Khẩu vị là chủ quan, và câu đó biến mọi chai khác trong danh mục thành hàng kém.`,
  },
  {
    ten: "Kết hợp rượu vang với món ăn Việt",
    noiDung: `Món Việt có ba thứ khiến nhiều chai rượu không hợp: vị mặn của nước mắm, rau thơm sống, và độ cay. Cả ba đều xử lý được.

Nguyên tắc chung. Món cay thì chọn rượu có độ cồn thấp, vì cồn khuếch đại cảm giác cay: chai 12,5 độ dễ chịu hơn hẳn chai 15 độ khi ăn lẩu Thái hay bún bò. Món mặn thì chọn rượu có độ chua cao để rửa sạch vị mặn của nước mắm, như Sauvignon Blanc, Riesling khô hoặc Champagne. Món nhiều rau thơm hợp với vang có nốt xanh như Sauvignon Blanc vùng Loire hoặc New Zealand.

Các cặp đôi cụ thể. Gỏi cuốn tôm thịt hợp Sauvignon Blanc. Phở bò hợp Pinot Noir nhẹ phục vụ mát khoảng 14 độ C. Bánh xèo hợp Champagne hoặc vang nổ khô, vì bọt khí và độ chua làm sạch dầu chiên. Cá kho tộ hợp Chardonnay ủ thùng nhẹ hoặc vang đỏ Grenache. Bún chả hợp Riesling bán khô. Bò lúc lắc và bít tết hợp Bordeaux bờ trái hoặc Cabernet Sauvignon. Món tráng miệng ngọt hợp vang ngọt Sauternes hoặc Moscato, với quy tắc bất di bất dịch là rượu phải ngọt hơn món tráng miệng.

Điều nên tránh: đừng ép vang đỏ đậm nhiều tannin vào mâm cơm có nước mắm. Tannin gặp muối sẽ trở nên kim loại và đắng.`,
  },
  {
    ten: "Nhiệt độ phục vụ và cách rót",
    noiDung: `Cùng một chai rượu, lệch 6 độ C là ra hai thứ khác nhau. Đây là cách rẻ nhất để một chai rượu ngon hơn.

Nhiệt độ phục vụ. Champagne và vang nổ 6 đến 8 độ C. Vang trắng nhẹ như Sauvignon Blanc hay Pinot Grigio 8 đến 10 độ C. Vang trắng đậm như Chardonnay ủ thùng 10 đến 12 độ C. Vang hồng 8 đến 10 độ C. Vang đỏ nhẹ như Pinot Noir hay Beaujolais 13 đến 15 độ C. Vang đỏ đậm như Bordeaux, Barolo, Cabernet 16 đến 18 độ C. Vang ngọt 6 đến 8 độ C.

Vì sao ở Việt Nam hay sai: nhiệt độ phòng trong sách rượu là nhiệt độ phòng châu Âu, khoảng 18 độ C, trong khi phòng khách ở Hà Nội hay Thành phố Hồ Chí Minh thường 27 đến 30 độ C. Rót vang đỏ ở nhiệt độ đó thì cồn bốc lên trước, hương quả biến mất, rượu có vị nóng ở cuống họng. Cách chữa nhanh là bỏ chai vang đỏ vào ngăn mát 20 phút trước khi rót, không lâu hơn vì lạnh quá thì tannin trở nên khô và chát gắt.

Vang trắng và Champagne thì ngược lại: đừng rót ngay khi vừa lấy khỏi tủ 4 độ C, để ngoài 5 đến 10 phút cho hương mở ra.

Xô đá phải có cả nước đá và nước lạnh, không phải chỉ đá khô. Hỗn hợp nước và đá bọc kín toàn bộ thân chai và làm lạnh nhanh gấp đôi.`,
  },
  {
    ten: "Chính sách mua hàng, thanh toán và giao nhận",
    noiDung: `Điều kiện mua hàng. Theo Luật Phòng, chống tác hại của rượu, bia 2019, Red Apron chỉ bán rượu cho người đủ 18 tuổi trở lên. Nhân viên giao hàng có quyền yêu cầu xuất trình giấy tờ tuỳ thân và từ chối giao hàng nếu người nhận chưa đủ tuổi.

Cách đặt hàng: đặt trực tuyến trên website, gọi tổng đài ${HOTLINE}, hoặc mua trực tiếp tại 16 cửa hàng. Đơn hàng chỉ được xác lập sau khi Red Apron xác nhận qua điện thoại hoặc email.

Hình thức thanh toán: tiền mặt khi nhận hàng, chuyển khoản ngân hàng, thẻ tín dụng và thẻ ghi nợ tại cửa hàng, ví điện tử.

Giá bán niêm yết trên website đã bao gồm thuế giá trị gia tăng, tính bằng đồng Việt Nam. Giá có thể thay đổi theo tỷ giá và chính sách nhà cung cấp; giá áp dụng là giá tại thời điểm Red Apron xác nhận đơn hàng.

Giao hàng: nội thành Hà Nội và Thành phố Hồ Chí Minh trong ngày hoặc ngày hôm sau; các tỉnh thành khác 2 đến 5 ngày làm việc. Rượu được đóng gói chống sốc, đơn hàng giá trị cao do nhân viên Red Apron giao trực tiếp.

Red Apron có quyền từ chối hoặc huỷ đơn khi không liên hệ được với khách để xác nhận, khi người nhận chưa đủ 18 tuổi, khi sản phẩm hết hàng tại thời điểm đóng gói, hoặc khi có dấu hiệu gian lận.

Hoá đơn VAT điện tử được xuất khi khách cung cấp thông tin doanh nghiệp lúc đặt hàng. Red Apron cũng bán buôn cho nhà hàng, khách sạn và doanh nghiệp, có báo giá riêng.`,
  },
  {
    ten: "Chính sách đổi trả",
    noiDung: `Red Apron nhận đổi hoặc hoàn tiền trong ba trường hợp: giao sai sản phẩm hoặc sai số lượng so với đơn đặt; chai vỡ, nứt, rò rỉ hoặc hư hỏng trong quá trình vận chuyển; rượu bị lỗi chất lượng như nút bần hỏng hoặc rượu bị oxy hoá, thường gọi là corked.

Thời hạn báo. Với chai vỡ hoặc giao sai hàng, khách báo trong 24 giờ kể từ khi nhận, kèm ảnh chụp tình trạng kiện hàng. Với lỗi chất lượng rượu, khách báo trong 7 ngày và chai phải còn ít nhất ba phần tư dung tích để kiểm định.

Không áp dụng đổi trả với chai đã khui hoặc đã sử dụng, trừ trường hợp lỗi chất lượng nêu trên; sản phẩm không mua tại Red Apron; khách đổi ý về khẩu vị, vì rượu vang là mặt hàng cảm quan và mỗi người một gu; hàng khuyến mãi có ghi rõ không đổi trả.

Quy trình: gọi tổng đài ${HOTLINE} hoặc gửi email tới info@redapron.vn, cung cấp mã đơn hàng và ảnh chụp sản phẩm. Red Apron phản hồi trong 24 giờ làm việc. Được chấp nhận thì đổi chai mới hoặc hoàn tiền trong 3 đến 7 ngày làm việc.

Lỗi thuộc về Red Apron thì Red Apron chịu toàn bộ chi phí đổi trả và vận chuyển.`,
  },
  {
    ten: "Quy định pháp lý về rượu mà nhân viên và bot phải tuân thủ",
    noiDung: `Không bán và không tư vấn bán rượu cho người dưới 18 tuổi. Đây là quy định của Luật Phòng, chống tác hại của rượu, bia 2019. Khi khách cho biết mình chưa đủ 18 tuổi hoặc mua hộ cho người chưa đủ tuổi, phải từ chối và không chuyển tiếp cho nhân viên bán hàng.

Không đưa ra bất kỳ công bố nào về tác dụng chữa bệnh, bồi bổ sức khoẻ, chống lão hoá hay kéo dài tuổi thọ của rượu. Rượu là đồ uống có cồn, không phải thực phẩm chức năng, không phải thuốc.

Không tư vấn cho phụ nữ mang thai, phụ nữ đang cho con bú, người đang dùng thuốc hoặc có bệnh nền về việc uống rượu. Chuyển sang khuyên hỏi ý kiến bác sĩ.

Việt Nam áp dụng quy định nồng độ cồn bằng không khi điều khiển phương tiện giao thông. Đã uống rượu bia thì không lái xe, không có ngưỡng an toàn nào. Không trả lời câu hỏi kiểu uống bao nhiêu thì không bị phạt.

Không thẩm định, không định giá và không thu mua lại rượu của khách.

Không đọc điểm số của nhà phê bình như Robert Parker, Wine Spectator, James Suckling, Decanter theo trí nhớ; điểm số khác nhau theo từng niên vụ và sai một điểm là mất uy tín. Chuyển sang chuyên gia để tra hồ sơ chính xác.`,
  },
];
