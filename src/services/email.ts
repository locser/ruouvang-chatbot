import nodemailer from "nodemailer";
import { layCaiDat } from "./caiDat";
import path from "path";
import fs from "fs";

/**
 * Sends a real or test reset password email using Nodemailer
 */
export async function sendResetPasswordEmail(email: string, username: string, resetLink: string): Promise<boolean> {
  let transporter;

  const smtpHost = await layCaiDat("smtp_host");
  const smtpPort = parseInt(await layCaiDat("smtp_port"), 10) || 587;
  const smtpUser = await layCaiDat("smtp_user");
  const smtpPass = await layCaiDat("smtp_pass");
  const smtpFrom = await layCaiDat("smtp_from");

  // Detect fallback/testing SMTP state
  const isMockSmtp = !smtpUser || !smtpPass ||
                     smtpUser.includes("mock_") || 
                     smtpUser.includes("vpholding.alert@gmail.com");

  if (isMockSmtp) {
    console.log("[Email] SMTP chưa cấu hình trong app_settings (smtp_user/smtp_pass). Creating Ethereal Test transport...");
    try {
      const testAccount = await nodemailer.createTestAccount();
      transporter = nodemailer.createTransport({
        host: "smtp.ethereal.email",
        port: 587,
        secure: false,
        auth: {
          user: testAccount.user,
          pass: testAccount.pass,
        },
      });
    } catch (e) {
      console.error("[Email] Failed to create Ethereal test account, falling back to local simulation:", e);
      return false;
    }
  } else {
    transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465,
      auth: {
        user: smtpUser,
        pass: smtpPass,
      },
    });
  }

  const mailOptions = {
    from: smtpFrom,
    to: email,
    subject: "Đặt lại mật khẩu VPH AI ChatBot Panel",
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px; background-color: #ffffff; color: #1e293b;">
        <h2 style="color: #0d9488; text-align: center; margin-bottom: 5px;">VPH AI ChatBot</h2>
        <p style="text-align: center; color: #64748b; font-size: 13px; margin-top: 0;">Hệ thống chăm sóc khách hàng tự động</p>
        <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 20px 0;">
        <p>Xin chào <strong>${username}</strong>,</p>
        <p>Chúng tôi nhận được yêu cầu đặt lại mật khẩu từ tài khoản của bạn trên hệ thống quản lý VPH AI ChatBot.</p>
        <p>Vui lòng click vào nút bên dưới để tiến hành thiết lập mật khẩu mới:</p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${resetLink}" style="background-color: #0d9488; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block; box-shadow: 0 4px 6px -1px rgba(13, 148, 136, 0.2);">Đặt lại mật khẩu</a>
        </div>
        <p style="font-size: 13px; color: #64748b;">Đường liên kết này sẽ hết hạn trong vòng 1 tiếng kể từ lúc email này được gửi.</p>
        <p style="font-size: 13px; color: #64748b;">Nếu bạn không yêu cầu hành động này, vui lòng bỏ qua thư này hoặc liên hệ hỗ trợ.</p>
        <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 20px 0;">
        <p style="font-size: 11px; color: #94a3b8; text-align: center; margin: 0;">Thư này được tạo tự động bởi máy chủ VPH AI ChatBot SaaS.</p>
      </div>
    `,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log("[Email] Message sent successfully. Message ID:", info.messageId);

    const previewUrl = nodemailer.getTestMessageUrl(info);
    
    // Log to file for development debugging
    const emailLogPath = path.join(__dirname, "../../logs/emails.log");
    const logsDir = path.dirname(emailLogPath);
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }

    const logEntry = `
========================================
[EMAIL SENT]
To: ${email}
Message ID: ${info.messageId}
Link: ${resetLink}
${previewUrl ? `Ethereal Web Preview: ${previewUrl}` : "Sent via Real SMTP Server"}
========================================
\n`;
    fs.appendFileSync(emailLogPath, logEntry);

    if (previewUrl) {
      console.log("[Email] Ethereal Web Mailbox Preview URL:", previewUrl);
    }
    return true;
  } catch (err) {
    console.error("[Email] Error sending email:", err);
    return false;
  }
}
