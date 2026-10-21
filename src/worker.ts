import { Worker, Job } from "bullmq";
import { runInTenantContext } from "./db/client";
import { env } from "./config/env";
import { taoVectorEmbedding } from "./services/embedding";

// Regex patterns to detect prompt injection attempts in uploaded knowledge base files
export const MAU_TIEM_LENH = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /bỏ\s+qua\s+(mọi\s+)?(lệnh|chỉ\s*dẫn)\s+(trước|trên)/i,
  /you\s+are\s+now\s+/i,
  /system\s*:\s*/i,
  /giảm\s+giá\s+\d{2,3}\s*%/i,
];

export function quetTiemLenh(text: string): string[] {
  return MAU_TIEM_LENH.filter((re) => re.test(text)).map((re) => re.source);
}

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

// Structured data parsing stub
function laBangCoCauTruc(filename: string): boolean {
  return filename.endsWith(".xlsx") || filename.endsWith(".csv");
}

async function processStructuredTable(tenantId: string, documentId: string, filename: string, content: string, client: any) {
  console.log(`[StructuredTable] Processing ${filename} into SQL rows for tenant ${tenantId}...`);
  
  // Parse CSV mock content: Expect "col1,col2,col3"
  const lines = content.split("\n").map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return;

  const headers = lines[0].split(",").map(h => h.trim());
  const rows = lines.slice(1).map(line => {
    const vals = line.split(",").map(v => v.trim());
    const obj: Record<string, string> = {};
    headers.forEach((h, idx) => {
      obj[h] = vals[idx] || "";
    });
    return obj;
  });

  // Create table entry
  const tableResult = await client.query(
    `INSERT INTO kb_table (tenant_id, ten_bang, lay_do_cot) 
     VALUES ($1, $2, $3) RETURNING id`,
    [tenantId, filename, JSON.stringify(headers)]
  );
  
  const tableId = tableResult.rows[0].id;

  // Insert rows
  for (const row of rows) {
    await client.query(
      `INSERT INTO kb_table_row (tenant_id, table_id, du_lieu) 
       VALUES ($1, $2, $3)`,
      [tenantId, tableId, JSON.stringify(row)]
    );
  }

  // Update table row count
  await client.query(
    `UPDATE kb_table SET so_dong = $1 WHERE id = $2`,
    [rows.length, tableId]
  );
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

    if (laBangCoCauTruc(filename)) {
      await processStructuredTable(tenantId, documentId, filename, content, client);
    } else {
      // General RAG text processing
      const chunks = chiaKhuc(content, 500, 50);
      for (let i = 0; i < chunks.length; i++) {
        const text = chunks[i];
        const emb = await taoVectorEmbedding(text);
        
        await client.query(
          `INSERT INTO kb_chunk (tenant_id, document_id, noi_dung, embedding, meta) 
           VALUES ($1, $2, $3, $4, $5)`,
          [tenantId, documentId, text, JSON.stringify(emb), JSON.stringify({ index: i })]
        );

        // Update progress dynamically
        const progress = Math.min(99, Math.round(50 + (i / chunks.length) * 45));
        await job.updateProgress(progress);
      }
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

worker.on("failed", (job, err) => {
  console.error(`Job ${job?.id} failed:`, err);
});

console.log("Ingestion Queue Worker is running and waiting for jobs...");
