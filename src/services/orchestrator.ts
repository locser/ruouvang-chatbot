/**
 * ORCHESTRATOR — vòng lặp agent của luồng chat bán hàng.
 *
 * Đây là mảnh ghép cuối của kiến trúc 2.0. Trước file này, `tools/schemas.ts`,
 * `tools/validate.ts`, `search.ts` và `catalog.ts` đã được viết và test đầy đủ
 * nhưng KHÔNG có ai gọi — luồng chat thật vẫn chạy cơ chế thẻ <cart_action> cũ.
 *
 * Luồng một lượt trả lời:
 *
 *   1. Đọc giỏ hàng thật → đưa vào prompt để mô hình tính được tổng tuyệt đối.
 *   2. Lượt gọi quyết định tool (không stream) — tối đa 3 vòng.
 *        · kiểm tên tool          (validate.kiemTraTenTool)
 *        · kiểm số lượng tool call (validate.kiemTraSoLuongToolCall)
 *        · chạy handler           (tools/handlers.chayTool)
 *        · nhét kết quả thật trở lại ngữ cảnh
 *   3. Lượt phát câu trả lời cuối (có stream) cho khách.
 *
 * Vì sao tối đa 3 vòng: mỗi vòng là một lần gọi API mà khách phải ngồi chờ.
 * Ba vòng đủ cho kịch bản sâu nhất (tìm hàng → thêm giỏ → ghi địa chỉ). Chạm
 * trần nghĩa là mô hình đang loanh quanh — chuyển nhân viên thay vì để khách đợi.
 */

import { PoolClient } from "pg";
import { MedusaConfig } from "./medusa";
import { TOOL_SCHEMAS } from "./tools/schemas";
import { kiemTraTenTool, kiemTraSoLuongToolCall } from "./tools/validate";
import { chayTool, NguCanhTool } from "./tools/handlers";
import { PROMPT_CO_DINH, dungPromptDong } from "./tools/prompt";
import {
  goiDeepSeekCoTool,
  streamDeepSeekCuoi,
  sinhCauTraLoiStream,
  coApiKeyThat,
  ChatMessageTool,
  ToolCallDeepSeek,
} from "./llm";
import { medusaCartRetrieve } from "./medusa";

/** Số vòng gọi tool tối đa trong một lượt trả lời. */
const SO_VONG_TOI_DA = 3;

export interface TrangThaiLuot {
  /** Có tool nào yêu cầu chuyển hội thoại cho nhân viên không. */
  chuyenNguoi: boolean;
  lyDoChuyenNguoi: string | null;
  /** Giỏ hàng vừa được tạo trong lượt này — nơi gọi phải lưu vào conversation. */
  cartIdMoi: string | null;
  daChotDon: boolean;
  orderId: string | null;
  /** Số đơn Medusa (display_id) — cùng mã khách thấy ở storefront (CW + số). */
  orderDisplayId: number | string | null;
  tongTienVnd: number | null;
  tienHangVnd: number | null;
  phiShipVnd: number | null;
  qrUrl: string | null;
  /** Tên các tool đã chạy, theo thứ tự. Dùng để ghi log và truy vết. */
  toolDaChay: string[];
  /** Khác null = lượt này hỏng ở tầng hạ tầng, KHÔNG phải lỗi nghiệp vụ. */
  loiHaTang: string | null;
}

export function trangThaiMoi(): TrangThaiLuot {
  return {
    chuyenNguoi: false,
    lyDoChuyenNguoi: null,
    cartIdMoi: null,
    daChotDon: false,
    orderId: null,
    orderDisplayId: null,
    tongTienVnd: null,
    tienHangVnd: null,
    phiShipVnd: null,
    qrUrl: null,
    toolDaChay: [],
    loiHaTang: null,
  };
}

export interface ThamSoOrchestrator {
  tenantId: string;
  conversationId: string;
  client: PoolClient;
  medusa: MedusaConfig | null;
  cartId: string | null;
  tenShop?: string | null;
  /**
   * Lịch sử hội thoại đã chuẩn hoá xen kẽ vai trò, KHÔNG gồm tin nhắn lượt này.
   *
   * Nhận cả vai trò "system" cho khớp kiểu `ChatMessage` bên llm.ts, nhưng mọi
   * message "system" đều bị lọc bỏ trước khi gửi đi: prompt hệ thống của lượt
   * này do orchestrator dựng, để lẫn prompt cũ vào sẽ ghi đè luật tool-calling.
   */
  lichSu: Array<{ role: "user" | "assistant" | "system"; content: string }>;
  /** Tin nhắn khách vừa gửi trong lượt này. */
  tinNhanKhach: string;
  /** Đoạn tri thức phi sản phẩm lấy từ pgvector (chính sách, FAQ). */
  triThuc: string[];
  vuaTiepQuanTuNhanVien?: boolean;
  /** Lý do hội thoại từng phải chuyển cho người, giữ lại cả sau khi bàn giao. */
  lyDoLeoThangTruoc?: string | null;
}

