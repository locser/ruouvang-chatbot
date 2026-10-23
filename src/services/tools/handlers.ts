/**
 * MƯỜI TOOL HANDLER — phần thực thi của kiến trúc tool-calling (ADR-006).
 *
 * Đây là mảnh còn thiếu của bản 2.0: `schemas.ts` mô tả hợp đồng gửi cho mô
 * hình, `validate.ts` kiểm chứng tham số, còn file này là nơi thật sự chạm vào
 * Meilisearch và Medusa.
 *
 * BA NGUYÊN TẮC KHÔNG ĐƯỢC PHÁ:
 *
 *  1. Không tin tham số mô hình sinh ra. Mọi handler gọi validate.ts TRƯỚC khi
 *     chạm vào Medusa. Schema chỉ bảo đảm đúng kiểu, không bảo đảm SKU có thật.
 *
 *  2. Giá và tồn kho nói với khách LUÔN đọc lại từ Medusa (ADR-008). Meilisearch
 *     chỉ dùng để TÌM RA sản phẩm nào phù hợp. Sản phẩm không lấy được dữ liệu
 *     thật bị `dinhDangChoLLM()` loại khỏi kết quả — thà thiếu một gợi ý còn hơn
 *     báo sai giá cho người đang chuẩn bị trả tiền.
 *
 *  3. Lỗi trả về cho mô hình dưới dạng dữ liệu, không ném exception. Mô hình đọc
 *     `ok: false` cùng `thong_diep_cho_khach` rồi tự diễn đạt lại cho khách.
 *     Ném exception giữa vòng lặp tool sẽ giết cả lượt trả lời.
 */

import { PoolClient } from "pg";
import { MedusaConfig } from "../medusa";
import {
  medusaCartRetrieve,
  medusaCartCreate,
  medusaCartAddItem,
  medusaCartClear,
  medusaCartRemoveItem,
  medusaCartUpdateQuantity,
  medusaCartUpdateAddress,
  medusaCartCheckout,
  medusaGetPaymentInfo,
  medusaTraCuuDonHang,
  medusaLuuKhachTiemNang,
  medusaGetStoreLocations,
  StoreLocation,
} from "../medusa";
import { cache, buildTenantCacheKey } from "../cache";
import { timSanPham, laySkuHopLe, ThamSoTimKiem } from "../search";
import { lamGiauSanPham, dinhDangChoLLM, traCuuThat } from "../catalog";
import {
  chuanHoaSoLuong,
  chuanHoaSoDienThoai,
  chuanHoaSdtKhachTiemNang,
  kiemTraDinhDangSku,
  kiemTraSkuCoThat,
  kiemTraTonKho,
  kiemTraDanhSachSoSanh,
  kiemTraDuDieuKienChotDon,
  TrangThaiDonHang,
} from "./validate";
import { khachMuonChotDon } from "../checkoutIntent";
import { guiThongBaoDonMoi } from "../telegram";

// ---------------------------------------------------------------------------
// Ngữ cảnh & kiểu trả về
// ---------------------------------------------------------------------------

export interface NguCanhTool {
  tenantId: string;
  conversationId: string;
  client: PoolClient;
  /** null = tenant chưa cấu hình Medusa. Mọi tool chạm thương mại phải từ chối. */
  medusa: MedusaConfig | null;
  /** Giỏ hàng hiện tại của hội thoại. null = chưa tạo. */
  cartId: string | null;
  /** Nguyên văn tin nhắn khách vừa gửi trong lượt này. */
  tinNhanKhach: string;
  /** Handler gọi khi tạo giỏ mới, để orchestrator lưu lại vào conversation. */
  ghiNhanCartId(cartId: string): void;
  /** Handler gọi khi cần chuyển hội thoại cho nhân viên. */
  yeuCauChuyenNguoi(lyDo: string): void;
}

/**
 * Kết quả một tool. Được JSON.stringify rồi gửi lại mô hình dưới dạng
 * message `role: "tool"`.
 */
export interface KetQuaTool {
  ok: boolean;
  /** Câu gợi ý cho mô hình diễn đạt lại với khách khi ok = false. */
  thong_diep_cho_khach?: string;
  /** Mã lỗi nội bộ, để ghi log và truy vết. Không đọc cho khách. */
  ma_loi?: string;
  [khac: string]: unknown;
}

function loi(maLoi: string, thongDiep: string, them: Record<string, unknown> = {}): KetQuaTool {
  return { ok: false, ma_loi: maLoi, thong_diep_cho_khach: thongDiep, ...them };
}

function thanhCong(du_lieu: Record<string, unknown>): KetQuaTool {
  return { ok: true, ...du_lieu };
}

/** Tenant chưa nối Medusa — dùng chung cho mọi tool chạm vào thương mại. */
function chuaCoMedusa(): KetQuaTool {
  return loi(
    "CHUA_CAU_HINH_MEDUSA",
    "Dạ em xin phép chuyển anh/chị tới nhân viên để hỗ trợ đặt hàng ngay ạ!"
  );
}

