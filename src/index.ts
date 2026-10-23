import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import fs from "fs";
import { env } from "./config/env";
import { pool, runInTenantContext, runCentralAdmin } from "./db/client";
import { dongBoKhachTiemNangTonDong } from "./services/dongBoKhachTiemNang";
import { chayMigration } from "./db/migrate";
import { matchHardScript, routeModel, sinhCauTraLoiStream, ChatMessage, MODEL_THUC_TE } from "./services/llm";
import { botDangQuyDoi } from "./services/priceCheck";
import { anhVietQR } from "./services/vietqr";
import { danhGiaPhamVi } from "./services/scope";
import { assertSafeTranslation } from "./services/claimGuard";
import { documentQueue } from "./services/queues";
import { taoVectorEmbedding } from "./services/embedding";
// TỐI ƯU 08/2026 — tầng đệm ngữ cảnh cho luồng chat (tri thức RAG + kịch bản cứng).
import { layTriThucCoDem, matchHardScriptCoDem } from "./services/ngucanhCache";
import { sendTakeoverAlert, sendTelegramMessage, guiTinQuaBot, answerCallbackQuery, guiThongBaoDonMoi, dangKyWebhookChoShop, layThongTinWebhook, layThongTinBot } from "./services/telegram";
import { layBotCuaShop, layTatCaBot, xoaCacheBot, BotShop } from "./services/telegramTenant";
import { verifyPassword, verifyTelegramSignature, hashPassword, hashPasswordAsync, verifyPasswordAsync } from "./services/auth";
import { securityHeaders, soSanhAnToan, hanMucDangNhap, hanMucChatTheoIp, hanMucTaoPhien } from "./services/security";
import { sendResetPasswordEmail } from "./services/email";
import { getTenantMedusaConfig, detectMedusaIntent, executeMedusaTool, MedusaConfig, medusaCartCreate, medusaCartAddItem, medusaCartClear, medusaCartRemoveItem, medusaCartUpdateQuantity, medusaCartUpdateAddress, medusaCartCheckout, medusaGetPaymentInfo, medusaCartRetrieve } from "./services/medusa";
import { encrypt, decrypt } from "./services/encryption";
import { khachMuonChotDon, botHuaGuiQr } from "./services/checkoutIntent";
import { chayOrchestrator, trangThaiMoi } from "./services/orchestrator";
import { fetchJson } from "./services/http";
import { routerCaiDat, routerCongKhai } from "./routes/caiDat";
import { LoiThanThien, goiYDonHang, trongGiongLenh, luuCauChoGui, layCauChoGui, hoiThoaiConTiepQuan, danhDauCauDaGui, canGiuCauChoGui, UUID_RE, html as escapeHtml, laYeuCauVanHanh, laYeuCauVanHanhRoRang, xuLyCallbackVanHanh, xuLyYeuCauVanHanh } from "./services/telegramOperator";
import { layCaiDat } from "./services/caiDat";
import { khoiDongOutboxDispatcher, dungOutboxDispatcher } from "./services/outboxDispatcher";

import { quetTiemLenh } from "./worker";
import { extractDocumentText, queueKnowledgeDocument, deleteKnowledgeDocument, KnowledgeIngestError, MAX_DOCUMENT_BYTES } from "./services/knowledgeIngest";
import path from "path";

const app = express();

// Security headers (thay cho helmet, không cần thêm dependency)
app.use(securityHeaders);

// CORS: CHO PHÉP MỌI ORIGIN (theo yêu cầu), kể cả /v1/admin và /v1/auth.
// `origin: true` phản hồi lại đúng origin của request nên dùng được cùng credentials.
// Việc chặn truy cập nằm ở xác thực (Bearer token admin), không phải ở CORS.
app.use("/v1/admin", cors({ origin: true, credentials: true }));
app.use("/v1/auth",  cors({ origin: true, credentials: true }));
app.use(cors());

// Giới hạn kích thước body tường minh (mặc định 100kb quá nhỏ cho upload KB)
// Route upload tri thức nhận file base64 (tối đa 20MB giải mã ≈ 27MB base64) — phải đăng ký TRƯỚC parser 1mb toàn cục.
app.use("/v1/admin/kb/upload", express.json({ limit: "30mb" }), ((err: any, _req: Request, res: Response, next: NextFunction) => {
  if (err?.type === "entity.too.large") {
    return res.status(413).json({ error: "File quá lớn. Dung lượng tối đa 20MB." });
  }
  return next(err);
}) as any);
app.use(express.json({ limit: "1mb" }));

// Serve Static Frontends
app.use(express.static(path.join(__dirname, "../public")));
app.use("/tma", express.static(path.join(__dirname, "../tma")));
app.use("/admin", express.static(path.join(__dirname, "../admin")));

// Helper to calculate sha256 hash of public key
const sha256 = (key: string) => crypto.createHash("sha256").update(key).digest("hex");

// Helper to validate URL for SSRF protection
export function isSafeUrl(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") return false;
    if (hostname.startsWith("10.") || hostname.startsWith("192.168.") || hostname.startsWith("169.254.")) return false;
    if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostname)) return false;
    return true;
  } catch (e) {
    return false;
  }
}

// -----------------------------------------------------------------------------
// MIDDLEWARES
// -----------------------------------------------------------------------------

export interface CustomRequest extends Request {
  tenantId?: string;
  conversationId?: string;
  locale?: string;
}

// Session Token Verification Middleware
export function verifySessionToken(req: CustomRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing or invalid session token" });
  }

  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, env.SESSION_JWT_SECRET, { algorithms: ["HS256"] }) as any;
    if (decoded.typ === "admin") {
      return res.status(401).json({ error: "Admin tokens cannot be used as widget session tokens" });
    }
    req.tenantId = decoded.tenantId;
    req.conversationId = decoded.conversationId;
    next();
  } catch (error) {
    return res.status(401).json({ error: "Invalid or expired session token" });
  }
}


// -----------------------------------------------------------------------------
// WIDGET CLIENT API ENDPOINTS
// -----------------------------------------------------------------------------

