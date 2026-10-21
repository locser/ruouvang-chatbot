/**
 * NẠP TRI THỨC CHO MỘT SHOP — kịch bản cứng + tài liệu.
 *
 * Chạy:
 *   npx ts-node src/scripts/napTriThuc.ts --shop "Farmers Market"
 *   npx ts-node src/scripts/napTriThuc.ts --shop "Farmers Market" --thu   (chỉ xem, không ghi)
 *
 * Vì sao là script chứ không phải gõ SQL tay: bộ tri thức là TÀI SẢN của shop,
 * cần version hoá cùng mã nguồn. Gõ tay thì không ai biết ai sửa gì, và dựng
 * lại môi trường là mất sạch.
 *
 * Idempotent: xoá hết kịch bản/tài liệu do script này tạo rồi nạp lại. Sửa nội
 * dung trong `src/data/triThuc*.ts` rồi chạy lại là xong.
 */

import crypto from "crypto";
import { pool } from "../db/client";
import { taoVectorEmbedding } from "../services/embedding";
import * as triThucFarmersMarket from "../data/triThucFarmersMarket";
import * as triThucHasaki from "../data/triThucHasaki";
import * as triThucRedApron from "../data/triThucRedApron";

/**
 * Bộ tri thức theo TÊN shop (khớp `tenant.ten`).
 *
 * Thêm shop mới: tạo `src/data/triThuc<Ten>.ts` theo đúng khuôn của
 * `triThucFarmersMarket.ts` rồi khai báo ở đây. Bộ tri thức là TÀI SẢN của
 * shop nên phải version hoá cùng mã nguồn, không gõ thẳng SQL.
 */
const BO_TRI_THUC: Record<string, { KICH_BAN: any[]; TAI_LIEU: any[] }> = {
  "Farmers Market": triThucFarmersMarket,
  Hasaki: triThucHasaki,
  "Red Apron": triThucRedApron,
};

/** Đánh dấu bản ghi do script tạo, để lần chạy sau xoá đúng phần của mình. */
const DAU_HIEU = "[napTriThuc]";

/** Cắt tài liệu thành đoạn. Cùng cỡ với worker.ts để hành vi tìm kiếm nhất quán. */
function catDoan(s: string, soTu = 220, chongLan = 40): string[] {
  const tu = s.split(/\s+/).filter(Boolean);
  if (tu.length <= soTu) return [s.trim()];
  const ra: string[] = [];
  for (let i = 0; i < tu.length; i += soTu - chongLan) {
    ra.push(tu.slice(i, i + soTu).join(" "));
    if (i + soTu >= tu.length) break;
  }
  return ra;
}

