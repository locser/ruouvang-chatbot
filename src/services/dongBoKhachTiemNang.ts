import { pool, runInTenantContext } from "../db/client";
import { getTenantMedusaConfig, medusaLuuKhachTiemNang } from "./medusa";

/**
 * Thử lại việc đẩy khách tiềm năng sang backend Medusa cho những dòng lần trước lỗi
 * (Medusa tắt, mạng đứt…). Lead luôn đã nằm an toàn trong CSDL chatbot; việc này chỉ
 * bảo đảm nó cũng sang được backend. Không cần realtime nên chạy nền, mỗi lượt tối đa 50 dòng.
 */
export async function dongBoKhachTiemNangTonDong(): Promise<number> {
  const { rows } = await pool.query(
    `SELECT id, tenant_id, conversation_id, ten, so_dien_thoai, nhu_cau
     FROM khach_tiem_nang WHERE da_dong_bo_backend = false ORDER BY tao_luc LIMIT 50`
  );
  let soDaDongBo = 0;
  for (const r of rows) {
    try {
      await runInTenantContext(r.tenant_id, async (client) => {
        const medusa = await getTenantMedusaConfig(client, r.tenant_id);
        if (!medusa) return; // shop chưa bật Medusa: để nguyên, bật xong sẽ được đẩy
        await medusaLuuKhachTiemNang(medusa, {
          conversation_id: r.conversation_id, phone: r.so_dien_thoai, name: r.ten, need: r.nhu_cau,
        });
        await client.query(`UPDATE khach_tiem_nang SET da_dong_bo_backend = true WHERE id = $1`, [r.id]);
        soDaDongBo++;
      });
    } catch (e) {
      console.error(`[DongBoLead] Lead ${r.id} chưa đẩy được, lượt sau thử lại:`, e);
    }
  }
  return soDaDongBo;
}
