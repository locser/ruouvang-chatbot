import { PoolClient } from "pg";
import { layCaiDat } from "./caiDat";
import { fetchCoTimeout, TIMEOUT } from "./http";

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

/**
 * Searches the database for matching kịch bản cứng (hard scripts) before calling LLMs.
 * Returns the answer if matched (saving 100% token cost).
 */
export interface KetQuaKichBan {
  traLoi: string;
  /** true = phải chuyển hội thoại cho nhân viên sau khi trả lời (xem migration 004). */
  chuyenNguoi: boolean;
}

/**
 * Tìm kịch bản cứng khớp câu hỏi. Trả lời tức thì, tốn 0 token.
 *
 * ⚠️ `mau_khop` chạy bằng REGEX CỦA POSTGRESQL, không phải JavaScript. Ranh
 * giới từ là `\y`, không phải `\b` — viết `\b` thì mẫu KHÔNG BAO GIỜ khớp mà
 * cũng không báo lỗi nào. Script nạp tri thức kiểm mẫu qua chính PostgreSQL
 * để chặn nhầm lẫn này.
 */
export async function matchHardScript(
  client: PoolClient,
  tenantId: string,
  question: string,
  locale: string
): Promise<KetQuaKichBan | null> {
  const result = await client.query(
    `SELECT tra_loi, chuyen_nguoi
     FROM kb_script
     WHERE tenant_id = $1
       AND loai = 'cung'
       AND (locale IS NULL OR locale = $2)
       AND $3 ~* mau_khop
     ORDER BY uu_tien DESC, tao_luc DESC
     LIMIT 1`,
    [tenantId, locale, question]
  );

  if (result.rows.length > 0) {
    return {
      traLoi: result.rows[0].tra_loi,
      chuyenNguoi: result.rows[0].chuyen_nguoi === true,
    };
  }
  return null;
}

/**
 * Routes the query to either a lightweight model (DeepSeek-V4-Flash)
 * or a complex reasoning model (Claude-3.5-Sonnet) based on intent.
 */
// Model THUC SU duoc goi trong sinhCauTraLoiStream(). routeModel() chi la nhan
// dinh tuyen dung de log/uu tien; don gia credit phai tinh theo hang so nay.
export const MODEL_THUC_TE = "deepseek-chat";

export function routeModel(question: string): "deepseek-flash" | "claude-sonnet" {
  const complexKeywords = [
    /khiếu nại/i, /hoàn tiền/i, /lừa đảo/i, /pháp lý/i, /chất lượng/i, 
    /hỏng/i, /thối/i, /mốc/i, /bốc mùi/i, /sức khỏe/i, /chữa bệnh/i,
    /trị/i, /bệnh/i, /tiểu đường/i
  ];
  const isComplex = complexKeywords.some((regex) => regex.test(question));
  return isComplex ? "claude-sonnet" : "deepseek-flash";
}

/**
 * Live LLM streaming response generation via DeepSeek API with fallback.
 * Yields tokens over time as SSE chunks.
 */
