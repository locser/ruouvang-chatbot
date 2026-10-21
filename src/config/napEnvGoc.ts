import dotenv from "dotenv";
import fs from "fs";
import path from "path";

/**
 * Nạp `.env` GỐC của dự án cho các lệnh chạy tay (migrate, settings).
 *
 * Chỉ import file này ĐẦU TIÊN trong script: các module khác (config/env.ts) đọc
 * process.env ngay lúc được import.
 *
 * Trong `.env`, host CSDL là tên service Docker (`chatbot-db`). Chạy lệnh từ máy
 * host thì đặt `CONFIG_LOCAL_MODE=1` để đổi sang localhost:15433 (cùng quy ước với
 * run-chatbot-local.js).
 */
for (const p of [path.resolve(__dirname, "../../.env"), path.resolve(__dirname, "../../../.env")]) {
  if (fs.existsSync(p)) {
    dotenv.config({ path: p });
    break;
  }
}

if (process.env.CONFIG_LOCAL_MODE === "1") {
  const doi = (u?: string) => (u || "").replace("@chatbot-db:5432", "@localhost:15433");
  process.env.CONFIG_POSTGRES_URL_CHATBOT = doi(process.env.CONFIG_POSTGRES_URL_CHATBOT_CENTRAL || process.env.CONFIG_POSTGRES_URL_CHATBOT);
  process.env.CONFIG_POSTGRES_URL_CHATBOT_APP = doi(process.env.CONFIG_POSTGRES_URL_CHATBOT_APP);
  process.env.CONFIG_POSTGRES_URL_CHATBOT_CENTRAL = doi(process.env.CONFIG_POSTGRES_URL_CHATBOT_CENTRAL);
}

if (!process.env.CONFIG_POSTGRES_URL_CHATBOT && process.env.CONFIG_POSTGRES_URL_CHATBOT_CENTRAL) {
  process.env.CONFIG_POSTGRES_URL_CHATBOT = process.env.CONFIG_POSTGRES_URL_CHATBOT_CENTRAL;
}
