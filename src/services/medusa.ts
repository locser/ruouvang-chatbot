import { PoolClient } from "pg";
import { encrypt, decrypt } from "./encryption";
import { env } from "../config/env";

export interface MedusaConfig {
  enabled: boolean;
  baseUrl: string;
  apiToken: string;
  defaultCarrier?: string;
}

export interface MedusaToolParam {
  name: string;
  type: "string" | "number" | "boolean";
  required: boolean;
  description: string;
}

export interface MedusaToolDef {
  name: string;
  description: string;
  params: MedusaToolParam[];
  route: string;
  method: "GET" | "POST";
}

export const ALLOWED_CARRIERS = ["ghn", "ghtk", "ninjavan", "vtp", "vnpost", "jt"] as const;

export const MEDUSA_TOOLS: MedusaToolDef[] = [
  {
    name: "tra_don",
    description: "Tra cứu thông tin và trạng thái đơn hàng Medusa theo mã đơn.",
    params: [{ name: "orderId", type: "string", required: true, description: "Mã đơn hàng" }],
    route: "/admin/ai/tra-don",
    method: "GET",
  },
  {
    name: "tra_ton_kho",
    description: "Tra cứu tồn kho sản phẩm thời gian thực theo mã SKU.",
    params: [{ name: "sku", type: "string", required: true, description: "Mã SKU sản phẩm" }],
    route: "/admin/ai/tra-ton-kho",
    method: "GET",
  },
  {
    name: "tra_san_pham",
    description: "Tìm kiếm thông tin sản phẩm và giá niêm yết theo từ khóa.",
    params: [{ name: "keyword", type: "string", required: true, description: "Từ khóa tìm kiếm" }],
    route: "/admin/ai/tra-san-pham",
    method: "GET",
  },
  {
    name: "chot_don",
    description: "Chốt đơn hàng: tạo vận đơn và trừ tồn kho tự động qua Medusa Workflow.",
    params: [
      { name: "orderId", type: "string", required: true, description: "Mã đơn hàng" },
      { name: "lineItemId", type: "string", required: true, description: "Mã dòng sản phẩm" },
      { name: "sku", type: "string", required: true, description: "Mã SKU" },
      { name: "quantity", type: "number", required: true, description: "Số lượng" },
      { name: "carrier", type: "string", required: true, description: "Hãng giao hàng (ghn|ghtk|ninjavan|vtp|vnpost|jt)" },
    ],
    route: "/admin/ai/chot-don",
    method: "POST",
  },
];

/**
 * Retrieves and decrypts tenant's Medusa Store platform configuration.
 */