export async function* sinhCauTraLoiStream(
  history: ChatMessage[],
  contextChunks: string[],
  model: string,
  hasHumanHistory: boolean = false
): AsyncGenerator<string, void, unknown> {
  const apiKey = await layCaiDat("deepseek_api_key");

  // Try real DeepSeek API streaming if API key is provided
  if (apiKey) {
    try {
        let systemPrompt = "Bạn là Trợ lý AI tư vấn bán hàng chuyên nghiệp, lịch sự, thân thiện, súc tích cho shop Đặc Sản Việt.\n" +
        "Chỉ trả lời dựa trên thông tin tri thức sản phẩm bên dưới. Nếu không có thông tin, hãy tư vấn nhẹ nhàng.\n" +
        "Trong thông tin sản phẩm, mỗi biến thể (variant) có trường `available` đại diện cho số lượng hàng tồn kho (stock) hiện tại. Hãy sử dụng thông tin này để trả lời ngay cho khách hàng nếu họ hỏi về việc sản phẩm còn hàng hay không hoặc số lượng còn lại bao nhiêu (ví dụ: available: 999 nghĩa là còn hàng với số lượng 999). Tuyệt đối không được hướng dẫn khách liên hệ nhân viên hoặc hotline để hỏi về tình trạng tồn kho khi sản phẩm đã có thông tin trong tri thức.\n" +
        "QUY TẮC NHỚ SỐ LƯỢNG & TRÁNH HỎI LẠI (CỰC KỲ QUAN TRỌNG):\n" +
        "- Khi khách hàng đã đưa ra số lượng cụ thể (ví dụ: 'chốt 2', 'lấy 2 cái', 'đặt 2'), bạn BẮT BUỘC ghi nhận ngay số lượng đó và xuất thẻ hành động <cart_action>. TUYỆT ĐỐI KHÔNG ĐƯỢC HỎI LẠI SỐ LƯỢNG khi khách đã trả lời!\n" +
        "- Hãy luôn nhớ rằng các sản phẩm trong mục `[GIỎ HÀNG HIỆN TẠI CỦA KHÁCH HÀNG]` chính là các sản phẩm đã được khách hàng yêu cầu ở các tin nhắn trước và đã được thêm vào giỏ hàng. Tuyệt đối KHÔNG ĐƯỢC tính cộng dồn đúp (ví dụ: khách trước đó nhắn mua 10 cái, giỏ hiện tại có 10 cái, thì tổng đơn vẫn chỉ là 10 cái, KHÔNG phải 20 cái!). Khi số lượng thay đổi, hãy dùng `set_quantity` với TỔNG SỐ LƯỢNG CUỐI CÙNG (xem quy tắc bên dưới).\n" +
        "QUY TẮC THÔNG TIN GIAO HÀNG (TINH GỌN & ĐƠN GIẢN):\n" +
        "- Khi yêu cầu thông tin giao hàng: CHỈ CẦN xin SĐT, địa chỉ nhận hàng (số nhà, đường, thành phố) và tên người nhận. TUYỆT ĐỐI KHÔNG bắt khách hàng khai báo phường, xã, quận, huyện.\n" +
        "- CẬP NHẬT ĐỊA CHỈ: Khi khách hàng cung cấp thông tin SĐT/địa chỉ nhận hàng, bạn BẮT BUỘC phải xuất thẻ cập nhật ở cuối câu trả lời: <cart_action>{\"action\": \"update_address\", \"phone\": \"SĐT\", \"address\": \"Địa chỉ nhận hàng\", \"province\": \"Tỉnh/Thành\", \"firstName\": \"Tên\"}</cart_action>.\n" +
        "QUY TẮC TRÌNH BÀY ĐƠN HÀNG ĐẸP MẮT:\n" +
        "- Khi tóm tắt đơn hàng, trình bày bằng danh sách dấu chấm tròn (bullet points) kèm emoji rõ ràng (📦, 💰, 📍, 👤). TUYỆT ĐỐI KHÔNG dùng bảng kẻ vạch đứng | hay ký tự * rối mắt.\n" +
        "QUY TẮC XỬ LÝ GIỎ HÀNG & HÀNH ĐỘNG (BẮT BUỘC CHÍNH XÁC 100%):\n" +
        "- THÊM GIỎ HÀNG LẬP TỨC (`add_item`): Ngay khi khách hàng chọn hoặc nhắn muốn mua sản phẩm cụ thể (ví dụ: 'cho anh 5 cái bánh nậm chay', 'lấy cho em 2 hộp tré'), bạn BẮT BUỘC xuất thẻ: <cart_action>{\"action\": \"add_item\", \"sku\": \"MÃ_SKU\", \"quantity\": SỐ_LƯỢNG}</cart_action>.\n" +
        "- ĐẶT SỐ LƯỢNG (`set_quantity`) — DÙNG CHO MỌI THAY ĐỔI SỐ LƯỢNG CỦA MÓN ĐÃ CÓ TRONG GIỎ: `quantity` LUÔN LÀ TỔNG SỐ LƯỢNG CUỐI CÙNG khách muốn có, TUYỆT ĐỐI KHÔNG phải phần chênh lệch. Hãy đọc `[GIỎ HÀNG HIỆN TẠI CỦA KHÁCH HÀNG]` để biết đang có bao nhiêu rồi TỰ CỘNG/TRỪ trước khi xuất thẻ. Ví dụ: giỏ đang có 5 hộp tré, khách nói 'cho anh THÊM 2 hộp nữa' → tổng cuối là 7 → xuất <cart_action>{\"action\": \"set_quantity\", \"sku\": \"MÃ_SKU\", \"quantity\": 7}</cart_action>. Khách nói 'giảm còn 2' → tổng cuối là 2. Chỉ dùng `add_item` khi món CHƯA có trong giỏ.\n" +
        "- XÓA MỘT SẢN PHẨM KHỎI GIỎ (`remove_item`): Khi khách nhắn xóa/bỏ 1 món (ví dụ: 'xóa bánh nậm', 'bỏ tré huế ra', 'không lấy mè xửng nữa'), bạn xác nhận nhẹ nhàng đã bỏ món đó và xuất thẻ: <cart_action>{\"action\": \"remove_item\", \"sku\": \"MÃ_SKU\"}</cart_action>.\n" +
        "- XÓA TOÀN BỘ GIỎ HÀNG / RESET GIỎ (`clear_cart`): Khi khách nhắn xóa giỏ hàng, hủy giỏ hàng, đặt lại (ví dụ: 'không, xóa giỏ hàng đi em, anh đặt mới', 'xóa hết những gì đã đặt', 'reset giỏ hàng', 'hủy đơn hàng hiện tại'), bạn BẮT BUỘC phải phản hồi lịch sự xác nhận đã xóa giỏ hàng (ví dụ: 'Dạ em đã xóa toàn bộ giỏ hàng cho anh rồi ạ. Anh muốn chọn lại sản phẩm nào để em hỗ trợ nhé!') VÀ xuất thẻ: <cart_action>{\"action\": \"clear_cart\"}</cart_action> ở cuối câu trả lời. TUYỆT ĐỐI KHÔNG lặp lại báo tồn kho hay chào mua lại các món vừa bảo xóa.\n" +
        "- CHỐT ĐƠN & GỬI QR CODE (`checkout`): Khi giỏ hàng đã có sản phẩm và khách xác nhận chốt mua hoặc hỏi xin mã QR (ví dụ: 'chốt', 'ok', 'đồng ý', 'chốt đơn đi', 'QRCode đâu', 'qr code đâu', 'gửi mã qr', 'gửi cho anh qrcode thanh toán'), bạn BẮT BUỘC phải xuất thẻ: <cart_action>{\"action\": \"checkout\"}</cart_action> ở cuối câu trả lời của bạn. TUYỆT ĐỐI KHÔNG HỨA SUÔNG 'Em sẽ gửi mã QR' mà KHÔNG xuất thẻ `<cart_action>{\"action\": \"checkout\"}</cart_action>`!\n\n" +
        "VÍ DỤ ĐỐI THOẠI MẪU:\n" +
        "Khách: Chào em, lấy cho anh 2 cái bánh nậm chay huế nhé.\n" +
        "AI: Dạ vâng, em chốt 2 cái Bánh Nậm Chay Huế (2.500đ/cái) cho anh nhé. Em xin phép thêm vào giỏ hàng ngay ạ. Anh cho em xin SĐT, địa chỉ nhận hàng và tên người nhận để em chuẩn bị đơn nhé! <cart_action>{\"action\": \"add_item\", \"sku\": \"banh-nam-chay-hue-def-9934\", \"quantity\": 2}</cart_action>\n\n" +
        "Khách: không, xóa giỏ hàng đi em, anh đặt mới\n" +
        "AI: Dạ, em đã xóa toàn bộ giỏ hàng cho anh rồi ạ! Anh muốn đặt lại sản phẩm nào để em hỗ trợ nhé! <cart_action>{\"action\": \"clear_cart\"}</cart_action>\n\n" +
        "Khách: Sđt 0987654321 địa chỉ 123 Nguyễn Trãi Huế, người nhận Nam\n" +
        "AI: Dạ em cảm ơn anh Nam! Em đã cập nhật thông tin giao hàng như sau:\n📦 Đơn hàng: 2 x Bánh Nậm Chay Huế (5.000đ)\n📍 Địa chỉ: 123 Nguyễn Trãi, Huế\n👤 Người nhận: Nam (0987654321)\nAnh kiểm tra lại và xác nhận chốt đơn để em gửi mã QR thanh toán nhé! <cart_action>{\"action\": \"update_address\", \"phone\": \"0987654321\", \"address\": \"123 Nguyễn Trãi, Huế\", \"province\": \"Thừa Thiên Huế\", \"firstName\": \"Nam\"}</cart_action>\n\n" +
        "Khách: qr code đâu / gửi mã qr cho anh\n" +
        "AI: Dạ em xin phép chốt đơn và gửi mã QR thanh toán cho anh ngay ạ! <cart_action>{\"action\": \"checkout\"}</cart_action>\n\n";

      if (hasHumanHistory) {
        systemPrompt += "Lưu ý đặc biệt: Cuộc hội thoại vừa kết thúc phiên chat trực tiếp với nhân viên hỗ trợ. Trợ lý AI (bạn) hiện đã tiếp quản lại cuộc trò chuyện. Hãy tiếp tục tư vấn khách hàng tự nhiên, súc tích.\n\n";
      }

      if (contextChunks.length > 0) {
        systemPrompt += `[Tri thức tài liệu sản phẩm]:\n${contextChunks.join("\n---\n")}\n\n`;
      }

      const response = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: MODEL_THUC_TE,
          messages: [
            { role: "system", content: systemPrompt },
            ...history,
          ],
          stream: true,
          temperature: 0.3,
          max_tokens: 1500,
        }),
      });

      if (response.ok && response.body) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith(":")) continue;
            if (trimmed === "data: [DONE]") return;

            if (trimmed.startsWith("data: ")) {
              try {
                const json = JSON.parse(trimmed.substring(6));
                const content = json.choices?.[0]?.delta?.content;
                if (content) {
                  yield content;
                }
              } catch (err) {
                // Ignore parse errors on partial lines
              }
            }
          }
        }
        return; // Successfully completed streaming from DeepSeek API
      } else {
        const errText = await response.text();
        console.warn(`[DeepSeek API Warning] HTTP ${response.status}: ${errText}. Falling back to default response generator.`);
      }
    } catch (error) {
      console.error("[DeepSeek API Error] Exception during LLM stream:", error);
    }
  }

  // Fallback response generator if API key is invalid/unreachable
  const lastUserMsg = history.filter((h) => h.role === "user").pop();
  const question = lastUserMsg ? lastUserMsg.content : "";
  let responseText = "";
  if (contextChunks.length > 0) {
    responseText = `Dựa trên tài liệu đã nạp, về câu hỏi "${question}": ${contextChunks[0]}`;
  } else {
    if (question.toLowerCase().includes("chào") || question.toLowerCase().includes("hello")) {
      responseText = "Dạ em chào anh/chị ạ! Trợ lý ảo của cửa hàng xin phép được hỗ trợ anh/chị. Anh/chị đang quan tâm đến sản phẩm nào ạ?";
    } else if (question.toLowerCase().includes("size")) {
      responseText = "Bảng size của chúng tôi được thiết kế phù hợp với chiều cao và cân nặng của người Việt. Chiều cao 1m70 nặng 65kg khuyên dùng size M ạ.";
    } else if (question.toLowerCase().includes("giá") || question.toLowerCase().includes("tiền")) {
      responseText = "Sản phẩm Dưa Cải Lên Men 200g có giá niêm yết là 290.000₫ ạ.";
    } else if (question.toLowerCase().includes("đổi trả") || question.toLowerCase().includes("trả hàng")) {
      responseText = "Chính sách đổi trả của chúng tôi cho phép khách hàng đổi trả sản phẩm lỗi trong vòng 7 ngày kể từ khi nhận hàng. Em có thể mở phiếu đổi trả giúp mình ạ.";
    } else {
      responseText = `Em đã nhận được câu hỏi "${question}". Em xin phép ghi nhận và sẽ chuyển nhân viên tư vấn chi tiết giúp anh/chị nhé!`;
    }
  }

  const tokens = responseText.split(" ");
  for (const token of tokens) {
    yield token + " ";
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

// ===========================================================================
// TẦNG VẬN CHUYỂN CHO NATIVE FUNCTION CALLING (ADR-006)
//
// Hai hàm dưới đây thay thế cơ chế thẻ <cart_action> nhúng trong văn bản.
// Chúng chỉ lo việc gọi API; toàn bộ luật nghiệp vụ nằm ở orchestrator.ts và
// tools/handlers.ts.
//
// Vì sao tách làm hai lượt gọi:
//   Lượt 1 (goiDeepSeekCoTool) — KHÔNG stream, để đọc trọn vẹn mảng tool_calls.
//     Stream mà vừa ghép tool call vừa phát token ra màn hình chính là nguyên
//     nhân của lỗi "max_tokens cắt cụt thẻ" ở bản cũ.
//   Lượt 2 (streamDeepSeekCuoi) — CÓ stream, phát câu trả lời cuối cho khách
//     sau khi mọi tool đã chạy xong và kết quả thật đã nằm trong ngữ cảnh.
// ===========================================================================

export interface ToolCallDeepSeek {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** Message mở rộng, hỗ trợ vai trò `tool` và trường `tool_calls`. */
export interface ChatMessageTool {
  role: "user" | "assistant" | "system" | "tool";
  content: string | null;
  tool_calls?: ToolCallDeepSeek[];
  tool_call_id?: string;
}

export interface PhanHoiCoTool {
  /** Văn bản mô hình nói kèm (có thể rỗng khi nó chỉ gọi tool). */
  content: string;
  tool_calls: ToolCallDeepSeek[];
  /** true = mô hình đã dừng vì muốn gọi tool. */
  muonGoiTool: boolean;
}

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";

/**
 * Có khoá DeepSeek thật hay không.
 *
 * Export ra ngoài vì orchestrator cần biết để rẽ nhánh: không có khoá thì
 * KHÔNG chạy vòng lặp tool (sẽ không có tool call nào) mà rơi thẳng xuống bộ
 * sinh câu trả lời dự phòng — bộ này là thứ mà các bài test tường lửa dùng để
 * tạo ra câu trả lời rủi ro rồi kiểm chứng Price Check và Claim Guard chặn được.
 */
export async function coApiKeyThat(): Promise<boolean> {
  return Boolean(await layCaiDat("deepseek_api_key"));
}

/**
 * Lượt gọi quyết định tool. Không stream.
 *
 * Ném lỗi khi API hỏng — orchestrator bắt và chuyển nhân viên, TUYỆT ĐỐI không
 * trả lời khách bằng dữ liệu đoán (ADR-013: DeepSeek lỗi → chuyển người, không
 * im lặng, không trả lời sai).
 */
export async function goiDeepSeekCoTool(
  messages: ChatMessageTool[],
  tools: unknown[]
): Promise<PhanHoiCoTool> {
  if (!(await coApiKeyThat())) {
    // Môi trường dev/test không có khoá thật: không gọi tool nào, để luồng
    // rơi xuống câu trả lời dự phòng.
    return { content: "", tool_calls: [], muonGoiTool: false };
  }

  const khoaDeepSeek = await layCaiDat("deepseek_api_key");
  const res = await fetchCoTimeout(
    DEEPSEEK_URL,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${khoaDeepSeek}`,
      },
      body: JSON.stringify({
        model: MODEL_THUC_TE,
        messages,
        tools,
        tool_choice: "auto",
        stream: false,
        temperature: 0.3,
        max_tokens: 1500,
      }),
    },
    TIMEOUT.DEEPSEEK
  );

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`DeepSeek HTTP ${res.status}: ${body.slice(0, 300)}`);
  }

  const data: any = await res.json();
  const choice = data?.choices?.[0];
  const toolCalls: ToolCallDeepSeek[] = Array.isArray(choice?.message?.tool_calls)
    ? choice.message.tool_calls
    : [];

  return {
    content: choice?.message?.content ?? "",
    tool_calls: toolCalls,
    muonGoiTool: choice?.finish_reason === "tool_calls" || toolCalls.length > 0,
  };
}

/**
 * Lượt phát câu trả lời cuối cho khách. Có stream.
 *
 * Không truyền `tools` ở lượt này: mọi tool đã chạy xong, kết quả thật đã nằm
 * trong `messages`. Cho mô hình gọi tiếp tool ở đây chỉ tạo thêm vòng lặp mà
 * khách phải chờ.
 */
export async function* streamDeepSeekCuoi(
  messages: ChatMessageTool[]
): AsyncGenerator<string, void, unknown> {
  if (!(await coApiKeyThat())) {
    yield "Dạ em xin phép chuyển nhân viên hỗ trợ anh/chị ngay ạ!";
    return;
  }

  const khoaDeepSeek = await layCaiDat("deepseek_api_key");
  const res = await fetchCoTimeout(
    DEEPSEEK_URL,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${khoaDeepSeek}`,
      },
      body: JSON.stringify({
        model: MODEL_THUC_TE,
        messages,
        stream: true,
        temperature: 0.3,
        max_tokens: 1500,
      }),
    },
    TIMEOUT.DEEPSEEK
  );

  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => "");
    throw new Error(`DeepSeek stream HTTP ${res.status}: ${body.slice(0, 300)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(":")) continue;
      if (trimmed === "data: [DONE]") return;
      if (!trimmed.startsWith("data: ")) continue;

      try {
        const json = JSON.parse(trimmed.substring(6));
        const content = json.choices?.[0]?.delta?.content;
        if (content) yield content;
      } catch {
        // Dòng SSE chưa trọn vẹn — bỏ qua, phần còn lại nằm ở buffer.
      }
    }
  }
}