/**
 * Bảo đảm hội thoại có giỏ hàng, tạo mới nếu chưa có.
 *
 * Tạo giỏ là thao tác có tác dụng phụ nên chỉ gọi từ các tool thật sự cần ghi
 * (set_cart_item, set_shipping_info, checkout) — không gọi từ tool chỉ đọc.
 */
async function damBaoCoGio(nc: NguCanhTool, medusa: MedusaConfig): Promise<string> {
  if (nc.cartId) return nc.cartId;
  const gio = await medusaCartCreate(medusa);
  const id = gio?.cart?.id ?? gio?.id;
  if (!id) throw new Error("Medusa trả về giỏ hàng không có id");
  nc.cartId = id;
  nc.ghiNhanCartId(id);
  return id;
}

/** Đọc giỏ hàng hiện tại. Trả về null khi chưa có giỏ hoặc đọc lỗi. */
async function docGio(nc: NguCanhTool, medusa: MedusaConfig): Promise<any | null> {
  if (!nc.cartId) return null;
  try {
    const r = await medusaCartRetrieve(medusa, nc.cartId);
    return r?.cart ?? r ?? null;
  } catch (e) {
    console.error("[Tool] Không đọc được giỏ hàng:", e);
    return null;
  }
}

/** Tóm tắt giỏ hàng cho mô hình — luôn kèm số lượng để nó tính tổng tuyệt đối. */
function tomTatGio(gio: any): Array<Record<string, unknown>> {
  const items = gio?.items ?? [];
  return items.map((i: any) => ({
    sku: i?.variant?.sku ?? i?.sku ?? null,
    title: i?.title ?? i?.product_title ?? null,
    quantity: i?.quantity ?? 0,
    unit_price_vnd: i?.unit_price ?? null,
  }));
}

// ---------------------------------------------------------------------------
// 1. search_products
// ---------------------------------------------------------------------------

export async function xuLySearchProducts(nc: NguCanhTool, args: any): Promise<KetQuaTool> {
  console.log("[DEBUG search_products] args LLM gửi:", JSON.stringify(args));
  const thamSo: ThamSoTimKiem = {
    query: typeof args?.query === "string" ? args.query : undefined,
    store_type: args?.store_type,
    brand: typeof args?.brand === "string" ? args.brand : undefined,
    category: typeof args?.category === "string" ? args.category : undefined,
    price_min_vnd: typeof args?.price_min_vnd === "number" ? args.price_min_vnd : undefined,
    price_max_vnd: typeof args?.price_max_vnd === "number" ? args.price_max_vnd : undefined,
    ram_gb_min: typeof args?.ram_gb_min === "number" ? args.ram_gb_min : undefined,
    storage_gb_min: typeof args?.storage_gb_min === "number" ? args.storage_gb_min : undefined,
    battery_mah_min: typeof args?.battery_mah_min === "number" ? args.battery_mah_min : undefined,
    storage_condition: args?.storage_condition,
    origin_region: typeof args?.origin_region === "string" ? args.origin_region : undefined,
    organic_certified: typeof args?.organic_certified === "boolean" ? args.organic_certified : undefined,
    in_stock_only: typeof args?.in_stock_only === "boolean" ? args.in_stock_only : undefined,
    sort: args?.sort,
    limit: typeof args?.limit === "number" ? args.limit : undefined,
  };

  let kq;
  try {
    kq = await timSanPham(nc.tenantId, thamSo);
  } catch (e) {
    console.error("[Tool search_products] Meilisearch lỗi:", e);
    nc.yeuCauChuyenNguoi("Meilisearch không phản hồi");
    return loi(
      "TIM_KIEM_LOI",
      "Dạ hệ thống tra cứu đang bận, em xin phép chuyển nhân viên hỗ trợ anh/chị ngay ạ!"
    );
  }

  // Làm giàu bằng giá & tồn kho THẬT. Không có Medusa thì không được báo giá.
  const dayDu = await lamGiauSanPham(nc.medusa, kq.products);
  const choLLM = dinhDangChoLLM(dayDu);
  console.log(
    `[DEBUG search_products] Meili trả ${kq.products.length} (tổng ${kq.total_found}, nới lỏng=${kq.filters_relaxed}); ` +
    `sau làm giàu: ${dayDu.map((d) => `${d.sku}:${d.thieu_du_lieu_that ? "THIEU" : `con_hang=${d.con_hang_that},ton=${d.ton_kho_that},gia=${d.gia_that_vnd}`}`).join(" | ")}; ` +
    `gửi LLM: ${choLLM.length}`
  );

  if (choLLM.length === 0) {
    return thanhCong({
      products: [],
      total_found: 0,
      filters_relaxed: kq.filters_relaxed,
      note:
        dayDu.length > 0
          ? "Tìm thấy sản phẩm nhưng chưa đọc được giá và tồn kho thật. TUYỆT ĐỐI không báo giá. Hãy xin lỗi khách và đề nghị chuyển nhân viên."
          : kq.note,
    });
  }

  return thanhCong({
    products: choLLM,
    total_found: kq.total_found,
    filters_relaxed: kq.filters_relaxed,
    // Khi hệ thống tự nới lỏng điều kiện, bot BẮT BUỘC nói rõ với khách —
    // im lặng đưa hàng lệch tiêu chí là một dạng nói dối.
    note: kq.note,
  });
}

