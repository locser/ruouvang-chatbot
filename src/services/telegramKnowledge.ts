import type { BotShop } from "./telegramTenant";
import { guiTinQuaBot } from "./telegram";
import { runInTenantContext } from "../db/client";
import { fetchCoTimeout, fetchJson, TIMEOUT } from "./http";
import {
  extractDocumentText, queueKnowledgeDocument, scanInjection, getExtension,
  KnowledgeIngestError, MAX_DOCUMENT_BYTES, SUPPORTED_EXTENSIONS,
} from "./knowledgeIngest";
import { html, LoiThanThien, taoAction, nutXacNhan } from "./telegramOperator";

/** Phần của tin Telegram có file đính kèm mà luồng nạp tài liệu cần. */
export interface TelegramDocumentMessage {
  message_id?: string | number;
  chat: { id: string | number };
  from?: { id?: string | number };
  caption?: string;
  document?: { file_id: string; file_name?: string; file_size?: number; mime_type?: string };
}

const WORDS_PER_CHUNK = 450;
const PREVIEW_CHARS = 300;
const DOWNLOAD_TIMEOUT_MS = 30_000;
export const FOLLOW_UP_INTERVAL_MS = 2_000;
export const FOLLOW_UP_TIMEOUT_MS = 60_000;

function formatMegabytes(bytes: number): string {
  return `${(Math.round((bytes / 1024 / 1024) * 10) / 10).toString().replace(".", ",")} MB`;
}

function formatSize(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : formatMegabytes(bytes);
}

export function estimateChunks(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(words / WORDS_PER_CHUNK));
}

/** Kiểm tra đuôi file và dung lượng trước khi tải. Ném LoiThanThien nếu không nạp được. */
export function assertDocumentAccepted(fileName: string, fileSize: number | undefined): void {
  const ext = getExtension(fileName);
  if (!(SUPPORTED_EXTENSIONS as readonly string[]).includes(ext)) {
    throw new LoiThanThien(`Em chỉ học được file ${SUPPORTED_EXTENSIONS.map((e) => e.toUpperCase()).join(", ")}. File “${fileName}” chưa được hỗ trợ.`);
  }
  if ((fileSize ?? 0) > MAX_DOCUMENT_BYTES) {
    throw new LoiThanThien(`File “${fileName}” nặng ${formatMegabytes(fileSize!)}, vượt giới hạn ${formatMegabytes(MAX_DOCUMENT_BYTES)}. Anh/chị chia nhỏ file giúp em nhé.`);
  }
}

/** Tải file từ Telegram (getFile + file/bot<token>/<path>), giống cách tải ảnh. */
async function downloadTelegramFile(bot: BotShop, fileId: string, fileName: string): Promise<Buffer> {
  const info = await fetchJson<any>(
    `https://api.telegram.org/bot${bot.token}/getFile?file_id=${encodeURIComponent(fileId)}`, {}, TIMEOUT.TELEGRAM
  );
  const filePath = info?.result?.file_path;
  if (!filePath) throw new Error("Telegram không trả đường dẫn file.");
  const res = await fetchCoTimeout(`https://api.telegram.org/file/bot${bot.token}/${filePath}`, {}, DOWNLOAD_TIMEOUT_MS);
  if (!res.ok) throw new Error(`Không tải được file Telegram (${res.status}).`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > MAX_DOCUMENT_BYTES) {
    throw new LoiThanThien(`File “${fileName}” nặng ${formatMegabytes(bytes.length)}, vượt giới hạn ${formatMegabytes(MAX_DOCUMENT_BYTES)}. Anh/chị chia nhỏ file giúp em nhé.`);
  }
  return bytes;
}

/** Tải rồi trích chữ; lỗi nghiệp vụ của luồng nạp được đổi thành lời nhắn thân thiện. */
async function downloadAndExtract(bot: BotShop, fileId: string, fileName: string): Promise<{ bytes: Buffer; text: string }> {
  let bytes: Buffer;
  try {
    bytes = await downloadTelegramFile(bot, fileId, fileName);
  } catch (e) {
    if (e instanceof LoiThanThien) throw e;
    console.error("[telegram-knowledge] tải file lỗi:", e);
    throw new LoiThanThien("Em chưa tải được file từ Telegram. Anh/chị thử gửi lại sau ít phút nhé.");
  }
  try {
    return { bytes, text: await extractDocumentText(bytes, fileName) };
  } catch (e) {
    if (e instanceof KnowledgeIngestError) throw new LoiThanThien(e.message);
    throw e;
  }
}

