import crypto from "crypto";
import ExcelJS from "exceljs";
import mammoth from "mammoth";
import { runInTenantContext } from "../db/client";

/** Dung lượng tối đa của file sau khi giải mã (20 MB). */
export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;

export const SUPPORTED_EXTENSIONS = ["pdf", "docx", "txt", "md", "csv", "xlsx"] as const;

export type KnowledgeErrorCode = "unsupported" | "empty" | "too_large" | "duplicate" | "corrupt";

/** Lỗi có thông điệp tiếng Việt, hiển thị thẳng cho người dùng. */
export class KnowledgeIngestError extends Error {
  constructor(public code: KnowledgeErrorCode, message: string) {
    super(message);
    this.name = "KnowledgeIngestError";
  }
}

export function getExtension(filename: string): string {
  const idx = filename.lastIndexOf(".");
  return idx < 0 ? "" : filename.slice(idx + 1).toLowerCase();
}

function cellToString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    const v = value as any;
    if (Array.isArray(v.richText)) return v.richText.map((r: any) => r.text).join("");
    if (v.result !== undefined) return cellToString(v.result);
    if (v.text !== undefined) return cellToString(v.text);
    if (v.hyperlink) return String(v.hyperlink);
    return "";
  }
  return String(value).trim();
}

/** Biến bảng (dòng đầu là tiêu đề) thành các dòng "Tiêu đề: giá trị; ..." để chia khúc như văn bản. */
function rowsToText(rows: string[][]): string {
  const nonEmpty = rows.filter((r) => r.some((c) => c !== ""));
  if (nonEmpty.length === 0) return "";
  if (nonEmpty.length === 1) return nonEmpty[0].filter(Boolean).join("; ");
  const headers = nonEmpty[0];
  return nonEmpty
    .slice(1)
    .map((row) =>
      row
        .map((v, i) => (v === "" ? "" : `${headers[i] || `Cột ${i + 1}`}: ${v}`))
        .filter(Boolean)
        .join("; ")
    )
    .filter(Boolean)
    .join("\n");
}

/** Parser CSV tối giản: hỗ trợ dấu ngoặc kép, dấu phẩy/chấm phẩy/tab, xuống dòng trong ô. */
export function parseCsv(text: string): string[][] {
  const clean = text.replace(/^﻿/, "");
  const firstLine = clean.split(/\r?\n/, 1)[0] || "";
  const counts: Record<string, number> = {
    ",": (firstLine.match(/,/g) || []).length,
    ";": (firstLine.match(/;/g) || []).length,
    "\t": (firstLine.match(/\t/g) || []).length,
  };
  const delim = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (inQuotes) {
      if (ch === '"') {
        if (clean[i + 1] === '"') { cur += '"'; i++; } else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === delim) { row.push(cur.trim()); cur = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && clean[i + 1] === "\n") i++;
      row.push(cur.trim()); cur = "";
      rows.push(row); row = [];
    } else cur += ch;
  }
  if (cur !== "" || row.length > 0) { row.push(cur.trim()); rows.push(row); }
  return rows;
}

/** Rút văn bản thuần từ file tải lên. Ném KnowledgeIngestError (tiếng Việt) khi không dùng được. */
export async function extractDocumentText(buffer: Buffer, filename: string): Promise<string> {
  const ext = getExtension(filename);
  if (!(SUPPORTED_EXTENSIONS as readonly string[]).includes(ext)) {
    throw new KnowledgeIngestError(
      "unsupported",
      `Định dạng .${ext || "?"} chưa được hỗ trợ. Chỉ nhận PDF, DOCX, TXT, MD, CSV, XLSX.`
    );
  }

  let text = "";
  try {
    if (ext === "txt" || ext === "md") {
      text = buffer.toString("utf8");
    } else if (ext === "csv") {
      text = rowsToText(parseCsv(buffer.toString("utf8")));
    } else if (ext === "docx") {
      text = (await mammoth.extractRawText({ buffer })).value;
    } else if (ext === "xlsx") {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buffer as any);
      const parts: string[] = [];
      wb.eachSheet((sheet) => {
        const rows: string[][] = [];
        sheet.eachRow({ includeEmpty: false }, (row) => {
          const values = (row.values as unknown[]).slice(1);
          rows.push(values.map(cellToString));
        });
        const body = rowsToText(rows);
        if (body) parts.push(wb.worksheets.length > 1 ? `[${sheet.name}]\n${body}` : body);
      });
      text = parts.join("\n\n");
    } else if (ext === "pdf") {
      const { PDFParse } = await import("pdf-parse");
      const parser = new PDFParse({ data: new Uint8Array(buffer) });
      try {
        text = (await parser.getText()).text;
      } finally {
        await parser.destroy().catch(() => undefined);
      }
      if (!text.trim()) {
        throw new KnowledgeIngestError(
          "empty",
          "PDF này không có chữ để đọc (có thể là bản scan/ảnh). Hãy dùng PDF có chữ hoặc nhập nội dung dạng văn bản."
        );
      }
    }
  } catch (err) {
    if (err instanceof KnowledgeIngestError) throw err;
    throw new KnowledgeIngestError(
      "corrupt",
      `Không đọc được file ${filename}. File có thể bị hỏng hoặc đặt mật khẩu.`
    );
  }

  text = text.replace(/\r\n?/g, "\n").trim();
  if (!text) {
    throw new KnowledgeIngestError("empty", "Tài liệu không có nội dung chữ để nạp.");
  }
  return text;
}