// ---------------------------------------------------------------------------
// 2. get_product_detail
// ---------------------------------------------------------------------------

export async function xuLyGetProductDetail(nc: NguCanhTool, args: any): Promise<KetQuaTool> {
  const id = typeof args?.product_id === "string" ? args.product_id.trim() : "";
  if (!id) {
    return loi("THIEU_PRODUCT_ID", "Dạ anh/chị cho em xin lại tên sản phẩm muốn xem chi tiết nhé!");
  }
  if (!nc.medusa) return chuaCoMedusa();

  try {
    const kq = await traCuuThat(nc.medusa, { ids: [id] });
    const m = kq.items[0];
    if (!m) {
      return loi(
        "KHONG_TIM_THAY_SAN_PHAM",
        "Dạ em chưa tìm thấy sản phẩm này ạ. Anh/chị cho em xin lại tên sản phẩm nhé!"
      );
    }
    return thanhCong({
      product: {
        id: m.product_id,
        sku: m.sku,
        title: m.title,
        price_vnd: m.price_vnd,
        stock_qty: m.stock_qty,
        in_stock: m.in_stock,
        url: m.handle ? `/products/${m.handle}` : undefined,
      },
    });
  } catch (e) {
    console.error("[Tool get_product_detail] Medusa lỗi:", e);
    return loi(
      "MEDUSA_LOI",
      "Dạ em đang kiểm tra lại thông tin sản phẩm, anh/chị đợi em một chút nhé!"
    );
  }
}

// ---------------------------------------------------------------------------
// 3. compare_products
// ---------------------------------------------------------------------------

export async function xuLyCompareProducts(nc: NguCanhTool, args: any): Promise<KetQuaTool> {
  const kt = kiemTraDanhSachSoSanh(args?.product_ids);
  if (!kt.hopLe) return loi(kt.maLoi, kt.thongDiepChoKhach);
  if (!nc.medusa) return chuaCoMedusa();

  try {
    const kq = await traCuuThat(nc.medusa, { ids: kt.duLieu });
    if (kq.items.length < 2) {
      return loi(
        "SO_SANH_THIEU_DU_LIEU",
        "Dạ em chưa lấy đủ thông tin để so sánh ạ. Anh/chị cho em xin lại tên các sản phẩm nhé!"
      );
    }
    return thanhCong({
      products: kq.items.map((m) => ({
        id: m.product_id,
        sku: m.sku,
        title: m.title,
        price_vnd: m.price_vnd,
        stock_qty: m.stock_qty,
      })),
    });
  } catch (e) {
    console.error("[Tool compare_products] Medusa lỗi:", e);
    return loi("MEDUSA_LOI", "Dạ em đang tra lại thông tin, anh/chị đợi em chút nhé!");
  }
}

// ---------------------------------------------------------------------------
// 4. set_cart_item — SỐ LƯỢNG TUYỆT ĐỐI (ADR-007)
// ---------------------------------------------------------------------------

/**
 * `quantity` là TỔNG số lượng cuối cùng, không phải phần tăng thêm.
 *
 * Phép cộng do server làm, không giao cho mô hình: ngày 28/07/2026 khách nói
 * "thêm 2 hộp nữa" khi giỏ đang có 5, mô hình gọi với quantity = 2 và giỏ tụt
 * xuống 2 — trừ mất hàng của khách. Ở đây ta ghi đè thẳng số lượng cuối cùng,
 * nên kể cả khi mô hình hiểu sai thì hậu quả vẫn nằm trong tầm kiểm soát và
 * quan sát được.
 */
