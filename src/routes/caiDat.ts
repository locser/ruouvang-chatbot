import { Router, Request, Response } from "express";
import crypto from "crypto";
import nodemailer from "nodemailer";
import { runCentralAdmin } from "../db/client";
import {
  DANH_SACH_CAI_DAT,
  LOAI_CHUOI,
  LoaiChuoi,
  LoiCaiDat,
  PhamVi,
  datCaiDat,
  khaiBaoCuaKhoa,
  kiemTraCaiDat,
  layCaiDat,
  layCauHinhCongKhai,
  lietKeCaiDat,
  sinhChuoi,
  xoaCaiDat,
} from "../services/caiDat";

/**
 * API QUẢN LÝ `app_settings`
 * ===========================================================================
 *
 * Gắn dưới /v1/admin/settings — đã đi qua requireAdminAuth + assertTenantScope.
 *
 *   GET    /v1/admin/settings/schema                danh sách khoá được phép + mô tả
 *   GET    /v1/admin/settings?scope=platform|shop   liệt kê (khoá bí mật bị che)
 *   GET    /v1/admin/settings/:key                  một khoá
 *   PUT    /v1/admin/settings/:key   {value}        đặt ("" = xoá)
 *   PUT    /v1/admin/settings        {settings:{k:v,…}}   đặt nhiều khoá, hoặc không khoá nào
 *   DELETE /v1/admin/settings/:key                  xoá
 *   POST   /v1/admin/settings/generate  {type,bytes?,prefix?,save_as?}   sinh chuỗi ngẫu nhiên
 *   POST   /v1/admin/settings/test/deepseek         thử gọi DeepSeek bằng khoá đã lưu
 *   POST   /v1/admin/settings/test/smtp             thử đăng nhập SMTP bằng cấu hình đã lưu
 *
 * Phân quyền:
 *   · Khoá phạm vi "nen_tang" (DeepSeek, SMTP, bot nền tảng): chỉ super_admin.
 *   · Khoá phạm vi "shop": tenant_admin chỉ thao tác tenant của mình;
 *     super_admin truyền thêm `tenant_id` (query hoặc body).
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

interface NguoiDung {
  username: string;
  role: string;
  tenantId: string | null;
}

function nguoiDung(req: Request): NguoiDung {
  const u = (req as any).adminUser;
  return { username: String(u?.username ?? "?"), role: String(u?.role ?? ""), tenantId: u?.tenantId ?? null };
}

/** Xác định tenant của yêu cầu, chặn vượt quyền. Trả null nếu yêu cầu không cần tenant. */
function tenantCuaYeuCau(req: Request, nd: NguoiDung): string | null {
  const guiLen = (req.query.tenant_id ?? (req.body as any)?.tenant_id ?? (req.body as any)?.tenantId) as string | undefined;
  if (nd.role !== "super_admin") {
    if (!nd.tenantId) throw new LoiCaiDat("Thiếu ngữ cảnh tenant", 403);
    if (guiLen && guiLen !== nd.tenantId) throw new LoiCaiDat("Không được thao tác tenant khác", 403);
    return nd.tenantId;
  }
  if (!guiLen) return null;
  if (!UUID_RE.test(guiLen)) throw new LoiCaiDat("tenant_id không hợp lệ");
  return guiLen;
}

/** Kiểm tra quyền và tenant cho một khoá cụ thể. */
function phamViCuaKhoa(key: string, nd: NguoiDung, tenantId: string | null): string | null {
  const kb = khaiBaoCuaKhoa(key);
  if (!kb) throw new LoiCaiDat(`Khoá không hợp lệ: ${key}. Xem GET /v1/admin/settings/schema`, 404);
  if (kb.phamVi === "nen_tang") {
    if (nd.role !== "super_admin") throw new LoiCaiDat("Chỉ super_admin được sửa cấu hình toàn nền tảng", 403);
    return null;
  }
  if (!tenantId) throw new LoiCaiDat(`${key} là cấu hình theo shop: truyền tenant_id`);
  return tenantId;
}

/** Ràng buộc ngoài định dạng: widget_key phải là khoá đã đăng ký cho đúng tenant. */
async function kiemTraLienQuan(key: string, value: string, tenantId: string | null): Promise<void> {
  if (key !== "widget_key" || value.trim() === "" || !tenantId) return;
  const ok = await runCentralAdmin(async (c) => {
    const r = await c.query(
      `SELECT 1 FROM tenant_key WHERE tenant_id = $1 AND khoa_bam = $2 AND thu_hoi_luc IS NULL`,
      [tenantId, sha256(value.trim())]
    );
    return r.rows.length > 0;
  });
  if (!ok) {
    throw new LoiCaiDat(
      "widget_key chưa được đăng ký cho tenant này. Sinh khoá mới bằng POST /v1/admin/settings/generate " +
        '{"type":"widget_key","save_as":"widget_key"} để vừa đăng ký vừa lưu.'
    );
  }
}

