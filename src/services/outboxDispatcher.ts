import { pool, runInTenantContext } from "../db/client";
import { env } from "../config/env";
import { cache } from "./cache";
import { fetchCoTimeout, TIMEOUT } from "./http";
import { getTenantMedusaConfig, MedusaConfig } from "./medusa";
import { guiThongBaoDonMoi } from "./telegram";

/**
 * Kéo cảnh báo tự động của backend Medusa (bảng ai_outbox) và gửi vào nhóm Telegram của shop.
 * Chỉ nhận 3 loại an toàn. KHÔNG nhận "chot_don" (trùng thông báo đơn mới) và
 * "gui_email_marketing" (chứa email khách).
 */
export const ALLOWED_OUTBOX_TYPES = ["bao_cao_doanh_thu", "canh_bao_het_hang", "canh_bao_loi_thanh_toan"] as const;

export interface OutboxItem {
  id: string;
  loai: string;
  tham_chieu?: string;
  du_lieu: any;
  tao_luc?: string;
  so_lan_thu?: number;
  claimed_at?: string;
}

const INTERVAL_MS = 60_000;
const DEDUPE_TTL_SECONDS = 30 * 60; // lớn hơn 10 phút backend cho phép giành lại dòng treo

// ---------------------------------------------------------------------------
// Định dạng (hàm thuần)
// ---------------------------------------------------------------------------