/** Đọc giỏ hàng để đưa vào prompt. Lỗi thì trả mảng rỗng, không làm hỏng lượt. */
async function docGioChoPrompt(
  medusa: MedusaConfig | null,
  cartId: string | null
): Promise<Array<Record<string, unknown>>> {
  if (!medusa || !cartId) return [];
  try {
    const r = await medusaCartRetrieve(medusa, cartId);
    const items = (r?.cart ?? r)?.items ?? [];
    return items.map((i: any) => ({
      sku: i?.variant?.sku ?? i?.sku ?? null,
      title: i?.title ?? i?.product_title ?? null,
      quantity: i?.quantity ?? 0,
    }));
  } catch (e) {
    console.error("[Orchestrator] Không đọc được giỏ hàng cho prompt:", e);
    return [];
  }
}

/** Bóc tham số JSON của một tool call. Mô hình đôi khi trả chuỗi rỗng. */
function bocThamSo(tc: ToolCallDeepSeek): { ok: true; args: any } | { ok: false; loi: string } {
  const raw = tc.function?.arguments ?? "";
  if (!raw.trim()) return { ok: true, args: {} };
  try {
    return { ok: true, args: JSON.parse(raw) };
  } catch (e: any) {
    return { ok: false, loi: `JSON tham số hỏng: ${e?.message ?? e}` };
  }
}

/**
 * Chạy một lượt trả lời hoàn chỉnh. Yield từng đoạn văn bản cho khách.
 *
 * `trangThai` bị ghi đè trong quá trình chạy — nơi gọi đọc nó SAU KHI generator
 * kết thúc để biết cần lưu cartId mới, có phải chuyển người, có đơn mới không.
 */
