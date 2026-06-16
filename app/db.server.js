import { PrismaClient } from "@prisma/client";

const initPragmas = (client) => {
  // WAL mode: concurrent readers don't block writers and vice versa.
  // busy_timeout: retry for 5 s instead of failing immediately on SQLITE_BUSY.
  // synchronous=NORMAL: ~3× faster writes; DB stays consistent on crash (just not power-loss safe).
  // cache_size=-32000: 32 MB page cache — reduces disk I/O for hot data.
  Promise.all([
    client.$queryRaw`PRAGMA journal_mode=WAL`,
    client.$queryRaw`PRAGMA busy_timeout=5000`,
    client.$queryRaw`PRAGMA synchronous=NORMAL`,
    client.$queryRaw`PRAGMA cache_size=-32000`,
    client.$queryRaw`PRAGMA temp_store=MEMORY`,
  ]).catch(() => {});
  return client;
};

let prisma;
if (process.env.NODE_ENV === "production") {
  prisma = initPragmas(new PrismaClient());
} else {
  if (!global.prismaGlobal) {
    global.prismaGlobal = initPragmas(new PrismaClient());
  }
  prisma = global.prismaGlobal;
}

export default prisma;