export async function xuLySetCartItem(nc: NguCanhTool, args: any): Promise<KetQuaTool> {
  const ktSku = kiemTraDinhDangSku(args?.sku);
  if (!ktSku.hopLe) return loi(ktSku.maLoi, ktSku.thongDiepChoKhach);
  const sku = ktSku.duLieu;

  const ktSl = chuanHoaSoLuong(args?.quantity);
  if (!ktSl.hopLe) {
    // Vượt trần số lượng là tình huống bán sỉ — chuyển người, đừng tự quyết.
    if (ktSl.maLoi === "SO_LUONG_VUOT_TRAN") nc.yeuCauChuyenNguoi("Khách đặt số lượng lớn, cần báo giá sỉ");
    return loi(ktSl.maLoi, ktSl.thongDiepChoKhach);
  }
  const { soLuong, laXoaMon } = ktSl.duLieu;

  if (!nc.medusa) return chuaCoMedusa();
  const medusa = nc.medusa;

  // Chốt chặn chống ảo giác: SKU phải có thật trong danh mục của CHÍNH tenant này.
  let skuHopLe: Set<string>;
  try {
    skuHopLe = await laySkuHopLe(nc.tenantId, [sku]);
  } catch (e) {
    console.error("[Tool set_cart_item] Không kiểm chứng được SKU:", e);
    return loi(
      "KHONG_KIEM_CHUNG_DUOC_SKU",
      "Dạ em đang kiểm tra lại sản phẩm, anh/chị đợi em một chút nhé!"
    );
  }
  const ktThat = kiemTraSkuCoThat(sku, skuHopLe);
  if (!ktThat.hopLe) {
    console.warn(`[Tool set_cart_item] Mô hình bịa SKU "${sku}" cho tenant ${nc.tenantId}`);
    return loi(ktThat.maLoi, ktThat.thongDiepChoKhach);
  }

  try {
    const cartId = await damBaoCoGio(nc, medusa);

    // quantity = 0 nghĩa là bỏ món, không phải đặt 1 món.
    if (laXoaMon) {
      await medusaCartRemoveItem(medusa, cartId, sku);
      const gio = await docGio(nc, medusa);
      return thanhCong({ da_bo_mon: sku, cart: tomTatGio(gio) });
    }

    // Tồn kho THẬT tại thời điểm này, không lấy từ index tìm kiếm.
    const traCuu = await traCuuThat(medusa, { skus: [sku] });
    const muc = traCuu.items.find((m) => m.sku === sku) ?? traCuu.items[0];
    // `in_stock = true` kèm `stock_qty = 0` là dấu hiệu của biến thể không quản
    // lý tồn kho (manage_inventory = false) — luôn bán được.
    const khongGioiHan = muc?.in_stock === true && (muc?.stock_qty ?? 0) === 0;
    const ktKho = kiemTraTonKho(soLuong, muc ? muc.stock_qty : null, khongGioiHan);
    if (!ktKho.hopLe) return loi(ktKho.maLoi, ktKho.thongDiepChoKhach, { ton_kho_con: muc?.stock_qty ?? null });

    // Món đã có trong giỏ thì ghi đè số lượng, chưa có thì thêm mới.
    const gioTruoc = await docGio(nc, medusa);
    const daCo = (gioTruoc?.items ?? []).some(
      (i: any) => (i?.variant?.sku ?? i?.sku) === sku
    );

    if (daCo) await medusaCartUpdateQuantity(medusa, cartId, sku, soLuong);
    else await medusaCartAddItem(medusa, cartId, sku, soLuong);

    const gioSau = await docGio(nc, medusa);
    return thanhCong({
      sku,
      quantity_da_dat: soLuong,
      unit_price_vnd: muc?.price_vnd ?? null,
      cart: tomTatGio(gioSau),
    });
  } catch (e: any) {
    console.error("[Tool set_cart_item] Lỗi khi ghi giỏ:", e);
    return loi(
      "GHI_GIO_LOI",
      "Dạ em chưa thêm được vào giỏ ạ. Anh/chị thử lại giúp em hoặc để em chuyển nhân viên hỗ trợ nhé!"
    );
  }
}

// ---------------------------------------------------------------------------
// 5. remove_cart_item
// ---------------------------------------------------------------------------

export async function xuLyRemoveCartItem(nc: NguCanhTool, args: any): Promise<KetQuaTool> {
  const ktSku = kiemTraDinhDangSku(args?.sku);
  if (!ktSku.hopLe) return loi(ktSku.maLoi, ktSku.thongDiepChoKhach);
  if (!nc.medusa) return chuaCoMedusa();
  if (!nc.cartId) {
    return loi("GIO_CHUA_TON_TAI", "Dạ giỏ hàng của anh/chị đang trống ạ!");
  }

  try {
    await medusaCartRemoveItem(nc.medusa, nc.cartId, ktSku.duLieu);
    const gio = await docGio(nc, nc.medusa);
    return thanhCong({ da_bo_mon: ktSku.duLieu, cart: tomTatGio(gio) });
  } catch (e) {
    console.error("[Tool remove_cart_item] Lỗi:", e);
    return loi("XOA_MON_LOI", "Dạ em chưa bỏ được món này ra khỏi giỏ ạ, anh/chị thử lại giúp em nhé!");
  }
}

// ---------------------------------------------------------------------------
// 6. clear_cart
// ---------------------------------------------------------------------------

export async function xuLyClearCart(nc: NguCanhTool, _args: any): Promise<KetQuaTool> {
  if (!nc.medusa) return chuaCoMedusa();
  if (!nc.cartId) return thanhCong({ cart: [], ghi_chu: "Giỏ hàng vốn đã trống." });

  try {
    await medusaCartClear(nc.medusa, nc.cartId);
    return thanhCong({ cart: [], da_xoa_toan_bo: true });
  } catch (e) {
    console.error("[Tool clear_cart] Lỗi:", e);
    return loi("XOA_GIO_LOI", "Dạ em chưa xoá được giỏ hàng ạ, anh/chị thử lại giúp em nhé!");
  }
}

// ---------------------------------------------------------------------------
// 7. set_shipping_info
// ---------------------------------------------------------------------------

