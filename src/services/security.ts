import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { cache } from "./cache";

/**
 * Lớp bảo vệ HTTP: security headers + rate limiting + so sánh chuỗi an toàn.
 *
 * KHÔNG dùng thư viện ngoài (helmet / express-rate-limit) để không phải cài
 * thêm dependency — toàn bộ dựa trên Redis đã có sẵn trong dự án. Đổi lại,
 * rate limiter này hiểu được khái niệm tenant, thứ mà express-rate-limit
 * không có sẵn.
 */

// ---------------------------------------------------------------------------
// 1. Security headers (thay cho helmet)
// ---------------------------------------------------------------------------
export function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-DNS-Prefetch-Control", "off");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  res.removeHeader("X-Powered-By");
  next();
}

// ---------------------------------------------------------------------------
// 2. So sánh chuỗi an toàn về thời gian
// ---------------------------------------------------------------------------
export function soSanhAnToan(a: string, b: string): boolean {
  const ba = Buffer.from(String(a ?? ""), "utf8");
  const bb = Buffer.from(String(b ?? ""), "utf8");
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// ---------------------------------------------------------------------------
// 3. Rate limiter (thuật toán cửa sổ cố định trên Redis)
// ---------------------------------------------------------------------------
export interface HanMuc {
  /** Số request tối đa trong cửa sổ */
  soLuong: number;
  /** Độ dài cửa sổ, tính bằng giây */
  cuaSoGiay: number;
  /** Tiền tố khoá, để các nhóm hạn mức không đè nhau */
  ten: string;
  /** Hàm lấy định danh đối tượng bị giới hạn */
  layKhoa: (req: Request) => string;
  /** Thông điệp trả về khi vượt */
  thongDiep?: string;
}

function layIp(req: Request): string {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) return xff.split(",")[0].trim();
  return req.ip || req.socket?.remoteAddress || "unknown";
}

/**
 * Tăng bộ đếm và trả về số lượt đã dùng trong cửa sổ hiện tại.
 * Dùng khoá có nhúng số thứ tự cửa sổ nên tự hết hạn, không cần dọn dẹp.
 */
async function tangBoDem(khoa: string, cuaSoGiay: number): Promise<number> {
  const soCuaSo = Math.floor(Date.now() / 1000 / cuaSoGiay);
  const khoaDay = `rl:${khoa}:${soCuaSo}`;
  const hienTai = parseInt((await cache.get(khoaDay)) || "0", 10);
  const moi = hienTai + 1;
  await cache.set(khoaDay, String(moi), cuaSoGiay + 1);
  return moi;
}

export function gioiHanTanSuat(hanMuc: HanMuc) {
  return async function (req: Request, res: Response, next: NextFunction) {
    try {
      const khoa = `${hanMuc.ten}:${hanMuc.layKhoa(req)}`;
      const daDung = await tangBoDem(khoa, hanMuc.cuaSoGiay);

      res.setHeader("RateLimit-Limit", String(hanMuc.soLuong));
      res.setHeader("RateLimit-Remaining", String(Math.max(0, hanMuc.soLuong - daDung)));

      if (daDung > hanMuc.soLuong) {
        res.setHeader("Retry-After", String(hanMuc.cuaSoGiay));
        return res.status(429).json({
          error: "TOO_MANY_REQUESTS",
          message: hanMuc.thongDiep
            || "Anh/chị thao tác hơi nhanh ạ. Vui lòng đợi một chút rồi thử lại giúp em nhé!",
          retry_after_seconds: hanMuc.cuaSoGiay,
        });
      }
      return next();
    } catch (e) {
      // Redis hỏng thì KHÔNG chặn người dùng thật — ghi log và cho qua.
      console.error("[RateLimit] lỗi, bỏ qua giới hạn cho request này:", e);
      return next();
    }
  };
}

// ---------------------------------------------------------------------------
// 4. Các hạn mức chuẩn (tài liệu 07 §2.1)
// ---------------------------------------------------------------------------

/** Đăng nhập / quên mật khẩu: chống brute-force và chống DoS bằng PBKDF2. */
export const hanMucDangNhap = gioiHanTanSuat({
  ten: "auth",
  soLuong: 10,
  cuaSoGiay: 15 * 60,
  layKhoa: layIp,
  thongDiep: "Bạn đã thử quá nhiều lần. Vui lòng đợi 15 phút.",
});

/** Chat theo IP khách: 20 tin / 1 phút (nhiều khách dùng chung wifi vẫn chat được). */
export const hanMucChatTheoIp = gioiHanTanSuat({
  ten: "chat_ip",
  soLuong: 20,
  cuaSoGiay: 60,
  layKhoa: layIp,
});

/** Tạo phiên chat: chặn cào khoá API. */
export const hanMucTaoPhien = gioiHanTanSuat({
  ten: "session",
  soLuong: 30,
  cuaSoGiay: 5 * 60,
  layKhoa: layIp,
});

/** Ghi API quản trị. */
export const hanMucAdminGhi = gioiHanTanSuat({
  ten: "admin_write",
  soLuong: 120,
  cuaSoGiay: 60,
  layKhoa: layIp,
});
