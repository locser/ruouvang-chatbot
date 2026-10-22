import { env } from "../config/env";
import { fetchJson, TIMEOUT } from "./http";

/**
 * Tầng tìm kiếm sản phẩm — Meilisearch.
 *
 * Thay thế `embedding.ts` (vốn là feature-hashing DJB2, không phải embedding
 * ngữ nghĩa) và đoạn fetch catalog có danh sách sản phẩm hardcode trong
 * index.ts. Xem tài liệu TechUpdate 04_MEILISEARCH.md và ADR-005.
 *
 * NGUYÊN TẮC BẤT KHẢ XÂM PHẠM (ADR-008):
 *   Meilisearch dùng để TÌM RA sản phẩm nào phù hợp.
 *   Giá và tồn kho hiển thị cho khách LUÔN đọc lại từ Medusa (catalog.ts).
 *   Kể cả khi đồng bộ hỏng, khách vẫn không bao giờ thấy giá sai.
 *
 * Dùng fetch trực tiếp thay vì SDK `meilisearch` để không phải thêm dependency.
 */

export interface ThamSoTimKiem {
  query?: string;
  store_type?: "cellphones" | "farmersmarket" | "all";
  brand?: string;
  category?: string;
  price_min_vnd?: number;
  price_max_vnd?: number;
  ram_gb_min?: number;
  storage_gb_min?: number;
  battery_mah_min?: number;
  storage_condition?: "thuong" | "mat" | "dong-lanh";
  origin_region?: string;
  organic_certified?: boolean;
  in_stock_only?: boolean;
  sort?: "relevance" | "price_asc" | "price_desc" | "popularity";
  limit?: number;
}

export interface SanPhamTimDuoc {
  id: string;
  sku?: string;
  title: string;
  brand?: string;
  store_type?: string;
  price_vnd?: number;   // chỉ để tham khảo/sắp xếp — KHÔNG hiển thị cho khách
  in_stock?: boolean;   // chỉ để lọc — KHÔNG trả lời khách bằng trường này
  specs?: Record<string, any>;
  thumbnail?: string;
  handle?: string;
}

export interface KetQuaTimKiem {
  products: SanPhamTimDuoc[];
  total_found: number;
  filters_applied: Record<string, unknown>;
  /** true = hệ thống đã tự nới lỏng điều kiện. Bot BẮT BUỘC nói rõ với khách. */
  filters_relaxed: boolean;
  note: string | null;
}

/** Escape giá trị đưa vào biểu thức filter của Meilisearch. */
function nhayKep(v: string): string {
  return `"${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Dựng danh sách filter. Trả về MẢNG (không phải chuỗi) để các bước sau có thể
 * bỏ bớt điều kiện một cách an toàn — bản tài liệu cũ nối chuỗi rồi lọc bằng
 * `.includes("price <=")`, hỏng ngay khi đổi định dạng.
 */
export function dungBoLoc(tenantId: string, p: ThamSoTimKiem): string[] {
  const f: string[] = [`tenant_id = ${nhayKep(tenantId)}`];  // LUÔN đứng đầu — cách ly tenant

  if (p.store_type && p.store_type !== "all") f.push(`store_type = ${nhayKep(p.store_type)}`);
  if (p.brand) f.push(`brand = ${nhayKep(p.brand)}`);
  if (p.category) f.push(`category_path = ${nhayKep(p.category)}`);
  if (typeof p.price_min_vnd === "number") f.push(`price_vnd >= ${Math.trunc(p.price_min_vnd)}`);
  if (typeof p.price_max_vnd === "number") f.push(`price_vnd <= ${Math.trunc(p.price_max_vnd)}`);
  if (typeof p.ram_gb_min === "number") f.push(`specs.ram_gb >= ${Math.trunc(p.ram_gb_min)}`);
  if (typeof p.storage_gb_min === "number") f.push(`specs.storage_gb >= ${Math.trunc(p.storage_gb_min)}`);
  if (typeof p.battery_mah_min === "number") f.push(`specs.battery_mah >= ${Math.trunc(p.battery_mah_min)}`);
  if (p.storage_condition) f.push(`specs.storage_condition = ${nhayKep(p.storage_condition)}`);
  if (p.origin_region) f.push(`specs.origin_region = ${nhayKep(p.origin_region)}`);
  if (typeof p.organic_certified === "boolean") f.push(`specs.organic_certified = ${p.organic_certified}`);
  if (p.in_stock_only !== false) f.push(`in_stock = true`);

  return f;
}

function xepTheo(sort?: string): string[] | undefined {
  switch (sort) {
    case "price_asc":  return ["price_vnd:asc"];
    case "price_desc": return ["price_vnd:desc"];
    case "popularity": return ["popularity:desc"];
    default: return undefined;   // để Meilisearch tự xếp theo độ liên quan
  }
}

async function goiMeili(body: Record<string, unknown>): Promise<any> {
  return fetchJson(
    `${env.MEILI_HOST}/indexes/${env.MEILI_INDEX}/search`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.MEILI_MASTER_KEY}`,
      },
      body: JSON.stringify(body),
    },
    TIMEOUT.MEILISEARCH
  );
}