export async function* chayOrchestrator(
  ts: ThamSoOrchestrator,
  trangThai: TrangThaiLuot
): AsyncGenerator<string, void, unknown> {
  // Không có khoá DeepSeek thật (máy dev, CI, Jest): vòng lặp tool vô nghĩa vì
  // sẽ không bao giờ có tool call. Rơi thẳng xuống bộ sinh câu trả lời dự phòng
  // để luồng chat vẫn chạy được — và để các bài test tường lửa Price Check /
  // Claim Guard vẫn có câu trả lời rủi ro mà kiểm chứng.
  if (!(await coApiKeyThat())) {
    for await (const doan of sinhCauTraLoiStream(
      ts.lichSu.filter((m) => m.role !== "system") as any,
      ts.triThuc,
      "deepseek-flash",
      Boolean(ts.vuaTiepQuanTuNhanVien)
    )) {
      yield doan;
    }
    return;
  }

  const gioHang = await docGioChoPrompt(ts.medusa, ts.cartId);

  const nguCanh: NguCanhTool = {
    tenantId: ts.tenantId,
    conversationId: ts.conversationId,
    client: ts.client,
    medusa: ts.medusa,
    cartId: ts.cartId,
    tinNhanKhach: ts.tinNhanKhach,
    ghiNhanCartId(cartId: string) {
      trangThai.cartIdMoi = cartId;
    },
    yeuCauChuyenNguoi(lyDo: string) {
      trangThai.chuyenNguoi = true;
      trangThai.lyDoChuyenNguoi = lyDo;
    },
  };

  // TỐI ƯU 08/2026 — GIỮ NGUYÊN VẸN PHẦN PROMPT BẤT BIẾN ĐỂ DÙNG ĐƯỢC
  // BỘ NHỚ ĐỆM NGỮ CẢNH CỦA DEEPSEEK.
  //
  // `prompt.ts` đã cố ý chia prompt làm hai phần: phần cố định (không đổi giữa
  // mọi lượt, mọi shop) và phần động (tên shop, giỏ hàng, tri thức). Mục đích
  // ghi rõ trong chú thích đầu file đó: để phần cố định nằm ở ĐẦU chuỗi
  // message thì DeepSeek nhận ra tiền tố quen thuộc và tính tiền phần đó rẻ
  // hơn nhiều lần, đồng thời trả lời nhanh hơn vì không phải xử lý lại.
  //
  // Nhưng bản trước NỐI hai phần bằng dấu cộng thành MỘT chuỗi rồi mới đưa vào
  // một message `system` duy nhất. Chỉ cần khách thêm một món vào giỏ là toàn
  // bộ chuỗi đó khác đi, tiền tố không còn khớp, và ~1.800 token quy tắc bất
  // biến bị tính giá đầy đủ lại từ đầu — ở CẢ HAI lượt gọi API của mỗi tin
  // nhắn. Ý định thiết kế đúng, nhưng cách lắp đã vô hiệu hoá nó.
  //
  // Nay tách thành hai message `system` liền nhau. Nội dung mô hình đọc được
  // y hệt như cũ, nhưng message đầu tiên giữ nguyên từng ký tự qua mọi lượt
  // nên tiền tố luôn khớp.
  const promptDong = dungPromptDong({
    tenShop: ts.tenShop,
    gioHang,
    triThuc: ts.triThuc,
    vuaTiepQuanTuNhanVien: ts.vuaTiepQuanTuNhanVien,
    lyDoLeoThangTruoc: ts.lyDoLeoThangTruoc,
  });

  const lichSuSach = ts.lichSu
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

  // `index.ts` ghi tin nhắn khách vào bảng `message` TRƯỚC khi truy vấn lịch
  // sử, nên `lichSu` thường đã kết thúc bằng chính tin nhắn của lượt này. Thêm
  // lần nữa sẽ khiến mô hình thấy khách nói hai lần — và với câu kiểu "chốt
  // đơn đi em" thì đó là một lời xác nhận bị nhân đôi.
  //
  // Vẫn kiểm tra thay vì tin tưởng thứ tự: nơi gọi có thể đổi, và nếu vì lý do
  // nào đó tin nhắn chưa có trong lịch sử thì bỏ hẳn còn tệ hơn (mô hình không
  // biết khách vừa nói gì).
  const cuoi = lichSuSach[lichSuSach.length - 1];
  const daCoTinLuotNay =
    cuoi?.role === "user" && cuoi.content.trim().endsWith(ts.tinNhanKhach.trim());

  const messages: ChatMessageTool[] = [
    // Message BẤT BIẾN — phải luôn đứng đầu và không được đổi một ký tự nào,
    // nếu không thì mất bộ nhớ đệm ngữ cảnh (xem giải thích ở trên).
    { role: "system", content: PROMPT_CO_DINH },
    { role: "system", content: promptDong },
    ...lichSuSach,
    ...(daCoTinLuotNay ? [] : [{ role: "user" as const, content: ts.tinNhanKhach }]),
  ];

  let daGoiTool = false;

  for (let vong = 1; vong <= SO_VONG_TOI_DA; vong++) {
    let phanHoi;
    try {
      phanHoi = await goiDeepSeekCoTool(messages, TOOL_SCHEMAS);
    } catch (e: any) {
      // ADR-013: DeepSeek lỗi → chuyển nhân viên, không im lặng, không đoán.
      console.error(`[Orchestrator] DeepSeek lỗi ở vòng ${vong}:`, e);
      trangThai.loiHaTang = String(e?.message ?? e);
      trangThai.chuyenNguoi = true;
      trangThai.lyDoChuyenNguoi = "Dịch vụ AI không phản hồi";
      yield "Dạ hệ thống đang bận một chút ạ. Em xin phép chuyển nhân viên hỗ trợ anh/chị ngay nhé!";
      return;
    }

    if (!phanHoi.muonGoiTool) {
      // Mô hình trả lời thẳng, không cần tool.
      if (!daGoiTool) {
        // Chưa gọi tool lần nào → nội dung này đã đầy đủ, phát luôn để tiết
        // kiệm một lần gọi API (và ~500ms khách phải chờ).
        if (phanHoi.content) {
          for (const doan of catDoan(phanHoi.content)) yield doan;
          return;
        }
      }
      break;
    }

    // --- Có tool call ---
    const ktSo = kiemTraSoLuongToolCall(phanHoi.tool_calls.length);
    if (!ktSo.hopLe) {
      console.warn(`[Orchestrator] ${ktSo.ly_do} (tenant ${ts.tenantId})`);
      trangThai.chuyenNguoi = true;
      trangThai.lyDoChuyenNguoi = ktSo.ly_do;
      yield ktSo.thongDiepChoKhach;
      return;
    }

    daGoiTool = true;
    messages.push({
      role: "assistant",
      content: phanHoi.content || null,
      tool_calls: phanHoi.tool_calls,
    });

    for (const tc of phanHoi.tool_calls) {
      const ten = tc.function?.name ?? "";
      const ktTen = kiemTraTenTool(ten);

      let ketQua: Record<string, unknown>;
      if (!ktTen.hopLe) {
        console.warn(`[Orchestrator] Mô hình gọi tool lạ "${ten}" (tenant ${ts.tenantId})`);
        ketQua = { ok: false, ma_loi: ktTen.maLoi, thong_diep_cho_khach: ktTen.thongDiepChoKhach };
      } else {
        const boc = bocThamSo(tc);
        if (!boc.ok) {
          ketQua = {
            ok: false,
            ma_loi: "THAM_SO_HONG",
            thong_diep_cho_khach: "Dạ anh/chị nhắn lại giúp em rõ hơn một chút nhé!",
            chi_tiet: boc.loi,
          };
        } else {
          // Đồng bộ cartId: vòng trước có thể vừa tạo giỏ mới.
          if (trangThai.cartIdMoi) nguCanh.cartId = trangThai.cartIdMoi;
          ketQua = await chayTool(nguCanh, ktTen.duLieu, boc.args);
          trangThai.toolDaChay.push(ktTen.duLieu);

          if (ktTen.duLieu === "checkout" && ketQua.ok === true) {
            trangThai.daChotDon = true;
            trangThai.orderId = (ketQua.order_id as string) ?? null;
            trangThai.orderDisplayId = (ketQua.order_display_id as number | string) ?? null;
            trangThai.tongTienVnd = typeof ketQua.tong_tien_vnd === "number" ? ketQua.tong_tien_vnd : null;
            trangThai.tienHangVnd = typeof ketQua.tien_hang_vnd === "number" ? ketQua.tien_hang_vnd : null;
            trangThai.phiShipVnd = typeof ketQua.phi_ship_vnd === "number" ? ketQua.phi_ship_vnd : null;
            trangThai.qrUrl = (ketQua.qr_url as string) ?? null;
          }
        }
      }

      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: JSON.stringify(ketQua),
      });
    }
  }

  // --- Lượt phát câu trả lời cuối, sau khi mọi tool đã chạy ---
  //
  // Nhắc rõ mô hình rằng lượt này KHÔNG có công cụ. Thiếu câu này, khi nó vẫn
  // muốn hành động thì sẽ viết cú pháp gọi công cụ ra văn bản và khách đọc thấy
  // `<｜｜DSML｜｜tool_calls>` giữa câu trả lời (đã xảy ra 29/07/2026).
  messages.push({
    role: "system",
    content:
      "Mọi công cụ cần thiết đã chạy xong và kết quả đã nằm trong hội thoại. " +
      "Lượt này CHỈ trả lời khách bằng lời nói tự nhiên. TUYỆT ĐỐI không gọi thêm " +
      "công cụ và không viết cú pháp gọi công cụ dưới bất kỳ dạng nào. Nếu còn " +
      "thiếu thông tin để hành động, hãy HỎI khách bằng một câu bình thường.",
  });

  try {
    let coChu = false;
    const loc = new LocLuong();
    for await (const doan of streamDeepSeekCuoi(messages)) {
      const sach = loc.nap(doan);
      if (sach) { coChu = true; yield sach; }
      if (loc.biChan) break;
    }
    const con = loc.xa();
    if (con) { coChu = true; yield con; }

    if (loc.biChan) {
      // Mô hình vẫn cố gọi công cụ ở lượt cuối. Đã chặn không cho lọt ra khách,
      // nhưng phải ghi log — đây là dấu hiệu prompt hoặc vòng lặp tool có vấn đề.
      console.warn(
        `[Orchestrator] Mô hình phun cú pháp công cụ ở lượt trả lời cuối — đã chặn. ` +
        `conversation=${ts.conversationId} tool_da_chay=[${trangThai.toolDaChay.join(",")}]`
      );
      if (!coChu) {
        yield "Dạ anh/chị cho em hỏi lại một chút cho chắc ạ — anh/chị muốn em hỗ trợ phần nào tiếp theo ạ?";
      }
    } else if (!coChu) {
      yield "Dạ em đã ghi nhận yêu cầu của anh/chị ạ!";
    }
  } catch (e: any) {
    console.error("[Orchestrator] Lỗi khi phát câu trả lời cuối:", e);
    trangThai.loiHaTang = String(e?.message ?? e);
    trangThai.chuyenNguoi = true;
    trangThai.lyDoChuyenNguoi = "Dịch vụ AI lỗi khi soạn câu trả lời";
    yield "Dạ em xin phép chuyển nhân viên hỗ trợ anh/chị ngay ạ!";
  }
}