/** Nhân viên gửi file: kiểm tra, đọc thử, lập bản nháp kèm nút Xác nhận/Huỷ. */
export async function draftKnowledgeIngest(bot: BotShop, tenantId: string, message: TelegramDocumentMessage): Promise<void> {
  const doc = message.document;
  if (!doc?.file_id) return;
  const chatId = String(message.chat.id);
  const messageId = message.message_id == null ? null : String(message.message_id);
  const operatorId = String(message.from?.id || "");
  const fileName = (doc.file_name || "tai-lieu").slice(0, 200);

  assertDocumentAccepted(fileName, doc.file_size);
  const { bytes, text } = await downloadAndExtract(bot, doc.file_id, fileName);

  const payload = {
    file_id: doc.file_id,
    file_name: fileName,
    file_size: doc.file_size ?? bytes.length,
    mime_type: doc.mime_type ?? null,
  };
  const action = await taoAction(tenantId, chatId, messageId, operatorId, "kb_ingest", "awaiting_confirmation", payload,
    String(message.caption || "").slice(0, 500));
  if (!action.created) return;

  const flagged = scanInjection(text).length > 0;
  const preview = text.replace(/\s+/g, " ").trim().slice(0, PREVIEW_CHARS);
  const draft =
    `📚 <b>Nạp tài liệu vào kiến thức của bot?</b>\n` +
    `Tệp: <b>${html(fileName)}</b>\n` +
    `Dung lượng: ${formatSize(payload.file_size)}\n` +
    `Nội dung: ${text.length.toLocaleString("en-US").replace(/,/g, ".")} ký tự, ước tính khoảng ${estimateChunks(text)} đoạn\n` +
    `Xem trước: <i>${html(preview)}${text.trim().length > PREVIEW_CHARS ? "…" : ""}</i>\n` +
    (flagged ? `\n⚠️ Tài liệu có câu giống lệnh điều khiển bot, sau khi nạp sẽ bị giữ lại để kiểm tra.\n` : "") +
    `\nBấm Xác nhận để nạp, hoặc Huỷ để bỏ qua.`;
  await guiTinQuaBot(bot, { chat_id: chatId, text: draft, parse_mode: "HTML", reply_markup: nutXacNhan(action.id, "kb_ingest") as any });
}

type FollowUpScheduler = (job: () => Promise<void>) => void;
const defaultScheduler: FollowUpScheduler = (job) => {
  job().catch((e) => console.error("[telegram-knowledge] theo dõi kết quả lỗi:", e));
};
let scheduler: FollowUpScheduler = defaultScheduler;