function baoLoi(res: Response, e: unknown) {
  if (e instanceof LoiCaiDat) return res.status(e.maHttp).json({ error: e.message });
  console.error("[CaiDat API]", e);
  return res.status(500).json({ error: "Lỗi máy chủ khi xử lý cấu hình" });
}

export const routerCaiDat = Router();

routerCaiDat.get("/schema", (req: Request, res: Response) => {
  const nd = nguoiDung(req);
  const ds = DANH_SACH_CAI_DAT.filter((d) => nd.role === "super_admin" || d.phamVi === "shop").map((d) => ({
    key: d.key,
    pham_vi: d.phamVi,
    bi_mat: d.biMat,
    cong_khai: d.congKhai,
    mo_ta: d.moTa,
    mac_dinh: d.macDinh ?? null,
  }));
  res.json({ settings: ds, loai_chuoi: LOAI_CHUOI });
});

routerCaiDat.get("/", async (req: Request, res: Response) => {
  try {
    const nd = nguoiDung(req);
    const tenantId = tenantCuaYeuCau(req, nd);
    let phamVi = (req.query.scope as string | undefined) as PhamVi | "platform" | undefined;
    if (phamVi === "platform") phamVi = "nen_tang";
    if (!phamVi) phamVi = tenantId ? "shop" : "nen_tang";
    if (phamVi !== "nen_tang" && phamVi !== "shop") throw new LoiCaiDat("scope phải là platform hoặc shop");
    if (phamVi === "nen_tang" && nd.role !== "super_admin") throw new LoiCaiDat("Chỉ super_admin xem cấu hình nền tảng", 403);
    if (phamVi === "shop" && !tenantId) throw new LoiCaiDat("Cần tenant_id cho scope=shop");
    res.json({ scope: phamVi === "nen_tang" ? "platform" : "shop", tenant_id: phamVi === "shop" ? tenantId : null, settings: await lietKeCaiDat(phamVi, tenantId) });
  } catch (e) {
    baoLoi(res, e);
  }
});

routerCaiDat.put("/", async (req: Request, res: Response) => {
  try {
    const nd = nguoiDung(req);
    const tenantId = tenantCuaYeuCau(req, nd);
    const gui = (req.body as any)?.settings;
    if (!gui || typeof gui !== "object" || Array.isArray(gui) || Object.keys(gui).length === 0) {
      throw new LoiCaiDat('Body cần dạng {"settings":{"khoa":"gia_tri"}}');
    }
    // Kiểm tra TOÀN BỘ trước khi ghi: một khoá sai thì không ghi khoá nào.
    const cacMuc: Array<[string, string, string | null]> = [];
    for (const [k, v] of Object.entries<unknown>(gui)) {
      const tid = phamViCuaKhoa(k, nd, tenantId);
      kiemTraCaiDat(k, v);
      await kiemTraLienQuan(k, v as string, tid);
      cacMuc.push([k, v as string, tid]);
    }
    const kq: Record<string, "da_dat" | "da_xoa"> = {};
    for (const [k, v, tid] of cacMuc) {
      kq[k] = (await datCaiDat(k, v, { tenantId: tid, nguoiSua: nd.username })) ? "da_dat" : "da_xoa";
    }
    res.json({ ok: true, ket_qua: kq });
  } catch (e) {
    baoLoi(res, e);
  }
});

// --- sinh chuỗi ---------------------------------------------------------------

routerCaiDat.post("/generate", async (req: Request, res: Response) => {
  try {
    const nd = nguoiDung(req);
    const b = (req.body ?? {}) as { type?: string; bytes?: number; prefix?: string; save_as?: string };
    const loai = (b.type ?? "hex") as LoaiChuoi;
    if (!LOAI_CHUOI.includes(loai)) throw new LoiCaiDat(`type phải thuộc: ${LOAI_CHUOI.join(", ")}`);
    const value = sinhChuoi(loai, { soByte: b.bytes, tienTo: b.prefix });

    if (!b.save_as) return res.json({ type: loai, value, saved: false });

    // Lưu luôn vào app_settings. Giá trị chỉ hiện đúng một lần ở phản hồi này
    // nếu là khoá bí mật.
    const tenantId = tenantCuaYeuCau(req, nd);
    const tid = phamViCuaKhoa(b.save_as, nd, tenantId);
    kiemTraCaiDat(b.save_as, value);

    if (b.save_as === "widget_key") {
      // Khoá widget thật phải có dấu vết sha256 trong tenant_key thì /v1/chat/session mới nhận.
      await runCentralAdmin(async (c) => {
        await c.query(
          `INSERT INTO tenant_key (tenant_id, khoa_bam, origin_allowlist) VALUES ($1, $2, ARRAY['*'])
           ON CONFLICT (khoa_bam) DO NOTHING`,
          [tid, sha256(value)]
        );
      });
    }
    await datCaiDat(b.save_as, value, { tenantId: tid, nguoiSua: nd.username });
    res.json({
      type: loai,
      value,
      saved: true,
      save_as: b.save_as,
      note: khaiBaoCuaKhoa(b.save_as)!.biMat ? "Khoá bí mật: chỉ hiện đầy đủ một lần này, DB lưu bản mã hoá." : undefined,
    });
  } catch (e) {
    baoLoi(res, e);
  }
});

