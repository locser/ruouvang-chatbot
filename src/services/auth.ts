import crypto from 'crypto';

/**
 * PBKDF2 Password Hashing
 */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

/**
 * Verify Password match against stored PBKDF2 hash
 */
export function verifyPassword(password: string, storedValue: string): boolean {
  try {
    const parts = storedValue.split(':');
    if (parts.length !== 2) return false;
    const [salt, storedHash] = parts;
    const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash, 'utf8'), Buffer.from(storedHash, 'utf8'));
  } catch (e) {
    return false;
  }
}

/**
 * Phiên bản BẤT ĐỒNG BỘ của hashPassword / verifyPassword.
 *
 * Vì sao cần: pbkdf2Sync với 100.000 vòng mất ~50-100ms và CHẶN event loop
 * đơn luồng của Node. Khoảng 20-50 request/giây vào endpoint đăng nhập (dù
 * sai mật khẩu) là đủ treo toàn bộ API cho MỌI tenant. Hai hàm dưới đây đẩy
 * việc tính toán sang threadpool nên không chặn event loop.
 *
 * Mọi đường đi có thể bị người ngoài kích hoạt (đăng nhập, đổi/đặt lại mật
 * khẩu) BẮT BUỘC dùng bản async. Bản sync chỉ còn cho seed và test.
 */
export function hashPasswordAsync(password: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString('hex');
    crypto.pbkdf2(password, salt, 100000, 64, 'sha512', (err, dk) => {
      if (err) return reject(err);
      resolve(`${salt}:${dk.toString('hex')}`);
    });
  });
}

export function verifyPasswordAsync(password: string, storedValue: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const parts = String(storedValue || '').split(':');
      if (parts.length !== 2) return resolve(false);
      const [salt, storedHash] = parts;
      crypto.pbkdf2(password, salt, 100000, 64, 'sha512', (err, dk) => {
        if (err) return resolve(false);
        const a = Buffer.from(dk.toString('hex'), 'utf8');
        const b = Buffer.from(storedHash, 'utf8');
        resolve(a.length === b.length && crypto.timingSafeEqual(a, b));
      });
    } catch {
      resolve(false);
    }
  });
}

/**
 * Official Telegram WebApp initData Signature Verification
 */
export function verifyTelegramSignature(initData: string, botToken: string): boolean {
  // Chi cho phep bypass khi dang chay duoi Jest (JEST_WORKER_ID do jest tu dat).
  // KHONG dung NODE_ENV: bien nay co the bi dat nham tren may that => cua hau.
  if (typeof process.env.JEST_WORKER_ID !== 'undefined' && initData.startsWith('bypass_tg_')) {
    return true;
  }

  try {
    const params = new URLSearchParams(initData);

    const hash = params.get('hash');
    if (!hash) return false;

    // Check auth_date for replay attack (must be within 5 minutes)
    const authDateStr = params.get('auth_date');
    if (authDateStr) {
      const authDate = parseInt(authDateStr, 10);
      const now = Math.floor(Date.now() / 1000);
      if (isNaN(authDate) || Math.abs(now - authDate) > 300) {
        return false;
      }
    }

    // Remove hash parameter
    params.delete('hash');

    // Sort and join parameters alphabetically by key
    const keys = Array.from(params.keys()).sort();
    const checkString = keys.map(key => `${key}=${params.get(key)}`).join('\n');

    // Compute HMAC-SHA256 signature
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const computedHash = crypto.createHmac('sha256', secretKey).update(checkString).digest('hex');

    const computedBuffer = Buffer.from(computedHash, 'hex');
    const hashBuffer = Buffer.from(hash, 'hex');
    if (computedBuffer.length !== hashBuffer.length) return false;

    return crypto.timingSafeEqual(computedBuffer, hashBuffer);
  } catch (e) {
    console.error("[Auth] Telegram signature check error:", e);
    return false;
  }
}

