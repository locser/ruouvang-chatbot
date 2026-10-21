/**
 * Claim Firewall Service ("Tường lửa công bố")
 * 
 * Rules:
 * - Scans LLM responses to ensure compliance with locale-specific health and medical claim regulations.
 * - Categorizes violations into:
 *   - BLOCK: Stop the message immediately, escalate to human operator.
 *   - REVIEW: Flag the message for operator audit but allow delivery (if configured).
 * - Fallbacks to EU regulations ('en-IE') for undefined/foreign locales if claim firewall is active for the tenant.
 */

export interface ComplianceFlag {
  ruleId: string;
  level: "BLOCK" | "REVIEW";
  matchedText: string;
  message: string;
}

interface ClaimRule {
  id: string;
  pattern: RegExp;
  level: "BLOCK" | "REVIEW";
  message: string;
}

const REGULATORY_RULES: Record<string, ClaimRule[]> = {
  "vi-VN": [
    {
      id: "vn_cure_disease",
      pattern: /(chữa bệnh|điều trị|đặc trị|trị dứt điểm|chữa dứt điểm)/iu,
      level: "BLOCK",
      message: "Vi phạm quy định quảng cáo thực phẩm: không được tự xưng có tác dụng điều trị/chữa bệnh.",
    },
    {
      id: "vn_replace_meds",
      pattern: /thay thế thuốc/iu,
      level: "BLOCK",
      message: "Vi phạm quy định: thực phẩm không thể thay thế thuốc chữa bệnh.",
    },
    {
      id: "vn_longevity_r13",
      pattern: /(120 tuổi|150 tuổi|trường sinh bất tử)/iu,
      level: "BLOCK",
      message: "Vi phạm nguyên tắc cam kết phi thực tế (R13).",
    },
  ],
  "en-IE": [
    // EU Regulations (highly restrictive)
    {
      id: "eu_probiotic",
      pattern: /\b(probiotic|probiotics)\b/i,
      level: "BLOCK",
      message: "EU Reg 1924/2006: 'Probiotic' is classified as an unauthorized health claim.",
    },
    {
      id: "eu_live_cultures",
      pattern: /\b(live culture|live cultures)\b/i,
      level: "BLOCK",
      message: "EU Regulation: 'Live cultures' claims are banned without EFSA authorization.",
    },
    {
      id: "eu_gut_health",
      pattern: /\b(gut health|digestive health|immune support|good bacteria)\b/i,
      level: "BLOCK",
      message: "EU Regulation: Banned general non-specific health claims.",
    },
  ],
  "en-US": [
    // FDA Regulations (moderate)
    {
      id: "us_cures_disease",
      pattern: /\b(cures disease|cures cancer|replaces medication)\b/i,
      level: "BLOCK",
      message: "FDA Regulation: Banned medical claims for dietary supplements.",
    },
    {
      id: "us_fda_approved",
      pattern: /\b(fda approved|approved by fda)\b/i,
      level: "BLOCK",
      message: "FDA Regulation: Supplements cannot claim FDA approval.",
    },
    {
      id: "us_probiotic_review",
      pattern: /\b(probiotic|probiotics)\b/i,
      level: "REVIEW",
      message: "US Regulation: Probiotic claims are allowed but subject to audit.",
    },
  ],
};

/**
 * Validates a text response against locale-specific claim guardrails.
 * If the locale is not defined in our registry, it fallbacks to EU rules (strict) as a safety measure.
 */
export function assertSafeTranslation(locale: string, text: string): ComplianceFlag[] {
  const flags: ComplianceFlag[] = [];
  
  // Normalize locale or fallback
  const rules = REGULATORY_RULES[locale] || REGULATORY_RULES["en-IE"]; // strict fallback

  for (const rule of rules) {
    const match = text.match(rule.pattern);
    if (match) {
      flags.push({
        ruleId: rule.id,
        level: rule.level,
        matchedText: match[0],
        message: rule.message,
      });
    }
  }

  return flags;
}
