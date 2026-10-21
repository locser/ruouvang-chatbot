/**
 * VPH Chatbot SaaS Admin i18n Translation Engine & CSV Import Manager
 */

(function () {
  const STORAGE_LANG_KEY = "vph_admin_lang";
  const STORAGE_CUSTOM_LANGS_KEY = "vph_admin_custom_langs"; // Array of { code, name, dict }

  // Built-in Translation Dictionaries
  const builtInTranslations = {
    vi: {
      // Sidebar Nav
      "nav_overview": "Tổng quan",
      "nav_super_tenants": "Quản lý Tenants",
      "nav_domains": "Tên miền & Keys",
      "nav_accounts": "Nhân sự (Operators)",
      "nav_documents": "Tài liệu tri thức (KB)",
      "nav_scripts": "Kịch bản cứng (Q&A)",
      "nav_credits": "Lịch sử Credit",
      "nav_settings": "Cấu hình Bot",
      "nav_conversations": "Lịch sử Chat",
      "logout": "Đăng xuất",

      // Header & Stats
      "page_overview": "Tổng quan hệ thống",
      "role_label": "Vai trò:",
      "balance_label": "Số dư:",
      "stat_active_bot": "Model AI đang dùng",
      "stat_total_convs": "Tổng cuộc hội thoại",
      "stat_spent_credit": "Credit đã tiêu",
      "stat_system_status": "Trạng thái hệ thống",
      "system_active": "Hoạt động tốt",

      // Buttons & Actions
      "btn_add_tenant": "+ Tạo Tenant Mới",
      "btn_add_operator": "+ Thêm Nhân viên",
      "btn_upload_doc": "Tải lên Tài liệu",
      "btn_add_script": "+ Thêm Kịch bản mới",
      "btn_save_settings": "Lưu Cấu Hình Bot",
      "btn_save_domains": "Lưu Cấu Hình Tên Miền",
      "btn_rotate_key": "Xoay Khóa (Rotate)",
      "btn_send_msg": "Gửi tin nhắn",
      "btn_release_bot": "🤖 Bàn giao lại cho Bot",
      "btn_import_csv_lang": "+ 📥 Nhập CSV Ngôn ngữ...",
      "btn_confirm_import": "Nhập & Áp dụng Ngôn ngữ",
      "btn_close": "Đóng",

      // Table Headers & Labels
      "th_tenant_name": "Tên Shop / Tenant",
      "th_domain": "Tên miền",
      "th_status": "Trạng thái",
      "th_created_at": "Ngày tạo",
      "th_actions": "Hành động",
      "th_operator_name": "Tên nhân viên",
      "th_telegram_id": "Telegram ID",
      "th_doc_name": "Tên tài liệu",
      "th_size": "Dung lượng",
      "th_trigger": "Từ khóa kích hoạt (Trigger)",
      "th_answer": "Câu trả lời cố định",
      "th_timestamp": "Thời gian",
      "th_amount": "Số tiền (Credit)",
      "th_description": "Nội dung giao dịch",
      "th_visitor": "Khách hàng (Visitor)",
      "th_mode": "Chế độ",
      "th_last_msg": "Tin nhắn gần nhất",

      // CSV Import Modal
      "import_csv_title": "Nhập Ngôn ngữ mới từ File CSV",
      "import_csv_desc": "Tải lên hoặc dán nội dung CSV chứa các cặp khóa bản dịch (key, translation) để mở rộng ngôn ngữ giao diện.",
      "import_csv_lang_code": "Mã ngôn ngữ (ví dụ: ja, fr, zh, es, ko):",
      "import_csv_lang_name": "Tên hiển thị (ví dụ: Japanese - 日本語):",
      "import_csv_content_label": "Nội dung CSV (hoặc kéo thả file CSV vào đây):",
      "import_csv_sample_link": "📋 Tải file CSV mẫu (Template)",

      // Placeholders & Helpers
      "ph_search": "Tìm kiếm...",
      "ph_reply_msg": "Nhập tin nhắn trả lời khách hàng...",
      "ph_csv_paste": "key,translation\nnav_overview,Overview\nbtn_send_msg,Send Message\n..."
    },

    en: {
      // Sidebar Nav
      "nav_overview": "Overview",
      "nav_super_tenants": "Manage Tenants",
      "nav_domains": "Domains & Keys",
      "nav_accounts": "Operators",
      "nav_documents": "Knowledge Base (KB)",
      "nav_scripts": "Hard Scripts (Q&A)",
      "nav_credits": "Credit Ledger",
      "nav_settings": "Bot Settings",
      "nav_conversations": "Chat Logs",
      "logout": "Log Out",

      // Header & Stats
      "page_overview": "System Overview",
      "role_label": "Role:",
      "balance_label": "Balance:",
      "stat_active_bot": "Active AI Model",
      "stat_total_convs": "Total Conversations",
      "stat_spent_credit": "Spent Credit",
      "stat_system_status": "System Status",
      "system_active": "Operational",

      // Buttons & Actions
      "btn_add_tenant": "+ Create New Tenant",
      "btn_add_operator": "+ Add Operator",
      "btn_upload_doc": "Upload Document",
      "btn_add_script": "+ Add New Script",
      "btn_save_settings": "Save Bot Settings",
      "btn_save_domains": "Save Domain Config",
      "btn_rotate_key": "Rotate API Key",
      "btn_send_msg": "Send Message",
      "btn_release_bot": "🤖 Handover to Bot",
      "btn_import_csv_lang": "+ 📥 Import Language CSV...",
      "btn_confirm_import": "Import & Apply Language",
      "btn_close": "Close",

      // Table Headers & Labels
      "th_tenant_name": "Tenant / Shop Name",
      "th_domain": "Domain Name",
      "th_status": "Status",
      "th_created_at": "Created Date",
      "th_actions": "Actions",
      "th_operator_name": "Operator Name",
      "th_telegram_id": "Telegram ID",
      "th_doc_name": "Document Name",
      "th_size": "Size",
      "th_trigger": "Trigger Phrase",
      "th_answer": "Fixed Response",
      "th_timestamp": "Timestamp",
      "th_amount": "Amount (Credit)",
      "th_description": "Transaction Description",
      "th_visitor": "Customer / Visitor",
      "th_mode": "Mode",
      "th_last_msg": "Last Message",

      // CSV Import Modal
      "import_csv_title": "Import Custom Language via CSV",
      "import_csv_desc": "Upload or paste CSV content containing translation key-value pairs to expand Admin UI languages.",
      "import_csv_lang_code": "Language Code (e.g. ja, fr, zh, es, ko):",
      "import_csv_lang_name": "Display Name (e.g. Japanese - 日本語):",
      "import_csv_content_label": "CSV Content (or drop CSV file here):",
      "import_csv_sample_link": "📋 Download Sample CSV Template",

      // Placeholders & Helpers
      "ph_search": "Search...",
      "ph_reply_msg": "Type reply message to customer...",
      "ph_csv_paste": "key,translation\nnav_overview,Overview\nbtn_send_msg,Send Message\n..."
    }
  };

  // State
  let currentLang = localStorage.getItem(STORAGE_LANG_KEY) || "vi";
  let customLanguages = {}; // { [code]: { name, dict } }

  // Load custom languages from localStorage
  function loadCustomLangs() {
    try {
      const raw = localStorage.getItem(STORAGE_CUSTOM_LANGS_KEY);
      if (raw) {
        customLanguages = JSON.parse(raw);
      }
    } catch (e) {
      console.error("[i18n] Failed to load custom languages:", e);
    }
  }

  // Get active translation dictionary
  function getActiveDict(lang) {
    const l = lang || currentLang;
    if (builtInTranslations[l]) return builtInTranslations[l];
    if (customLanguages[l]) return customLanguages[l].dict;
    return builtInTranslations["vi"]; // Fallback to Vietnamese
  }

  // Translate key function
  function t(key, fallbackText) {
    const dict = getActiveDict();
    if (dict && dict[key] !== undefined) {
      return dict[key];
    }
    const fallbackDict = builtInTranslations["vi"];
    if (fallbackDict && fallbackDict[key] !== undefined) {
      return fallbackDict[key];
    }
    return fallbackText || key;
  }

  // Apply language to all elements with data-i18n attribute
  function applyLanguage(lang) {
    if (lang) {
      currentLang = lang;
      localStorage.setItem(STORAGE_LANG_KEY, lang);
    }

    document.documentElement.lang = currentLang;

    // Translate all elements with data-i18n attribute
    const elements = document.querySelectorAll("[data-i18n]");
    elements.forEach((el) => {
      const key = el.getAttribute("data-i18n");
      const translation = t(key, el.textContent);
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
        if (el.hasAttribute("placeholder")) {
          el.setAttribute("placeholder", translation);
        }
      } else {
        el.textContent = translation;
      }
    });

    // Translate elements with data-i18n-placeholder
    const placeholderEls = document.querySelectorAll("[data-i18n-placeholder]");
    placeholderEls.forEach((el) => {
      const key = el.getAttribute("data-i18n-placeholder");
      el.setAttribute("placeholder", t(key, el.getAttribute("placeholder")));
    });

    // Update language selector dropdown
    updateLanguageSelectorUI();
  }

  // Update language selector UI options dynamically
  function updateLanguageSelectorUI() {
    const selector = document.getElementById("lang-selector");
    if (!selector) return;

    selector.innerHTML = "";

    // Built-in options
    const viOpt = document.createElement("option");
    viOpt.value = "vi";
    viOpt.textContent = "🇻🇳 Tiếng Việt";
    selector.appendChild(viOpt);

    const enOpt = document.createElement("option");
    enOpt.value = "en";
    enOpt.textContent = "🇬🇧 English";
    selector.appendChild(enOpt);

    // Custom imported languages options
    Object.keys(customLanguages).forEach((code) => {
      const opt = document.createElement("option");
      opt.value = code;
      opt.textContent = `🌐 ${customLanguages[code].name} (${code.toUpperCase()})`;
      selector.appendChild(opt);
    });

    // Import option
    const importOpt = document.createElement("option");
    importOpt.value = "import_csv";
    importOpt.textContent = t("btn_import_csv_lang", "+ 📥 Nhập CSV Ngôn ngữ...");
    selector.appendChild(importOpt);

    selector.value = currentLang;
  }

  // Parse CSV text into dictionary key-value map
  function parseCSV(csvText) {
    const lines = csvText.split(/\r?\n/);
    const dict = {};
    for (let line of lines) {
      line = line.trim();
      if (!line || line.startsWith("#")) continue;

      // Split by comma (handling basic quotes)
      const parts = line.split(",");
      if (parts.length >= 2) {
        let key = parts[0].trim().replace(/^["']|["']$/g, "");
        let val = parts.slice(1).join(",").trim().replace(/^["']|["']$/g, "");

        // Ignore header row if key is 'key' or 'code'
        if (key.toLowerCase() === "key" || key.toLowerCase() === "code") continue;

        if (key && val) {
          dict[key] = val;
        }
      }
    }
    return dict;
  }

  // Import custom language from CSV
  function importLanguageCSV(code, name, csvText) {
    const cleanCode = code.trim().toLowerCase();
    const cleanName = name.trim() || cleanCode.toUpperCase();

    if (!cleanCode) {
      throw new Error("Mã ngôn ngữ không được để trống!");
    }

    const dict = parseCSV(csvText);
    if (Object.keys(dict).length === 0) {
      throw new Error("File CSV không chứa dữ liệu bản dịch hợp lệ (Định dạng: key,translation)!");
    }

    customLanguages[cleanCode] = {
      name: cleanName,
      dict: dict
    };

    localStorage.setItem(STORAGE_CUSTOM_LANGS_KEY, JSON.stringify(customLanguages));
    applyLanguage(cleanCode);
    return Object.keys(dict).length;
  }

  // Download Sample CSV Template
  function downloadSampleCSV() {
    let csv = "key,translation\n";
    const viDict = builtInTranslations.vi;
    Object.keys(viDict).forEach((k) => {
      csv += `"${k}","${viDict[k]}"\n`;
    });

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "vph_i18n_template.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  // Expose global i18n API
  window.VPH_i18n = {
    t: t,
    applyLanguage: applyLanguage,
    importLanguageCSV: importLanguageCSV,
    downloadSampleCSV: downloadSampleCSV,
    getCurrentLang: () => currentLang
  };

  // Auto initialize on DOM ready
  document.addEventListener("DOMContentLoaded", () => {
    loadCustomLangs();
    applyLanguage(currentLang);
  });
})();