export async function xuLySetShippingInfo(nc: NguCanhTool, args: any): Promise<KetQuaTool> {
  if (!nc.medusa) return chuaCoMedusa();
  const medusa = nc.medusa;

  const diaChi: Record<string, string> = {};

  if (args?.phone !== undefined) {
    const ktSdt = chuanHoaSoDienThoai(args.phone);
    if (!ktSdt.hopLe) return loi(ktSdt.maLoi, ktSdt.thongDiepChoKhach);
    diaChi.phone = ktSdt.duLieu;
  }
  if (typeof args?.address === "string" && args.address.trim()) diaChi.address = args.address.trim();
  if (typeof args?.recipient_name === "string" && args.recipient_name.trim()) {
    diaChi.firstName = args.recipient_name.trim();
  }
  if (typeof args?.province === "string" && args.province.trim()) diaChi.province = args.province.trim();

  if (Object.keys(diaChi).length === 0) {
    return loi(
      "THIEU_THONG_TIN_GIAO_HANG",
      "Dạ anh/chị cho em xin số điện thoại, địa chỉ nhận hàng và tên người nhận giúp em nhé!"
    );
  }

  try {
    const cartId = await damBaoCoGio(nc, medusa);
    const kqDiaChi = await medusaCartUpdateAddress(medusa, cartId, diaChi);
    const tong = kqDiaChi?.totals;
    const coTamTinh = tong && typeof tong.total === "number" && tong.total > 0;
    return thanhCong({
      da_ghi_nhan: {
        phone: diaChi.phone ?? null,
        address: diaChi.address ?? null,
        recipient_name: diaChi.firstName ?? null,
      },
      tam_tinh: coTamTinh
        ? { tien_hang_vnd: tong.item_total, phi_ship_vnd: tong.shipping_total, tong_tien_vnd: tong.total }
        : null,
      luu_y: coTamTinh
        ? "Khi tóm tắt đơn để khách xác nhận, PHẢI ghi đủ: tiền hàng + phí ship = tổng (lấy đúng số trong tam_tinh). Phí ship 0 thì ghi miễn phí ship."
        : "Chưa tính được phí ship: khi tóm tắt đơn, nói rõ tổng chưa gồm phí ship và phí ship sẽ báo khi chốt đơn.",
    });
  } catch (e) {
    console.error("[Tool set_shipping_info] Lỗi:", e);
    return loi("GHI_DIA_CHI_LOI", "Dạ em chưa lưu được thông tin giao hàng ạ, anh/chị nhắn lại giúp em nhé!");
  }
}

// ---------------------------------------------------------------------------
// 8. checkout — TẠO ĐƠN THẬT, TRỪ TỒN KHO THẬT
// ---------------------------------------------------------------------------

/**
 * Tool duy nhất đụng vào tiền. Bảy điều kiện phải đúng hết mới chạy.
 *
 * Điều kiện quan trọng nhất là `khach_da_xac_nhan`. Ngày 28/07/2026 một guard
 * đoán ý bằng regex khớp cả chữ "đâu" khiến câu "shop ở đâu vậy em?" tạo ra
 * đơn hàng thật. Vì vậy ở đây so sánh `=== true` chứ không dùng truthy: chuỗi
 * "false" là truthy trong JavaScript, và mô hình thỉnh thoảng trả về chuỗi.
 *
 * Lệch giá được tính bằng cách đọc lại giá THẬT của từng món rồi so với giá
 * đang nằm trong giỏ. Khách phải được báo lại nếu giá đổi giữa lúc tư vấn và
 * lúc chốt — im lặng thu tiền theo giá mới là lừa khách.
 */