async function main() {
  const argv = process.argv.slice(2);
  const lay = (t: string) => {
    const i = argv.indexOf(`--${t}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const tenShop = lay("shop");
  const chiThu = argv.includes("--thu");

  if (!tenShop) throw new Error('Thiếu --shop. Ví dụ: --shop "Farmers Market"');

  const bo = BO_TRI_THUC[tenShop];
  if (!bo) {
    throw new Error(
      `Chưa có bộ tri thức cho shop "${tenShop}". ` +
        `Hiện có: ${Object.keys(BO_TRI_THUC).join(", ")}. ` +
        `Tạo src/data/triThuc<Ten>.ts rồi khai báo trong BO_TRI_THUC.`
    );
  }
  const { KICH_BAN, TAI_LIEU } = bo;

  const client = await pool.connect();
  try {
    const t = await client.query(`SELECT id, ten, nganh, tuong_lua_claim FROM tenant WHERE ten = $1`, [tenShop]);
    if (t.rows.length === 0) throw new Error(`Không tìm thấy shop "${tenShop}"`);
    const { id: tenantId, nganh, tuong_lua_claim } = t.rows[0];

    console.log("═".repeat(66));
    console.log(`  SHOP        : ${tenShop}`);
    console.log(`  tenant_id   : ${tenantId}`);
    console.log(`  ngành       : ${nganh}${tuong_lua_claim ? "  (tường lửa công bố y tế ĐANG BẬT)" : ""}`);
    console.log(`  kịch bản    : ${KICH_BAN.length}`);
    console.log(`  tài liệu    : ${TAI_LIEU.length}`);
    console.log("═".repeat(66));

    // --- Kiểm tra regex TRƯỚC khi ghi ---
    //
    // Mẫu khớp hỏng sẽ làm câu SQL `$3 ~* mau_khop` ném lỗi Ở GIỮA LƯỢT CHAT
    // của khách thật, không phải lúc nạp. Bắt ở đây rẻ hơn nhiều.
    let loi = 0;

    for (const k of KICH_BAN) {
      try {
        new RegExp(k.mauKhop, "i");
      } catch (e: any) {
        console.error(`  ✖ Regex hỏng: ${k.mauKhop.slice(0, 60)}\n    ${e.message}`);
        loi++;
        continue;
      }

      // Từ đơn phổ thông đứng RIÊNG ở cấp ngoài cùng là nguy hiểm: nó khớp
      // bất kỳ đâu trong câu. Từ nằm trong ngoặc nhóm thì an toàn vì luôn có
      // thành phần khác đi kèm.
      //
      // Tách theo dấu | ở ĐỘ SÂU 0 — bản trước cắt mọi dấu | nên báo động giả
      // với `(chào|hi|alo)`, vốn hoàn toàn hợp lệ.
      if (!k.mauKhop.startsWith("^")) {
        const nhanh: string[] = [];
        let sau = 0, dem = "";
        for (const c of k.mauKhop) {
          if (c === "(") sau++;
          else if (c === ")") sau--;
          if (c === "|" && sau === 0) { nhanh.push(dem); dem = ""; } else dem += c;
        }
        nhanh.push(dem);
        const xau = nhanh.filter((x) => /^[a-zà-ỹ]{1,5}$/i.test(x.trim()));
        if (xau.length > 0) {
          console.error(`  ✖ Nhánh cấp ngoài cùng quá ngắn, khớp nhầm cả câu khác: ${xau.join(", ")}`);
          loi++;
        }
      }
    }

    // --- Kiểm hồi quy bằng CÂU THẬT ---
    //
    // Có giá trị hơn mọi heuristic. Mỗi dòng nêu rõ câu nào PHẢI rơi vào đâu.
    // `null` = không được kịch bản nào bắt, phải để AI tra sản phẩm thật.
    //
    // ⚠️ Kịch bản cứng CHỈ trả về văn bản, không bao giờ tạo đơn hàng. Nguy cơ
    // "shop ở đâu vậy em?" tạo đơn nằm ở `khachMuonChotDon()`, kiểm riêng bên dưới.
    const KIEM_HOI_QUY: Array<{ cau: string; mong: RegExp | null; y: string }> = [
      // ── Mỗi kịch bản phải có ít nhất một câu chứng minh nó KHỚP ĐƯỢC ──
      // Thiếu phần này thì một mẫu hỏng (ví dụ viết \b thay vì \y) sẽ lọt qua
      // và im lặng không hoạt động cho tới khi có người tình cờ phát hiện.
      { cau: "chào em", mong: /chào/, y: "chào hỏi" },
      { cau: "shop bán gì vậy em", mong: /bán\|có/, y: "giới thiệu ngành hàng" },
      { cau: "thanh toán thế nào em", mong: /thanh toán/, y: "hướng dẫn thanh toán" },
      { cau: "đặt hàng thế nào em", mong: /đặt\|mua/, y: "hướng dẫn đặt hàng" },
      { cau: "giờ mở cửa mấy giờ", mong: /mở cửa/, y: "giờ làm việc" },
      { cau: "cho anh kiểm tra đơn hàng", mong: /kiểm tra\|tra/, y: "tra đơn" },
      { cau: "ship về Huế mất bao lâu", mong: /giao hàng\|vận chuyển/, y: "vận chuyển" },
      { cau: "chính sách đổi trả thế nào", mong: /đổi trả/, y: "đổi trả" },
      { cau: "shop ở đâu vậy em?", mong: /địa chỉ/, y: "địa chỉ → chuyển người" },
      { cau: "shop có xuất hoá đơn không", mong: /hoá đơn/, y: "hoá đơn / bán sỉ" },
      { cau: "giảm giá cho anh chút được không", mong: /giảm\|bớt/, y: "chặn mặc cả" },
      { cau: "món này chữa được bệnh tiểu đường không", mong: /chữa\|trị/, y: "chặn công bố y tế" },
      { cau: "cho anh gặp nhân viên", mong: /nhân viên/, y: "chuyển người" },
      { cau: "cảm ơn em", mong: /cảm ơn/, y: "kết thúc" },

      // ── Những câu PHẢI để AI xử lý, kịch bản không được bắt ──
      { cau: "cái này bao nhiêu tiền", mong: null, y: "phải để AI tra giá thật" },
      { cau: "còn hàng không em", mong: null, y: "phải để AI tra tồn kho thật" },
      { cau: "cho anh 2 hộp bánh quy", mong: null, y: "phải để AI thêm giỏ" },
      { cau: "thêm 1 gói nữa", mong: null, y: "phải để AI tính tổng tuyệt đối" },
      { cau: "có xoài không em", mong: null, y: "phải để AI tìm sản phẩm" },
      { cau: "tư vấn giúp anh giỏ quà tết", mong: null, y: "phải để AI tư vấn" },
    ];

    /**
     * Kiểm khớp BẰNG CHÍNH POSTGRESQL, không dùng RegExp của JavaScript.
     *
     * Hai bộ regex khác nhau ở những chỗ chết người: PostgreSQL dùng `\y` cho
     * ranh giới từ, còn `\b` là ký tự backspace. JavaScript thì ngược lại. Mẫu
     * viết `\b` chạy tốt trong bộ kiểm JS nhưng KHÔNG BAO GIỜ khớp lúc chạy
     * thật — không lỗi, chỉ im lặng tốn credit. Đã vấp ngày 29/07/2026.
     *
     * Truy vấn đúng hàm `matchHardScript()` dùng: `$1 ~* mau_khop`.
     */
    const khopThat = async (cau: string, mauKhop: string): Promise<boolean> => {
      try {
        const r = await client.query(`SELECT ($1::text ~* $2::text) AS k`, [cau, mauKhop]);
        return r.rows[0]?.k === true;
      } catch (e: any) {
        console.error(`  ✖ PostgreSQL từ chối mẫu: ${mauKhop.slice(0, 50)}\n    ${e.message}`);
        loi++;
        return false;
      }
    };

    for (const { cau, mong, y } of KIEM_HOI_QUY) {
      const khop: typeof KICH_BAN = [];
      for (const k of KICH_BAN) {
        if (await khopThat(cau, k.mauKhop)) khop.push(k);
      }
      if (mong === null && khop.length > 0) {
        console.error(`  ✖ "${cau}" (${y}) — bị ${khop.length} kịch bản bắt nhầm:`);
        khop.forEach((k) => console.error(`      ${k.mauKhop.slice(0, 62)}`));
        loi++;
      } else if (mong !== null && !khop.some((k) => mong.test(k.mauKhop))) {
        console.error(`  ✖ "${cau}" (${y}) — KHÔNG kịch bản nào bắt, sẽ tốn credit gọi AI`);
        loi++;
      }
    }

    // Chốt chặn quan trọng nhất: câu hỏi thông tin KHÔNG được coi là ý chốt đơn.
    // Đây mới đúng là chỗ từng gây sự cố tạo đơn hàng thật ngày 28/07/2026.
    const { khachMuonChotDon } = await import("../services/checkoutIntent");
    for (const cau of ["shop ở đâu vậy em?", "ship về đâu cũng được à", "hàng ở đâu về vậy em"]) {
      if (khachMuonChotDon(cau)) {
        console.error(`  ✖ NGUY HIỂM: "${cau}" bị hiểu là ý CHỐT ĐƠN`);
        loi++;
      }
    }

    if (loi > 0) throw new Error(`${loi} vấn đề ở mẫu khớp — DỪNG, không ghi gì vào CSDL.`);
    console.log(`  ✓ ${KICH_BAN.length} mẫu khớp hợp lệ · ${KIEM_HOI_QUY.length} câu kiểm hồi quy đều đạt`);

    if (chiThu) {
      console.log("\n  (--thu: chỉ kiểm tra, KHÔNG ghi vào CSDL)\n");
      for (const k of KICH_BAN) {
        console.log(`  [${String(k.uuTien).padStart(2)}] ${k.mauKhop.slice(0, 72)}`);
      }
      return;
    }

    await client.query("BEGIN");
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);

    // --- Dọn phần do script này tạo lần trước ---
    const xoaKb = await client.query(
      `DELETE FROM kb_chunk WHERE tenant_id = $1 AND document_id IN
         (SELECT id FROM kb_document WHERE tenant_id = $1 AND ten_file LIKE $2)`,
      [tenantId, `${DAU_HIEU}%`]
    );
    await client.query(`DELETE FROM kb_document WHERE tenant_id = $1 AND ten_file LIKE $2`, [
      tenantId, `${DAU_HIEU}%`,
    ]);
    const xoaKs = await client.query(`DELETE FROM kb_script WHERE tenant_id = $1`, [tenantId]);
    console.log(`  ✓ Dọn cũ: ${xoaKs.rowCount} kịch bản · ${xoaKb.rowCount} đoạn tri thức`);

    // --- Kịch bản cứng ---
    for (const k of KICH_BAN) {
      await client.query(
        `INSERT INTO kb_script (tenant_id, loai, mau_khop, tra_loi, uu_tien, locale, chuyen_nguoi)
         VALUES ($1, 'cung', $2, $3, $4, 'vi-VN', $5)`,
        [tenantId, k.mauKhop, k.traLoi, k.uuTien, k.chuyenNguoi === true]
      );
    }
    console.log(`  ✓ Nạp ${KICH_BAN.length} kịch bản cứng (${KICH_BAN.filter((k) => k.chuyenNguoi).length} kịch bản sẽ chuyển nhân viên)`);

    // --- Tài liệu + đoạn tri thức ---
    let tongDoan = 0;
    for (const tl of TAI_LIEU) {
      const checksum = crypto.createHash("sha256").update(tl.noiDung).digest("hex");
      const doc = await client.query(
        `INSERT INTO kb_document (tenant_id, ten_file, loai, kich_thuoc, checksum, trang_thai)
         VALUES ($1, $2, 'txt', $3, $4, 'san_sang') RETURNING id`,
        [tenantId, `${DAU_HIEU} ${tl.ten}`, Buffer.byteLength(tl.noiDung), checksum]
      );
      const docId = doc.rows[0].id;

      for (const doan of catDoan(tl.noiDung)) {
        const vec = await taoVectorEmbedding(doan);
        await client.query(
          `INSERT INTO kb_chunk (tenant_id, document_id, noi_dung, embedding, meta)
           VALUES ($1, $2, $3, $4::vector, $5)`,
          [tenantId, docId, doan, JSON.stringify(vec), JSON.stringify({ nguon: tl.ten })]
        );
        tongDoan++;
      }
    }
    console.log(`  ✓ Nạp ${TAI_LIEU.length} tài liệu · ${tongDoan} đoạn tri thức`);

    await client.query("COMMIT");

    console.log("═".repeat(66));
    console.log("  HOÀN TẤT — có hiệu lực NGAY, không cần khởi động lại dịch vụ.");
    console.log("  Kiểm thử: mở widget chat và thử các câu ở KIEN_TRUC/04_HUAN_LUYEN_AI.md");
    console.log("═".repeat(66));
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error("✖ Lỗi:", e?.message ?? e);
  process.exit(1);
});
