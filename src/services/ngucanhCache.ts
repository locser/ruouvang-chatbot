/**
 * BỘ NHỚ ĐỆM NGỮ CẢNH CHO LUỒNG CHAT — TỐI ƯU 08/2026.
 *
 * Vì sao có file này: hạ tầng đệm đã có sẵn từ lâu (`services/cache.ts` với
 * Redis và bộ nhớ dự phòng, kèm `buildTenantCacheKey` để tránh lẫn dữ liệu
 * giữa các shop), nhưng rà lại toàn bộ mã nguồn thì chỉ có DUY NHẤT bộ đếm
 * hạn mức truy cập dùng tới nó. `buildTenantCacheKey` được viết ra rồi bỏ
 * không, không một dòng nào gọi. Nói cách khác: có Redis, có tầng đệm, nhưng
 * không đệm gì cả — mọi tin nhắn của khách đều tra lại cơ sở dữ liệu từ đầu.
 *
 * Hai thứ được đệm ở đây, chọn theo đúng đặc điểm của bán hàng qua chat:
 *
 *   1. TRI THỨC NỘI BỘ (RAG) — khách hỏi lặp lại rất nhiều. "Ship mấy ngày",
 *      "có ship COD không", "đổi trả thế nào" xuất hiện suốt cả ngày với cách
 *      viết gần như y hệt. Mỗi lần như vậy hệ thống lại tính vector rồi quét
 *      pgvector để nhận về đúng bộ đoạn văn cũ.
 *
 *   2. KỊCH BẢN CỨNG — mỗi tin nhắn đều phải hỏi cơ sở dữ liệu một lượt để
 *      biết có kịch bản nào khớp không, và phần lớn câu trả lời là "không có".
 *
 * ⚠️ NGUYÊN TẮC AN TOÀN, KHÔNG ĐƯỢC PHÁ:
 *
 *   · MỌI khoá đệm đều đi qua `buildTenantCacheKey` để mang tiền tố tenant.
 *     Tri thức nội bộ là tài sản riêng của từng shop; một khoá đặt thiếu tiền
 *     tố là chính sách của shop này lọt sang câu trả lời của shop khác.
 *
 *   · TUYỆT ĐỐI KHÔNG đệm giá bán và tồn kho (ADR-008). Hai thứ đó luôn phải
 *     đọc thẳng từ Medusa trong chính lượt trả lời. Ở đây chỉ đệm những thứ
 *     tĩnh: đoạn văn chính sách và kịch bản trả lời soạn sẵn.
 *
 *   · Thời gian sống ngắn (5 phút). Quản trị viên vừa sửa chính sách thì chậm
 *     nhất 5 phút sau là bot nói theo bản mới.
 */

import { PoolClient } from "pg";
import { cache, buildTenantCacheKey } from "./cache";
import { matchHardScript, KetQuaKichBan } from "./llm";
import { taoVectorEmbedding } from "./embedding";

/** Thời gian sống của các mục đệm trong luồng chat, tính bằng giây. */
const TTL_GIAY = 300;

/** Số đoạn tri thức lấy vào ngữ cảnh mỗi lượt. */
const SO_DOAN_TRI_THUC = 6;

/**
 * Chuẩn hoá câu hỏi để những cách viết khác nhau của cùng một ý dùng chung
 * một mục đệm.
 *
 * Gộp khoảng trắng, bỏ dấu câu ở cuối và hạ chữ thường. Nhờ vậy "Ship mấy
 * ngày?", "ship mấy ngày" và "Ship  mấy  ngày !!!" cùng trỏ về một khoá.
 *
 * KHÔNG bỏ dấu tiếng Việt: "ma" và "mà" là hai từ khác nhau, gộp lại sẽ trả
 * về tri thức sai.
 */
export function chuanHoaCauHoi(cau: string): string {
  return cau
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[?!.,;:]+$/g, "");
}

/**
 * Băm chuỗi thành khoá ngắn, ổn định (thuật toán FNV-1a 32 bit).
 *
 * Dùng để không nhét cả câu hỏi của khách vào tên khoá Redis — câu hỏi có thể
 * rất dài, có dấu cách và cả ký tự lạ.
 */