export async function xuLyCheckout(nc: NguCanhTool, args: any): Promise<KetQuaTool> {
  if (!nc.medusa) return chuaCoMedusa();
  const medusa = nc.medusa;

  const daXacNhan = args?.khach_da_xac_nhan === true;

  // Tín hiệu đối chiếu: mô hình nói khách đã xác nhận nhưng câu khách vừa gửi
  // không mang ý chốt đơn. Không chặn (sẽ chặn nhầm câu "ok em" hợp lệ), nhưng
  // phải quan sát được — đây là nơi lỗi tự chốt đơn sẽ lộ ra.
  if (daXacNhan && !khachMuonChotDon(nc.tinNhanKhach)) {
    console.warn(
      `[Tool checkout] Mô hình khai khách đã xác nhận nhưng tin nhắn không có ý chốt đơn. ` +
      `tenant=${nc.tenantId} conversation=${nc.conversationId} tin_nhan="${nc.tinNhanKhach.slice(0, 120)}"`
    );
  }

  const gio = await docGio(nc, medusa);
  const items: any[] = gio?.items ?? [];
  const diaChi = gio?.shipping_address ?? {};

  // Đọc lại giá & tồn kho THẬT của từng món trong giỏ.
  const skus = items
    .map((i) => i?.variant?.sku ?? i?.sku)
    .filter((s): s is string => typeof s === "string" && s.length > 0);

  const monHetHang: string[] = [];
  let lechTien = 0;

  if (skus.length > 0) {
    try {
      const traCuu = await traCuuThat(medusa, { skus });
      const theoSku = new Map(traCuu.items.map((m) => [m.sku ?? "", m]));

      for (const i of items) {
        const sku = i?.variant?.sku ?? i?.sku;
        const sl = Number(i?.quantity ?? 0);
        const that = sku ? theoSku.get(sku) : undefined;

        if (!that) {
          monHetHang.push(i?.title ?? sku ?? "sản phẩm");
          continue;
        }
        // Bỏ qua kiểm tra số lượng với hàng không quản lý tồn kho (xem ghi chú
        // ở `kiemTraTonKho`), nếu không mọi đơn đều bị chặn ở bước chốt.
        const khongGioiHanChot = that.in_stock === true && (that.stock_qty ?? 0) === 0;
        if (!khongGioiHanChot && that.stock_qty < sl) {
          monHetHang.push(i?.title ?? sku ?? "sản phẩm");
          continue;
        }
        const giaTrongGio = Number(i?.unit_price ?? that.price_vnd);
        lechTien += (that.price_vnd - giaTrongGio) * sl;
      }
    } catch (e) {
      console.error("[Tool checkout] Không đọc được giá/tồn kho thật:", e);
      return loi(
        "KHONG_DOC_DUOC_GIA_THAT",
        "Dạ em đang kiểm tra lại giá và tồn kho, anh/chị đợi em một chút nhé!"
      );
    }
  }

  // Cửa hàng đã cấu hình tài khoản ngân hàng chưa — không có thì không sinh được VietQR.
  let coTaiKhoan = false;
  try {
    const tt = await medusaGetPaymentInfo(medusa);
    coTaiKhoan = Boolean(tt?.bank_account ?? tt?.account_number ?? tt?.accountNumber);
  } catch (e) {
    console.error("[Tool checkout] Không đọc được thông tin ngân hàng:", e);
  }

  const trangThai: TrangThaiDonHang = {
    soMonTrongGio: items.length,
    coSoDienThoai: Boolean(diaChi?.phone),
    coDiaChi: Boolean(diaChi?.address_1 ?? diaChi?.address),
    coTenNguoiNhan: Boolean(diaChi?.first_name ?? diaChi?.firstName),
    khachDaXacNhan: daXacNhan,
    shopCoTaiKhoanNganHang: coTaiKhoan,
    monHetHang,
    lechTien,
  };

  const kt = kiemTraDuDieuKienChotDon(trangThai);
  if (!kt.hopLe) {
    if (kt.maLoi === "SHOP_CHUA_CAU_HINH_NGAN_HANG") {
      nc.yeuCauChuyenNguoi("Cửa hàng chưa cấu hình tài khoản ngân hàng");
    }
    return loi(kt.maLoi, kt.thongDiepChoKhach, { cart: tomTatGio(gio) });
  }

  try {
    const kq = await medusaCartCheckout(medusa, nc.cartId!);
    return thanhCong({
      da_chot_don: true,
      order_id: kq?.order?.id ?? kq?.order_id ?? null,
      order_display_id: kq?.order?.display_id ?? null,
      // Mã khách nhìn thấy, trùng với storefront và trang theo dõi đơn.
      ma_don_hien_thi: kq?.order?.display_id != null ? `CW${kq.order.display_id}` : null,
      luu_y: "Khi báo mã đơn cho khách CHỈ dùng ma_don_hien_thi, tuyệt đối không đọc order_id nội bộ. Khi nói tổng tiền, tách rõ tien_hang_vnd + phi_ship_vnd = tong_tien_vnd.",
      tong_tien_vnd: kq?.order?.total ?? null,
      // Medusa v2: `subtotal` của đơn đã gồm phí ship; tiền hàng là `item_total`.
      tien_hang_vnd: typeof kq?.order?.item_total === "number"
        ? kq.order.item_total
        : (typeof kq?.order?.total === "number" && typeof kq?.order?.shipping_total === "number"
          ? kq.order.total - kq.order.shipping_total
          : null),
      phi_ship_vnd: kq?.order?.shipping_total ?? null,
      qr_url: kq?.qr_url ?? kq?.vietqr_url ?? null,
    });
  } catch (e) {
    console.error("[Tool checkout] Chốt đơn thất bại:", e);
    nc.yeuCauChuyenNguoi("Chốt đơn qua Medusa thất bại");
    return loi(
      "CHOT_DON_THAT_BAI",
      "Dạ em chưa chốt được đơn ạ. Em xin phép chuyển nhân viên hoàn tất giúp anh/chị ngay!"
    );
  }
}

// ---------------------------------------------------------------------------
// 9. get_order_status
// ---------------------------------------------------------------------------

export async function xuLyGetOrderStatus(nc: NguCanhTool, args: any): Promise<KetQuaTool> {
  if (!nc.medusa) return chuaCoMedusa();

  const maDon = typeof args?.order_code === "string" ? args.order_code.trim() : "";
  const sdt = typeof args?.phone === "string" ? args.phone.replace(/\D/g, "") : "";

  // Phải có CẢ mã đơn và số điện thoại: mã đơn một mình không đủ để xem đơn.
  if (!maDon) {
    return loi(
      "THIEU_MA_DON",
      "Dạ anh/chị cho em xin mã đơn hàng giúp em nhé (ví dụ CW12), hoặc em chuyển nhân viên tra giúp anh/chị ngay ạ!"
    );
  }
  if (!sdt) {
    return loi(
      "THIEU_SO_DIEN_THOAI",
      "Dạ anh/chị cho em xin số điện thoại đã dùng để đặt hàng để em kiểm tra đơn giúp anh/chị nhé!"
    );
  }

  try {
    const kq = await medusaTraCuuDonHang(nc.medusa, maDon, sdt);
    if (!kq.found) {
      // Không phân biệt "sai mã" với "sai số điện thoại" để không ai dò được đơn.
      return loi(
        "KHONG_TIM_THAY_DON",
        "Dạ em chưa tìm thấy đơn nào khớp với mã đơn và số điện thoại này. Anh/chị kiểm tra lại giúp em nhé!"
      );
    }
    return thanhCong({ order: kq.order });
  } catch (e) {
    console.error("[Tool get_order_status] Medusa lỗi:", e);
    return loi("TRA_DON_LOI", "Dạ em chưa tra được đơn lúc này ạ. Anh/chị thử lại sau ít phút nhé!");
  }
}