/** Cắt văn bản thành đoạn nhỏ để phát dần, giữ cảm giác streaming cho khách. */
function* catDoan(s: string, co = 24): Generator<string> {
  for (let i = 0; i < s.length; i += co) yield s.slice(i, i + co);
}

/**
 * Dấu hiệu mô hình đang VIẾT lời gọi công cụ ra văn bản thay vì dùng kênh riêng.
 *
 * DeepSeek đôi khi phun cú pháp nội bộ khi nó muốn gọi tool mà lượt đó không
 * được cấp `tools` — ví dụ `<｜｜DSML｜｜tool_calls>`, `<|tool▁calls|>`,
 * `<function=`. Ký tự `｜` là gạch đứng TOÀN PHÁT (U+FF5C), khác `|` thường.
 *
 * Khách tuyệt đối không được nhìn thấy những thứ này. Đây chính là lớp lỗi mà
 * ADR-006 sinh ra để diệt — bỏ thẻ `<cart_action>` rồi thì không được để một
 * loại thẻ khác lọt ra thay chỗ.
 */
const DAU_HIEU_TOOL = /<\s*[|｜]|[|｜]\s*>|DSML|tool▁calls|tool_calls|<function|invoke name=|<\｜/i;

/**
 * Lọc luồng chữ trước khi tới khách.
 *
 * Giữ lại một cửa sổ nhỏ ở cuối để không phát ra nửa đầu của một dấu hiệu rồi
 * mới nhận ra — chính là lỗi "thẻ lọt ra màn hình" của bản cũ. Khi phát hiện
 * dấu hiệu, NGỪNG phát hoàn toàn phần còn lại: thà cụt câu còn hơn để khách
 * đọc cú pháp nội bộ.
 */
