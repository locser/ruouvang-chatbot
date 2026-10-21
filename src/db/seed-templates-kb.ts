import { pool, runCentralAdmin } from "./client";
import { taoVectorEmbedding } from "../services/embedding";

async function seedTemplatesKnowledgeBase() {
  console.log("🚀 Seeding SaaS Chatbot AI Knowledge Base for Coolmate, Yody, Hasaki...");

  const tenantId = "da97c3f1-41d7-4ef7-9e4e-adefca37c665";
  const docId = "00000000-0000-0000-0000-000000000003";

  await runCentralAdmin(async (client) => {
    // 1. Ensure Document Metadata exists
    await client.query(
      `INSERT INTO kb_document (id, tenant_id, ten_file, loai, kich_thuoc, checksum, trang_thai)
       VALUES ($1, $2, 'Templates_Coolmate_Yody_Hasaki_KB.csv', 'csv', 1024, 'templates_checksum', 'da_xu_ly')
       ON CONFLICT (id) DO UPDATE SET trang_thai = 'da_xu_ly'`,
      [docId, tenantId]
    );

    // 2. Clear old template chunks if any
    await client.query("DELETE FROM kb_chunk WHERE document_id = $1", [docId]);

    // 3. Define KB Chunks
    const kbItems = [
      // ── COOLMATE D2C ──
      "Sản phẩm Áo thun Nam Coolmate Cotton Compact Premium có giá bán là 199.000đ (giá gốc 250.000đ), thuộc danh mục Áo thun nam. Thông tin chi tiết: 100% Cotton Compact cao cấp, mềm mịn, thấm hút mồ hôi vượt trội, công nghệ may chống nhão cổ.",
      "Sản phẩm Quần Lót Nam Trunk Excool Kháng Khuẩn có giá bán là 99.000đ (giá gốc 130.000đ), thuộc danh mục Đồ lót nam. Thông tin chi tiết: Công nghệ sợi Excool làm mát nhanh, mỏng nhẹ 0.1mm, mạ ion bạc khử mùi và kháng khuẩn 99.9%.",
      "Sản phẩm Áo Polo Nam Coolmate Ultra-Cool Thể Thao có giá bán là 269.000đ (giá gốc 350.000đ), thuộc danh mục Polo nam. Thông tin chi tiết: Phom Slim-fit, vải Pima dệt phối Spandex co giãn 4 chiều, cổ bo dệt chống quăn gấp.",
      "Sản phẩm Tủ Đồ Nam Giới Daily Capsule Combo (5 Món) có giá bán là 699.000đ (giá gốc 930.000đ). Thông tin chi tiết: Combo gồm 2 Áo thun Cotton Compact + 2 Quần lót Trunk Excool + 1 Đôi tất Bamboo. Tiết kiệm 25% giá lẻ.",
      "Chính sách dịch vụ D2C Coolmate: Đổi trả 60 ngày miễn phí 100% tận nhà mà không cần lý do. Shipper Coolmate sẽ đến tận nơi mang sản phẩm mới tới đổi cho khách hàng hoàn toàn miễn phí.",

      // ── YODY OMNICHANNEL ──
      "Sản phẩm Áo Polo Nam Yody Pique Mắt Chim Thoáng Mát có giá bán là 299.000đ (giá gốc 399.000đ), thuộc danh mục Polo Nam Yody. Thông tin chi tiết: Chất liệu vải Pique hiệu ứng mắt chim độc quyền, giữ phom chuẩn đẹp, thoáng khí, chống nhăn tự nhiên.",
      "Sản phẩm Bộ Đồ Gia Đình Yody Joyful Days (Set Bố Mẹ Bé) có giá bán là 799.000đ (giá gốc 1.100.000đ), thuộc danh mục Đồng phục Gia đình. Thông tin chi tiết: Chất liệu Cotton 100% tự nhiên co giãn, thiết kế năng động thích hợp đi du lịch.",
      "Sản phẩm Quần Jeans Nam Yody Flex Co Giãn Thoải Mái có giá bán là 499.000đ (giá gốc 650.000đ). Thông tin chi tiết: Công nghệ Yody Flex đàn hồi siêu việt, đứng ngồi vận động cực kỳ êm ái, màu xanh denim bền đẹp.",
      "Sản phẩm Áo Chống Nắng Trẻ Em Yody Smart-Sun SPF50+ có giá bán là 239.000đ (giá gốc 320.000đ). Thông tin chi tiết: Mũ trùm rộng và xỏ ngón, cản 98% tia UV bảo vệ làn da bé.",
      "Mạng lưới Yody Omnichannel: Hơn 250 cửa hàng trên toàn quốc (Hồ Chí Minh, Hà Nội, Đà Nẵng, Hải Phòng...). Hỗ trợ kiểm tra tồn kho tại shop, giữ hàng 24h và đổi trả chéo 15 ngày tại mọi chi nhánh.",

      // ── HASAKI BEAUTY ──
      "Sản phẩm Kem Chống Nắng La Roche-Posay Anthelios UVmune 400 SPF50+ 50ml có giá bán là 465.000đ (giá gốc 535.000đ), thuộc danh mục Kem chống nắng. Thông tin chi tiết: Màng lọc Mexoryl 400 độc quyền chống tia UVA dài, kiểm soát dầu 12h, không gây vệt trắng.",
      "Sản phẩm Nước Tẩy Trang Bioderma Sensibio H2O Nắp Hồng 500ml có giá bán là 425.000đ (giá gốc 520.000đ), thuộc danh mục Tẩy trang. Thông tin chi tiết: Công nghệ Micellar làm sạch 99% makeup và bụi mịn cho da nhạy cảm.",
      "Sản phẩm Serum Skin1004 Madagascar Centella Ampoule Rau Má 100ml có giá bán là 385.000đ (giá gốc 470.000đ), thuộc danh mục Tinh chất phục hồi da. Thông tin chi tiết: 100% chiết xuất rau má Madagascar tinh khiết kháng viêm dịu da mụn.",
      "Cam kết dịch vụ Hasaki Beauty: Cam kết 100% hàng chính hãng có tem phụ tiếng Việt, đền 200% nếu phát hiện hàng giả. Dịch vụ giao hàng siêu tốc NowFree 2 Giờ tự vận hành tại HCM và Hà Nội. Hasaki Clinic & Spa cung cấp liệu trình chẩn đoán da và lấy nhân mụn y khoa."
    ];

    console.log(`Generating embeddings and inserting ${kbItems.length} knowledge chunks...`);

    for (let i = 0; i < kbItems.length; i++) {
      const text = kbItems[i];
      const embedding = await taoVectorEmbedding(text);
      await client.query(
        `INSERT INTO kb_chunk (tenant_id, document_id, noi_dung, embedding, meta)
         VALUES ($1, $2, $3, $4::vector, $5)`,
        [tenantId, docId, text, JSON.stringify(embedding), JSON.stringify({ template_index: i })]
      );
    }

    console.log("✅ Successfully seeded AI Knowledge Base Chunks into chatbot_saas_dev!");
  });

  await pool.end();
}

seedTemplatesKnowledgeBase().catch((err) => {
  console.error("❌ Failed to seed templates KB:", err);
  process.exit(1);
});