function bam(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/**
 * Lấy các đoạn tri thức nội bộ liên quan tới câu hỏi, có đệm.
 *
 * Thay cho đoạn mã trước đây nằm thẳng trong `index.ts`: tính vector rồi
 * `ORDER BY embedding <=> $2::vector LIMIT 10` ở mọi tin nhắn, không đệm.
 *
 * Số đoạn giảm từ 10 xuống 6. Lý do không phải để tiết kiệm cho có: mười đoạn
 * là quá nhiều so với lượng tri thức thực tế của một shop, và những đoạn xếp
 * cuối gần như luôn lạc đề — chúng chỉ làm ngữ cảnh dài thêm, tốn tiền token
 * ở cả hai lượt gọi mô hình, đồng thời làm loãng những đoạn thật sự đúng.
 */
export async function layTriThucCoDem(
  client: PoolClient,
  tenantId: string,
  cauHoi: string
): Promise<string[]> {
  const khoa = buildTenantCacheKey(
    tenantId,
    "tri-thuc",
    bam(chuanHoaCauHoi(cauHoi))
  );

  try {
    const daCo = await cache.get(khoa);
    if (daCo !== null) {
      const ds = JSON.parse(daCo);
      if (Array.isArray(ds)) return ds as string[];
    }
  } catch (e) {
    // Đệm hỏng thì bỏ qua và tra lại từ cơ sở dữ liệu — không bao giờ để lỗi
    // của tầng đệm làm chết một lượt trả lời khách.
    console.warn("[NgữCảnh] Không đọc được đệm tri thức, tra lại CSDL:", e);
  }

  const vector = await taoVectorEmbedding(cauHoi);
  const kq = await client.query(
    `SELECT noi_dung FROM kb_chunk
     WHERE tenant_id = $1
     ORDER BY embedding <=> $2::vector
     LIMIT $3`,
    [tenantId, JSON.stringify(vector), SO_DOAN_TRI_THUC]
  );
  const doan = kq.rows.map((r: any) => r.noi_dung as string);

  try {
    await cache.set(khoa, JSON.stringify(doan), TTL_GIAY);
  } catch (e) {
    console.warn("[NgữCảnh] Không ghi được đệm tri thức:", e);
  }

  return doan;
}

/**
 * Tìm kịch bản cứng khớp câu hỏi, có đệm — kể cả khi KHÔNG khớp.
 *
 * Đệm cả trường hợp không khớp là chỗ ăn thật của tối ưu này: phần lớn tin
 * nhắn của khách không trúng kịch bản nào, mà lượt tra nào cũng phải chạy so
 * khớp biểu thức chính quy trên toàn bộ kịch bản của shop.
 *
 * ⚠️ Việc so khớp vẫn do PostgreSQL làm, KHÔNG chuyển sang JavaScript. Mẫu
 * `mau_khop` viết theo cú pháp biểu thức chính quy của PostgreSQL — ranh giới
 * từ là `\y` chứ không phải `\b`. Đem sang JavaScript chạy thì mẫu sẽ không
 * khớp mà cũng chẳng báo lỗi nào, tức là bot lặng lẽ bỏ qua toàn bộ kịch bản
 * đã soạn. Ở đây chỉ đệm KẾT QUẢ, không đụng tới cách so khớp.
 */
export async function matchHardScriptCoDem(
  client: PoolClient,
  tenantId: string,
  cauHoi: string,
  locale: string
): Promise<KetQuaKichBan | null> {
  const khoa = buildTenantCacheKey(
    tenantId,
    "kich-ban",
    `${locale}:${bam(chuanHoaCauHoi(cauHoi))}`
  );

  try {
    const daCo = await cache.get(khoa);
    if (daCo !== null) {
      // Chuỗi rỗng là cách ghi lại "đã tra rồi, không có kịch bản nào khớp".
      if (daCo === "") return null;
      return JSON.parse(daCo) as KetQuaKichBan;
    }
  } catch (e) {
    console.warn("[NgữCảnh] Không đọc được đệm kịch bản, tra lại CSDL:", e);
  }

  const kq = await matchHardScript(client, tenantId, cauHoi, locale);

  try {
    await cache.set(khoa, kq ? JSON.stringify(kq) : "", TTL_GIAY);
  } catch (e) {
    console.warn("[NgữCảnh] Không ghi được đệm kịch bản:", e);
  }

  return kq;
}