// --- thử kết nối --------------------------------------------------------------

routerCaiDat.post("/test/deepseek", async (req: Request, res: Response) => {
  try {
    if (nguoiDung(req).role !== "super_admin") throw new LoiCaiDat("Chỉ super_admin", 403);
    const khoa = await layCaiDat("deepseek_api_key");
    if (!khoa) return res.status(400).json({ ok: false, error: "Chưa đặt deepseek_api_key" });
    const r = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${khoa}` },
      body: JSON.stringify({ model: "deepseek-chat", messages: [{ role: "user", content: "ping" }], max_tokens: 1 }),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await r.text().catch(() => "");
    res.status(r.ok ? 200 : 502).json({ ok: r.ok, status: r.status, detail: r.ok ? undefined : text.slice(0, 300) });
  } catch (e) {
    if (e instanceof LoiCaiDat) return baoLoi(res, e);
    res.status(502).json({ ok: false, error: (e as Error).message });
  }
});

routerCaiDat.post("/test/smtp", async (req: Request, res: Response) => {
  try {
    if (nguoiDung(req).role !== "super_admin") throw new LoiCaiDat("Chỉ super_admin", 403);
    const [host, port, user, pass] = await Promise.all([
      layCaiDat("smtp_host"),
      layCaiDat("smtp_port"),
      layCaiDat("smtp_user"),
      layCaiDat("smtp_pass"),
    ]);
    if (!user || !pass) return res.status(400).json({ ok: false, error: "Chưa đặt smtp_user / smtp_pass" });
    const p = parseInt(port, 10) || 587;
    const t = nodemailer.createTransport({ host, port: p, secure: p === 465, auth: { user, pass }, connectionTimeout: 8000 });
    await t.verify();
    res.json({ ok: true });
  } catch (e) {
    if (e instanceof LoiCaiDat) return baoLoi(res, e);
    res.status(502).json({ ok: false, error: (e as Error).message });
  }
});

// --- một khoá -----------------------------------------------------------------
// (đặt SAU các đường tĩnh để "/schema", "/generate", "/test/*" không bị :key nuốt)

routerCaiDat.get("/:key", async (req: Request, res: Response) => {
  try {
    const nd = nguoiDung(req);
    const tenantId = tenantCuaYeuCau(req, nd);
    const tid = phamViCuaKhoa(req.params.key, nd, tenantId);
    const kb = khaiBaoCuaKhoa(req.params.key)!;
    const ds = await lietKeCaiDat(kb.phamVi, tid);
    res.json(ds.find((m) => m.key === req.params.key));
  } catch (e) {
    baoLoi(res, e);
  }
});

routerCaiDat.put("/:key", async (req: Request, res: Response) => {
  try {
    const nd = nguoiDung(req);
    const tenantId = tenantCuaYeuCau(req, nd);
    const tid = phamViCuaKhoa(req.params.key, nd, tenantId);
    const value = (req.body as any)?.value;
    kiemTraCaiDat(req.params.key, value);
    await kiemTraLienQuan(req.params.key, value, tid);
    const daDat = await datCaiDat(req.params.key, value, { tenantId: tid, nguoiSua: nd.username });
    res.json({ ok: true, key: req.params.key, trang_thai: daDat ? "da_dat" : "da_xoa" });
  } catch (e) {
    baoLoi(res, e);
  }
});

routerCaiDat.delete("/:key", async (req: Request, res: Response) => {
  try {
    const nd = nguoiDung(req);
    const tenantId = tenantCuaYeuCau(req, nd);
    const tid = phamViCuaKhoa(req.params.key, nd, tenantId);
    const co = await xoaCaiDat(req.params.key, tid);
    res.json({ ok: true, key: req.params.key, da_xoa: co });
  } catch (e) {
    baoLoi(res, e);
  }
});

// ---------------------------------------------------------------------------
// ENDPOINT CÔNG KHAI — storefront và Medusa đọc cấu hình hiển thị
// ---------------------------------------------------------------------------

export const routerCongKhai = Router();

/**
 * GET /v1/public/config?tenant_id=<uuid>
 * Chỉ trả khoá `congKhai` và KHÔNG bí mật: hiện chỉ có `widget_key` (khoá công khai
 * của widget chat, vốn đã nằm trong HTML của storefront). Hotline, Zalo, ngân hàng
 * thuộc Medusa: GET /store/app-settings.
 */
routerCongKhai.get("/config", async (req: Request, res: Response) => {
  const tid = String(req.query.tenant_id ?? "");
  if (!UUID_RE.test(tid)) return res.status(400).json({ error: "tenant_id không hợp lệ" });
  try {
    const settings = await layCauHinhCongKhai(tid);
    res.set("Cache-Control", "public, max-age=30");
    res.json({ tenant_id: tid, settings });
  } catch (e) {
    baoLoi(res, e);
  }
});