// Mẫu phát hiện tiêm lệnh (prompt injection) trong tài liệu tri thức.
// "Giảm giá 10%" là nội dung khuyến mãi bình thường nên không bị chặn; chỉ chặn
// khi mức giảm >= 50% hoặc đi kèm từ ngữ ra lệnh cho bot.
export const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /bỏ\s+qua\s+(mọi\s+)?(lệnh|chỉ\s*dẫn)\s+(trước|trên)/i,
  /you\s+are\s+now\s+/i,
  /system\s*:\s*/i,
  // giảm giá từ 50% trở lên (50-99, 100+)
  /giảm\s+giá\s+(?:[5-9]\d|\d{3})\s*%/i,
  // lệnh ép bot giảm giá / tặng miễn phí
  /(?:hãy|phải|luôn|cứ)\s+(?:giảm\s+giá|bán\s+(?:với\s+giá\s+)?0\s*đ|tặng\s+miễn\s+phí)/i,
];

export function scanInjection(text: string): string[] {
  return INJECTION_PATTERNS.filter((re) => re.test(text)).map((re) => re.source);
}

export type KnowledgeSource = "admin" | "telegram";

/**
 * Lưu kb_document (cho_xu_ly) rồi đẩy job chia khúc vào hàng đợi.
 * Dùng chung cho trang quản trị và (sau này) luồng Telegram.
 */
export async function queueKnowledgeDocument(params: {
  tenantId: string;
  filename: string;
  text: string;
  sizeBytes: number;
  source: KnowledgeSource;
}): Promise<{ documentId: string; status: "queued" }> {
  const { tenantId, filename, text, sizeBytes, source } = params;
  const checksum = crypto.createHash("sha256").update(text).digest("hex");

  let documentId: string;
  try {
    documentId = await runInTenantContext(tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO kb_document (tenant_id, ten_file, loai, kich_thuoc, checksum, trang_thai)
         VALUES ($1, $2, $3, $4, $5, 'cho_xu_ly')
         RETURNING id`,
        [tenantId, filename, getExtension(filename) || "txt", sizeBytes, checksum]
      );
      return result.rows[0].id as string;
    });
  } catch (error: any) {
    if (error?.code === "23505") {
      throw new KnowledgeIngestError("duplicate", "Tài liệu này (cùng nội dung) đã có trong hệ thống. Muốn nạp lại thì xoá bản cũ trước.");
    }
    throw error;
  }

  const { documentQueue } = await import("./queues");
  await documentQueue.add("ingest", {
    tenantId,
    documentId,
    filename,
    s3Key: `uploads/${tenantId}/${documentId}`,
    content: text,
    source,
  });
  console.log(`[KnowledgeIngest] queued ${documentId} (${filename}) source=${source}`);
  return { documentId, status: "queued" };
}

/** Xoá tài liệu và các khúc của nó (kb_chunk có ON DELETE CASCADE nhưng xoá tường minh cho rõ). */
export async function deleteKnowledgeDocument(tenantId: string, documentId: string): Promise<boolean> {
  return runInTenantContext(tenantId, async (client) => {
    await client.query("DELETE FROM kb_chunk WHERE document_id = $1 AND tenant_id = $2", [documentId, tenantId]);
    const r = await client.query("DELETE FROM kb_document WHERE id = $1 AND tenant_id = $2", [documentId, tenantId]);
    return (r.rowCount ?? 0) > 0;
  });
}