// ---------------------------------------------------------------------------
// 10. escalate_to_human
// ---------------------------------------------------------------------------

export async function xuLyEscalateToHuman(nc: NguCanhTool, args: any): Promise<KetQuaTool> {
  const lyDo = typeof args?.reason === "string" && args.reason.trim() ? args.reason.trim() : "Khách cần hỗ trợ trực tiếp";
  nc.yeuCauChuyenNguoi(lyDo);
  return thanhCong({
    da_chuyen_nhan_vien: true,
    ly_do: lyDo,
    huong_dan: "Hãy báo khách rằng nhân viên sẽ tiếp nhận ngay. Không hứa thời gian cụ thể.",
  });
}

// ---------------------------------------------------------------------------
// 11. save_lead — khách để lại số để nhân viên gọi tư vấn
// ---------------------------------------------------------------------------

const escHtml = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export async function xuLySaveLead(nc: NguCanhTool, args: any): Promise<KetQuaTool> {
  const sdt = chuanHoaSdtKhachTiemNang(args?.phone);
  if (!sdt.hopLe) return loi(sdt.maLoi, sdt.thongDiepChoKhach);

  const cat = (v: unknown, n: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null);
  const ten = cat(args?.name, 100);
  const nhuCau = cat(args?.need, 500);

  // Mỗi hội thoại một dòng. Chỉ báo nhân viên lần đầu hoặc khi khách đổi số;
  // khách bổ sung tên/nhu cầu thì cập nhật âm thầm để không spam Telegram.
  const r = await nc.client.query(
    `INSERT INTO khach_tiem_nang (tenant_id, conversation_id, ten, so_dien_thoai, nhu_cau)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (conversation_id) DO UPDATE SET
       ten = COALESCE(EXCLUDED.ten, khach_tiem_nang.ten),
       nhu_cau = COALESCE(EXCLUDED.nhu_cau, khach_tiem_nang.nhu_cau),
       da_bao_nhan_vien = khach_tiem_nang.da_bao_nhan_vien AND khach_tiem_nang.so_dien_thoai = EXCLUDED.so_dien_thoai,
       so_dien_thoai = EXCLUDED.so_dien_thoai,
       da_dong_bo_backend = false,
       cap_nhat_luc = now()
     RETURNING id, ten, nhu_cau, da_bao_nhan_vien`,
    [nc.tenantId, nc.conversationId, ten, sdt.duLieu, nhuCau]
  );
  const dong = r.rows[0];

  // Đẩy sang backend Medusa. Lỗi thì giữ cờ chưa đồng bộ, vòng nền sẽ thử lại.
  if (nc.medusa) {
    try {
      await medusaLuuKhachTiemNang(nc.medusa, {
        conversation_id: nc.conversationId, phone: sdt.duLieu, name: dong.ten, need: dong.nhu_cau,
      });
      await nc.client.query(`UPDATE khach_tiem_nang SET da_dong_bo_backend = true WHERE id = $1`, [dong.id]);
    } catch (e) {
      console.error("[Tool save_lead] Chưa đẩy được sang backend, sẽ thử lại:", e);
    }
  }

  if (!dong.da_bao_nhan_vien) {
    try {
      const soNoi = await guiThongBaoDonMoi(
        nc.tenantId,
        `📞 <b>KHÁCH ĐỂ LẠI SỐ — CẦN GỌI TƯ VẤN</b>

` +
          `👤 ${escHtml(dong.ten ?? "(chưa rõ tên)")}
` +
          `📱 <code>${sdt.duLieu}</code>
` +
          `📝 ${escHtml(dong.nhu_cau ?? "(chưa ghi nhu cầu)")}

` +
          `Hội thoại: <code>${nc.conversationId}</code>`
      );
      if (soNoi > 0) {
        await nc.client.query(`UPDATE khach_tiem_nang SET da_bao_nhan_vien = true WHERE id = $1`, [dong.id]);
      }
    } catch (e) {
      // Báo Telegram hỏng không được làm mất lead: dòng đã nằm trong CSDL.
      console.error("[Tool save_lead] Không báo được nhân viên:", e);
    }
  }

  return thanhCong({
    da_luu: true,
    huong_dan:
      "Cảm ơn khách và báo nhân viên sẽ gọi lại số này để tư vấn thêm. KHÔNG hứa giờ gọi cụ thể. " +
      "Vẫn tiếp tục tư vấn nếu khách còn hỏi. Chỉ đọc số hotline nếu có trong TRI THỨC NỘI BỘ.",
  });
}

