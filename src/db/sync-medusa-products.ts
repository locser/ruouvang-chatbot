import { pool, runCentralAdmin } from "./client";
import { taoVectorEmbedding } from "../services/embedding";
import { Pool } from "pg";

async function syncMedusaProducts() {
  console.log("Starting Medusa products synchronization...");

  // Medusa database is running on port 5432 on localhost
  const medusaPool = new Pool({
    connectionString: "postgres://postgres:REPLACE_WITH_NEW_SECRET@localhost:5432/medusa",
  });

  try {
    const medusaClient = await medusaPool.connect();
    console.log("Connected to Medusa database successfully!");

    // Query active products, variants, SKUs and VND prices
    const query = `
      SELECT 
        p.title AS product_title,
        p.handle AS product_handle,
        p.description AS product_description,
        v.title AS variant_title,
        v.sku AS variant_sku,
        pr.amount AS price_amount
      FROM product p
      JOIN product_variant v ON v.product_id = p.id
      LEFT JOIN product_variant_price_set pvps ON pvps.variant_id = v.id
      LEFT JOIN price pr ON pr.price_set_id = pvps.price_set_id AND pr.currency_code = 'vnd'
    `;

    const res = await medusaClient.query(query);
    const products = res.rows;
    console.log(`Fetched ${products.length} products/variants from Medusa.`);

    const tenantId = "da97c3f1-41d7-4ef7-9e4e-adefca37c665";
    const docId = "00000000-0000-0000-0000-000000000003"; // Synced document identifier

    await runCentralAdmin(async (chatbotClient) => {
      // 1. Clean old synced document metadata and chunks
      console.log("Cleaning old synced product data...");
      await chatbotClient.query("DELETE FROM kb_document WHERE id = $1", [docId]);

      // 2. Insert kb_document
      await chatbotClient.query(
        `INSERT INTO kb_document (id, tenant_id, ten_file, loai, kich_thuoc, checksum, trang_thai)
         VALUES ($1, $2, 'medusa_synced_products', 'sync', 0, 'sync_checksum', 'da_xu_ly')`,
        [docId, tenantId]
      );

      // 3. Loop through variants, format text description, generate vector embedding and insert
      let count = 0;
      for (const prod of products) {
        let text = `Sản phẩm "${prod.product_title}"`;
        if (prod.variant_title && prod.variant_title !== "Default Variant") {
          text += ` phân loại "${prod.variant_title}"`;
        }
        if (prod.price_amount) {
          // Format price beautifully (e.g. 290.000đ)
          const formattedPrice = Number(prod.price_amount).toLocaleString("vi-VN");
          text += ` có giá bán là ${formattedPrice}đ`;
        }
        if (prod.variant_sku) {
          text += `. Mã sản phẩm (SKU): ${prod.variant_sku}`;
        }
        if (prod.product_description) {
          text += `. Mô tả sản phẩm: ${prod.product_description}`;
        }

        const embedding = await taoVectorEmbedding(text);

        await chatbotClient.query(
          `INSERT INTO kb_chunk (tenant_id, document_id, noi_dung, embedding, meta)
           VALUES ($1, $2, $3, $4::vector, $5)`,
          [
            tenantId,
            docId,
            text,
            JSON.stringify(embedding),
            JSON.stringify({ sku: prod.variant_sku, handle: prod.product_handle }),
          ]
        );
        count++;
        if (count % 10 === 0) {
          console.log(`Embedded ${count}/${products.length} products...`);
        }
      }
      console.log(`Successfully synchronized and embedded ${count} Medusa products/variants.`);
    });

    medusaClient.release();
  } catch (error) {
    console.error("Failed to sync Medusa products:", error);
  } finally {
    await medusaPool.end();
    await pool.end();
  }
}

if (require.main === module) {
  syncMedusaProducts().catch(console.error);
}

export { syncMedusaProducts };
