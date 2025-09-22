// apps/web/server/lib/db/prismaDirectNoTx.ts
import { PrismaClient } from "@calcom/prisma/client";

// Re-use instance khi dev/hot-reload
const g = globalThis as any;
const base: PrismaClient = g.__prismaNoTx ?? new PrismaClient();
if (process.env.NODE_ENV !== "production") g.__prismaNoTx = base;

// Chặn $transaction; cho $use là no-op để không vỡ các nơi vô tình gọi
type Patched = PrismaClient & {
  $transaction: (...args: any[]) => never;
  $use: (...args: any[]) => void;
};

const prismaDirectNoTx = new Proxy(base, {
  get(target, prop, receiver) {
    if (prop === "$transaction") {
      return () => {
        throw new Error("$transaction is disabled in prismaDirectNoTx");
      };
    }
    if (prop === "$use") {
      return () => {}; // bỏ qua middleware trên client này
    }
    return Reflect.get(target, prop, receiver);
  },
}) as unknown as Patched;

export default prismaDirectNoTx;
