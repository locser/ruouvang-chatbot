/**
 * Price Checker Service ("Bộ soi tiền")
 * 
 * Rules:
 * - Detects and prevents the bot from performing currency conversions or estimating prices.
 * - Compares currency symbols in bot response with the designated channel currency.
 * - Uses a Unicode-aware lookbehind/lookahead pattern to accurately match Vietnamese "đ" 
 *   (e.g., in "780.000đ") without falsely triggering on Vietnamese letters like "được", "đặt", "đã".
 */

export const KY_HIEU_TIEN =
  /(VND|VNĐ|USD|EUR|JPY|GBP|CNY|KRW|AUD|SGD|THB|đồng|₫|\$|€|¥|£)|(?<=[\d\s.,])đ(?![\p{L}])/giu;

export const BI_DANH: Record<string, string> = {
  "VNĐ": "VND",
  "ĐỒNG": "VND",
  "₫": "VND",
  "Đ": "VND",
  "$": "USD",
  "€": "EUR",
  "¥": "JPY",
  "£": "GBP",
};

export const chuanHoa = (s: string): string => {
  const upper = s.toUpperCase();
  return BI_DANH[upper] ?? upper;
};

/**
 * Returns true if the answer contains a currency that DOES NOT match the channel currency (indicating unauthorized currency conversion/leakage).
 */
export function botDangQuyDoi(cauTraLoi: string, tienTeKenh: string): boolean {
  const matches = [...cauTraLoi.matchAll(KY_HIEU_TIEN)].map((m) => chuanHoa(m[0]));
  const targetCurrency = chuanHoa(tienTeKenh);
  
  // Return true if any of the matched currencies do not equal the target currency
  return matches.some((t) => t !== targetCurrency);
}
