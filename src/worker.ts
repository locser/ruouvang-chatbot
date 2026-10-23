import { Worker, Job } from "bullmq";
import { runInTenantContext } from "./db/client";
import { env } from "./config/env";
import { taoVectorEmbedding } from "./services/embedding";
import { INJECTION_PATTERNS, scanInjection } from "./services/knowledgeIngest";

// Tiêm lệnh: mẫu nằm ở knowledgeIngest để test được mà không khởi động worker.
export const MAU_TIEM_LENH = INJECTION_PATTERNS;
export const quetTiemLenh = scanInjection;

// Stub for virus scanner (e.g. ClamAV integration)
async function quetVirus(s3Key: string): Promise<boolean> {
  console.log(`[VirusScan] Scanning file ${s3Key} for malware...`);
  await new Promise((resolve) => setTimeout(resolve, 500)); // Simulate IO latency
  return true; // Clean
}

// Simple sliding window text splitter
function chiaKhuc(text: string, size: number = 500, overlap: number = 50): string[] {
  const words = text.split(/\s+/);
  const chunks: string[] = [];
  
  let i = 0;
  while (i < words.length) {
    const chunkWords = words.slice(i, i + size);
    if (chunkWords.length === 0) break;
    chunks.push(chunkWords.join(" "));
    i += size - overlap;
  }
  
  return chunks;
}

// The Worker Ingest Job Handler
const worker = new Worker("kb-ingest", async (job: Job) => {
  const { tenantId, documentId, filename, s3Key, content } = job.data;
  console.log(`[IngestWorker] Started processing document ${documentId} (${filename}) for tenant ${tenantId}...`);

  await job.updateProgress(10);
  const scanOk = await quetVirus(s3Key);
  if (!scanOk) {
    throw new Error(`Virus scanner flagged document: ${filename}`);
  }

  await job.updateProgress(25);
  // Check for prompt injection keywords
  const flags = quetTiemLenh(content);
  
  await runInTenantContext(tenantId, async (client) => {
    // If prompt injection is found, flag the document but don't crash yet, let admin review
    if (flags.length > 0) {
      console.warn(`[IngestWorker] WARNING: Prompt injection detected in document: ${filename}`);
      await client.query(
        `UPDATE kb_document 
         SET trang_thai = 'nghi_tiem_lenh', loi = $1 
         WHERE id = $2`,
        [JSON.stringify(flags), documentId]
      );
      return;
    }

    await job.updateProgress(50);

    // CSV/XLSX đã được đổi thành dòng chữ ở bước trích xuất, nên cùng đường chia khúc.
    const chunks = chiaKhuc(content, 500, 50);
    for (let i = 0; i < chunks.length; i++) {
      const text = chunks[i];
      const emb = await taoVectorEmbedding(text);

      await client.query(
        `INSERT INTO kb_chunk (tenant_id, document_id, noi_dung, embedding, meta)
         VALUES ($1, $2, $3, $4, $5)`,
        [tenantId, documentId, text, JSON.stringify(emb), JSON.stringify({ index: i })]
      );

      const progress = Math.min(99, Math.round(50 + (i / chunks.length) * 45));
      await job.updateProgress(progress);
    }

    // Success status update
    await client.query(
      `UPDATE kb_document SET trang_thai = 'da_xu_ly' WHERE id = $1`,
      [documentId]
    );
  });

  await job.updateProgress(100);
  console.log(`[IngestWorker] Completed document ${documentId} (${filename})`);
}, {
  connection: {
    host: new URL(env.REDIS_URL).hostname,
    port: parseInt(new URL(env.REDIS_URL).port || "6379", 10),
  },
  concurrency: 2,
});

worker.on("completed", (job) => {
  console.log(`Job ${job.id} completed successfully`);
});

worker.on("failed", async (job, err) => {
  console.error(`Job ${job?.id} failed:`, err);
  // Chỉ đánh dấu lỗi khi đã hết lượt thử lại, tránh ghi 'loi' rồi job lại chạy thành công.
  if (!job) return;
  const maxAttempts = job.opts.attempts ?? 1;
  if (job.attemptsMade < maxAttempts) return;
  const { tenantId, documentId } = job.data || {};
  if (!tenantId || !documentId) return;
  try {
    await runInTenantContext(tenantId, async (client) => {
      await client.query(
        `UPDATE kb_document SET trang_thai = 'loi', loi = $1 WHERE id = $2`,
        [`Xử lý thất bại: ${String(err?.message || err).slice(0, 300)}`, documentId]
      );
    });
  } catch (e) {
    console.error(`[IngestWorker] Không ghi được trạng thái lỗi cho ${documentId}:`, e);
  }
});

console.log("Ingestion Queue Worker is running and waiting for jobs...");