/** Cho test thay cách chạy phần theo dõi nền (không để timer treo jest). Gọi không tham số để trả về mặc định. */
export function setKnowledgeFollowUpScheduler(fn?: FollowUpScheduler): void {
  scheduler = fn ?? defaultScheduler;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Hỏi trạng thái kb_document mỗi vài giây (có giới hạn) rồi báo kết quả cuối cho nhân viên. */
export async function reportKnowledgeResult(
  bot: BotShop, tenantId: string, chatId: string, documentId: string, fileName: string,
  opts: { intervalMs?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void> } = {}
): Promise<void> {
  const intervalMs = opts.intervalMs ?? FOLLOW_UP_INTERVAL_MS;
  const attempts = Math.max(1, Math.ceil((opts.timeoutMs ?? FOLLOW_UP_TIMEOUT_MS) / intervalMs));
  const wait = opts.sleep ?? sleep;
  const name = html(fileName);

  for (let i = 0; i < attempts; i++) {
    if (i > 0) await wait(intervalMs);
    const row = await runInTenantContext(tenantId, async (client) => {
      const r = await client.query(
        `SELECT d.trang_thai, d.loi, (SELECT count(*) FROM kb_chunk c WHERE c.document_id = d.id) AS chunks
           FROM kb_document d WHERE d.id = $1 AND d.tenant_id = $2`,
        [documentId, tenantId]
      );
      return r.rows[0] as { trang_thai: string; loi: string | null; chunks: string | number } | undefined;
    });
    if (!row) {
      await guiTinQuaBot(bot, { chat_id: chatId, parse_mode: "HTML", text: `⚠️ Em không còn thấy “${name}” trong hệ thống (có thể đã bị xoá).` });
      return;
    }
    if (row.trang_thai === "da_xu_ly") {
      await guiTinQuaBot(bot, { chat_id: chatId, parse_mode: "HTML", text: `✅ Đã học xong “${name}”: ${Number(row.chunks)} đoạn.` });
      return;
    }
    if (row.trang_thai === "nghi_tiem_lenh") {
      await guiTinQuaBot(bot, { chat_id: chatId, parse_mode: "HTML", text:
        `⚠️ “${name}” đang bị giữ lại để kiểm tra vì có câu giống lệnh điều khiển bot` +
        `${row.loi ? ` (${html(String(row.loi).slice(0, 200))})` : ""}. Anh/chị xem và duyệt ở trang quản trị nhé.` });
      return;
    }
    if (row.trang_thai === "loi") {
      await guiTinQuaBot(bot, { chat_id: chatId, parse_mode: "HTML", text:
        `❌ Em chưa học được “${name}”${row.loi ? `: ${html(String(row.loi).slice(0, 300))}` : ""}. Anh/chị thử lại hoặc xem ở trang quản trị nhé.` });
      return;
    }
  }
  await guiTinQuaBot(bot, { chat_id: chatId, parse_mode: "HTML", text: `⏳ “${name}” vẫn đang xử lý, anh/chị xem kết quả ở trang quản trị nhé.` });
}

/**
 * Chạy sau khi nhân viên bấm Xác nhận (action đã được claim sang 'executing').
 * Tải lại file, nạp vào hàng chờ, cập nhật action và hẹn báo kết quả cuối.
 */
export async function confirmKnowledgeIngest(
  bot: BotShop, tenantId: string, action: { id: string; payload?: any }, chatId: string
): Promise<void> {
  const p = action.payload || {};
  const fileName = String(p.file_name || "tai-lieu");
  try {
    assertDocumentAccepted(fileName, Number(p.file_size) || undefined);
    const { bytes, text } = await downloadAndExtract(bot, String(p.file_id), fileName);
    const { documentId } = await queueKnowledgeDocument({
      tenantId, filename: fileName, text, sizeBytes: bytes.length, source: "telegram",
    });
    await runInTenantContext(tenantId, (client) => client.query(
      `UPDATE telegram_operator_action SET status='completed', result=$1::jsonb WHERE id=$2 AND tenant_id=$3`,
      [JSON.stringify({ document_id: documentId }), action.id, tenantId]
    ));
    await guiTinQuaBot(bot, { chat_id: chatId, parse_mode: "HTML", text: `⏳ Đã đưa “${html(fileName)}” vào hàng chờ học. Học xong em báo anh/chị ngay.` });
    scheduler(() => reportKnowledgeResult(bot, tenantId, chatId, documentId, fileName));
  } catch (e: any) {
    const friendly = e instanceof LoiThanThien || e instanceof KnowledgeIngestError;
    if (!friendly) console.error("[telegram-knowledge] nạp tài liệu lỗi:", e);
    await runInTenantContext(tenantId, (client) => client.query(
      `UPDATE telegram_operator_action SET status='failed', error=$1 WHERE id=$2 AND tenant_id=$3`,
      [String(e?.message || e).slice(0, 1000), action.id, tenantId]
    ));
    const msg = friendly ? e.message : "Em chưa nạp được tài liệu này. Anh/chị thử lại sau ít phút giúp em nhé.";
    await guiTinQuaBot(bot, { chat_id: chatId, parse_mode: "HTML", text: `❌ ${html(msg)}` });
  }
}