// ---------------------------------------------------------------------------
// 12. get_store_locations — chi nhánh thật, không bịa
// ---------------------------------------------------------------------------

const STORE_LOCATIONS_TTL_SECONDS = 300;
const NO_STORE_INFO_MESSAGE =
  "Hiện chưa có thông tin chi nhánh từ hệ thống. Nếu mục TRI THỨC NỘI BỘ có thông tin cửa hàng thì dùng; " +
  "nếu không, nói: Dạ em xin phép chuyển nhân viên hỗ trợ anh/chị ạ. TUYỆT ĐỐI không tự nêu địa chỉ hay số điện thoại.";

function stripDiacritics(v: string): string {
  return v.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/gi, "d").toLowerCase();
}

/** Chuẩn hoá để so khớp theo ranh giới từ: bỏ dấu, "q1"/"q.1" -> "quan 1", dấu câu -> khoảng trắng. */
function normalizeForMatch(v: string): string {
  const t = stripDiacritics(v)
    .replace(/\bq\.?\s*(\d)/g, "quan $1")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return ` ${t} `;
}

export async function xuLyGetStoreLocations(nc: NguCanhTool, args: any): Promise<KetQuaTool> {
  if (!nc.medusa) return loi("NO_STORE_INFO", NO_STORE_INFO_MESSAGE);

  const area = typeof args?.area === "string" ? args.area.trim() : "";
  const key = buildTenantCacheKey(nc.tenantId, "store-locations", "all");

  let stores: StoreLocation[] | null = null;
  try {
    const hit = await cache.get(key);
    if (hit) {
      const parsed = JSON.parse(hit);
      stores = Array.isArray(parsed) ? parsed : null;
    }
  } catch {
    stores = null;
  }

  if (!stores) {
    try {
      stores = await medusaGetStoreLocations(nc.medusa);
    } catch (e) {
      console.error("[Tool get_store_locations] Medusa lỗi:", e);
      return loi("NO_STORE_INFO", NO_STORE_INFO_MESSAGE);
    }
    stores = stores.filter((s) => s && typeof s.address === "string" && s.address.trim() !== "");
    if (stores.length > 0) {
      await cache.set(key, JSON.stringify(stores), STORE_LOCATIONS_TTL_SECONDS).catch(() => undefined);
    }
  }

  if (stores.length === 0) return loi("NO_STORE_INFO", NO_STORE_INFO_MESSAGE);

  let matched = stores;
  let areaMatched = true;
  if (area) {
    const needle = normalizeForMatch(area);
    const filtered = stores.filter((s) => normalizeForMatch(`${s.name ?? ""} ${s.address ?? ""}`).includes(needle));
    if (filtered.length > 0) matched = filtered;
    else areaMatched = false; // không khớp khu vực: trả đủ danh sách, nói rõ cho mô hình
  }

  return thanhCong({
    stores: matched.map((s) => ({
      name: s.name,
      address: s.address,
      phone: s.phone ?? null,
      opening_hours: s.opening_hours ?? null,
      maps_url: s.maps_url ?? null,
    })),
    ...(area && !areaMatched
      ? { luu_y: `Không có chi nhánh nào khớp khu vực "${area}"; đây là toàn bộ chi nhánh. Nói rõ điều này với khách.` }
      : {}),
    huong_dan: "Chỉ nêu thông tin có trong danh sách. Trường null nghĩa là chưa có thông tin, không tự điền.",
  });
}

// ---------------------------------------------------------------------------
// Bộ điều phối
// ---------------------------------------------------------------------------

export type HamXuLyTool = (nc: NguCanhTool, args: any) => Promise<KetQuaTool>;

export const BANG_HANDLER: Record<string, HamXuLyTool> = {
  search_products: xuLySearchProducts,
  get_product_detail: xuLyGetProductDetail,
  compare_products: xuLyCompareProducts,
  set_cart_item: xuLySetCartItem,
  remove_cart_item: xuLyRemoveCartItem,
  clear_cart: xuLyClearCart,
  set_shipping_info: xuLySetShippingInfo,
  checkout: xuLyCheckout,
  get_order_status: xuLyGetOrderStatus,
  escalate_to_human: xuLyEscalateToHuman,
  save_lead: xuLySaveLead,
  get_store_locations: xuLyGetStoreLocations,
};

/**
 * Chạy một tool call đã được kiểm tra tên.
 *
 * Bọc try/catch tổng: một handler ném exception không được phép giết cả lượt
 * trả lời — mô hình cần nhận lại kết quả để nói với khách một câu tử tế.
 */
export async function chayTool(nc: NguCanhTool, ten: string, args: any): Promise<KetQuaTool> {
  const handler = BANG_HANDLER[ten];
  if (!handler) {
    return loi("TOOL_KHONG_TON_TAI", "Dạ em chưa hỗ trợ thao tác này ạ!");
  }
  try {
    return await handler(nc, args);
  } catch (e: any) {
    console.error(`[Tool ${ten}] Lỗi không lường trước:`, e);
    return loi(
      "LOI_KHONG_LUONG_TRUOC",
      "Dạ em gặp trục trặc kỹ thuật ạ. Em xin phép chuyển nhân viên hỗ trợ anh/chị ngay!"
    );
  }
}