/**
 * Tên và loại rượu trong catalog viết bằng tiếng Anh ("Red Wine", "Shiraz"…) còn khách hỏi
 * tiếng Việt ("vang đỏ"). Meilisearch không tự hiểu, nên dịch các cụm hay gặp sang tiếng Anh
 * và bỏ từ đệm/giá tiền (giá đã có bộ lọc riêng) trước khi tìm.
 */
const DAU = String.raw`(?<![\p{L}\p{N}])`;
const CUOI = String.raw`(?![\p{L}\p{N}])`;
const cum = (mau: string) => new RegExp(`${DAU}(?:${mau})${CUOI}`, "giu");
const CUM_VI_SANG_EN: Array<[RegExp, string]> = [
  [cum(String.raw`(?:rượu\s+)?vang\s+đỏ|vang\s+do`), "red wine"],
  [cum(String.raw`(?:rượu\s+)?vang\s+trắng|vang\s+trang`), "white wine"],
  [cum(String.raw`(?:rượu\s+)?vang\s+hồng|vang\s+hong`), "rose"],
  [cum(String.raw`(?:rượu\s+)?vang\s+sủi|vang\s+sui|sâm\s+panh`), "sparkling"],
  [cum(String.raw`(?:rượu\s+)?vang\s+ngọt|vang\s+tráng\s+miệng`), "dessert wine"],
];
// Từ đệm và số (giá đã có bộ lọc riêng). Chạy SAU bước dịch nên "red wine" không bị đụng tới.
const TU_DEM_VI = cum(
  String.raw`khoảng|tầm|giá|dưới|trên|từ|đến|tới|triệu|nghìn|ngàn|k|đ|vnd|cho|mình|em|anh|chị|xin|gợi\s+ý|tư\s+vấn|giúp|loại|chai|một|vài|nào|ngon|rượu|vang|\d+(?:[.,]\d+)?[kđ]?`
);

export function chuanHoaTuKhoa(q: string): string {
  const MOC = "\u0001";
  let r = q ?? "";
  for (const [re, en] of CUM_VI_SANG_EN) r = r.replace(re, ` ${MOC}${en}${MOC} `);
  // Chỉ bỏ từ đệm bên ngoài cụm đã dịch.
  r = r.split(MOC).map((doan, i) => (i % 2 === 1 ? doan : doan.replace(TU_DEM_VI, " "))).join(" ");
  return r.replace(/\s+/g, " ").trim();
}

/**
 * Tìm sản phẩm, có cơ chế nới lỏng nhiều bậc.
 *
 * Bậc 1: đúng toàn bộ điều kiện.
 * Bậc 2: nới khoảng giá ±20%, bỏ thương hiệu.
 * Bậc 3: bỏ hết bộ lọc thuộc tính, chỉ giữ tenant + từ khoá.
 *
 * KHÔNG BAO GIỜ trả về mảng rỗng một cách im lặng: khi đã nới lỏng,
 * `filters_relaxed = true` và `note` mô tả rõ để bot nói lại với khách.
 */