class LocLuong {
  private dem = "";
  private daChan = false;
  /** true nếu đã phát hiện mô hình phun cú pháp công cụ. */
  get biChan() { return this.daChan; }

  /** Nạp một đoạn, trả về phần AN TOÀN để phát cho khách. */
  nap(doan: string, cuaSo = 16): string {
    if (this.daChan) return "";
    this.dem += doan;

    const i = this.dem.search(DAU_HIEU_TOOL);
    if (i >= 0) {
      this.daChan = true;
      // Lùi một bước nếu điểm cắt rơi vào giữa cặp thay thế.
      let cat = i;
      const ma = cat > 0 ? this.dem.charCodeAt(cat - 1) : 0;
      if (ma >= 0xd800 && ma <= 0xdbff) cat -= 1;
      const sach = this.dem.slice(0, cat);
      this.dem = "";
      return sach;
    }

    if (this.dem.length <= cuaSo) return "";

    // ⚠️ KHÔNG được cắt vào giữa một cặp thay thế (surrogate pair).
    //
    // Emoji chiếm HAI đơn vị UTF-16. Cắt trúng giữa sẽ phát ra một nửa ký tự
    // rác, và phía nhận báo lỗi "surrogates not allowed" hoặc hiện ô vuông.
    // Bot của shop dùng emoji ở gần như mọi câu nên chuyện này xảy ra liên tục.
    let cat = this.dem.length - cuaSo;
    const ma = this.dem.charCodeAt(cat - 1);
    if (ma >= 0xd800 && ma <= 0xdbff) cat -= 1;  // lùi lại nếu đang đứng sau nửa đầu

    const ra = this.dem.slice(0, cat);
    this.dem = this.dem.slice(cat);
    return ra;
  }

  /** Xả nốt phần còn giữ lại khi luồng kết thúc. */
  xa(): string {
    if (this.daChan) return "";
    const ra = this.dem;
    this.dem = "";
    return DAU_HIEU_TOOL.test(ra) ? ra.slice(0, ra.search(DAU_HIEU_TOOL)) : ra;
  }
}
