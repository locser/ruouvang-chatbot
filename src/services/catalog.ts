import { env } from "../config/env";
import { fetchJson, TIMEOUT } from "./http";
import { MedusaConfig } from "./medusa";
import { SanPhamTimDuoc } from "./search";

/**
 * Làm giàu kết quả tìm kiếm bằng GIÁ và TỒN KHO THẬT từ Medusa.
 *
 * Đây là lưới an toàn quan trọng nhất của hệ thống (ADR-008):
 * Meilisearch có thể lệch vài giây, hoặc lệch hẳn nếu subscriber hỏng — nhưng
 * khách hàng KHÔNG BAO GIỜ được thấy giá sai. Vì vậy mọi con số tiền và mọi
 * câu trả lời còn/hết hàng đều phải đi qua hàm này.
 *
 * Nguồn: POST {baseUrl}/ai/products-lookup (tra theo lô ID/SKU).
 * KHÔNG dùng /ai/catalog: endpoint đó trần 500 sản phẩm và không trả giá.
 */

export interface SanPhamDayDu extends SanPhamTimDuoc {
  /** Giá THẬT tại thời điểm này. Đây là con số duy nhất được phép nói với khách. */
  gia_that_vnd: number | null;
  /** Tồn kho THẬT tại thời điểm này. */
  ton_kho_that: number | null;
  /**
   * Có bán được không, THEO MEDUSA.
   *
   * ⚠️ KHÔNG suy ra từ `ton_kho_that > 0`. Biến thể đặt `manage_inventory =
   * false` (luôn bán được, không theo dõi số lượng) không có bản ghi tồn kho
   * nào nên `ton_kho_that` luôn là 0 — suy từ số lượng sẽ kết luận "hết hàng"
   * cho toàn bộ catalog. Ngày 04/08/2026 lỗi này khiến bot Hasaki từ chối bán
   * cả 7.869 sản phẩm.
   */
  con_hang_that: boolean | null;
  /** true = không lấy được dữ liệu thật → TUYỆT ĐỐI không báo giá cho khách. */
  thieu_du_lieu_that: boolean;
}

export interface MucTraCuu {
  product_id: string;
  variant_id?: string;
  sku?: string;
  title?: string;
  handle?: string;
  price_vnd: number;
  stock_qty: number;
  in_stock: boolean;
}

export interface KetQuaTraCuu {
  items: MucTraCuu[];
  khong_tim_thay: { ids: string[]; skus: string[] };
}

/** Tra cứu giá & tồn kho thật theo lô. Tối đa 100 ID và 100 SKU mỗi lần. */
export async function traCuuThat(
  config: MedusaConfig,
  args: { ids?: string[]; skus?: string[] }
): Promise<KetQuaTraCuu> {
  const ids = (args.ids ?? []).slice(0, 100);
  const skus = (args.skus ?? []).slice(0, 100);
  if (ids.length === 0 && skus.length === 0) {
    return { items: [], khong_tim_thay: { ids: [], skus: [] } };
  }

  const data = await fetchJson<KetQuaTraCuu>(
    `${config.baseUrl}/ai/products-lookup`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-ai-secret-key": env.AI_SECRET_KEY,
      },
      body: JSON.stringify({ ids, skus }),
    },
    TIMEOUT.MEDUSA
  );

  return {
    items: data.items ?? [],
    khong_tim_thay: data.khong_tim_thay ?? { ids: [], skus: [] },
  };
}

/**
 * Ghép kết quả Meilisearch với giá/tồn kho thật.
 *
 * Sản phẩm không lấy được dữ liệu thật mang `thieu_du_lieu_that = true` và bị
 * `dinhDangChoLLM()` loại khỏi câu trả lời — thà thiếu một gợi ý còn hơn báo
 * sai giá cho khách hàng đang chuẩn bị trả tiền.
 */
export async function lamGiauSanPham(
  config: MedusaConfig | null,
  sanPham: SanPhamTimDuoc[]
): Promise<SanPhamDayDu[]> {
  if (sanPham.length === 0) return [];

  if (!config) {
    return sanPham.map((s) => ({ ...s, gia_that_vnd: null, ton_kho_that: null, con_hang_that: null, thieu_du_lieu_that: true }));
  }

  const bang = new Map<string, MucTraCuu>();
  try {
    const kq = await traCuuThat(config, { ids: sanPham.map((s) => s.id) });
    for (const m of kq.items) bang.set(m.product_id, m);
  } catch (e) {
    console.error("[Catalog] Không đọc được giá/tồn kho thật từ Medusa:", e);
  }

  return sanPham.map((s) => {
    const that = bang.get(s.id);
    return {
      ...s,
      sku: that?.sku ?? s.sku,
      gia_that_vnd: that ? that.price_vnd : null,
      ton_kho_that: that ? that.stock_qty : null,
      con_hang_that: that ? that.in_stock : null,
      thieu_du_lieu_that: !that,
    };
  });
}

/**
 * Định dạng sản phẩm để đưa vào kết quả tool cho LLM.
 * Chỉ xuất sản phẩm có dữ liệu THẬT — model không bao giờ nhìn thấy giá lấy
 * từ index tìm kiếm.
 */
export function dinhDangChoLLM(sp: SanPhamDayDu[]): Array<Record<string, unknown>> {
  return sp
    .filter((s) => !s.thieu_du_lieu_that)
    .map((s) => ({
      id: s.id,
      sku: s.sku,
      title: s.title,
      brand: s.brand,
      price_vnd: s.gia_that_vnd,
      stock_qty: s.ton_kho_that,
      // Cờ quyết định còn/hết hàng. Model phải đọc cờ này, đừng tự suy từ
      // `stock_qty` — xem ghi chú ở `con_hang_that`.
      in_stock: s.con_hang_that,
      specs: s.specs,
      url: s.handle ? `/products/${s.handle}` : undefined,
      thumbnail: s.thumbnail,
    }));
}