// Start Session
app.post("/v1/chat/session", hanMucTaoPhien, async (req: Request, res: Response) => {
  const apiKey = req.headers["x-chatbot-key"] as string;
  const origin = req.headers.origin || "";
  const { visitorId, channelId, currencyCode, locale } = req.body;

  if (!apiKey || !visitorId) {
    return res.status(400).json({ error: "Missing X-Chatbot-Key or visitorId" });
  }

  try {
    const hashedKey = sha256(apiKey);

    // Look up tenant from API key using central admin connection
    const tenantInfo = await runCentralAdmin(async (client) => {
      const result = await client.query(
        `SELECT k.tenant_id, t.bac_du_lieu, t.locale_da_bat, t.tuong_lua_claim 
         FROM tenant_key k
         JOIN tenant t ON k.tenant_id = t.id
         WHERE k.khoa_bam = $1 AND k.thu_hoi_luc IS NULL`,
        [hashedKey]
      );
      return result.rows[0];
    });

    if (!tenantInfo) {
      return res.status(401).json({ error: "Unauthorized API Key" });
    }

    const { tenant_id: tenantId, bac_du_lieu, locale_da_bat, tuong_lua_claim } = tenantInfo;

    // Execute inside tenant RLS transaction
    const conversationId = await runInTenantContext(tenantId, async (client) => {
      // Find or create conversation
      const checkConv = await client.query(
        `SELECT id FROM conversation 
         WHERE tenant_id = $1 AND visitor_id = $2 AND dong_luc IS NULL`,
        [tenantId, visitorId]
      );

      if (checkConv.rows.length > 0) {
        return checkConv.rows[0].id;
      } else {
        const createConv = await client.query(
          `INSERT INTO conversation (tenant_id, visitor_id, channel_id, currency_code, locale_nhan_duoc, mode) 
           VALUES ($1, $2, $3, $4, $5, 'BOT') RETURNING id`,
          [tenantId, visitorId, channelId || "widget", currencyCode || "VND", locale || "vi-VN"]
        );
        return createConv.rows[0].id;
      }
    });

    // Generate short-lived JWT token (30 minutes)
    const sessionToken = jwt.sign(
      { typ: "widget", tenantId, conversationId },
      env.SESSION_JWT_SECRET,          // secret RIÊNG cho token khách (không dùng chung với admin)
      { expiresIn: "30m", algorithm: "HS256" }
    );

    return res.json({
      conversation_id: conversationId,
      session_token: sessionToken,
      tenant: {
        bac_du_lieu,
        locale_da_bat,
        currency_code: currencyCode || "VND",
        tuong_lua_claim,
      },
    });
  } catch (error) {
    console.error("Session creation error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Chat & Send Message (SSE stream output)
// -----------------------------------------------------------------------------
// KHÁCH TỰ XOÁ LỊCH SỬ CHAT CỦA MÌNH
//
// Quyền xoá dữ liệu cá nhân của chủ thể dữ liệu (Nghị định 13/2023). Khách bấm
// nút trong khung chat là xoá được, không phải xin ai.
//
// ═══ RANH GIỚI: XOÁ GÌ VÀ GIỮ GÌ ═══
//
// XOÁ: toàn bộ tin nhắn của hội thoại này (kể cả tin của bot và nhân viên).
//
// GIỮ:
//   - Bản ghi `conversation` (đánh dấu đã đóng). Xoá cả dòng này sẽ kéo theo
//     ràng buộc và làm rối thống kê; giữ lại một vỏ rỗng là đủ.
//   - ĐƠN HÀNG bên Medusa và SỔ CÁI CREDIT. Đây là chứng từ giao dịch, không
//     phải nội dung trò chuyện — khách xoá chat không có nghĩa là xoá đơn đã
//     đặt. `credit_ledger` vốn đã bất biến bằng rule `ledger_no_delete`.
//
// Chỉ xoá được hội thoại của CHÍNH MÌNH: `conversationId` lấy từ token phiên
// (do máy chủ ký), không lấy từ body — khách không tự chỉ định được id lạ.
// -----------------------------------------------------------------------------
app.post("/v1/chat/xoa-lich-su", hanMucChatTheoIp, verifySessionToken, async (req: CustomRequest, res: Response) => {
  const tenantId = req.tenantId!;
  const conversationId = req.conversationId!;

  try {
    const soDaXoa = await runInTenantContext(tenantId, async (client) => {
      const r = await client.query(
        `DELETE FROM message WHERE conversation_id = $1`,
        [conversationId]
      );
      // Đóng hội thoại: nó biến khỏi màn hình trực của nhân viên, và lượt chat
      // sau sẽ mở phiên mới thay vì nối vào một hội thoại đã bị xoá rỗng.
      await client.query(
        `UPDATE conversation
         SET dong_luc = now(), mode = 'BOT', assigned_to = NULL, ly_do_leo_thang = NULL
         WHERE id = $1 AND dong_luc IS NULL`,
        [conversationId]
      );
      return r.rowCount ?? 0;
    });

    console.log(`[XoaLichSu] conv ${conversationId} — khách xoá ${soDaXoa} tin nhắn`);
    return res.json({ success: true, so_tin_da_xoa: soDaXoa });
  } catch (error) {
    console.error("[XoaLichSu] lỗi:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/v1/chat/message", hanMucChatTheoIp, verifySessionToken, async (req: CustomRequest, res: Response) => {
  const tenantId = req.tenantId!;
  const conversationId = req.conversationId!;
  const { text } = req.body;

  if (!text) {
    return res.status(400).json({ error: "Missing message text" });
  }

  // Prompt Injection Guard
  const injectionFlags = quetTiemLenh(text);
  if (injectionFlags.length > 0) {
    console.warn(`[PromptInjection] Blocked message: ${text}`);
    res.setHeader("Content-Type", "text/event-stream");
    res.write(`data: ${JSON.stringify({ type: "chu", value: "Dạ em xin lỗi, câu hỏi của anh/chị chứa nội dung hoặc chỉ thị không phù hợp ạ." })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: "xong", credit_da_tru: 0, model: "cung" })}\n\n`);
    res.end();
    return;
  }

  try {
    await runInTenantContext(tenantId, async (client) => {
      // 1. Fetch current conversation details & tenant credit balance
      const convResult = await client.query(
        `SELECT c.mode, c.mode_version, c.currency_code, c.locale_nhan_duoc, c.cart_id,
                c.ly_do_leo_thang, t.ten AS ten_shop
         FROM conversation c JOIN tenant t ON t.id = c.tenant_id
         WHERE c.id = $1`,
        [conversationId]
      );

      if (convResult.rows.length === 0) {
        throw new Error("Conversation not found");
      }

      // --- KÍCH HOẠT CHÍNH SÁCH HẾT CREDIT (ADR-013) ---
      const creditRes = await client.query(
        `SELECT COALESCE(so_du, 0) as so_du FROM credit_balance WHERE tenant_id = $1`,
        [tenantId]
      );
      const soDuHienTai = creditRes.rows.length > 0 ? parseFloat(creditRes.rows[0].so_du) : 0;

      // `so_du` tính bằng ĐƠN VỊ CREDIT, KHÔNG phải VNĐ.
      // Bằng chứng: mỗi lượt chat trừ 0.2 credit; tenant seed khởi tạo 1000;
      // nạp credit mặc định 500. Số dư thật của một shop nằm ở mức hàng trăm
      // đến vài nghìn.
      //
      // Bản trước đặt ngưỡng 50.000 và ghi chú "≈ 2 USD" — nhầm đơn vị, khiến
      // 100% tenant luôn dính cảnh báo LOW_CREDIT ngay từ giây đầu tiên, header
      // cảnh báo bắn ở mọi request và trở thành nhiễu vô nghĩa.
      const CREDIT_MOI_LUOT = 0.2;
      const NGUONG_CANH_BAO_CREDIT = 50;   // ~250 lượt chat còn lại

      if (soDuHienTai <= 0) {
        console.warn(`[CreditBlock] Tenant ${tenantId} hết credit (số dư = ${soDuHienTai}). CHẶN CHAT (ADR-013).`);
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("X-Credit-Status", "EXHAUSTED");
        res.write(`data: ${JSON.stringify({ type: "chu", value: "Dạ hiện tại tài khoản dịch vụ của cửa hàng đã hết credit. Vui lòng liên hệ quản trị viên nạp thêm credit để tiếp tục tư vấn ạ!" })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: "xong", credit_da_tru: 0, model: "he_thong" })}\n\n`);
        res.end();
        return;
      }

      if (soDuHienTai <= NGUONG_CANH_BAO_CREDIT) {
        const soLuotConLai = Math.floor(soDuHienTai / CREDIT_MOI_LUOT);
        console.warn(
          `[CreditWarning] Tenant ${tenantId} sắp hết credit: còn ${soDuHienTai} credit ` +
          `(~${soLuotConLai} lượt chat).`
        );
        res.setHeader("X-Credit-Warning", "LOW_CREDIT");
        res.setHeader("X-Credit-Remaining-Turns", String(soLuotConLai));
      }

      const { mode, mode_version: initialVersion, currency_code, locale_nhan_duoc } = convResult.rows[0];
      const tenantName: string | null = convResult.rows[0].ten_shop ?? null;
      // Lý do hội thoại từng phải chuyển cho người. Giữ lại sau khi bàn giao để
      // bot biết mình đã hỏng ở đâu — xem ghi chú ở endpoint /release.
      const lyDoLeoThangTruoc: string | null = convResult.rows[0].ly_do_leo_thang ?? null;
      let cartId = convResult.rows[0].cart_id;
      const locale = locale_nhan_duoc || "vi-VN";

      const medusaConfig = await getTenantMedusaConfig(client, tenantId);

      // Auto-create cart if integration is active and no cart exists yet
      if (!cartId && medusaConfig) {
        try {
          const createRes = await medusaCartCreate(medusaConfig);
          if (createRes && createRes.cart_id) {
            cartId = createRes.cart_id;
            await client.query("UPDATE conversation SET cart_id = $1 WHERE id = $2", [cartId, conversationId]);
            console.log(`[MedusaCart] Created cart ${cartId} for conversation ${conversationId}`);
          }
        } catch (cErr) {
          console.error("[MedusaCart] Failed to auto-create cart:", cErr);
        }
      }

      if (mode !== "BOT") {
        // Record customer's message so operator can see it
        await client.query(
          `INSERT INTO message (tenant_id, conversation_id, vai_tro, noi_dung) 
           VALUES ($1, $2, 'khach', $3)`,
          [tenantId, conversationId, text]
        );
        
        await client.query(
          `UPDATE conversation SET last_customer_msg_at = now() WHERE id = $1`,
          [conversationId]
        );

        if (mode === "CHO_NGUOI") {
          await sendTakeoverAlert(conversationId, text, "Khách hàng gửi thêm tin nhắn đang chờ hỗ trợ");
        }

        return res.status(400).json({ error: "Cuộc hội thoại đang được nhân viên tiếp quản (AI disabled)" });
      }


      // Record customer message in database
      await client.query(
        `INSERT INTO message (tenant_id, conversation_id, vai_tro, noi_dung) 
         VALUES ($1, $2, 'khach', $3)`,
        [tenantId, conversationId, text]
      );
      
      await client.query(
        `UPDATE conversation SET last_customer_msg_at = now() WHERE id = $1`,
        [conversationId]
      );

      // 1b. Escalation / Frustration Detector ("Đánh chặn yêu cầu con người & khách hàng khó chịu")
      const textLower = text.toLowerCase();
      const keywordsNeedsHuman = [
        // 1. Yêu cầu gặp người trực tiếp
        "gặp người quản lý", "gặp admin", "gặp nhân viên", "gặp người", "nhân viên trực",
        "chuyển gặp người", "nói chuyện với người", "gặp tư vấn viên", "gặp con người",
        "gặp tổng đài viên", "chuyển máy", "gọi điện cho tôi", "gọi hotline", "số điện thoại shop",
        // 2. Biểu thị bực tức, khó chịu
        "bực mình", "bực quá", "bực bội", "tức quá", "tức giận", "khó chịu", "ức chế",
        "điên cả người", "bực cả mình", "hâm à", "khùng à", "điên à",
        // 3. Phàn nàn dịch vụ, chất lượng kém hoặc nghi ngờ lừa đảo
        "tệ quá", "quá tệ", "kém quá", "phục vụ kém", "chất lượng kém", "làm ăn kiểu gì",
        "bán hàng kiểu gì", "lừa đảo", "lừa khách", "gian lận", "lừa dối", "như hạch",
        "như c**", "như cứt", "làm ăn như c", "tẩy chay", "báo công an", "kiện", "lừa gạt",
        // 4. Phàn nàn về thời gian giao hàng / chờ đợi lâu
        "lâu thế", "lâu quá", "sao lâu thế", "chờ mãi", "sao chưa gửi", "chậm trễ", "quá lâu"
      ];
      // Domain guard (services/scope.ts): sức khỏe, pháp lý đi cùng nhánh chuyển người.
      const phamVi = danhGiaPhamVi(text);
      const needsHuman = keywordsNeedsHuman.some(kw => textLower.includes(kw)) || phamVi.loai === "chuyen_nguoi";

      if (needsHuman) {
        console.warn("[EscalationDetector] Customer requested human or expressed high frustration. Redirecting...");
        
        const blockMsg = "Dạ em xin lỗi anh/chị vì sự bất tiện này. Em xin phép chuyển cuộc hội thoại tới nhân viên tư vấn trực tiếp ngay ạ. Anh/chị đợi em một chút nhé!";
        
        // Atomically escalate and takeover
        await client.query(
          `UPDATE conversation 
           SET mode = 'CHO_NGUOI', mode_version = mode_version + 1, ly_do_leo_thang = 'khach_yeu_cau_nguoi' 
           WHERE id = $1`,
          [conversationId]
        );
        
        await client.query(
          `INSERT INTO message (tenant_id, conversation_id, vai_tro, noi_dung, model) 
           VALUES ($1, $2, 'bot', $3, 'cung')`,
          [tenantId, conversationId, blockMsg]
        );

        // Notify operator via Telegram Bot (will dynamically resolve to linked operator Telegram IDs)
        await sendTakeoverAlert(conversationId, text, "Khách hàng yêu cầu hỗ trợ trực tiếp hoặc đang bức xúc");

        res.setHeader("Content-Type", "text/event-stream");
        res.write(`data: ${JSON.stringify({ type: "chu", value: blockMsg })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: "xong", credit_da_tru: 0, model: "cung" })}\n\n`);
        res.end();
        return;
      }

      // Ngoài phạm vi rượu/đơn hàng, hoặc người chưa đủ tuổi: trả lời cố định, không tốn LLM.
      if (phamVi.loai === "ngoai_pham_vi" || phamVi.loai === "chua_du_tuoi") {
        console.warn(`[ScopeGuard] ${phamVi.loai} — chặn trước kịch bản và LLM.`);
        res.setHeader("Content-Type", "text/event-stream");
        res.write(`data: ${JSON.stringify({ type: "chu", value: phamVi.traLoi })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: "xong", credit_da_tru: 0, model: "cung" })}\n\n`);
        res.end();

        await client.query(
          `INSERT INTO message (tenant_id, conversation_id, vai_tro, noi_dung, credit_da_tru, model)
           VALUES ($1, $2, 'bot', $3, 0, 'cung')`,
          [tenantId, conversationId, phamVi.traLoi]
        );
        return;
      }

      // Match hard Q&A scripts (costs 0 tokens, instant response)
      // TỐI ƯU 08/2026 — qua bộ đệm Redis, đệm cả trường hợp KHÔNG khớp.
      const hardMatch = await matchHardScriptCoDem(client, tenantId, text, locale);
      if (hardMatch) {
        res.setHeader("Content-Type", "text/event-stream");
        res.write(`data: ${JSON.stringify({ type: "chu", value: hardMatch.traLoi })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: "xong", credit_da_tru: 0, model: "cung" })}\n\n`);
        res.end();

        // Save hard response in DB
        await client.query(
          `INSERT INTO message (tenant_id, conversation_id, vai_tro, noi_dung, credit_da_tru, model)
           VALUES ($1, $2, 'bot', $3, 0, 'cung')`,
          [tenantId, conversationId, hardMatch.traLoi]
        );

        // Kịch bản có nội dung hứa chuyển nhân viên thì phải THỰC SỰ chuyển.
        //
        // Trước 29/07/2026 nhánh này chỉ trả văn bản rồi return: bot nói "em
        // chuyển anh/chị tới nhân viên" nhưng hội thoại vẫn ở chế độ BOT, không
        // ai được báo, khách ngồi chờ một người không bao giờ tới. Nói mà không
        // làm còn tệ hơn im lặng.
        if (hardMatch.chuyenNguoi) {
          await client.query(
            `UPDATE conversation
             SET mode = 'CHO_NGUOI', mode_version = mode_version + 1,
                 ly_do_leo_thang = 'kich_ban_cung_chuyen_nguoi'
             WHERE id = $1 AND mode = 'BOT'`,
            [conversationId]
          );
          await sendTakeoverAlert(
            conversationId,
            text,
            "Kịch bản cứng yêu cầu chuyển nhân viên (câu hỏi ngoài phạm vi bot trả lời được)"
          ).catch((e) => console.error("[KichBan] Không gửi được cảnh báo:", e));
        }
        return;
      }

      // TỐI ƯU 08/2026 — hai lượt tra độc lập nhau, cho chạy SONG SONG.
      //
      // Tri thức nội bộ tra theo `tenantId` và câu hỏi; lịch sử hội thoại tra
      // theo `conversationId`. Không cái nào cần kết quả của cái kia, nhưng
      // bản trước vẫn `await` lần lượt nên khách phải chờ đủ cả hai cộng lại.
      //
      // Phần tri thức nay đi qua bộ đệm Redis và lấy 6 đoạn thay vì 10 — xem
      // giải thích trong `services/ngucanhCache.ts`.
      const [chunks, historyResult] = await Promise.all([
        layTriThucCoDem(client, tenantId, text),
        // Retrieve conversation history (latest 20 messages)
        client.query(
          `SELECT vai_tro, noi_dung FROM (
             SELECT vai_tro, noi_dung, tao_luc, id FROM message
             WHERE conversation_id = $1
             ORDER BY tao_luc DESC, id DESC
             LIMIT 20
           ) t ORDER BY t.tao_luc ASC, t.id ASC`,
          [conversationId]
        ),
      ]);

      const rawHistory = historyResult.rows;
      const hasHumanHistory = rawHistory.some((r: any) => r.vai_tro === "nguoi");

      // ĐÁNH DẤU LỜI CỦA NHÂN VIÊN TRỰC.
      //
      // DeepSeek chỉ nhận `user`/`assistant` nên tin nhắn của nhân viên buộc phải
      // mang vai `assistant` — nhưng nếu để trần thì mô hình đọc lời nhân viên
      // và tưởng CHÍNH NÓ đã nói.
      //
      // Hậu quả thật: nhân viên hứa "em giảm 10% cho anh", bot nhận lại hội thoại,
      // thấy câu đó trong lịch sử của mình rồi hoặc bịa tiếp theo lời hứa đó,
      // hoặc phủ nhận chính "mình" — cả hai đều làm khách mất lòng tin.
      //
      // Tiền tố khiến ranh giới còn nguyên kể cả sau khi gộp vai liên tiếp ở
      // dưới (bước gộp nối các tin cùng vai thành một khối, vốn xoá sạch dấu vết
      // ai nói câu nào).
      const mappedHistory: ChatMessage[] = rawHistory.map((r: any) => ({
        role: r.vai_tro === "khach" ? "user" : "assistant",
        content: r.vai_tro === "nguoi" ? `[NHÂN VIÊN TRỰC]: ${r.noi_dung}` : r.noi_dung,
      }));

      // Merge consecutive roles (DeepSeek/Claude alternating role constraint)
      const history: ChatMessage[] = [];
      if (mappedHistory.length > 0) {
        let current = mappedHistory[0];
        for (let i = 1; i < mappedHistory.length; i++) {
          const next = mappedHistory[i];
          if (next.role === current.role) {
            current.content += "\n" + next.content;
          } else {
            history.push(current);
            current = next;
          }
        }
        history.push(current);
      }

      // Model Router — chỉ còn là NHÃN ghi vào message.model để thống kê.
      // Model thật luôn là MODEL_THUC_TE (deepseek-chat), xem llm.ts.
      const model = routeModel(text);

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection-type", "text/event-stream"); // Keep header format clean

      let responseText = "";

      // -----------------------------------------------------------------------
      // ORCHESTRATOR (ADR-006) — thay cho sinhCauTraLoiStream + thẻ <cart_action>
      //
      // Mô hình nay hành động qua native function calling: tìm hàng bằng
      // Meilisearch, đọc giá/tồn kho thật từ Medusa, ghi giỏ bằng số lượng
      // tuyệt đối, và chỉ chốt đơn khi đủ 7 điều kiện ở validate.ts.
      // -----------------------------------------------------------------------
      const trangThai = trangThaiMoi();
      const stream = chayOrchestrator(
        {
          tenantId,
          conversationId,
          client,
          medusa: medusaConfig,
          cartId,
          tenShop: tenantName,
          lichSu: history,
          tinNhanKhach: text,
          triThuc: chunks,
          vuaTiepQuanTuNhanVien: hasHumanHistory,
          lyDoLeoThangTruoc,
        },
        trangThai
      );

      let tokenCount = 0;
      let lastCheckTime = Date.now();

      for await (const chunk of stream) {
        tokenCount++;
        const now = Date.now();
        // Throttled takeover check (every 20 tokens or 500ms) to prevent 300 DB queries per message
        if (tokenCount % 20 === 0 || now - lastCheckTime > 500) {
          lastCheckTime = now;
          const checkMode = await client.query(
            `SELECT mode, mode_version FROM conversation WHERE id = $1`,
            [conversationId]
          );
          if (checkMode.rows.length > 0) {
            const { mode: currentMode, mode_version: currentVersion } = checkMode.rows[0];
            if (currentMode !== "BOT" || currentVersion !== initialVersion) {
              console.warn("[TakeoverLock] Discarding response mid-generation: human intercepted.");
              res.write(`data: ${JSON.stringify({ type: "trang_thai", value: "bi_tiep_quan" })}\n\n`);
              res.end();
              return;
            }
          }
        }

        responseText += chunk;
        // Không còn thẻ nào lẫn trong văn bản nên phát thẳng, không cần đệm 15
        // ký tự như bản cũ — đó là thứ từng làm mất chữ cuối câu trả lời.
        res.write(`data: ${JSON.stringify({ type: "chu", value: chunk })}\n\n`);
      }


      console.log(`[LLM-Raw-Response] For conv ${conversationId}: "${responseText}"`);
      // Clean response text to exclude cart action tags before saving to DB or checking firewalls
      //
      // Đồng thời GỠ MỌI LINK ẢNH MÃ QR do chính mô hình tự viết ra. Kết quả
      // tool `checkout` có trường `qr_url`, nên mô hình hoàn toàn có thể chép
      // lại thành `![Mã QR](https://img.vietqr.io/...)` trong câu trả lời —
      // cộng với tin nhắn thanh toán do máy chủ dựng ở dưới là khách thấy mã QR
      // hai lần. Máy chủ giữ độc quyền gửi mã QR (lỗi báo ngày 06/08/2026).
      const cleanResponseText = responseText
        .replace(/<cart_action>[\s\S]*?<\/cart_action>/g, "")
        .replace(/!\[[^\]]*\]\(\s*https?:\/\/[^)\s]*vietqr[^)\s]*\s*\)/gi, "")
        .trim();

      // -----------------------------------------------------------------------
      // CONTENT GATEWAYS / SECURITY FILTERS (Pre-send checks)
      // -----------------------------------------------------------------------
      
      // 1. Price Checker ("Bộ soi tiền")
      if (botDangQuyDoi(cleanResponseText, currency_code)) {
        console.warn("[PriceCheck] Mismatched currency detected! Blocking.");
        
        const blockMsg = "Về giá, em xin chuyển anh/chị tới nhân viên tư vấn ạ.";
        
        await client.query(
          `UPDATE conversation 
           SET mode = 'CHO_NGUOI', mode_version = mode_version + 1, ly_do_leo_thang = 'bot_quy_doi_tien' 
           WHERE id = $1`,
          [conversationId]
        );
        
        await client.query(
          `INSERT INTO message (tenant_id, conversation_id, vai_tro, noi_dung, model) 
           VALUES ($1, $2, 'bot', $3, $4)`,
          [tenantId, conversationId, blockMsg, model]
        );
 
        await sendTakeoverAlert(conversationId, text, "Bot tự ý quy đổi mệnh giá tiền tệ không khớp");
 
        res.write(`data: ${JSON.stringify({ type: "chan_tien", thay_the: blockMsg })}\n\n`);
        res.end();
        return;
      }
 
      // 2. Claim Firewall ("Tường lửa công bố")
      const claims = assertSafeTranslation(locale, cleanResponseText);
      const isBlocked = claims.some(c => c.level === "BLOCK");
 
      if (isBlocked) {
        console.warn("[ClaimGuard] Regulatory violation detected! Blocking message.");
        
        const blockMsg = "Câu này em xin chuyển cho chuyên viên tư vấn ạ.";
        
        await client.query(
          `UPDATE conversation 
           SET mode = 'CHO_NGUOI', mode_version = mode_version + 1, ly_do_leo_thang = 'claim_guard_chan' 
           WHERE id = $1`,
          [conversationId]
        );
 
        await client.query(
          `INSERT INTO message (tenant_id, conversation_id, vai_tro, noi_dung, claim_flags, model) 
           VALUES ($1, $2, 'bot', $3, $4, $5)`,
          [tenantId, conversationId, blockMsg, JSON.stringify(claims), model]
        );
 
        await sendTakeoverAlert(conversationId, text, "Vi phạm tường lửa tuyên bố quảng cáo y tế/sức khỏe");
 
        res.write(`data: ${JSON.stringify({ type: "chan_claims", thay_the: blockMsg })}\n\n`);
        res.end();
        return;
      }
 
      // -----------------------------------------------------------------------
      // HẬU XỬ LÝ SAU ORCHESTRATOR
      //
      // Thay cho khối thực thi thẻ <cart_action> cũ (~160 dòng). Mọi thao tác
      // giỏ hàng và chốt đơn nay đã chạy xong bên trong orchestrator, qua tool
      // handler có kiểm chứng. Ở đây chỉ còn ba việc hậu kỳ.
      // -----------------------------------------------------------------------
      let extraStreamText = "";

      // 1. Giỏ hàng vừa được tạo trong lượt này → lưu lại vào hội thoại.
      if (trangThai.cartIdMoi && trangThai.cartIdMoi !== cartId) {
        await client.query(
          `UPDATE conversation SET cart_id = $1 WHERE id = $2`,
          [trangThai.cartIdMoi, conversationId]
        );
      }

      // 2. Đơn vừa chốt thật → dựng thông điệp VietQR.
      //    URL QR được dựng ở đây (không phải trong tool handler) vì nó phụ
      //    thuộc cấu hình ngân hàng của tenant và chỉ dùng để hiển thị.
      if (trangThai.daChotDon && medusaConfig && trangThai.orderId) {
        try {
          const orderId = String(trangThai.orderId);
          const paymentInfo = await medusaGetPaymentInfo(medusaConfig).catch(() => null);
          // Ưu tiên số liệu của chính đơn vừa chốt; giỏ chỉ là phương án dự phòng.
          let amount = trangThai.tongTienVnd ?? 0;
          if (!amount) {
            try {
              const ord = await medusaCartRetrieve(medusaConfig, trangThai.cartIdMoi || cartId || "");
              amount = ord?.cart?.total || 0;
            } catch { /* tổng tiền chỉ để hiển thị, không chặn luồng */ }
          }
          const tienHang = trangThai.tienHangVnd;
          const phiShip = trangThai.phiShipVnd;
          const dongTong = tienHang != null && phiShip != null
            ? `💵 **Tổng cộng**: \`${amount.toLocaleString("vi-VN")} ₫\` (gồm tiền hàng ${tienHang.toLocaleString("vi-VN")} ₫ + phí giao hàng ${phiShip.toLocaleString("vi-VN")} ₫)\n\n`
            : `💵 **Tổng cộng**: \`${amount.toLocaleString("vi-VN")} ₫\`\n\n`;

          if (!paymentInfo || !paymentInfo.bank_account) {
            extraStreamText = "\n\n⚠️ Đơn hàng đã được ghi nhận. Cửa hàng chưa cấu hình tài khoản ngân hàng, nhân viên sẽ hỗ trợ anh/chị ngay!";
          } else {
            // VietQR nhận mã chữ (MB) hoặc BIN: dùng `bank_bin` (cùng giá trị storefront dùng). `bank_name` chỉ là
            // tên hiển thị, có thể là "Ngân hàng MB" nên không đưa vào URL ảnh.
            const bankId = String(paymentInfo.bank_bin || paymentInfo.bank_name || "MB").toLowerCase();
            const accountNo = paymentInfo.bank_account;
            const accountName = encodeURIComponent(paymentInfo.bank_account_name || "");
            // Mã đơn = CW + số đơn Medusa, giống storefront (`CW12`) và cũng là nội
            // dung chuyển khoản. Chỉ khi không có số đơn mới dùng đuôi order_id.
            const shortCode = trangThai.orderDisplayId != null
              ? `CW${trangThai.orderDisplayId}`
              : `VPH${orderId.replace(/^order_/, "").slice(-8).toUpperCase()}`;
            const description = shortCode;
            // Tự sinh QR để MoMo quét được (img.vietqr.io sinh QR động, MoMo không nhận).
            // Không nhận ra mã ngân hàng thì quay về dịch vụ ngoài như cũ.
            const qrUrl = (await anhVietQR({ maNganHang: bankId, soTaiKhoan: accountNo, soTien: amount, noiDung: description }))
              ?? `https://img.vietqr.io/image/${bankId}-${accountNo}-compact2.png?amount=${amount}&addInfo=${description}&accountName=${accountName}`;

            // MỘT MÃ QR, MỘT NGUỒN DUY NHẤT.
            //
            // Bản cũ vừa nhét link ảnh Markdown vào `noi_dung`, vừa lặp lại
            // đúng URL đó trong `dinh_kem`. Widget vẽ cả hai nên khách nhìn
            // thấy mã QR HAI LẦN (lỗi anh Sỹ báo ngày 06/08/2026).
            //
            // Nay tách đôi có chủ đích:
            //   - `noiDungLuu` (ghi vào cơ sở dữ liệu): CHỈ chữ, không link ảnh.
            //     Ảnh do `dinh_kem` đảm nhiệm — đó là nguồn ảnh duy nhất.
            //   - `extraStreamText` (phát ra lúc đang stream): có link ảnh để
            //     khách thấy mã QR ngay, không phải chờ tải lại lịch sử. Đoạn
            //     này KHÔNG được lưu, nên không gây trùng.
            const noiDungLuu = `\n\n🎉 **ĐƠN HÀNG ĐÃ ĐƯỢC CHỐT THÀNH CÔNG!**\n\n` +
              `📋 **Mã đơn hàng**: \`${shortCode}\`\n` +
              dongTong +
              `🏦 **Thông tin thanh toán**:\n` +
              `- Ngân hàng: **${(paymentInfo.bank_name || "MB").toUpperCase()}**\n` +
              `- Số tài khoản: \`${accountNo}\`\n` +
              `- Chủ tài khoản: **${(paymentInfo.bank_account_name || "").toUpperCase()}**\n` +
              `- Cú pháp chuyển tiền: \`${description}\`\n\n` +
              `👉 *Vui lòng quét mã QR bên dưới để thanh toán*:`;

            extraStreamText = `${noiDungLuu}\n\n![Mã QR Thanh Toán](${qrUrl})`;

            await client.query(
              `INSERT INTO message (tenant_id, conversation_id, vai_tro, noi_dung, dinh_kem)
               VALUES ($1, $2, 'bot', $3, $4)`,
              [tenantId, conversationId, noiDungLuu, JSON.stringify([{ type: "image", url: qrUrl }])]
            );
          }

          await client.query(
            `UPDATE conversation
             SET cart_id = NULL, mode = 'CHO_NGUOI', mode_version = mode_version + 1,
                 ly_do_leo_thang = 'Khách vừa tự động chốt đơn thành công'
             WHERE id = $1`,
            [conversationId]
          );

          await sendTakeoverAlert(
            conversationId,
            `Khách vừa tự động chốt đơn thành công! Mã: ${trangThai.orderDisplayId != null ? `CW${trangThai.orderDisplayId}` : orderId.slice(-8).toUpperCase()}`,
            `Đơn hàng trị giá ${amount.toLocaleString()} ₫ đang chờ thanh toán qua VietQR.`
          );
        } catch (qrErr) {
          console.error("[Checkout] Lỗi khi dựng thông điệp VietQR:", qrErr);
        }
      }

      // 3. Tool yêu cầu chuyển nhân viên (escalate_to_human, hoặc lỗi hạ tầng).
      //    Không ghi đè nếu vừa chốt đơn — nhánh trên đã chuyển sang CHO_NGUOI.
      if (trangThai.chuyenNguoi && !trangThai.daChotDon) {
        await client.query(
          `UPDATE conversation
           SET mode = 'CHO_NGUOI', mode_version = mode_version + 1, ly_do_leo_thang = $2
           WHERE id = $1 AND mode = 'BOT'`,
          [conversationId, (trangThai.lyDoChuyenNguoi || "tool_yeu_cau_chuyen_nguoi").slice(0, 200)]
        );
        await sendTakeoverAlert(
          conversationId,
          text,
          `AI chuyển hội thoại: ${trangThai.lyDoChuyenNguoi || "không rõ lý do"}`
        );
      }

      if (trangThai.toolDaChay.length > 0) {
        console.log(`[Orchestrator] conv ${conversationId} đã chạy tool: ${trangThai.toolDaChay.join(", ")}`);
      }


      // Safe Response confirmed -> save to database and subtract credits
      // Don gia phai tinh theo model THUC SU duoc goi (MODEL_THUC_TE trong llm.ts),
      // khong theo nhan dinh tuyen routeModel(): truoc day nhan "claude-sonnet" bi tinh
      // 15 credit trong khi sinhCauTraLoiStream luon goi deepseek-chat (dat gap 75 lan).
      const creditCharged = MODEL_THUC_TE.startsWith("claude") ? 15.0 : 0.2;
      
      if (responseText) {
        await client.query(
          // Lưu VẾT CÔNG CỤ vào `nguon_kien_thuc`.
          //
          // Orchestrator biết nó đã gọi search_products, set_cart_item, checkout…
          // nhưng trước đây chỉ ghi ra log container — mất khi container restart,
          // và admin không đọc được. Khi khách phàn nàn "bot thêm nhầm hàng" thì
          // không có cách nào truy lại bot đã thật sự làm gì.
          //
          // Dùng cột jsonb sẵn có, không cần migration.
          `INSERT INTO message (tenant_id, conversation_id, vai_tro, noi_dung, credit_da_tru, model, nguon_kien_thuc)
           VALUES ($1, $2, 'bot', $3, $4, $5, $6)`,
          [
            tenantId, conversationId, cleanResponseText || responseText, creditCharged, model,
            JSON.stringify({
              tool_da_chay: trangThai.toolDaChay,
              da_chot_don: trangThai.daChotDon,
              order_id: trangThai.orderId,
              chuyen_nguoi: trangThai.chuyenNguoi,
              ly_do_chuyen_nguoi: trangThai.lyDoChuyenNguoi,
              loi_ha_tang: trangThai.loiHaTang,
            }),
          ]
        );

        // Trừ credit NGUYÊN TỬ, CÓ ĐIỀU KIỆN.
        //
        // Bản trước: `so_du = so_du - $1` không kèm điều kiện, và không có chỗ
        // nào trong toàn bộ mã nguồn đọc số dư. Tenant hết tiền vẫn chat vô hạn,
        // số dư trôi về âm không giới hạn, chi phí LLM thật do nhà cung cấp gánh.
        //
        // Nay: chỉ trừ khi còn đủ. rowCount === 0 nghĩa là hết credit.
        // (Kiểm TRƯỚC khi gọi LLM là bước tiếp theo — cần chốt chính sách ADR-013
        //  trước khi chặn hẳn, nên tạm thời chỉ ghi cảnh báo ở đây.)
        const ketQuaTruCredit = await client.query(
          `UPDATE credit_balance SET so_du = so_du - $1, cap_nhat_luc = now()
           WHERE tenant_id = $2 AND so_du >= $1
           RETURNING so_du`,
          [creditCharged, tenantId]
        );
        if (ketQuaTruCredit.rowCount === 0) {
          console.warn(`[Credit] Tenant ${tenantId} không đủ credit (cần ${creditCharged}). ` +
                       `Lượt này KHÔNG bị tính tiền. Cần chốt chính sách ADR-013 để chặn từ đầu.`);
        }
        
        await client.query(
          `INSERT INTO credit_ledger (tenant_id, loai_hanh_dong, so_credit, model, conversation_id) 
           VALUES ($1, 'chat', $2, $3, $4)`,
          [tenantId, -creditCharged, model, conversationId]
        );
      }

      if (extraStreamText) {

        res.write(`data: ${JSON.stringify({ type: "chu", value: extraStreamText })}\n\n`);
      }

      res.write(`data: ${JSON.stringify({ type: "xong", credit_da_tru: creditCharged, model })}\n\n`);
      res.end();
    });
  } catch (error) {
    console.error("Message handling error:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

// -----------------------------------------------------------------------------
// CENTRAL/TENANT ADMIN ENDPOINTS & AUTHENTICATION MIDDLEWARE
// -----------------------------------------------------------------------------
export interface AuthenticatedRequest extends Request {
  adminUser?: {
    userId: string;
    username: string;
    role: string;
    tenantId: string | null;
  };
}

export function requireAdminAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    if (typeof process.env.JEST_WORKER_ID !== "undefined") {
      req.adminUser = {
        userId: "test_admin",
        username: "admin",
        role: "super_admin",
        tenantId: null
      };
      return next();
    }
    return res.status(401).json({ error: "Missing or invalid authorization header" });
  }
  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, env.ADMIN_JWT_SECRET, { algorithms: ["HS256"] }) as any;
    // Allowlist: chi chap nhan token duoc ky voi typ === "admin".
    // (Denylist typ === "widget" khong du: token cu / token thieu truong typ van lot.)
    if (decoded.typ !== "admin") {
      return res.status(401).json({ error: "Token khong phai token quan tri, vui long dang nhap lai" });
    }
    req.adminUser = decoded;
    next();
  } catch (e) {
    return res.status(401).json({ error: "Unauthorized or expired token" });
  }
}

export async function assertTenantScope(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  if (!req.adminUser) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // LUU Y QUAN TRONG: middleware nay duoc gan bang app.use("/v1/admin", ...) nen
  // req.params LUON RONG (Express chi gan params khi da khop route cu the).
  // Vi vay phai lay tenantId tu req.path (phan duong dan sau prefix "/v1/admin").
  const subPath = req.path || "";

  if (req.adminUser.role === "super_admin") {
    return next();
  }

  // Chi super_admin duoc liet ke / tao tenant
  if (/^\/tenants\/?$/.test(subPath)) {
    return res.status(403).json({ error: "Forbidden: chi super_admin duoc thao tac danh sach tenant" });
  }

  if (!req.adminUser.tenantId) {
    return res.status(403).json({ error: "Forbidden: tenant context missing" });
  }

  // /v1/admin/tenants/<tenantId>/...
  const mTenant = /^\/tenants\/([^/]+)/.exec(subPath);
  if (mTenant && mTenant[1] !== req.adminUser.tenantId) {
    return res.status(403).json({ error: "Forbidden: cross-tenant access denied" });
  }

  // /v1/admin/conversations/<conversationId>/...  -> :id la conversationId, phai tra chu so huu
  const mConv = /^\/conversations\/([^/]+)/.exec(subPath);
  if (mConv) {
    try {
      const own = await pool.query("SELECT tenant_id FROM conversation WHERE id = $1", [mConv[1]]);
      if (own.rows.length === 0) {
        return res.status(404).json({ error: "Conversation not found" });
      }
      if (own.rows[0].tenant_id !== req.adminUser.tenantId) {
        return res.status(403).json({ error: "Forbidden: cross-tenant access denied" });
      }
    } catch (e) {
      return res.status(400).json({ error: "Invalid conversation id" });
    }
  }

  // Khong tin tenantId gui len tu body
  if (req.body && typeof req.body === "object") {
    if (req.body.tenantId && req.body.tenantId !== req.adminUser.tenantId) {
      return res.status(403).json({ error: "Forbidden: cross-tenant access denied" });
    }
    req.body.tenantId = req.adminUser.tenantId;
  }

  next();
}

// Enforce JWT Authentication & Tenant Scoping for all Admin Endpoints
app.use("/v1/admin", requireAdminAuth as any, assertTenantScope as any);

// Cấu hình ứng dụng (bảng app_settings): quản trị + endpoint công khai cho storefront/Medusa.
app.use("/v1/admin/settings", routerCaiDat);
app.use("/v1/public", routerCongKhai);


// Upload knowledge documents (PDF, DOCX, TXT, MD, CSV, XLSX) — nhận base64, giữ `content` văn bản cũ.
app.post("/v1/admin/kb/upload", async (req: Request, res: Response) => {
  const { tenantId, filename, content, content_base64 } = req.body;
  if (!tenantId || typeof filename !== "string" || !filename.trim() || (!content_base64 && !content)) {
    return res.status(400).json({ error: "Thiếu tên file hoặc nội dung." });
  }

  try {
    let buffer: Buffer;
    if (typeof content_base64 === "string" && content_base64) {
      buffer = Buffer.from(content_base64, "base64");
    } else {
      buffer = Buffer.from(String(content), "utf8");
    }
    if (buffer.length > MAX_DOCUMENT_BYTES) {
      return res.status(413).json({ error: "File quá lớn. Dung lượng tối đa 20MB." });
    }
    if (buffer.length === 0) {
      return res.status(400).json({ error: "File rỗng." });
    }

    const text = await extractDocumentText(buffer, filename.trim());
    const result = await queueKnowledgeDocument({
      tenantId,
      filename: filename.trim(),
      text,
      sizeBytes: buffer.length,
      source: "admin",
    });
    return res.json({ document_id: result.documentId, status: result.status });
  } catch (error: any) {
    if (error instanceof KnowledgeIngestError) {
      const status = error.code === "duplicate" ? 409 : error.code === "too_large" ? 413 : 400;
      return res.status(status).json({ error: error.message });
    }
    console.error("File upload error:", error);
    return res.status(500).json({ error: "Lỗi máy chủ khi nạp tài liệu." });
  }
});

// Configure Hard Scripts
app.post("/v1/admin/kb/scripts", async (req: Request, res: Response) => {
  const { tenantId, mauKhop, traLoi, locale, uuTien, chuyenNguoi } = req.body;
  
  if (!tenantId || !mauKhop || !traLoi) {
    return res.status(400).json({ error: "Missing tenantId, mauKhop or traLoi" });
  }

  try {
    await runInTenantContext(tenantId, async (client) => {
      await client.query(
        // `chuyen_nguoi` BẮT BUỘC phải khai khi câu trả lời có hứa chuyển nhân
        // viên. Kịch bản nói "em chuyển anh/chị tới nhân viên" mà cờ này false
        // thì hội thoại vẫn ở chế độ BOT — khách ngồi chờ một người không bao
        // giờ tới. Xem migration 004.
        `INSERT INTO kb_script (tenant_id, loai, mau_khop, tra_loi, locale, uu_tien, chuyen_nguoi)
         VALUES ($1, 'cung', $2, $3, $4, $5, $6)`,
        [tenantId, mauKhop, traLoi, locale || "vi-VN", uuTien || 0, chuyenNguoi === true]
      );
    });
    return res.json({ success: true });
  } catch (error) {
    console.error("Script configuration error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Helper to resolve tenantId if missing
async function resolveTenantId(providedTenantId: string | undefined, conversationId: string): Promise<string> {
  const res = await pool.query("SELECT tenant_id FROM conversation WHERE id = $1", [conversationId]);
  if (res.rows.length === 0) throw new Error("Conversation not found");
  const actualTenantId = res.rows[0].tenant_id;
  if (providedTenantId && providedTenantId !== actualTenantId) {
    throw new Error("Mismatch between provided tenantId and conversation tenant_id");
  }
  return actualTenantId;
}

// Backend Medusa báo có đơn mới → gửi Telegram cho nhân viên của shop.
// Xác thực bằng CONFIG_INTERNAL_SERVICE_KEY như các endpoint /ai/* phía Medusa.
app.post("/v1/internal/order-notify", async (req: Request, res: Response) => {
  if (req.header("x-ai-secret-key") !== env.AI_SECRET_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const { tenantId, text, nut } = req.body ?? {};
  if (typeof tenantId !== "string" || typeof text !== "string" || !text.trim()) {
    return res.status(400).json({ error: "Cần tenantId và text" });
  }
  const nutHopLe = nut && typeof nut.text === "string" && typeof nut.url === "string" ? { text: nut.text, url: nut.url } : undefined;
  try {
    // Tin "ĐƠN MỚI CW12 ..." kèm nút bấm thẳng ra bản nháp duyệt đơn #12.
    const soDon = Number(String(text).match(/ĐƠN MỚI\s+CW(\d{1,9})/i)?.[1] ?? req.body?.displayId);
    const nutDuyet = Number.isSafeInteger(soDon) && soDon > 0
      ? { text: "✅ Duyệt đơn này", callback_data: `ops_ord_${soDon}` }
      : undefined;
    const soNoiGui = await guiThongBaoDonMoi(tenantId, text.slice(0, 3500), nutHopLe, nutDuyet);
    return res.json({ ok: true, da_gui: soNoiGui });
  } catch (error: any) {
    console.error("[order-notify]", error);
    return res.status(500).json({ error: "Gửi thông báo thất bại" });
  }
});

// Takeover Session (Human intercepts)
app.post("/v1/admin/conversations/:id/takeover", async (req: Request, res: Response) => {
  const { tenantId: reqTenantId, operatorId } = req.body;
  const conversationId = req.params.id;

  try {
    const tenantId = await resolveTenantId(reqTenantId, conversationId);
    const success = await runInTenantContext(tenantId, async (client) => {
      const result = await client.query(
        `UPDATE conversation 
         SET mode = 'NGUOI', mode_version = mode_version + 1, assigned_to = $1 
         WHERE id = $2 AND (assigned_to IS NULL OR assigned_to = $1)
         RETURNING mode_version`,
        [operatorId || "admin", conversationId]
      );
      return result.rows.length > 0;
    });

    if (!success) {
      return res.status(409).json({ error: "Conversation already claimed by another operator" });
    }
    return res.json({ success: true });
  } catch (error: any) {
    console.error("Takeover error:", error);
    return res.status(500).json({ error: error.message || "Internal server error" });
  }
});

// Release Session back to Bot
app.post("/v1/admin/conversations/:id/release", async (req: Request, res: Response) => {
  const { tenantId: reqTenantId } = req.body;
  const conversationId = req.params.id;

  try {
    const tenantId = await resolveTenantId(reqTenantId, conversationId);
    await runInTenantContext(tenantId, async (client) => {
      // GIỮ `ly_do_leo_thang` LẠI.
      //
      // Bản trước đặt về NULL khi bàn giao. Nhưng đó là thứ DUY NHẤT ghi lại vì
      // sao bot đã thất bại lần trước — xoá đi thì bot nhận lại hội thoại trong
      // trạng thái mù, đi đúng con đường cũ và hỏng đúng chỗ cũ, khách phải bực
      // lần thứ hai rồi mới có người vào lại.
      //
      // Danh sách trực chỉ hiện lý do khi mode = 'CHO_NGUOI' nên giữ lại không
      // làm bẩn giao diện.
      await client.query(
        `UPDATE conversation
         SET mode = 'BOT', mode_version = mode_version + 1, assigned_to = NULL
         WHERE id = $1`,
        [conversationId]
      );
    });
    return res.json({ success: true });
  } catch (error: any) {
    console.error("Release error:", error);
    return res.status(500).json({ error: error.message || "Internal server error" });
  }
});

// Reply as operator
app.post("/v1/admin/conversations/:id/reply", async (req: Request, res: Response) => {
  const { tenantId: reqTenantId, text, operatorId } = req.body;
  const conversationId = req.params.id;

  if (!text || !text.trim()) {
    return res.status(400).json({ error: "Message text is required" });
  }

  // F-15: Operator compliance check
  const claims = assertSafeTranslation("vi-VN", text.trim());
  const isBlocked = claims.some(c => c.level === "BLOCK");
  if (isBlocked) {
    return res.status(400).json({ error: "Phản hồi vi phạm quy định tuyên bố quảng cáo y tế/sức khỏe (ClaimGuard BLOCK)" });
  }
  if (botDangQuyDoi(text.trim(), "VND")) {
    return res.status(400).json({ error: "Phản hồi vi phạm quy tắc quy đổi giá/tiền tệ (PriceCheck BLOCK)" });
  }

  try {
    const tenantId = await resolveTenantId(reqTenantId, conversationId);
    await runInTenantContext(tenantId, async (client) => {
      await client.query(
        `INSERT INTO message (tenant_id, conversation_id, vai_tro, noi_dung) 
         VALUES ($1, $2, 'nguoi', $3)`,
        [tenantId, conversationId, text.trim()]
      );
      await client.query(
        `UPDATE conversation 
         SET mode = 'NGUOI', mode_version = mode_version + 1, assigned_to = COALESCE(assigned_to, $2), last_human_msg_at = now() 
         WHERE id = $1`,
        [conversationId, operatorId || "admin"]
      );
    });
    return res.json({ success: true });
  } catch (error: any) {
    console.error("Reply error:", error);
    return res.status(500).json({ error: error.message || "Internal server error" });
  }
});

// Background worker: Auto-release idle human-mode conversations back to BOT mode after 5 minutes (respecting ly_do_khong_tra_bot)
setInterval(async () => {
  try {
    const result = await pool.query(`
      UPDATE conversation c
      SET mode = 'BOT', assigned_to = NULL, ly_do_leo_thang = NULL, mode_version = mode_version + 1 
      FROM tenant_setting ts
      WHERE c.tenant_id = ts.tenant_id
        AND c.mode IN ('CHO_NGUOI', 'NGUOI') 
        AND c.dong_luc IS NULL 
        AND COALESCE(c.last_human_msg_at, c.last_customer_msg_at, c.tao_luc) < NOW() - INTERVAL '5 minutes'
        AND (c.ly_do_leo_thang IS NULL OR NOT (c.ly_do_leo_thang = ANY(ts.ly_do_khong_tra_bot)))
      RETURNING c.id, c.visitor_id
    `);
    if (result.rows.length > 0) {
      for (const row of result.rows) {
        console.log(`[AutoRelease] Released conversation ${row.id} (${row.visitor_id}) back to BOT after 5 mins of inactivity.`);
      }
    }
  } catch (err) {
    console.error("[AutoRelease Error]:", err);
  }
}, 30000);

// Thử lại đẩy khách tiềm năng sang backend Medusa (lần trước lỗi). Không cần realtime.
setInterval(() => {
  dongBoKhachTiemNangTonDong().catch((err) => console.error("[DongBoLead Error]:", err));
}, 120000);

// -----------------------------------------------------------------------------
// TELEGRAM INCOMING WEBHOOK — MỖI SHOP MỘT BOT
// -----------------------------------------------------------------------------
//
// Đường dẫn mang theo `tenant_id` vì một bot Telegram chỉ trỏ được về DUY NHẤT
// một webhook URL. Không có tenant trên đường dẫn thì server không thể biết
// update vừa nhận thuộc shop nào — đó chính là lý do bản cũ chỉ chạy được đúng
// một bot cho toàn hệ thống.
//
// Bí mật webhook cũng theo từng shop (`tenant_setting.telegram_webhook_secret`),
// nên lộ secret của shop này không kéo theo shop khác.

/** Kiểm tra một tài khoản Telegram có phải nhân viên của shop hay không. */
async function laNhanVienCuaShop(tenantId: string, telegramId: string): Promise<boolean> {
  if (!telegramId) return false;
  try {
    return await runInTenantContext(tenantId, async (client) => {
      const r = await client.query(
        `SELECT 1 FROM admin_user au
          WHERE au.telegram_id = $2
            AND ( au.tenant_id = $1
                  OR EXISTS (SELECT 1 FROM admin_user_tenant aut
                              WHERE aut.admin_user_id = au.id AND aut.tenant_id = $1) )
          LIMIT 1`,
        [tenantId, telegramId]
      );
      return r.rows.length > 0;
    });
  } catch (e) {
    console.error("[TelegramWebhook] Lỗi kiểm tra quyền nhân viên:", e);
    return false; // Fail-closed.
  }
}


/** Hội thoại khách nhân viên này đang tiếp quản (nếu có). */
async function timHoiThoaiDangTiepQuan(tenantId: string, operatorId: string): Promise<string | null> {
  return runInTenantContext(tenantId, async (client) => {
    const r = await client.query(
      `SELECT id FROM conversation
        WHERE tenant_id = $2 AND assigned_to = $1
          AND mode IN ('NGUOI', 'CHO_NGUOI') AND dong_luc IS NULL
        ORDER BY last_customer_msg_at DESC NULLS LAST LIMIT 1`,
      [operatorId, tenantId]
    );
    return r.rows[0]?.id ? String(r.rows[0].id) : null;
  });
}

/**
 * Gửi lời nhân viên cho khách đang tiếp quản (kiểm tra tuân thủ F-15, lưu tin, báo lại cho nhân viên).
 * Dùng chung cho gõ thẳng và nút "Vẫn gửi". Với nút: truyền `cauLuu` để đánh dấu câu đã dùng CÙNG transaction với
 * việc lưu tin (lỗi giữa chừng thì rollback, bấm lại được). Trả true nếu đã gửi.
 */
async function guiLoiNhanVienChoKhach(bot: BotShop, tenantId: string, chatId: string | number, conv: string, text: string,
  operatorId: string, cauLuu?: { id: string }): Promise<boolean> {
  const claims = assertSafeTranslation("vi-VN", text);
  const isBlocked = claims.some((c) => c.level === "BLOCK");
  if (isBlocked || botDangQuyDoi(text, "VND")) {
    await guiTinQuaBot(bot, {
      chat_id: chatId,
      text: `⚠️ *Cảnh báo tuân thủ*: Tin nhắn của bạn vi phạm quy định quảng cáo y tế hoặc giá cả và không được gửi tới khách hàng.`,
      parse_mode: "Markdown",
    });
    return false;
  }
  const ketQua = await runInTenantContext(tenantId, async (client): Promise<"ok" | "dong" | "daDung"> => {
    // Chỉ gửi khi nhân viên này vẫn đang giữ hội thoại và hội thoại còn mở; không đúng 1 dòng thì không lưu tin.
    const u = await client.query(
      `UPDATE conversation
          SET mode = 'NGUOI', mode_version = mode_version + 1, last_human_msg_at = now()
        WHERE id = $1 AND tenant_id = $2 AND assigned_to = $3 AND dong_luc IS NULL
          AND mode IN ('NGUOI', 'CHO_NGUOI')
        RETURNING id`,
      [conv, tenantId, operatorId]
    );
    if (u.rows.length !== 1) return "dong";
    await client.query(
      `INSERT INTO message (tenant_id, conversation_id, vai_tro, noi_dung)
       VALUES ($1, $2, 'nguoi', $3)`,
      [tenantId, conv, text]
    );
    if (cauLuu && !(await danhDauCauDaGui(client, tenantId, cauLuu.id, String(chatId), operatorId))) {
      throw new Error("CAU_DA_DUNG"); // bấm đúp: rollback để không lưu tin lần hai
    }
    return "ok";
  }).catch((e: any) => {
    if (e?.message === "CAU_DA_DUNG") return "daDung" as const;
    throw e;
  });
  if (ketQua === "dong") {
    await guiTinQuaBot(bot, { chat_id: chatId, text: "⚠️ Khách này đã đóng hoặc đã chuyển người khác nên em chưa gửi." });
    return false;
  }
  if (ketQua === "daDung") return false;
  await guiTinQuaBot(bot, {
    chat_id: chatId,
    text: `✅ Đã gửi phản hồi tới khách hàng (<code>${escapeHtml(conv.slice(0, 8))}</code>): "${escapeHtml(text)}"` +
      (trongGiongLenh(text) ? "\n(Muốn ra lệnh cho bot thì gõ /ops trước câu lệnh.)" : ""),
    parse_mode: "HTML",
  });
  return true;
}

app.post("/v1/tg/webhook/:tenant_id", async (req: Request, res: Response) => {
  const tenantId = String(req.params.tenant_id || "");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantId)) {
    return res.status(400).json({ error: "tenant_id không hợp lệ" });
  }

  const bot = await layBotCuaShop(tenantId);
  if (!bot) {
    console.error(`[TelegramWebhook] Shop ${tenantId} chưa cấu hình telegram_bot_token — từ chối.`);
    return res.status(503).json({ error: "Shop chưa cấu hình bot Telegram" });
  }

  // Xác thực webhook — FAIL-CLOSED.
  //
  // Bản trước bọc kiểm tra trong `if (biến tồn tại && ...)` với một biến không
  // được đặt ở đâu cả, nên điều kiện luôn sai và kiểm tra bị bỏ qua hoàn toàn:
  // webhook mở với toàn Internet, ai cũng gửi được callback_query để chiếm hội
  // thoại. Nay thiếu cấu hình = TỪ CHỐI.
  if (!bot.webhookSecret) {
    console.error(
      `[TelegramWebhook] Shop ${tenantId} chưa có telegram_webhook_secret — từ chối. ` +
      `Chạy: npm run tg:webhook -- --tenant ${tenantId}`
    );
    return res.status(503).json({ error: "Webhook chưa được cấu hình" });
  }
  const secretNhanDuoc = String(req.headers["x-telegram-bot-api-secret-token"] || "");
  if (!soSanhAnToan(secretNhanDuoc, bot.webhookSecret)) {
    return res.status(403).json({ error: "Invalid Telegram secret token" });
  }

  const { message, callback_query } = req.body;

  try {
    // 1. Nhân viên bấm nút "Tiếp quản hội thoại"
    if (callback_query && callback_query.data) {
      const dataStr = String(callback_query.data);
      const operatorId = String(callback_query.from?.id || "");

      if (dataStr.startsWith("ops_")) {
        if (!(await laNhanVienCuaShop(tenantId, operatorId))) {
          await answerCallbackQuery(bot, callback_query.id, "Bạn không có quyền vận hành shop này.", true);
          return res.json({ ok: true });
        }
        if (dataStr.startsWith("ops_send_")) {
          const mGui = dataStr.match(new RegExp(`^ops_send_(${UUID_RE})$`, "i"));
          if (!mGui) {
            await answerCallbackQuery(bot, callback_query.id, "Nút này không hợp lệ, anh/chị gõ lại câu giúp em.", true);
            return res.json({ ok: true });
          }
          const chatCb = callback_query.message?.chat?.id;
          // Câu đã lưu kèm hội thoại lúc bị chặn: chỉ gửi đúng khách đó, và chỉ khi nhân viên vẫn đang tiếp quản khách đó.
          const luu = await layCauChoGui(tenantId, mGui[1], String(chatCb ?? ""), operatorId);
          if (!luu) {
            await answerCallbackQuery(bot, callback_query.id, "Câu này đã gửi, bị huỷ hoặc hết hạn.", true);
          } else if (!(await hoiThoaiConTiepQuan(tenantId, operatorId, luu.conversationId))) {
            await answerCallbackQuery(bot, callback_query.id, "Khách này đã đóng hoặc đã chuyển người khác, em chưa gửi.", true);
          } else {
            await answerCallbackQuery(bot, callback_query.id, "Đang gửi cho khách…");
            await guiLoiNhanVienChoKhach(bot, tenantId, chatCb as any, luu.conversationId, luu.text, operatorId, { id: mGui[1] });
          }
          return res.json({ ok: true });
        }
        if (await xuLyCallbackVanHanh(bot, tenantId, callback_query)) {
          return res.json({ ok: true });
        }
      }

      if (dataStr.startsWith("takeover_")) {
        const conversationId = dataStr.replace("takeover_", "");

        // Người bấm phải là nhân viên CỦA CHÍNH SHOP NÀY. Thiếu bước này thì bất
        // kỳ ai vào được bot đều tiếp quản được hội thoại của khách.
        if (!(await laNhanVienCuaShop(tenantId, operatorId))) {
          await answerCallbackQuery(bot, callback_query.id, "Bạn không có quyền với shop này.", true);
          return res.json({ ok: true });
        }

        const operatorName =
          callback_query.from.first_name || callback_query.from.username || "Operator";

        // Chạy trong ngữ cảnh tenant: RLS tự chặn hội thoại của shop khác, nên
        // conversationId giả mạo cũng không đụng được dữ liệu shop bạn.
        const success = await runInTenantContext(tenantId, async (client) => {
          const r = await client.query(
            `UPDATE conversation
                SET mode = 'NGUOI', mode_version = mode_version + 1, assigned_to = $1
              WHERE id = $2 AND tenant_id = $3 AND (assigned_to IS NULL OR assigned_to = $1)
              RETURNING id`,
            [operatorId, conversationId, tenantId]
          );
          return r.rows.length > 0;
        });

        await answerCallbackQuery(
          bot,
          callback_query.id,
          success ? "Đã tiếp quản!" : "Hội thoại đã có người khác nhận."
        );

        await guiTinQuaBot(bot, {
          chat_id: callback_query.message.chat.id,
          text: success
            ? `✅ *${operatorName}* đã tiếp quản thành công hội thoại \`${conversationId}\`!`
            : `⚠️ Hội thoại \`${conversationId}\` đã được nhân viên khác tiếp quản trước đó!`,
          parse_mode: "Markdown",
        });
      }
    }

    // 2. Nhân viên gõ tin nhắn trả lời khách ngay trong Telegram (F-14)
    if (message && (message.text || message.caption || message.photo?.length)) {
      const chatId = message.chat.id;
      const text = String(message.text || message.caption || "").trim();
      const operatorId = String(message.from?.id || "");

      // Chế độ vận hành kho trong group/private chat. Tin nhắn chữ chỉ vào
      // nhánh này khi có /ops, @mention hoặc reply bot; ảnh luôn lập bản nháp.
      // Nhờ vậy không thể vô tình gửi một lệnh kho thành câu trả lời cho khách.
      // Câu thường như "đơn mới", "duyệt đơn 12" cũng vào đây, nhưng nếu người
      // gõ không phải nhân viên thì bỏ qua êm (không báo "chưa được cấp quyền").
      const roRang = laYeuCauVanHanhRoRang(message, bot);
      const chuyenVanHanh = laYeuCauVanHanh(message, bot);
      const laNhanVien = chuyenVanHanh && operatorId ? await laNhanVienCuaShop(tenantId, operatorId) : false;
      let vaoVanHanh = chuyenVanHanh && (laNhanVien || roRang);
      if (vaoVanHanh && laNhanVien && !roRang) {
        // Nhân viên đang tiếp quản một khách thì câu thường là lời nói với khách,
        // không phải lệnh. Chỉ /ops, @bot, reply bot hoặc nút bấm mới là lệnh.
        const dangTiepQuan = await runInTenantContext(tenantId, async (client) => {
          const r = await client.query(
            `SELECT 1 FROM conversation
              WHERE tenant_id = $2 AND assigned_to = $1
                AND mode IN ('NGUOI', 'CHO_NGUOI') AND dong_luc IS NULL LIMIT 1`,
            [operatorId, tenantId]
          );
          return r.rows.length > 0;
        });
        if (dangTiepQuan) vaoVanHanh = false;
      }
      if (vaoVanHanh) {
        if (!operatorId || !laNhanVien) {
          await guiTinQuaBot(bot, { chat_id: chatId, text: "⛔ Tài khoản Telegram này chưa được cấp quyền nhân viên của shop." });
          return res.json({ ok: true });
        }
        try {
          await xuLyYeuCauVanHanh(bot, tenantId, message);
        } catch (e: any) {
          let noiDung = "Em chưa làm được việc này. Anh/chị thử lại sau ít phút giúp em nhé.";
          if (e instanceof LoiThanThien) noiDung = e.message;
          else console.error("[telegram-operator] lỗi xử lý lệnh vận hành:", e);
          await guiTinQuaBot(bot, { chat_id: chatId, text: `⚠️ ${noiDung.slice(0, 800)}` });
        }
        return res.json({ ok: true });
      }

      if (text === "/start" || text === "/help") {
        const tenBot = bot.username ? `@${bot.username.replace(/^@/, "")}` : "bot của shop";
        await guiTinQuaBot(bot, {
          chat_id: chatId,
          text:
            `👋 *Chào mừng anh/chị đến với Telegram Console (${tenBot})!*\n\n` +
            `Bot sẽ tự động gửi thông báo khi có khách hàng cần tiếp quản.\n` +
            `Dùng /ops để xem cách tra kho, nhập kho hoặc tạo sản phẩm bằng AI.`,
          parse_mode: "Markdown",
        });
      } else if (operatorId && (await laNhanVienCuaShop(tenantId, operatorId))) {
        // Hội thoại đang gán cho nhân viên này — CHỈ trong phạm vi shop này.
        const conv = await timHoiThoaiDangTiepQuan(tenantId, operatorId);

        if (conv && canGiuCauChoGui(text)) {
          // Câu giống lệnh (huỷ/duyệt đơn, tạo mã, ẩn sản phẩm, đổi giá, kể cả viết lệch mẫu) khi đang chat với khách:
          // không gửi cho khách, nhưng cho nút gửi nếu thật ra là lời nhắn khách.
          const idGui = await luuCauChoGui(tenantId, String(chatId), operatorId, text, conv, message.message_id != null ? String(message.message_id) : null);
          const maKhach = conv.slice(0, 8);
          await guiTinQuaBot(bot, {
            chat_id: chatId,
            text: `Câu này giống một lệnh cho bot nên em chưa gửi cho khách (mã khách ${maKhach}). Nếu là lệnh, gõ /ops trước câu (ví dụ: /ops huỷ đơn 12). Nếu là lời nhắn cho khách ${maKhach}, bấm nút bên dưới.` +
              (text.length > 4000 ? "\n⚠️ Câu dài quá 4000 ký tự, nếu bấm gửi em chỉ gửi 4000 ký tự đầu." : ""),
            reply_markup: { inline_keyboard: [[{ text: `📤 Vẫn gửi cho khách ${maKhach}`, callback_data: `ops_send_${idGui}` }]] } as any,
          });
        } else if (conv) {
          await guiLoiNhanVienChoKhach(bot, tenantId, chatId, conv, text, operatorId);
        } else if (!message.photo?.length) {
          // Không tiếp quản khách nào mà gõ câu về đơn bot chưa hiểu: gợi ý nút, đừng im lặng.
          const goiY = goiYDonHang(text, message.chat?.type === "private");
          if (goiY) await guiTinQuaBot(bot, { chat_id: chatId, text: goiY.text, reply_markup: goiY.reply_markup as any });
        }
      }
    }
  } catch (error) {
    console.error(`[TelegramWebhook][${tenantId}] Lỗi:`, error);
  }

  // Luôn trả 200 sau khi đã qua xác thực: Telegram sẽ gửi lại update vô hạn nếu
  // nhận mã lỗi, tạo bão request cho một lỗi nghiệp vụ không tự khỏi.
  return res.json({ ok: true });
});

/**
 * Đường webhook cũ (không có tenant) — đã ngừng dùng.
 *
 * Trả 410 thay vì im lặng để lỗi cấu hình lộ ra ngay, thay vì biểu hiện thành
 * "bot không trả lời" mà không ai biết vì sao.
 */
app.post("/v1/tg/webhook", async (_req: Request, res: Response) => {
  console.error(
    "[TelegramWebhook] Nhận update ở đường dẫn CŨ /v1/tg/webhook. " +
    "Mỗi shop nay có bot riêng — đăng ký lại bằng: npm run tg:webhook"
  );
  return res.status(410).json({
    error: "GONE",
    message: "Webhook nay theo từng shop: POST /v1/tg/webhook/:tenant_id. Chạy `npm run tg:webhook` để đăng ký lại.",
  });
});


// -----------------------------------------------------------------------------
// DEVELOPMENT DEV STUBS FOR TELEGRAM MINI APP
// -----------------------------------------------------------------------------
app.get("/v1/tg/conversations-list-dev-stub", requireAdminAuth as any, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const adminUser = req.adminUser!;
    const showAll = req.query.all === "true";
    let queryStr = `
      SELECT c.id, c.tenant_id, c.visitor_id, c.mode, c.ly_do_leo_thang, c.assigned_to, c.last_customer_msg_at, c.tao_luc AS created_at,
        (SELECT noi_dung FROM message WHERE conversation_id = c.id ORDER BY tao_luc DESC LIMIT 1) as last_message
      FROM conversation c
      WHERE c.dong_luc IS NULL
        AND EXISTS (SELECT 1 FROM message m WHERE m.conversation_id = c.id)
    `;
    const queryParams: any[] = [];

    if (!showAll) {
      queryStr += ` AND c.mode IN ('CHO_NGUOI', 'NGUOI')`;
    }

    if (adminUser.role === "tenant_admin" && adminUser.tenantId) {
      queryStr += ` AND c.tenant_id = $${queryParams.length + 1}`;
      queryParams.push(adminUser.tenantId);
    }

    queryStr += ` ORDER BY COALESCE(c.last_customer_msg_at, c.tao_luc) DESC`;

    const result = await pool.query(queryStr, queryParams);
    return res.json(result.rows);
  } catch (error: any) {
    console.error("[TMA List Error]:", error);
    return res.status(500).json({ error: error.message });
  }
});

app.get("/v1/tg/conversation-messages-dev-stub", requireAdminAuth as any, async (req: AuthenticatedRequest, res: Response) => {
  const convId = req.query.id as string;
  if (!convId) {
    return res.status(400).json({ error: "Missing conversation ID" });
  }

  try {
    const adminUser = req.adminUser!;
    
    // Validate tenant ownership
    const convCheck = await pool.query("SELECT tenant_id FROM conversation WHERE id = $1", [convId]);
    if (convCheck.rows.length === 0) {
      return res.status(404).json({ error: "Conversation not found" });
    }

    if (adminUser.role === "tenant_admin" && adminUser.tenantId && convCheck.rows[0].tenant_id !== adminUser.tenantId) {
      return res.status(403).json({ error: "Forbidden: You do not have access to this conversation" });
    }

    const result = await pool.query(
      `SELECT vai_tro, noi_dung, tao_luc, dinh_kem FROM message WHERE conversation_id = $1 ORDER BY tao_luc ASC`,
      [convId]
    );
    const cleanRows = result.rows.map((r: any) => ({
      ...r,
      noi_dung: (r.noi_dung || "").replace(/<cart_action>[\s\S]*?<\/cart_action>/g, "").trim()
    }));
    return res.json(cleanRows);
  } catch (error: any) {
    console.error("[TMA Messages Error]:", error);
    return res.status(500).json({ error: error.message });
  }
});

// -----------------------------------------------------------------------------
// CLIENT CHAT HISTORY ENDPOINT
// -----------------------------------------------------------------------------
app.get("/v1/chat/history", verifySessionToken, async (req: CustomRequest, res: Response) => {
  const tenantId = req.tenantId!;
  const conversationId = req.conversationId!;
  try {
    await runInTenantContext(tenantId, async (client) => {
      const result = await client.query(
        `SELECT vai_tro, noi_dung, model, credit_da_tru, tao_luc, dinh_kem 
         FROM message 
         WHERE conversation_id = $1 
         ORDER BY tao_luc ASC`,
        [conversationId]
      );
      const cleanRows = result.rows.map((r: any) => ({
        ...r,
        noi_dung: (r.noi_dung || "").replace(/<cart_action>[\s\S]*?<\/cart_action>/g, "").trim()
      }));
      res.json(cleanRows);
    });
  } catch (error) {
    console.error("Fetch chat history error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// -----------------------------------------------------------------------------
// REAL ADMIN WORKSPACE API ENDPOINTS
// -----------------------------------------------------------------------------
app.get("/v1/admin/tenants", async (req: Request, res: Response) => {
  try {
    const result = await pool.query(
      // `?dang_hoat_dong=1` chỉ trả shop ĐÃ CẤU HÌNH Medusa — tức shop thật.
      // CSDL staging có 179 tenant, phần lớn là rác từ các đợt test
      // (Tenant A/B, E2E *, Shop QA). Ba shop thật lẫn trong đó rất khó nhìn.
      `SELECT t.id, t.ten, t.nganh, t.bac_du_lieu, t.tuong_lua_claim, t.goi,
              COALESCE(b.so_du, 0) as balance,
              s.medusa_base_url,
              s.telegram_bot_username,
              (s.telegram_bot_token IS NOT NULL) AS co_bot_telegram
       FROM tenant t
       LEFT JOIN credit_balance b ON t.id = b.tenant_id
       LEFT JOIN tenant_setting s ON s.tenant_id = t.id
       WHERE ($1::boolean IS NOT TRUE) OR s.medusa_base_url IS NOT NULL
       ORDER BY (s.medusa_base_url IS NOT NULL) DESC, t.tao_luc DESC`,
      [req.query.dang_hoat_dong === "1"]
    );
    res.json(result.rows);
  } catch (error) {
    console.error("Fetch tenants error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/v1/admin/tenants", async (req: Request, res: Response) => {
  const { ten, nganh, bac_du_lieu, initialCredits } = req.body;
  try {
    const tenantId = await runCentralAdmin(async (client) => {
      const tRes = await client.query(
        `INSERT INTO tenant (ten, nganh, bac_du_lieu) VALUES ($1, $2, $3) RETURNING id`,
        [ten, nganh, parseInt(bac_du_lieu || "0", 10)]
      );
      const tid = tRes.rows[0].id;

      await client.query(
        `INSERT INTO tenant_setting (tenant_id) VALUES ($1)`,
        [tid]
      );

      const credits = parseFloat(initialCredits || "1000");
      await client.query(
        `INSERT INTO credit_balance (tenant_id, so_du, da_tang) VALUES ($1, $2, $2)`,
        [tid, credits]
      );

      const publicApiKey = `pk_live_${crypto.randomBytes(8).toString("hex")}`;
      const hashedKey = crypto.createHash("sha256").update(publicApiKey).digest("hex");
      await client.query(
        `INSERT INTO tenant_key (tenant_id, khoa_bam, origin_allowlist) VALUES ($1, $2, ARRAY['*'])`,
        [tid, hashedKey]
      );

      await client.query(
        `INSERT INTO credit_ledger (tenant_id, loai_hanh_dong, so_credit) VALUES ($1, 'nap', $2)`,
        [tid, credits]
      );

      return tid;
    });

    res.json({ success: true, tenant_id: tenantId });
  } catch (error) {
    console.error("Create tenant error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/v1/admin/tenants/:id/credits", async (req: Request, res: Response) => {
  const tenantId = req.params.id;
  const { amount } = req.body;
  try {
    const credits = Number(amount || "500");
    if (!Number.isFinite(credits) || credits <= 0 || credits > 100_000_000) {
      return res.status(400).json({ error: "Số credit nạp không hợp lệ (phải là số dương <= 100.000.000)" });
    }
    await runCentralAdmin(async (client) => {
      await client.query(
        `UPDATE credit_balance SET so_du = so_du + $1 WHERE tenant_id = $2`,
        [credits, tenantId]
      );
      await client.query(
        `INSERT INTO credit_ledger (tenant_id, loai_hanh_dong, so_credit) VALUES ($1, 'nap', $2)`,
        [tenantId, credits]
      );
    });
    res.json({ success: true });
  } catch (error) {
    console.error("Add credits error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});


app.get("/v1/admin/tenants/:id/documents", async (req: Request, res: Response) => {
  const tenantId = req.params.id;
  try {
    const result = await pool.query(
      `SELECT id, ten_file as name, loai as type, kich_thuoc as size, trang_thai as status, loi as error 
       FROM kb_document WHERE tenant_id = $1 ORDER BY tao_luc DESC`,
      [tenantId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error("Fetch docs error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.delete("/v1/admin/tenants/:tid/documents/:id", async (req: Request, res: Response) => {
  const { tid, id } = req.params;
  if (!new RegExp(`^${UUID_RE}$`, "i").test(id)) {
    return res.status(400).json({ error: "Mã tài liệu không hợp lệ." });
  }
  try {
    const deleted = await deleteKnowledgeDocument(tid, id);
    if (!deleted) return res.status(404).json({ error: "Không tìm thấy tài liệu." });
    res.json({ success: true });
  } catch (error) {
    console.error("Delete document error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/v1/admin/tenants/:id/scripts", async (req: Request, res: Response) => {
  const tenantId = req.params.id;
  try {
    const result = await pool.query(
      `SELECT id, mau_khop as regex, tra_loi as reply, locale, uu_tien as priority,
              chuyen_nguoi
       FROM kb_script WHERE tenant_id = $1 ORDER BY uu_tien DESC, tao_luc DESC`,
      [tenantId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error("Fetch scripts error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.delete("/v1/admin/tenants/:tid/scripts/:id", async (req: Request, res: Response) => {
  const { tid, id } = req.params;
  try {
    await runInTenantContext(tid, async (client) => {
      await client.query("DELETE FROM kb_script WHERE id = $1 AND tenant_id = $2", [id, tid]);
    });
    res.json({ success: true });
  } catch (error) {
    console.error("Delete script error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/v1/admin/tenants/:id/leads", requireAdminAuth, async (req: Request, res: Response) => {
  const tenantId = req.params.id;
  try {
    const result = await pool.query(
      `SELECT id, ten as name, so_dien_thoai as phone, nhu_cau as need, trang_thai as status,
              conversation_id, tao_luc as time
       FROM khach_tiem_nang WHERE tenant_id = $1 ORDER BY tao_luc DESC LIMIT 200`,
      [tenantId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error("Fetch leads error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.patch("/v1/admin/tenants/:tid/leads/:id", requireAdminAuth, async (req: Request, res: Response) => {
  const { tid, id } = req.params;
  const status = req.body?.status;
  if (!["moi", "da_goi", "bo_qua"].includes(status)) {
    return res.status(400).json({ error: "status phải là moi, da_goi hoặc bo_qua" });
  }
  try {
    await runInTenantContext(tid, async (client) => {
      await client.query("UPDATE khach_tiem_nang SET trang_thai = $3, cap_nhat_luc = now() WHERE id = $1 AND tenant_id = $2", [id, tid, status]);
    });
    res.json({ success: true });
  } catch (error) {
    console.error("Update lead error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/v1/admin/tenants/:id/ledgers", async (req: Request, res: Response) => {
  const tenantId = req.params.id;
  try {
    const result = await pool.query(
      `SELECT id, loai_hanh_dong as action, so_credit as credits, model, tokens, tao_luc as time 
       FROM credit_ledger WHERE tenant_id = $1 ORDER BY tao_luc DESC LIMIT 50`,
      [tenantId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error("Fetch ledger error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/v1/admin/tenants/:id/key", async (req: Request, res: Response) => {
  const tenantId = req.params.id;
  try {
    const result = await pool.query(
      `SELECT khoa_bam FROM tenant_key WHERE tenant_id = $1 AND thu_hoi_luc IS NULL LIMIT 1`,
      [tenantId]
    );
    if (result.rows.length > 0) {
      res.json({ key: `pk_live_${result.rows[0].khoa_bam.substring(0, 8)}...` });
    } else {
      res.json({ key: "Không có" });
    }
  } catch (error) {
    console.error("Fetch key error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/v1/admin/tenants/:id/operators", requireAdminAuth, async (req: Request, res: Response) => {
  const tenantId = req.params.id;
  try {
    const result = await pool.query(
      `SELECT id, username as name, telegram_id as "tgId" FROM admin_user WHERE tenant_id = $1 ORDER BY username ASC`,
      [tenantId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error("Fetch operators error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/v1/admin/tenants/:id/operators", requireAdminAuth, async (req: Request, res: Response) => {
  const tenantId = req.params.id;
  const { name, tgId } = req.body;
  if (!name || !tgId) {
    return res.status(400).json({ error: "Thiếu tên nhân viên hoặc Telegram ID" });
  }
  try {
    // Generate dummy username, email, and password_hash
    const cleanUsername = name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, "_");
    const email = `${cleanUsername}_${Date.now()}@vpholding.com`;
    // Không dùng mật khẩu cố định: bất kỳ ai biết quy tắc đặt tên đều đăng nhập được.
    const matKhauTam = crypto.randomBytes(18).toString("base64url");
    const passwordHash = await hashPasswordAsync(matKhauTam);

    await pool.query(
      `INSERT INTO admin_user (tenant_id, username, password_hash, email, telegram_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [tenantId, name, passwordHash, email, tgId]
    );
    res.json({ success: true });
  } catch (error: any) {
    console.error("Add operator error:", error);
    if (error.code === "23505") {
      return res.status(400).json({ error: "Telegram ID này đã được liên kết với một tài khoản khác!" });
    }
    res.status(500).json({ error: "Internal server error" });
  }
});

app.delete("/v1/admin/tenants/:id/operators/:opId", requireAdminAuth, async (req: Request, res: Response) => {
  const { id: tenantId, opId } = req.params;
  try {
    await pool.query(
      `DELETE FROM admin_user WHERE id = $1 AND tenant_id = $2`,
      [opId, tenantId]
    );
    res.json({ success: true });
  } catch (error) {
    console.error("Delete operator error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/v1/admin/tenants/:id/conversations", requireAdminAuth, async (req: Request, res: Response) => {
  const tenantId = req.params.id;
  try {
    await runInTenantContext(tenantId, async (client) => {
      const result = await client.query(
        `SELECT c.id, c.visitor_id, c.mode, c.ly_do_leo_thang, c.cart_id, c.tao_luc AS created_at, c.last_customer_msg_at 
         FROM conversation c
         WHERE EXISTS (SELECT 1 FROM message m WHERE m.conversation_id = c.id)
         ORDER BY c.last_customer_msg_at DESC NULLS LAST, c.tao_luc DESC`
      );
      res.json(result.rows);
    });
  } catch (error) {
    console.error("Fetch conversations error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/v1/admin/tenants/:id/conversations/:convId/messages", requireAdminAuth, async (req: Request, res: Response) => {
  const { id: tenantId, convId } = req.params;
  try {
    await runInTenantContext(tenantId, async (client) => {
      const result = await client.query(
        // `nguon_kien_thuc` chứa vết công cụ AI đã gọi — cần cho admin truy
        // lại bot đã làm gì khi khách phàn nàn.
        `SELECT id, vai_tro, noi_dung, model, credit_da_tru, tao_luc, dinh_kem, nguon_kien_thuc 
         FROM message 
         WHERE conversation_id = $1 
         ORDER BY tao_luc ASC`,
        [convId]
      );
      res.json(result.rows);
    });
  } catch (error) {
    console.error("Fetch conv messages error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// -----------------------------------------------------------------------------
// -----------------------------------------------------------------------------
// CẤU HÌNH SHOP — bot Telegram riêng + địa chỉ Medusa
//
// Trước 29/07/2026 hai thứ này chỉ đặt được bằng SQL tay. Onboard mỗi shop mới
// là phải mở psql gõ UPDATE — dễ sai, không ai truy được ai đổi lúc nào.
// -----------------------------------------------------------------------------
app.get("/v1/admin/tenants/:id/cau-hinh", async (req: Request, res: Response) => {
  try {
    const [r, nv, visionBase, visionKey, visionModel] = await Promise.all([
      pool.query(
      `SELECT medusa_base_url, telegram_bot_username,
              (telegram_bot_token IS NOT NULL)   AS co_bot_token,
              (telegram_webhook_secret IS NOT NULL) AS co_webhook_secret
       FROM tenant_setting WHERE tenant_id = $1`,
      [req.params.id]
      ),
      pool.query(
        `SELECT count(DISTINCT au.id)::int AS n
           FROM admin_user au
          WHERE au.telegram_id IS NOT NULL AND au.telegram_id <> ''
            AND (au.tenant_id = $1 OR EXISTS (
              SELECT 1 FROM admin_user_tenant aut
               WHERE aut.admin_user_id = au.id AND aut.tenant_id = $1
            ))`,
        [req.params.id]
      ),
      layCaiDat("vision_api_base_url"),
      layCaiDat("vision_api_key"),
      layCaiDat("vision_model"),
    ]);
    if (r.rows.length === 0) return res.json({
      chua_co_cau_hinh: true,
      public_base_url: env.APP_BASE_URL,
      so_nhan_vien_telegram: Number(nv.rows[0]?.n || 0),
      vision_ready: Boolean(visionBase && visionKey && visionModel),
    });
    // KHÔNG trả token ra ngoài — chỉ cho biết đã có hay chưa.
    return res.json({
      ...r.rows[0],
      public_base_url: env.APP_BASE_URL,
      so_nhan_vien_telegram: Number(nv.rows[0]?.n || 0),
      vision_ready: Boolean(visionBase && visionKey && visionModel),
    });
  } catch (e) {
    console.error("[CauHinhShop] đọc lỗi:", e);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/** Trạng thái thực tế ở Telegram, không chỉ trạng thái đã lưu trong DB. */
app.get("/v1/admin/tenants/:id/telegram-webhook", async (req: Request, res: Response) => {
  const bot = await layBotCuaShop(req.params.id);
  if (!bot) return res.status(409).json({ error: "Shop chưa lưu token bot Telegram." });
  const [me, webhook] = await Promise.all([layThongTinBot(bot), layThongTinWebhook(bot)]);
  const webhookUrl = webhook?.result?.url || "";
  let webhookMatchesTenant = false;
  try {
    webhookMatchesTenant = new URL(webhookUrl).pathname === `/v1/tg/webhook/${req.params.id}`;
  } catch { /* chưa có webhook */ }
  return res.json({
    bot_ok: Boolean(me?.ok),
    username: me?.ok ? me.username : null,
    bot_error: me?.ok ? null : me?.loi,
    webhook_url: webhookUrl,
    webhook_matches_tenant: webhookMatchesTenant,
    pending_update_count: Number(webhook?.result?.pending_update_count || 0),
    last_error_message: webhook?.result?.last_error_message || null,
    expected_url: `${env.APP_BASE_URL.replace(/\/+$/, "")}/v1/tg/webhook/${req.params.id}`,
  });
});

/** Đăng ký webhook ngay từ Admin — không còn bắt người dùng SSH chạy script. */
app.post("/v1/admin/tenants/:id/telegram-webhook", async (req: Request, res: Response) => {
  const tenantId = req.params.id;
  const baseUrl = String(req.body?.publicBaseUrl || env.APP_BASE_URL || "").trim().replace(/\/+$/, "");
  if (!baseUrl.startsWith("https://") || !isSafeUrl(baseUrl)) {
    return res.status(400).json({ error: "URL công khai phải là https:// hợp lệ và truy cập được từ Internet." });
  }

  let bot = await layBotCuaShop(tenantId);
  if (!bot) return res.status(409).json({ error: "Hãy lưu token bot Telegram trước." });

  try {
    let secret = bot.webhookSecret;
    if (!secret || secret.length < 16) {
      secret = crypto.randomBytes(32).toString("hex");
      await runInTenantContext(tenantId, (client) => client.query(
        `UPDATE tenant_setting SET telegram_webhook_secret=$2 WHERE tenant_id=$1`,
        [tenantId, secret]
      ));
      xoaCacheBot(tenantId);
      bot = await layBotCuaShop(tenantId);
      if (!bot) throw new Error("Không đọc lại được cấu hình bot sau khi lưu secret.");
    }

    const me = await layThongTinBot(bot);
    if (!me.ok) return res.status(400).json({ error: `Token bot không hợp lệ: ${me.loi}` });
    const result = await dangKyWebhookChoShop(bot, baseUrl, secret);
    if (!result.ok) return res.status(502).json({ error: result.loi || "Telegram từ chối đăng ký webhook." });
    return res.json({
      ok: true,
      username: me.username,
      webhook_url: result.url,
      message: `Đã kết nối @${me.username} với shop. Bot có thể nhận /ops trong group.`,
    });
  } catch (e: any) {
    console.error("[TelegramWebhookAdmin] đăng ký lỗi:", e);
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
});

app.post("/v1/admin/tenants/:id/cau-hinh", async (req: Request, res: Response) => {
  const tenantId = req.params.id;
  const { medusaBaseUrl, telegramBotToken, telegramBotUsername } = req.body ?? {};

  // Chuỗi rỗng nghĩa là "không đổi", KHÔNG phải "xoá". Người dùng để trống ô
  // token vì không muốn nhập lại — xoá token của shop đang chạy vì hiểu nhầm
  // chỗ này là làm sập bot của họ.
  const doiToken = typeof telegramBotToken === "string" && telegramBotToken.trim().length > 0;

  if (medusaBaseUrl && !/^https?:\/\//.test(medusaBaseUrl)) {
    return res.status(400).json({ error: "medusa_base_url phải bắt đầu bằng http:// hoặc https://" });
  }

  try {
    await pool.query(
      `INSERT INTO tenant_setting (tenant_id, medusa_base_url, telegram_bot_username
                                   ${doiToken ? ", telegram_bot_token" : ""})
       VALUES ($1, $2, $3 ${doiToken ? ", $4" : ""})
       ON CONFLICT (tenant_id) DO UPDATE SET
         medusa_base_url       = COALESCE(EXCLUDED.medusa_base_url, tenant_setting.medusa_base_url),
         telegram_bot_username = COALESCE(EXCLUDED.telegram_bot_username, tenant_setting.telegram_bot_username)
         ${doiToken ? ", telegram_bot_token = EXCLUDED.telegram_bot_token" : ""}`,
      doiToken
        ? [tenantId, medusaBaseUrl || null, telegramBotUsername || null, telegramBotToken.trim()]
        : [tenantId, medusaBaseUrl || null, telegramBotUsername || null]
    );

    // Đổi token thì secret webhook cũ vô nghĩa — buộc đăng ký lại.
    if (doiToken) {
      await pool.query(
        `UPDATE tenant_setting SET telegram_webhook_secret = NULL WHERE tenant_id = $1`,
        [tenantId]
      );
    }

    return res.json({
      success: true,
      can_dang_ky_webhook: doiToken,
      huong_dan: doiToken
        ? `Đổi token xong PHẢI đăng ký lại webhook: npm run tg:webhook -- --tenant ${tenantId}`
        : undefined,
    });
  } catch (e) {
    console.error("[CauHinhShop] ghi lỗi:", e);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// -----------------------------------------------------------------------------
// TRẠNG THÁI MEILISEARCH
//
// Tầng tìm kiếm là xương sống của bot: 49.000+ document, đồng bộ qua subscriber
// và đối soát đêm. Trước đây admin mù hoàn toàn — index hỏng thì chỉ thấy bot
// bảo "không tìm thấy sản phẩm", không ai biết vì sao.
// -----------------------------------------------------------------------------
app.get("/v1/admin/meili/trang-thai", async (_req: Request, res: Response) => {
  const dauMeili = { Authorization: `Bearer ${env.MEILI_MASTER_KEY}` };
  try {
    // Chỉ đếm lỗi trong 24 giờ qua.
    //
    // `/tasks?statuses=failed` trả TỔNG CỘNG DỒN từ ngày dựng hệ thống và không
    // bao giờ giảm. Sự cố thiếu `primaryKey` hôm 28/07 để lại 49.134 tác vụ
    // hỏng; đã vá xong từ lâu mà bảng vẫn báo đỏ 49.134 mãi mãi. Một bảng cảnh
    // báo lúc nào cũng đỏ thì chẳng ai buồn nhìn — và hôm sự cố thật xảy ra sẽ
    // không ai nhận ra.
    const moc24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const [stats, tacVuHong] = await Promise.all([
      fetchJson<any>(`${env.MEILI_HOST}/indexes/${env.MEILI_INDEX}/stats`, { headers: dauMeili }, 3000),
      fetchJson<any>(
        `${env.MEILI_HOST}/tasks?statuses=failed&limit=20&afterFinishedAt=${encodeURIComponent(moc24h)}`,
        { headers: dauMeili },
        3000
      ).catch(() => ({ total: 0, results: [] })),
    ]);

    // `index_already_exists` là tiếng ồn: mỗi lần đồng bộ đều thử tạo index rồi
    // nhận lỗi này vì index đã có. Vô hại, nhưng lẫn vào thì che mất lỗi thật.
    const loiThat = (tacVuHong.results ?? []).filter(
      (t: any) => t?.error?.code !== "index_already_exists"
    );

    // Đếm document theo từng shop — lệch nhiều so với số sản phẩm trong Medusa
    // là dấu hiệu đồng bộ đang hỏng.
    const shops = await pool.query(
      `SELECT t.id, t.ten FROM tenant t
        JOIN tenant_setting s ON s.tenant_id = t.id
       WHERE s.medusa_base_url IS NOT NULL ORDER BY t.ten`
    );

    const theoShop = await Promise.all(
      shops.rows.map(async (t: any) => {
        try {
          const r = await fetchJson<any>(
            `${env.MEILI_HOST}/indexes/${env.MEILI_INDEX}/search`,
            {
              method: "POST",
              headers: { ...dauMeili, "Content-Type": "application/json" },
              body: JSON.stringify({ q: "", filter: [`tenant_id = "${t.id}"`], limit: 0, hitsPerPage: 1 }),
            },
            3000
          );
          return { ten: t.ten, so_document: r.totalHits ?? r.estimatedTotalHits ?? 0 };
        } catch {
          return { ten: t.ten, so_document: null };
        }
      })
    );

    return res.json({
      song: true,
      tong_document: stats.numberOfDocuments ?? 0,
      dang_lap_chi_muc: stats.isIndexing === true,
      so_tac_vu_hong: loiThat.length,
      loi_gan_nhat: loiThat[0]?.error?.message ?? null,
      theo_shop: theoShop,
    });
  } catch (e: any) {
    // Meilisearch chết KHÔNG được làm sập trang admin — trả trạng thái rõ ràng.
    return res.json({ song: false, loi: String(e?.message ?? e).slice(0, 200) });
  }
});

// -----------------------------------------------------------------------------
// MEDUSA E-COMMERCE PLATFORM INTEGRATION ENDPOINTS
// -----------------------------------------------------------------------------
app.get("/v1/admin/tenants/:id/platform/medusa", async (req: Request, res: Response) => {
  const tenantId = req.params.id;
  try {
    const result = await pool.query(
      `SELECT trang_thai, cau_hinh_ma_hoa, loi_gan_nhat FROM tenant_platform WHERE tenant_id = $1 AND loai = 'medusa'`,
      [tenantId]
    );

    if (result.rows.length === 0) {
      return res.json({ enabled: false, configured: false });
    }

    const { trang_thai, cau_hinh_ma_hoa, loi_gan_nhat } = result.rows[0];
    const decrypted = JSON.parse(decrypt(cau_hinh_ma_hoa));

    return res.json({
      enabled: trang_thai === "hoat_dong" && decrypted.enabled,
      configured: true,
      baseUrl: decrypted.baseUrl || "",
      defaultCarrier: decrypted.defaultCarrier || "ghn",
      lastError: loi_gan_nhat || null,
    });
  } catch (error) {
    console.error("Fetch Medusa config error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/v1/admin/tenants/:id/platform/medusa", async (req: Request, res: Response) => {
  const tenantId = req.params.id;
  const { enabled, baseUrl, apiToken, defaultCarrier } = req.body;

  if (enabled && (!baseUrl || !apiToken)) {
    return res.status(400).json({ error: "Thiếu baseUrl hoặc apiToken để bật kết nối Medusa Store" });
  }

  try {
    const configData: MedusaConfig = {
      enabled: Boolean(enabled),
      baseUrl: baseUrl || "http://localhost:9000",
      apiToken: apiToken || "",
      defaultCarrier: defaultCarrier || "ghn",
    };

    const encryptedJson = encrypt(JSON.stringify(configData));
    const status = enabled ? "hoat_dong" : "tat";

    await runInTenantContext(tenantId, async (client) => {
      await client.query(
        `INSERT INTO tenant_platform (tenant_id, loai, cau_hinh_ma_hoa, trang_thai) 
         VALUES ($1, 'medusa', $2, $3)
         ON CONFLICT (tenant_id, loai) 
         DO UPDATE SET cau_hinh_ma_hoa = EXCLUDED.cau_hinh_ma_hoa, trang_thai = EXCLUDED.trang_thai`,
        [tenantId, encryptedJson, status]
      );
    });

    return res.json({ success: true, enabled: configData.enabled });
  } catch (error) {
    console.error("Save Medusa config error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// -----------------------------------------------------------------------------
// AUTHENTICATION ENDPOINTS
// -----------------------------------------------------------------------------
app.post("/v1/auth/login", hanMucDangNhap, async (req: Request, res: Response) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: "Missing username or password" });
  }

  try {
    const result = await pool.query(
      "SELECT id, tenant_id, username, password_hash, email FROM admin_user WHERE username = $1",
      [username]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: "Invalid username or password" });
    }

    const user = result.rows[0];
    const match = await verifyPasswordAsync(password, user.password_hash);
    if (!match) {
      return res.status(401).json({ error: "Invalid username or password" });
    }

    // Sign JWT token
    const token = jwt.sign(
      {
        typ: "admin",
        userId: user.id,
        username: user.username,
        role: user.tenant_id ? "tenant_admin" : "super_admin",
        tenantId: user.tenant_id
      },
      env.ADMIN_JWT_SECRET,
      { expiresIn: "24h" }
    );

    // Kèm tên shop cho mini app hiện lên tiêu đề — xem ghi chú ở /v1/auth/tg-login.
    let tenShopDN: string | null = null;
    if (user.tenant_id) {
      const r = await pool.query("SELECT ten FROM tenant WHERE id = $1", [user.tenant_id]);
      tenShopDN = r.rows[0]?.ten ?? null;
    }

    return res.json({
      token,
      role: user.tenant_id ? "tenant_admin" : "super_admin",
      tenantId: user.tenant_id,
      tenShop: tenShopDN,
    });
  } catch (error) {
    console.error("Auth login error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/v1/auth/tg-login", hanMucDangNhap, async (req: Request, res: Response) => {
  const { initData, tenant_id: goiYTenant } = req.body;
  if (!initData) {
    return res.status(400).json({ error: "Missing initData" });
  }

  try {
    // Xác thực chữ ký theo BOT CỦA SHOP, không còn một token dùng chung.
    //
    // `tenant_id` client gửi lên chỉ là GỢI Ý và không cần tin: chữ ký chỉ khớp
    // khi ký bằng đúng token của shop đó, nên gợi ý sai thì tự rớt ở bước dưới.
    // Có gợi ý thì chỉ phải thử một token thay vì quét toàn bộ shop.
    const ungVien: BotShop[] = goiYTenant
      ? ([await layBotCuaShop(String(goiYTenant))].filter(Boolean) as BotShop[])
      : await layTatCaBot();

    let botKhop: BotShop | null = null;
    for (const b of ungVien) {
      if (verifyTelegramSignature(initData, b.token)) { botKhop = b; break; }
    }
    if (!botKhop) {
      return res.status(401).json({
        error: "Invalid Telegram signature",
        message: ungVien.length === 0
          ? "Chưa shop nào cấu hình telegram_bot_token."
          : "Chữ ký không khớp bot của shop nào.",
      });
    }

    // Parse initData to extract telegram user ID
    const params = new URLSearchParams(initData);
    const userStr = params.get("user");
    if (!userStr) {
      return res.status(400).json({ error: "Missing user in initData" });
    }

    const tgUser = JSON.parse(userStr);
    const tgId = tgUser.id?.toString();

    if (!tgId) {
      return res.status(400).json({ error: "Invalid Telegram user ID" });
    }

    // Find admin user by telegram ID
    const result = await pool.query(
      "SELECT id, tenant_id, username, email FROM admin_user WHERE telegram_id = $1",
      [tgId]
    );

    // Cửa hậu cũ ở đây (NODE_ENV="test" + initData bắt đầu bằng "bypass_tg_" +
    // tenantId gắn cứng) đã bị gỡ: nó cấp token quản trị cho một tenant có thật
    // mà không cần mật khẩu, chỉ dựa vào một biến môi trường. Việc bỏ qua chữ ký
    // khi chạy test nay nằm gọn trong verifyTelegramSignature, có JEST_WORKER_ID
    // canh — biến đó Jest tự đặt, không đặt tay được trên máy thật.
    if (result.rows.length === 0) {
      return res.status(404).json({ error: `No registered account found for Telegram ID ${tgId}. Please register in Admin Panel first.` });
    }


    const user = result.rows[0];

    // ── SHOP NÀO? PHẢI HỎI `admin_user_tenant`, KHÔNG CHỈ `admin_user.tenant_id` ──
    //
    // `admin_user.tenant_id` là shop GỐC của tài khoản. `admin_user_tenant` mới
    // là nơi ghi nhân viên đang trực cho shop nào — và hai thứ này khác nhau khi
    // người ta được điều sang shop khác.
    //
    // Ngày 29/07 bot Telegram chuyển từ Ẩm Thực Xứ Huế sang Farmers Market, 3
    // nhân viên đã được cấp quyền operator cho Farmers Market. Nhưng chỗ này chỉ
    // đọc `admin_user.tenant_id` (vẫn là Huế) nên mini app hiện danh sách của
    // Huế. Trong khi `services/telegram.ts` LẠI đọc `admin_user_tenant` để bắn
    // thông báo — thành ra bot báo "có chat mới" của Farmers Market, mở app ra
    // thấy chat của shop khác, và 34 hội thoại Farmers Market không ai trực
    // (một cái chờ người từ 02:52).
    //
    // Bài học: cấp quyền ở một bảng mà đường đăng nhập đọc bảng khác thì quyền
    // đó vô hiệu — và không có lỗi nào báo ra, chỉ là danh sách trống.
    let tenantHieuLuc: string | null = user.tenant_id;
    let nhieuShop = false;
    try {
      const dsShop = await pool.query(
        `SELECT tenant_id FROM admin_user_tenant WHERE admin_user_id = $1`,
        [user.id]
      );
      if (dsShop.rows.length === 1) {
        tenantHieuLuc = dsShop.rows[0].tenant_id;
      } else if (dsShop.rows.length > 1) {
        // Nhiều shop thì chưa có chỗ cho người dùng chọn — giữ shop gốc và ghi
        // log để không âm thầm đưa họ vào nhầm shop.
        nhieuShop = true;
        console.warn(
          `[TgLogin] ${user.username} được phân ${dsShop.rows.length} shop; ` +
          `tạm dùng shop gốc ${user.tenant_id}. Cần bổ sung màn hình chọn shop.`
        );
      }
    } catch (e) {
      console.error("[TgLogin] đọc admin_user_tenant lỗi:", e);
    }

    const token = jwt.sign(
      {
        typ: "admin",
        userId: user.id,
        username: user.username,
        role: tenantHieuLuc ? "tenant_admin" : "super_admin",
        tenantId: tenantHieuLuc
      },
      env.ADMIN_JWT_SECRET,
      { expiresIn: "24h" }
    );

    // Trả kèm TÊN shop để mini app hiện lên đầu màn hình. Sự cố vừa rồi khó lần
    // ra chính vì giao diện không nói nó đang xem shop nào — nhân viên chỉ thấy
    // một danh sách lạ và không có cách nào biết vì sao.
    let tenShop: string | null = null;
    if (tenantHieuLuc) {
      const r = await pool.query("SELECT ten FROM tenant WHERE id = $1", [tenantHieuLuc]);
      tenShop = r.rows[0]?.ten ?? null;
    }

    return res.json({
      token,
      role: tenantHieuLuc ? "tenant_admin" : "super_admin",
      tenantId: tenantHieuLuc,
      tenShop,
      nhieuShop,
    });
  } catch (error) {
    console.error("Telegram login error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});



app.post("/v1/auth/change-password", requireAdminAuth, async (req: AuthenticatedRequest, res: Response) => {
  const { currentPassword, newPassword } = req.body;
  const userId = req.adminUser?.userId;

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: "Missing currentPassword or newPassword" });
  }

  try {
    const result = await pool.query(
      "SELECT password_hash FROM admin_user WHERE id = $1",
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const match = await verifyPasswordAsync(currentPassword, result.rows[0].password_hash);
    if (!match) {
      return res.status(400).json({ error: "Mật khẩu hiện tại không chính xác!" });
    }

    const newHash = await hashPasswordAsync(newPassword);
    await pool.query(
      "UPDATE admin_user SET password_hash = $1 WHERE id = $2",
      [newHash, userId]
    );

    return res.json({ success: true, message: "Mật khẩu đã được thay đổi thành công!" });
  } catch (error) {
    console.error("Change password error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/v1/auth/forgot-password", hanMucDangNhap, async (req: Request, res: Response) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: "Missing email" });
  }

  try {
    const result = await pool.query(
      "SELECT id, tenant_id, username, telegram_id FROM admin_user WHERE email = $1",
      [email]
    );

    // Standard security: don't disclose whether email exists
    if (result.rows.length === 0) {
      return res.json({ success: true, message: "Nếu email tồn tại trong hệ thống, link đặt lại mật khẩu đã được gửi." });
    }

    const user = result.rows[0];
    const token = crypto.randomBytes(32).toString("hex");
    const expires = new Date(Date.now() + 3600000); // 1 hour

    await pool.query(
      "UPDATE admin_user SET reset_token = $1, reset_expires = $2 WHERE id = $3",
      [token, expires, user.id]
    );

    const resetLink = `${env.APP_BASE_URL}/admin/index.html?resetToken=${token}`;

    // 1. Send real SMTP email (fallback to Ethereal Sandbox with preview URLs)
    await sendResetPasswordEmail(email, user.username, resetLink);

    // 2. Send Telegram notification if the admin user has linked their Telegram account
    if (user.telegram_id) {
      try {
        const tgMsg = `🔒 *YÊU CẦU ĐẶT LẠI MẬT KHẨU*\n\nXin chào *${user.username}*,\nChúng tôi nhận được yêu cầu đặt lại mật khẩu từ tài khoản của bạn.\n\nNhấp vào link bên dưới để thiết lập mật khẩu mới:\n${resetLink}\n\n_Thời hạn liên kết là 1 tiếng._`;
        // Gửi qua bot của chính shop; tài khoản cấp hệ thống (tenant_id NULL)
        // mới dùng bot nền tảng.
        await sendTelegramMessage(user.tenant_id ?? null, {
          chat_id: user.telegram_id,
          text: tgMsg,
          parse_mode: "Markdown"
        });
        console.log(`[Auth] Sent Telegram forgot-password notification to Telegram ID ${user.telegram_id}`);
      } catch (tgErr) {
        console.error("[Auth] Failed to send Telegram reset password alert:", tgErr);
      }
    }

    return res.json({ success: true, message: "Nếu email tồn tại trong hệ thống, link đặt lại mật khẩu đã được gửi." });
  } catch (error) {
    console.error("Forgot password error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/v1/auth/reset-password", hanMucDangNhap, async (req: Request, res: Response) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) {
    return res.status(400).json({ error: "Missing token or newPassword" });
  }

  try {
    const result = await pool.query(
      "SELECT id FROM admin_user WHERE reset_token = $1 AND reset_expires > now()",
      [token]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ error: "Liên kết đặt lại mật khẩu không hợp lệ hoặc đã hết hạn!" });
    }

    const userId = result.rows[0].id;
    const newHash = await hashPasswordAsync(newPassword);

    await pool.query(
      "UPDATE admin_user SET password_hash = $1, reset_token = NULL, reset_expires = NULL WHERE id = $2",
      [newHash, userId]
    );

    return res.json({ success: true, message: "Đã đặt lại mật khẩu thành công! Bạn có thể đăng nhập." });
  } catch (error) {
    console.error("Reset password error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// -----------------------------------------------------------------------------
// HEALTH CHECK
// -----------------------------------------------------------------------------

/** Còn sống hay không — dùng cho HEALTHCHECK của Docker/orchestrator. */
app.get("/healthz", (_req: Request, res: Response) => {
  res.json({ status: "ok", uptime_s: Math.round(process.uptime()) });
});

/** Sẵn sàng nhận traffic hay chưa — có kiểm tra phụ thuộc. */
app.get("/readyz", async (_req: Request, res: Response) => {
  const kiemTra: Record<string, string> = {};
  let sanSang = true;
  try {
    await pool.query("SELECT 1");
    kiemTra.database = "ok";
  } catch (e: any) {
    kiemTra.database = `loi: ${e?.message ?? e}`;
    sanSang = false;
  }
  res.status(sanSang ? 200 : 503).json({ status: sanSang ? "ready" : "not_ready", kiemTra });
});

// -----------------------------------------------------------------------------
// START SERVER + TẮT AN TOÀN
// -----------------------------------------------------------------------------
if (require.main === module) {
  void (async () => {
    // Đặt migration trong entrypoint để mọi cách chạy source/container đều áp
    // schema trước khi nhận traffic, kể cả Docker live không dùng Dockerfile repo.
    await chayMigration();

    const server = app.listen(env.PORT, () => {
      console.log(`Express Chatbot Gateway is running on port ${env.PORT} in ${env.NODE_ENV} mode.`);
    });
    khoiDongOutboxDispatcher();

    let dangTat = false;
    async function tatAnToan(tinHieu: string) {
      if (dangTat) return;
      dangTat = true;
      dungOutboxDispatcher();
      console.log(`[Shutdown] Nhận ${tinHieu} — đang đóng an toàn...`);

      // Cưỡng bức thoát nếu quá 15s để không treo quá trình deploy
      const hen = setTimeout(() => {
        console.error("[Shutdown] Quá 15s, buộc thoát.");
        process.exit(1);
      }, 15_000);
      hen.unref();

      server.close(async () => {
        try {
          await pool.end();
          console.log("[Shutdown] Đã đóng connection pool. Kết thúc.");
        } catch (e) {
          console.error("[Shutdown] Lỗi khi đóng pool:", e);
        } finally {
          process.exit(0);
        }
      });
    }

    process.on("SIGTERM", () => void tatAnToan("SIGTERM"));
    process.on("SIGINT", () => void tatAnToan("SIGINT"));

    // Không để một promise reject không bắt làm sập tiến trình im lặng
    process.on("unhandledRejection", (ly_do) => {
      console.error("[unhandledRejection]", ly_do);
    });
    process.on("uncaughtException", (err) => {
      console.error("[uncaughtException]", err);
      void tatAnToan("uncaughtException");
    });
  })().catch((e) => {
    console.error("[Startup] Migration/khởi động thất bại:", e);
    process.exit(1);
  });
}

export { app };
