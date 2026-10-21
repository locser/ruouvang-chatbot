/**
 * Bọc fetch có timeout bắt buộc.
 *
 * Vì sao cần: fetch của Node 20 KHÔNG có timeout mặc định. Trước đây toàn bộ
 * 15 lời gọi ra ngoài (DeepSeek, Medusa, Telegram, Meilisearch) đều không có
 * giới hạn thời gian — một dịch vụ treo là request treo vô hạn, giữ luôn kết
 * nối database và làm cạn connection pool.
 *
 * Ngân sách timeout theo tài liệu 07 §3.
 */

export const TIMEOUT = {
  MEILISEARCH: 1_000,
  MEDUSA: 3_000,
  DEEPSEEK: 15_000,
  TELEGRAM: 5_000,
  MAC_DINH: 5_000,
} as const;

export class LoiHetGio extends Error {
  constructor(public url: string, public msTimeout: number) {
    super(`Hết thời gian chờ sau ${msTimeout}ms: ${url}`);
    this.name = "LoiHetGio";
  }
}

/**
 * fetch có timeout. Ném LoiHetGio khi quá hạn để nơi gọi phân biệt được
 * "dịch vụ chậm" với "dịch vụ trả lỗi".
 */
export async function fetchCoTimeout(
  url: string,
  init: RequestInit = {},
  msTimeout: number = TIMEOUT.MAC_DINH
): Promise<Response> {
  const ac = new AbortController();
  const hen = setTimeout(() => ac.abort(), msTimeout);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } catch (e: any) {
    if (e?.name === "AbortError") throw new LoiHetGio(url, msTimeout);
    throw e;
  } finally {
    clearTimeout(hen);
  }
}

/** Gọi JSON tiện dụng, đã có timeout. */
export async function fetchJson<T = any>(
  url: string,
  init: RequestInit = {},
  msTimeout: number = TIMEOUT.MAC_DINH
): Promise<T> {
  const res = await fetchCoTimeout(url, init, msTimeout);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} khi gọi ${url}: ${body.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}