export async function getTenantMedusaConfig(client: PoolClient, tenantId: string): Promise<MedusaConfig | null> {
  const result = await client.query(
    `SELECT cau_hinh_ma_hoa, trang_thai FROM tenant_platform WHERE tenant_id = $1 AND loai = 'medusa'`,
    [tenantId]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const { cau_hinh_ma_hoa, trang_thai } = result.rows[0];
  if (trang_thai !== "hoat_dong") {
    return null; // Feature is disabled (tắt)
  }

  try {
    const rawJson = decrypt(cau_hinh_ma_hoa);
    const parsed = JSON.parse(rawJson) as MedusaConfig;
    return parsed.enabled ? parsed : null;
  } catch (error) {
    console.error(`[Medusa] Decryption error for tenant ${tenantId}:`, error);
    return null;
  }
}

/**
 * Validates tool parameters before executing requests to Medusa backend.
 */
export function validateMedusaParams(toolName: string, params: Record<string, any>): { valid: boolean; errors: string[] } {
  const tool = MEDUSA_TOOLS.find((t) => t.name === toolName);
  if (!tool) {
    return { valid: false, errors: [`Công cụ Medusa "${toolName}" không hợp lệ.`] };
  }

  const errors: string[] = [];

  for (const p of tool.params) {
    const val = params[p.name];
    if (val === undefined || val === null || val === "") {
      if (p.required) {
        errors.push(`Thiếu tham số bắt buộc "${p.name}".`);
      }
      continue;
    }

    if (p.type === "number" && (typeof val !== "number" || !Number.isFinite(val))) {
      errors.push(`Tham số "${p.name}" phải là số.`);
    }

    if (p.type === "string" && typeof val !== "string") {
      errors.push(`Tham số "${p.name}" phải là chuỗi.`);
    }
  }

  if (toolName === "chot_don") {
    if (params.carrier && !ALLOWED_CARRIERS.includes(params.carrier)) {
      errors.push(`Hãng giao hàng "${params.carrier}" không hợp lệ. Chọn một trong: ${ALLOWED_CARRIERS.join(", ")}`);
    }
    if (params.quantity && params.quantity > 100) {
      errors.push("Số lượng chốt đơn > 100 vượt quá hạn mức tự động, cần chuyển nhân viên duyệt.");
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Executes a Medusa Store AI Workflow API call.
 */
export async function executeMedusaTool(
  config: MedusaConfig,
  toolName: string,
  params: Record<string, any>
): Promise<{ success: boolean; data?: any; error?: string }> {
  const tool = MEDUSA_TOOLS.find((t) => t.name === toolName);
  if (!tool) {
    return { success: false, error: `Công cụ ${toolName} không tồn tại` };
  }

  const validation = validateMedusaParams(toolName, params);
  if (!validation.valid) {
    return { success: false, error: validation.errors.join("; ") };
  }

  const url = new URL(tool.route, config.baseUrl).toString();

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${config.apiToken}`,
    };

    let response: Response;
    if (tool.method === "GET") {
      const searchParams = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null) searchParams.append(k, String(v));
      }
      const fullUrl = `${url}?${searchParams.toString()}`;
      response = await fetch(fullUrl, { method: "GET", headers });
    } else {
      response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(params),
      });
    }

    if (!response.ok) {
      const errText = await response.text();
      return { success: false, error: `Medusa API error (${response.status}): ${errText}` };
    }

    const data = await response.json();
    return { success: true, data };
  } catch (error: any) {
    console.error(`[MedusaTool Error] Failed to execute ${toolName}:`, error);
    return { success: false, error: error.message || "Lỗi kết nối tới Medusa Server" };
  }
}

/**
 * Khoá chia sẻ với Medusa cho nhánh /ai/*.
 *
 * Trước đây dòng này là `process.env.AI_SECRET_KEY || "REPLACE_WITH_NEW_SECRET"`.
 * Chuỗi mặc định nằm công khai trong mã nguồn, và Medusa phía kia cũng dùng
 * đúng chuỗi đó làm mặc định — nghĩa là ai đọc được repo cũng gọi được
 * /ai/chot-don (tạo đơn thật) và /ai/refund-order (hoàn tiền) trên bất kỳ
 * shop nào chưa đặt biến môi trường.
 *
 * Nay lấy từ `env` đã kiểm chứng lúc khởi động: thiếu cấu hình thì ứng dụng
 * từ chối chạy, thay vì âm thầm chạy bằng khoá mà cả thế giới biết.
 */
const AI_SECRET_KEY = env.AI_SECRET_KEY;

/**
 * Gọi API Medusa lấy thông tin giỏ hàng
 */
export async function medusaCartRetrieve(config: MedusaConfig, cartId: string): Promise<any> {
  const res = await fetch(`${config.baseUrl}/ai/cart`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-ai-secret-key": AI_SECRET_KEY,
    },
    body: JSON.stringify({ action: "retrieve", cartId }),
  });
  if (!res.ok) throw new Error(`Lấy giỏ hàng thất bại: ${await res.text()}`);
  return await res.json();
}

/**
 * Gọi API Medusa tạo giỏ hàng mới
 */
export async function medusaCartCreate(config: MedusaConfig, email?: string): Promise<any> {
  const res = await fetch(`${config.baseUrl}/ai/cart`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-ai-secret-key": AI_SECRET_KEY,
    },
    body: JSON.stringify({ action: "create", email }),
  });
  if (!res.ok) throw new Error(`Tạo giỏ hàng thất bại: ${await res.text()}`);
  return await res.json();
}

/**
 * Thêm sản phẩm vào giỏ hàng
 */
export async function medusaCartAddItem(config: MedusaConfig, cartId: string, sku: string, quantity: number): Promise<any> {
  const res = await fetch(`${config.baseUrl}/ai/cart`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-ai-secret-key": AI_SECRET_KEY,
    },
    body: JSON.stringify({ action: "add_item", cartId, sku, quantity }),
  });
  if (!res.ok) throw new Error(`Thêm sản phẩm thất bại: ${await res.text()}`);
  return await res.json();
}

/**
 * Xóa toàn bộ giỏ hàng / reset giỏ hàng
 */
export async function medusaCartClear(config: MedusaConfig, cartId: string): Promise<any> {
  const res = await fetch(`${config.baseUrl}/ai/cart`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-ai-secret-key": AI_SECRET_KEY,
    },
    body: JSON.stringify({ action: "clear_cart", cartId }),
  });
  if (!res.ok) throw new Error(`Xóa giỏ hàng thất bại: ${await res.text()}`);
  return await res.json();
}

/**
 * Xóa một sản phẩm ra khỏi giỏ hàng theo SKU
 */
export async function medusaCartRemoveItem(config: MedusaConfig, cartId: string, sku: string): Promise<any> {
  const res = await fetch(`${config.baseUrl}/ai/cart`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-ai-secret-key": AI_SECRET_KEY,
    },
    body: JSON.stringify({ action: "remove_item", cartId, sku }),
  });
  if (!res.ok) throw new Error(`Xóa sản phẩm khỏi giỏ thất bại: ${await res.text()}`);
  return await res.json();
}

/**
 * Cập nhật số lượng một sản phẩm trong giỏ hàng
 */
export async function medusaCartUpdateQuantity(config: MedusaConfig, cartId: string, sku: string, quantity: number): Promise<any> {
  const res = await fetch(`${config.baseUrl}/ai/cart`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-ai-secret-key": AI_SECRET_KEY,
    },
    body: JSON.stringify({ action: "update_quantity", cartId, sku, quantity }),
  });
  if (!res.ok) throw new Error(`Cập nhật số lượng thất bại: ${await res.text()}`);
  return await res.json();
}

/**
 * Cập nhật địa chỉ nhận hàng của giỏ hàng
 */
export async function medusaCartUpdateAddress(config: MedusaConfig, cartId: string, shippingAddress: {
  phone?: string;
  address?: string;
  province?: string;
  district?: string;
  ward?: string;
  firstName?: string;
  lastName?: string;
}): Promise<any> {
  const res = await fetch(`${config.baseUrl}/ai/cart`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-ai-secret-key": AI_SECRET_KEY,
    },
    body: JSON.stringify({
      action: "update_address",
      cartId,
      ...shippingAddress
    }),
  });
  if (!res.ok) throw new Error(`Cập nhật địa chỉ thất bại: ${await res.text()}`);
  return await res.json();
}

/**
 * Chốt đơn hàng (Checkout)
 */
export async function medusaCartCheckout(config: MedusaConfig, cartId: string): Promise<any> {
  const res = await fetch(`${config.baseUrl}/ai/cart`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-ai-secret-key": AI_SECRET_KEY,
    },
    body: JSON.stringify({ action: "checkout", cartId }),
  });
  if (!res.ok) throw new Error(`Chốt đơn hàng thất bại: ${await res.text()}`);
  return await res.json();
}

/**
 * Lấy cấu hình tài khoản ngân hàng của cửa hàng
 */
export async function medusaGetPaymentInfo(config: MedusaConfig): Promise<any> {
  const res = await fetch(`${config.baseUrl}/ai/payment-info`, {
    method: "GET",
    headers: {
      "x-ai-secret-key": AI_SECRET_KEY,
    },
  });
  if (!res.ok) throw new Error(`Lấy thông tin tài khoản ngân hàng thất bại: ${await res.text()}`);
  return await res.json();
}

/**
 * Tra trạng thái đơn theo mã đơn + số điện thoại đặt hàng.
 * Backend trả `found: false` cho mọi trường hợp không khớp (xem /ai/order-status).
 */
export async function medusaTraCuuDonHang(
  config: MedusaConfig,
  maDon: string,
  phone: string
): Promise<{ ok: boolean; found: boolean; order?: Record<string, unknown> }> {
  const res = await fetch(`${config.baseUrl}/ai/order-status`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-ai-secret-key": AI_SECRET_KEY,
    },
    body: JSON.stringify({ order_code: maDon, phone }),
  });
  if (!res.ok) throw new Error(`Tra cứu đơn hàng thất bại: ${await res.text()}`);
  return await res.json();
}

/** Đẩy khách tiềm năng sang backend để lưu. Upsert theo conversation_id nên gọi lại an toàn. */
export async function medusaLuuKhachTiemNang(
  config: MedusaConfig,
  lead: { conversation_id: string; phone: string; name?: string | null; need?: string | null }
): Promise<void> {
  const res = await fetch(`${config.baseUrl}/ai/leads`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-ai-secret-key": AI_SECRET_KEY },
    body: JSON.stringify(lead),
  });
  if (!res.ok) throw new Error(`Lưu khách tiềm năng thất bại: ${res.status} ${await res.text()}`);
}

/**
 * Intelligently detects Medusa queries from user message text.
 */
export function detectMedusaIntent(question: string): { toolName: string; params: Record<string, any> } | null {
  const orderMatch = question.match(/(?:kiểm tra|trạng thái|tra)\s+đơn\s*(?:hàng)?\s*([a-zA-Z0-9_-]+)/i);
  if (orderMatch && orderMatch[1]) {
    return { toolName: "tra_don", params: { orderId: orderMatch[1] } };
  }

  const stockMatch = question.match(/(?:tồn kho|còn hàng|check kho)\s+([a-zA-Z0-9_-]+)/i);
  if (stockMatch && stockMatch[1]) {
    return { toolName: "tra_ton_kho", params: { sku: stockMatch[1] } };
  }

  return null;
}
