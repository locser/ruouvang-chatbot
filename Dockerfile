# syntax=docker/dockerfile:1
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
# --legacy-peer-deps: bullmq@5.80.5 khai peerOptional `redis >= 5.0.0`, còn dự
# án dùng `redis@^4.6.13`. npm 10 coi đây là xung đột và dừng hẳn.
#
# Trên thực tế hai gói này KHÔNG dính nhau: `services/cache.ts` dùng node-redis
# v4 để cache, còn BullMQ kết nối bằng ioredis mà nó tự bundle — không đường mã
# nào đưa client node-redis vào BullMQ. Đây đúng là tổ hợp đang chạy ở local và
# đã qua 164 test, nên ép npm chấp nhận là tái lập trạng thái đã kiểm chứng,
# không phải bỏ qua một cảnh báo thật.
#
# Nâng `redis` lên v5 là việc riêng: API v5 có thay đổi phá vỡ ở cache.ts.
RUN npm ci --legacy-peer-deps
COPY . .
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --legacy-peer-deps && npm cache clean --force

COPY --from=builder /app/dist   ./dist
COPY --from=builder /app/public ./public
COPY --from=builder /app/admin  ./admin
COPY --from=builder /app/tma    ./tma
# File .sql của migration (tsc không chép) — dist/db/migrate.js đọc từ đây.
COPY --from=builder /app/src/db/migrations ./src/db/migrations
COPY --from=builder /app/src/db/schema.sql ./src/db/schema.sql

# KHÔNG COPY .env vào image.
# Bí mật truyền lúc chạy qua biến môi trường / secret manager.
# Bản trước có `COPY --from=builder /app/.env ./` khiến JWT_SECRET,
# CONFIG_ENCRYPTION_KEY_CHATBOT, DEEPSEEK_API_KEY, TELEGRAM_BOT_TOKEN nằm vĩnh viễn trong
# một layer của image — đọc được bằng `docker history`, còn nguyên kể cả khi
# lệnh sau đó xoá file.

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${SERVICE_PORT:-3000}/healthz || exit 1

# Áp migration trước khi mở cổng; `exec` để node nhận thẳng SIGTERM từ Docker.
CMD ["sh", "-c", "node dist/db/migrate.js && exec node dist/index.js"]