const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** 1250000 -> "1.250.000đ" */
export function formatVnd(n: number): string {
  const s = String(Math.round(Math.abs(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${n < 0 ? "-" : ""}${s}đ`;
}

/** Giờ:phút theo giờ Việt Nam (UTC+7) của một mốc thời gian ISO. */
function gioVietNam(iso: unknown): string | null {
  if (typeof iso !== "string") return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  const d = new Date(t + 7 * 3600_000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

/** dd/mm theo giờ Việt Nam. */
function ngayVietNam(t: number): string {
  const d = new Date(t + 7 * 3600_000);
  return `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function mocThoiGian(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

export function formatRevenueReport(d: any, opts: { now?: number; taoLuc?: string } = {}): string {
  const den = gioVietNam(d?.to);
  const now = opts.now ?? Date.now();
  const goc = mocThoiGian(d?.from) ?? mocThoiGian(opts.taoLuc);
  let tieuDe = "Doanh thu hôm nay";
  if (goc != null) {
    const ngay = ngayVietNam(goc);
    tieuDe = ngay === ngayVietNam(now) ? `Doanh thu hôm nay ${ngay}` : `Doanh thu ngày ${ngay}`;
  }
  const lines: string[] = [`📊 <b>${tieuDe}</b>${den ? ` (từ 0h đến ${den})` : ""}`];
  if (isNum(d?.revenue_all) && isNum(d?.order_count)) {
    lines.push(`• Tổng giá trị đơn: ${formatVnd(d.revenue_all)} (${d.order_count} đơn)`);
  } else if (isNum(d?.order_count)) {
    lines.push(`• Số đơn: ${d.order_count}`);
  }
  if (isNum(d?.revenue_paid)) {
    lines.push(`• Đã thu tiền: ${formatVnd(d.revenue_paid)}${isNum(d?.paid_order_count) ? ` (${d.paid_order_count} đơn)` : ""}`);
  }
  if (isNum(d?.revenue_pending)) {
    lines.push(`• Chờ duyệt: ${formatVnd(d.revenue_pending)}${isNum(d?.pending_count) ? ` (${d.pending_count} đơn)` : ""}`);
  } else if (isNum(d?.pending_count)) {
    lines.push(`• Đơn chờ duyệt: ${d.pending_count}`);
  }
  if (isNum(d?.canceled_count)) {
    lines.push(`• Đơn huỷ: ${d.canceled_count} (không tính vào doanh thu)`);
  }
  const top = Array.isArray(d?.top_products) ? d.top_products.filter((p: any) => p && p.name).slice(0, 3) : [];
  if (top.length > 0) {
    lines.push("", "<b>Bán chạy nhất:</b>");
    top.forEach((p: any, i: number) => lines.push(`${i + 1}. ${esc(p.name)}${isNum(p.qty) ? ` — ${p.qty} chai` : ""}`));
  }
  return lines.join("\n");
}

export function formatLowStockAlert(d: any): string {
  const items = Array.isArray(d?.items) ? d.items : [];
  const total = isNum(d?.count) ? d.count : items.length;
  const lines: string[] = [`⚠️ <b>Sắp hết hàng: ${total} sản phẩm</b>`];
  for (const it of items.slice(0, 10)) {
    // Job backend chỉ gửi sku (không có tên sản phẩm) và available = tồn - đã giữ chỗ.
    const ten = it?.title || it?.name || it?.sku;
    if (!ten) continue;
    const con = it?.available != null && isNum(Number(it.available)) ? Number(it.available) : null;
    lines.push(`• ${esc(ten)}${con != null ? ` — còn ${con}` : ""}`);
  }
  if (total > Math.min(items.length, 10)) lines.push(`… và ${total - Math.min(items.length, 10)} sản phẩm khác`);
  lines.push("", "Nhắn <code>nhập thêm 12 chai &lt;tên&gt;</code> để cập nhật kho.");
  return lines.join("\n");
}

export function formatPaymentErrorAlert(d: any): string {
  const sample = Array.isArray(d?.sample) ? d.sample : [];
  const count = isNum(d?.count) ? d.count : sample.length;
  const phut = isNum(d?.window_minutes) ? d.window_minutes : 10;
  const lines: string[] = [`🚨 <b>Có ${count} đơn gặp lỗi thanh toán trong ${phut} phút qua</b>`];
  const so = sample.map((s: any) => s?.display_id).filter((x: any) => x != null && x !== "");
  if (so.length > 0) lines.push(so.map((n: any) => `#${esc(n)}`).join(", "));
  lines.push("", "Gõ <code>xem đơn &lt;số&gt;</code> để kiểm tra.");
  return lines.join("\n");
}

/** Trả null nếu loại không được hỗ trợ. */
export function formatOutboxItem(item: Pick<OutboxItem, "loai" | "du_lieu"> & { tao_luc?: string }, now?: number): string | null {
  switch (item.loai) {
    case "bao_cao_doanh_thu": return formatRevenueReport(item.du_lieu, { now, taoLuc: item.tao_luc });
    case "canh_bao_het_hang": return formatLowStockAlert(item.du_lieu);
    case "canh_bao_loi_thanh_toan": return formatPaymentErrorAlert(item.du_lieu);
    default: return null;
  }
}

/** Tin quá hạn thì không gửi nữa (gửi dồn sau khi chatbot/Telegram tắt lâu). */
const TUOI_TOI_DA_MS: Record<string, number> = {
  bao_cao_doanh_thu: 36 * 3600_000,
  canh_bao_het_hang: 12 * 3600_000,
  canh_bao_loi_thanh_toan: 2 * 3600_000,
};

export function laTinQuaHan(item: Pick<OutboxItem, "loai" | "tao_luc">, now: number): boolean {
  const gioiHan = TUOI_TOI_DA_MS[item.loai];
  const t = mocThoiGian(item.tao_luc);
  return gioiHan != null && t != null && now - t > gioiHan;
}

export const chuanHoaBaseUrl = (u: string) => String(u ?? "").trim().toLowerCase().replace(/\/+$/, "");

/** Log mỗi khoá tối đa một lần trong `msGiuaHaiLan` (mặc định mãi mãi). */
const daLog = new Map<string, number>();
function logMotLan(khoa: string, msg: string, now: number, msGiuaHaiLan = Infinity): void {
  const truoc = daLog.get(khoa);
  if (truoc != null && now - truoc < msGiuaHaiLan) return;
  daLog.set(khoa, now);
  console.error(msg);
}
export function resetLogOutbox(): void { daLog.clear(); }

// ---------------------------------------------------------------------------
// Gọi backend
// ---------------------------------------------------------------------------

async function claim(cfg: MedusaConfig): Promise<OutboxItem[]> {
  const res = await fetchCoTimeout(`${cfg.baseUrl}/ai/outbox/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-ai-secret-key": env.AI_SECRET_KEY },
    body: JSON.stringify({ types: [...ALLOWED_OUTBOX_TYPES], limit: 20 }),
  }, TIMEOUT.MEDUSA);
  if (res.status === 404) {
    logMotLan(`404:${chuanHoaBaseUrl(cfg.baseUrl)}`, `[Outbox] ${cfg.baseUrl} chưa có route /ai/outbox/claim — bỏ qua.`, Date.now());
    return [];
  }
  if (!res.ok) throw new Error(`claim HTTP ${res.status}`);
  const body: any = await res.json();
  return Array.isArray(body?.items) ? body.items : [];
}

async function ack(cfg: MedusaConfig, id: string, ok: boolean, error?: string, claimedAt?: string): Promise<void> {
  const res = await fetchCoTimeout(`${cfg.baseUrl}/ai/outbox/${encodeURIComponent(id)}/ack`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-ai-secret-key": env.AI_SECRET_KEY },
    body: JSON.stringify({
      ...(ok ? { ok: true } : { ok: false, error: (error ?? "send_failed").slice(0, 200) }),
      ...(claimedAt ? { claimed_at: claimedAt } : {}),
    }),
  }, TIMEOUT.MEDUSA);
  // 409 not_claimed: dòng đã được xử lý/giành lại nơi khác, bỏ qua êm.
  if (!res.ok && res.status !== 409) throw new Error(`ack HTTP ${res.status}`);
}

// ---------------------------------------------------------------------------
// Xử lý
// ---------------------------------------------------------------------------

export interface DispatcherDeps {
  listTenantIds: () => Promise<string[]>;
  getConfig: (tenantId: string) => Promise<MedusaConfig | null>;
  claim: (cfg: MedusaConfig) => Promise<OutboxItem[]>;
  ack: (cfg: MedusaConfig, id: string, ok: boolean, error?: string, claimedAt?: string) => Promise<void>;
  send: (tenantId: string, html: string) => Promise<number>;
  dedupeGet: (key: string) => Promise<string | null>;
  dedupeSet: (key: string) => Promise<void>;
  now?: () => number;
}

const defaultDeps: DispatcherDeps = {
  listTenantIds: async () => (await pool.query("SELECT id FROM tenant ORDER BY id")).rows.map((r: any) => String(r.id)),
  getConfig: (tenantId) => runInTenantContext(tenantId, (c) => getTenantMedusaConfig(c, tenantId)),
  claim,
  ack,
  send: (tenantId, html) => guiThongBaoDonMoi(tenantId, html),
  dedupeGet: (k) => cache.get(k),
  dedupeSet: (k) => cache.set(k, "1", DEDUPE_TTL_SECONDS),
};

async function xuLyMotTin(tenantId: string, cfg: MedusaConfig, item: OutboxItem, deps: DispatcherDeps): Promise<void> {
  const now = (deps.now ?? Date.now)();
  const ca = item.claimed_at;
  if (!(ALLOWED_OUTBOX_TYPES as readonly string[]).includes(item.loai)) {
    await deps.ack(cfg, item.id, false, "unsupported_type", ca);
    return;
  }
  if (laTinQuaHan(item, now)) {
    console.warn(`[Outbox] Bỏ qua tin cũ (${item.loai}, tạo lúc ${item.tao_luc}).`);
    await deps.ack(cfg, item.id, true, undefined, ca); // ack ok để không quay vòng
    return;
  }
  const dedupeKey = `outbox:sent:${tenantId}:${item.id}`;
  if (await deps.dedupeGet(dedupeKey)) {
    await deps.ack(cfg, item.id, true, undefined, ca); // đã gửi rồi (dòng treo bị giành lại)
    return;
  }
  const html = formatOutboxItem(item, now);
  if (!html) {
    await deps.ack(cfg, item.id, false, "unsupported_type", ca);
    return;
  }
  let loi: string | null = null;
  try {
    const soNoi = await deps.send(tenantId, html);
    if (soNoi <= 0) {
      loi = "no_recipient";
      logMotLan(`norecipient:${tenantId}`, `[Outbox] Shop ${tenantId} chưa có người nhận Telegram — chưa gửi được cảnh báo.`, now, 3600_000);
    }
  } catch (e: any) {
    loi = `send_error: ${e?.message ?? e}`;
  }
  if (loi) {
    await deps.ack(cfg, item.id, false, loi, ca);
    return;
  }
  await deps.dedupeSet(dedupeKey);
  await deps.ack(cfg, item.id, true, undefined, ca);
}

async function xuLyMotTenant(tenantId: string, cfg: MedusaConfig, deps: DispatcherDeps): Promise<number> {
  const items = await deps.claim(cfg);
  let n = 0;
  for (const item of items) {
    try {
      await xuLyMotTin(tenantId, cfg, item, deps);
      n++;
    } catch (e: any) {
      console.error(`[Outbox] Tenant ${tenantId} tin ${item?.id}: ${e?.message ?? e}`);
    }
  }
  return n;
}

let dangChay = false;

/** Một vòng cho mọi tenant. Trả về số tin đã xử lý; -1 nếu vòng trước chưa xong. */
export async function chayMotVongOutbox(deps: DispatcherDeps = defaultDeps): Promise<number> {
  if (dangChay) return -1;
  dangChay = true;
  try {
    const now = (deps.now ?? Date.now)();
    // ai_outbox không có cột tenant: nhiều tenant chung một Medusa thì không phân biệt được tin của ai.
    const nhom = new Map<string, { tenantId: string; cfg: MedusaConfig }[]>();
    for (const id of await deps.listTenantIds()) {
      try {
        const cfg = await deps.getConfig(id);
        if (!cfg) continue; // chưa cấu hình Medusa: bỏ qua êm
        const khoa = chuanHoaBaseUrl(cfg.baseUrl);
        if (!khoa) continue;
        if (!nhom.has(khoa)) nhom.set(khoa, []);
        nhom.get(khoa)!.push({ tenantId: id, cfg });
      } catch (e: any) {
        console.error(`[Outbox] Tenant ${id} lỗi cấu hình: ${e?.message ?? e}`);
      }
    }
    let tong = 0;
    for (const [khoa, ds] of nhom) {
      if (ds.length > 1) {
        logMotLan(`shared:${khoa}`, `[Outbox] ${ds.length} shop (${ds.map((x) => x.tenantId).join(", ")}) dùng chung Medusa ${khoa} — bỏ qua để tránh gửi nhầm shop.`, now);
        continue;
      }
      try {
        tong += await xuLyMotTenant(ds[0].tenantId, ds[0].cfg, deps);
      } catch (e: any) {
        console.error(`[Outbox] Tenant ${ds[0].tenantId} lỗi: ${e?.message ?? e}`);
      }
    }
    return tong;
  } finally {
    dangChay = false;
  }
}

let timer: NodeJS.Timeout | null = null;

export function khoiDongOutboxDispatcher(): void {
  if (timer || !env.OUTBOX_DISPATCHER_ENABLED) return;
  timer = setInterval(() => {
    chayMotVongOutbox().catch((e) => console.error("[Outbox] Lỗi vòng chạy:", e));
  }, INTERVAL_MS);
  timer.unref();
}

export function dungOutboxDispatcher(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
