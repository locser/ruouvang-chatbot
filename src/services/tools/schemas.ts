/**
 * Hợp đồng tool gửi cho DeepSeek (native function calling — ADR-006).
 *
 * Thay thế hoàn toàn cơ chế cũ: LLM in thẻ <cart_action>{…}</cart_action> lẫn
 * trong văn bản trả lời. Cơ chế thẻ đã gây 6 lỗi thật trong production
 * (max_tokens cắt cụt thẻ, regex chỉ bắt thẻ đầu, JSON hỏng bị nuốt im lặng,
 * thẻ lọt ra màn hình khách, khách dụ bot in thẻ checkout, text sau thẻ mất).
 * Tất cả biến mất khi JSON đi qua kênh riêng của API.
 *
 * LƯU Ý: schema chỉ bảo đảm ĐÚNG KIỂU. Mọi ràng buộc nghiệp vụ (SKU có thật,
 * số lượng hợp lý, đủ điều kiện chốt đơn) nằm ở validate.ts và LUÔN chạy
 * phía server trước khi chạm vào Medusa.
 */

export interface ToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

const doiTuong = (props: Record<string, unknown>, batBuoc: string[] = []) => ({
  type: "object",
  properties: props,
  required: batBuoc,
  additionalProperties: false,
});

export const TOOL_SCHEMAS: ToolSchema[] = [
  {
    type: "function",
    function: {
      name: "search_products",
      description:
        "Tìm và lọc sản phẩm trong cửa hàng. BẮT BUỘC gọi tool này khi khách hỏi về sản phẩm, " +
        "muốn được gợi ý, hoặc nêu nhu cầu. TUYỆT ĐỐI không tự nghĩ ra sản phẩm, giá hay mã SKU.",
      parameters: doiTuong({
        query: { type: "string", description: "Từ khoá nhu cầu bằng tiếng Việt tự nhiên, ví dụ 'chụp ảnh đẹp', 'trái cây biếu Tết'" },
        store_type: { type: "string", enum: ["cellphones", "farmersmarket", "all"] },
        brand: { type: "string", description: "Thương hiệu, ví dụ 'Apple', 'Samsung'" },
        category: { type: "string", description: "Slug danh mục, ví dụ 'smartphone', 'trai-cay'" },
        price_min_vnd: { type: "integer", minimum: 0, description: "Giá tối thiểu (đồng). Lưu ý: '10 củ' = 10000000" },
        price_max_vnd: { type: "integer", minimum: 0, description: "Giá tối đa (đồng)" },
        ram_gb_min: { type: "integer", description: "RAM tối thiểu (GB). 'máy mượt' = 8" },
        storage_gb_min: { type: "integer", description: "Bộ nhớ tối thiểu (GB)" },
        battery_mah_min: { type: "integer", description: "Dung lượng pin tối thiểu (mAh). 'pin trâu' = 5000" },
        storage_condition: { type: "string", enum: ["thuong", "mat", "dong-lanh"], description: "Điều kiện bảo quản (hàng thực phẩm)" },
        origin_region: { type: "string", description: "Vùng xuất xứ, ví dụ 'Đà Lạt'" },
        organic_certified: { type: "boolean" },
        in_stock_only: { type: "boolean", description: "Mặc định true" },
        sort: { type: "string", enum: ["relevance", "price_asc", "price_desc", "popularity"] },
        limit: { type: "integer", minimum: 1, maximum: 8 },
      }),
    },
  },
  {
    type: "function",
    function: {
      name: "get_product_detail",
      description: "Lấy thông số đầy đủ, giá và tồn kho thật của MỘT sản phẩm. Dùng khi khách hỏi sâu về một sản phẩm cụ thể.",
      parameters: doiTuong({ product_id: { type: "string" } }, ["product_id"]),
    },
  },
  {
    type: "function",
    function: {
      name: "compare_products",
      description: "So sánh 2 đến 3 sản phẩm song song. Dùng khi khách phân vân giữa các lựa chọn.",
      parameters: doiTuong(
        { product_ids: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 3 } },
        ["product_ids"]
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "set_cart_item",
      description:
        "Đặt số lượng cho một sản phẩm trong giỏ. QUAN TRỌNG: 'quantity' LUÔN là TỔNG SỐ LƯỢNG CUỐI CÙNG " +
        "mà khách muốn có, KHÔNG phải phần tăng thêm. Ví dụ: giỏ đang có 5 hộp, khách nói 'cho anh thêm 2 hộp nữa' " +
        "→ gọi với quantity = 7. Khách nói 'giảm còn 2' → quantity = 2. Đặt quantity = 0 để bỏ món khỏi giỏ. " +
        "Hãy đọc giỏ hàng hiện tại trong ngữ cảnh trước khi tính tổng.",
      parameters: doiTuong(
        {
          sku: { type: "string", description: "Mã SKU lấy từ kết quả search_products. TUYỆT ĐỐI không tự bịa." },
          quantity: { type: "integer", minimum: 0, maximum: 100, description: "TỔNG số lượng cuối cùng" },
        },
        ["sku", "quantity"]
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "remove_cart_item",
      description: "Bỏ hẳn một sản phẩm khỏi giỏ hàng.",
      parameters: doiTuong({ sku: { type: "string" } }, ["sku"]),
    },
  },
  {
    type: "function",
    function: {
      name: "clear_cart",
      description: "Xoá toàn bộ giỏ hàng. Chỉ gọi khi khách nói rõ muốn xoá hết và bắt đầu lại.",
      parameters: doiTuong({}),
    },
  },
  {
    type: "function",
    function: {
      name: "set_shipping_info",
      description:
        "Ghi nhận thông tin giao hàng. Gọi NGAY khi khách cung cấp, không hỏi lại lần hai. " +
        "Chỉ cần SĐT, địa chỉ và tên người nhận — không hỏi phường/xã/quận/huyện.",
      parameters: doiTuong({
        phone: { type: "string", description: "Số điện thoại Việt Nam" },
        address: { type: "string", description: "Địa chỉ nhận hàng: số nhà, đường, thành phố" },
        recipient_name: { type: "string" },
        province: { type: "string" },
      }),
    },
  },
  {
    type: "function",
    function: {
      name: "checkout",
      description:
        "Chốt đơn hàng và sinh mã QR thanh toán. CHỈ gọi khi khách đã XÁC NHẬN RÕ RÀNG muốn chốt " +
        "ngay trong lượt hội thoại này (ví dụ 'chốt đơn đi em', 'ok chốt', 'xin mã QR'). " +
        "Câu hỏi thông thường có chứa từ 'đâu' như 'shop ở đâu?' KHÔNG phải là xác nhận chốt đơn. " +
        "Đây là thao tác tạo đơn hàng THẬT và trừ tồn kho THẬT.",
      parameters: doiTuong({
        khach_da_xac_nhan: {
          type: "boolean",
          description: "Đặt true CHỈ KHI khách nói rõ muốn chốt đơn ngay trong lượt này",
        },
      }, ["khach_da_xac_nhan"]),
    },
  },
  {
    type: "function",
    function: {
      name: "get_order_status",
      description:
        "Tra trạng thái đơn hàng. BẮT BUỘC có cả mã đơn (dạng CW12) VÀ số điện thoại đặt hàng; thiếu một trong hai thì hỏi khách trước, không gọi công cụ.",
      parameters: doiTuong({
        order_code: { type: "string", description: "Mã đơn khách gửi, ví dụ CW12" },
        phone: { type: "string", description: "Số điện thoại khách dùng khi đặt hàng" },
      }),
    },
  },
  {
    type: "function",
    function: {
      name: "escalate_to_human",
      description:
        "Chuyển hội thoại cho nhân viên tư vấn. Gọi khi không chắc chắn, khi khách yêu cầu gặp người, " +
        "khi khách bức xúc, hoặc khi câu hỏi nằm ngoài phạm vi sản phẩm và đơn hàng. " +
        "Thà chuyển người còn hơn trả lời sai.",
      parameters: doiTuong({ reason: { type: "string", description: "Lý do ngắn gọn để nhân viên nắm bối cảnh" } }, ["reason"]),
    },
  },
  {
    type: "function",
    function: {
      name: "save_lead",
      description:
        "Lưu tên và số điện thoại khách TỰ NGUYỆN để lại để nhân viên gọi tư vấn thêm, và báo nhân viên. " +
        "CHỈ gọi khi khách đã nói rõ số điện thoại của họ VÀ đồng ý để nhân viên gọi. " +
        "KHÔNG dùng cho khách đang chốt đơn (số điện thoại giao hàng đi qua set_shipping_info). " +
        "KHÔNG chuyển hội thoại sang nhân viên; bot vẫn tiếp tục tư vấn bình thường.",
      parameters: doiTuong({
        name: { type: "string", description: "Tên khách xưng, có thể bỏ trống nếu khách không nói" },
        phone: { type: "string", description: "Số điện thoại khách đưa" },
        need: { type: "string", description: "Tóm tắt nhu cầu để nhân viên nắm trước khi gọi (món quan tâm, tầm giá, dịp dùng)" },
      }, ["phone"]),
    },
  },
  {
    type: "function",
    function: {
      name: "get_store_locations",
      description:
        "Lấy danh sách chi nhánh/cửa hàng THẬT (tên, địa chỉ, số điện thoại, giờ mở cửa, link bản đồ). " +
        "BẮT BUỘC gọi khi khách hỏi cửa hàng ở đâu, có chi nhánh nào, địa chỉ, giờ mở cửa, số điện thoại cửa hàng. " +
        "Chỉ được nêu địa chỉ/giờ/số điện thoại lấy từ kết quả tool này.",
      parameters: doiTuong({
        area: { type: "string", description: "Khu vực khách quan tâm để lọc, ví dụ 'quận 1', 'Thủ Đức'. Bỏ trống nếu khách hỏi chung." },
      }),
    },
  },
];

/** Tra nhanh schema theo tên. */
export const SCHEMA_THEO_TEN = new Map(TOOL_SCHEMAS.map((t) => [t.function.name, t]));