export async function timSanPham(tenantId: string, p: ThamSoTimKiem): Promise<KetQuaTimKiem> {
  const gioiHan = Math.min(Math.max(1, Math.trunc(p.limit ?? 4)), 8);
  const sort = xepTheo(p.sort);

  const chay = async (filter: string[]) => {
    const body: Record<string, unknown> = {
      q: chuanHoaTuKhoa(p.query ?? ""),
      filter,
      limit: gioiHan,
      attributesToRetrieve: [
        "id", "sku", "title", "brand", "store_type",
        "price_vnd", "in_stock", "specs", "thumbnail", "handle",
      ],
    };
    if (sort) body.sort = sort;
    const r = await goiMeili(body);
    return { hits: (r.hits ?? []) as SanPhamTimDuoc[], total: r.estimatedTotalHits ?? r.hits?.length ?? 0 };
  };

  const bocLoc = { ...p };
  const locBac1 = dungBoLoc(tenantId, bocLoc);

  // --- Bậc 1 ---
  let kq = await chay(locBac1);
  if (kq.hits.length > 0) {
    return {
      products: kq.hits, total_found: kq.total,
      filters_applied: bocLoc as Record<string, unknown>,
      filters_relaxed: false, note: null,
    };
  }

  // --- Bậc 2: nới giá ±20%, bỏ thương hiệu ---
  const noiLong: ThamSoTimKiem = { ...bocLoc, brand: undefined };
  if (typeof noiLong.price_max_vnd === "number") noiLong.price_max_vnd = Math.round(noiLong.price_max_vnd * 1.2);
  if (typeof noiLong.price_min_vnd === "number") noiLong.price_min_vnd = Math.round(noiLong.price_min_vnd * 0.8);

  kq = await chay(dungBoLoc(tenantId, noiLong));
  if (kq.hits.length > 0) {
    const phan: string[] = [];
    if (bocLoc.brand) phan.push(`bỏ giới hạn thương hiệu ${bocLoc.brand}`);
    if (typeof bocLoc.price_max_vnd === "number") {
      phan.push(`mở rộng mức giá lên khoảng ${Math.round((noiLong.price_max_vnd ?? 0) / 1000).toLocaleString("vi-VN")}k`);
    }
    return {
      products: kq.hits, total_found: kq.total,
      filters_applied: noiLong as Record<string, unknown>,
      filters_relaxed: true,
      note: `Không có sản phẩm khớp hoàn toàn yêu cầu. Đã ${phan.join(" và ")} để tìm mẫu gần nhất.`,
    };
  }

  // --- Bậc 3: chỉ giữ tenant + từ khoá ---
  kq = await chay([`tenant_id = ${nhayKep(tenantId)}`, "in_stock = true"]);
  return {
    products: kq.hits,
    total_found: kq.total,
    filters_applied: { tenant_id: tenantId },
    filters_relaxed: true,
    note: kq.hits.length > 0
      ? "Không tìm được sản phẩm khớp tiêu chí. Đây là các sản phẩm liên quan trong cửa hàng."
      : "Cửa hàng hiện chưa có sản phẩm phù hợp với yêu cầu này.",
  };
}

/** Lấy tập SKU hợp lệ của tenant để kiểm chứng SKU do LLM sinh ra. */
export async function laySkuHopLe(tenantId: string, skus: string[]): Promise<Set<string>> {
  if (skus.length === 0) return new Set();
  const dieuKien = skus.map((s) => `sku = ${nhayKep(s)}`).join(" OR ");
  const r = await goiMeili({
    q: "",
    filter: [`tenant_id = ${nhayKep(tenantId)}`, `(${dieuKien})`],
    limit: skus.length,
    attributesToRetrieve: ["sku"],
  });
  return new Set(((r.hits ?? []) as Array<{ sku?: string }>).map((h) => h.sku).filter(Boolean) as string[]);
}
