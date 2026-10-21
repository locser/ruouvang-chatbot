import crypto from "crypto";

/**
 * Sinh chuỗi ngẫu nhiên + lỗi cấu hình. Tách riêng, KHÔNG phụ thuộc DB hay config/env,
 * để lệnh `npm run settings -- gen …` chạy được cả khi `.env` còn trống (chính là lúc
 * cần sinh các bí mật đầu tiên).
 */

export class LoiCaiDat extends Error {
  constructor(message: string, public maHttp = 400) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Sinh chuỗi ngẫu nhiên
// ---------------------------------------------------------------------------

export const LOAI_CHUOI = ["hex", "base64", "base64url", "uuid", "password", "jwt_secret", "encryption_key", "api_key", "widget_key"] as const;
export type LoaiChuoi = (typeof LOAI_CHUOI)[number];

/**
 * Sinh chuỗi ngẫu nhiên an toàn mật mã (crypto.randomBytes).
 *   hex / base64 / base64url — `soByte` byte ngẫu nhiên (mặc định 32)
 *   uuid                      — UUID v4
 *   password                  — mật khẩu dài `soByte`/… ký tự dễ gõ, không ký tự gây nhầm
 *   jwt_secret                — 48 byte base64 (đủ ≥ 32 ký tự mà env yêu cầu)
 *   encryption_key            — 32 ký tự hex = 32 byte, đúng độ dài AES-256 dùng ở encryption.ts
 *   api_key                   — `<tiền tố>_<hex>` (mặc định sk_)
 *   widget_key                — pk_<hex 24>, khoá công khai của widget
 */
export function sinhChuoi(loai: LoaiChuoi, opts: { soByte?: number; tienTo?: string } = {}): string {
  const n = opts.soByte ?? 32;
  if (!Number.isInteger(n) || n < 8 || n > 128) throw new LoiCaiDat("bytes phải là số nguyên 8–128");
  switch (loai) {
    case "hex":
      return crypto.randomBytes(n).toString("hex");
    case "base64":
      return crypto.randomBytes(n).toString("base64");
    case "base64url":
      return crypto.randomBytes(n).toString("base64url");
    case "uuid":
      return crypto.randomUUID();
    case "password": {
      const kyTu = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*-_";
      const dai = Math.max(12, Math.min(n, 64));
      let s = "";
      for (let i = 0; i < dai; i++) s += kyTu[crypto.randomInt(kyTu.length)];
      return s;
    }
    case "jwt_secret":
      return crypto.randomBytes(48).toString("base64");
    case "encryption_key":
      return crypto.randomBytes(16).toString("hex");
    case "api_key": {
      const tt = (opts.tienTo ?? "sk").replace(/[^A-Za-z0-9]/g, "").slice(0, 12) || "sk";
      return `${tt}_${crypto.randomBytes(n).toString("hex")}`;
    }
    case "widget_key":
      return `pk_${crypto.randomBytes(12).toString("hex")}`;
  }
}
