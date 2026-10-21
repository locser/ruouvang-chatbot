import { Queue } from "bullmq";
import { env } from "../config/env";

// Connect to Redis for BullMQ
const redisConnection = {
  url: env.REDIS_URL,
};

export const documentQueue = new Queue("kb-ingest", {
  connection: {
    host: new URL(env.REDIS_URL).hostname,
    port: parseInt(new URL(env.REDIS_URL).port || "6379", 10),
  },
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 5000,
    },
    removeOnComplete: true,
  },
});
