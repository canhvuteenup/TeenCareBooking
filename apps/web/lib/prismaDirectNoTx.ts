// apps/web/lib/prismaDirectNoTx.ts
import { PrismaClient } from '@calcom/prisma/client'

// BẮT BUỘC: trỏ DIRECT_URL để không đi qua pooler transaction-mode
const url = process.env.DATABASE_DIRECT_URL || process.env.DATABASE_URL
if (!url) throw new Error('DATABASE_DIRECT_URL or DATABASE_URL is required')

const DISABLE_TX = process.env.DISABLE_PRISMA_TX !== '0' // mặc định: khóa TX

// Khóa prototype TRƯỚC khi khởi tạo client khác
if (DISABLE_TX) {
  // Cấm interactive TX (callback form)
  // @ts-ignore
  PrismaClient.prototype.$transaction = function (arg: any, _opts?: any) {
    // Dạng mảng (batch) cũng là TX. Bạn có thể chọn "degrade" (chạy tuần tự) nếu muốn:
    if (Array.isArray(arg)) {
      // ⚠️ MẤT tính atomic — chạy TUẦN TỰ để giữ thứ tự
      return (async () => {
        const results: any[] = []
        for (const p of arg) results.push(await p)
        return results
      })()
    }
    throw new Error('Prisma transactions are disabled in this deployment.')
  }
}

const g = globalThis as any
export const prisma =
  g.__prismaDirectNoTx__ ??
  new PrismaClient({
    datasources: { db: { url } },
    // log: ['warn', 'error'], // bật nếu cần
  })

if (!g.__prismaDirectNoTx__) g.__prismaDirectNoTx__ = prisma
export default prisma
