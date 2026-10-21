/**
 * 进程纪元（bootId）：每次后端进程启动生成一次，进程内恒定。
 *
 * 前端用 `GET /state` 的 `data.bootId` 识别「服务端已重启」：重启后 `revision`
 * 与日志 `seq` 都从 0 重新计数，旧页面若继续拿旧水位做乱序防护/增量，会被
 * 永久判定为「旧快照」或「无新日志」。bootId 变化即视为新纪元，前端先重置
 * 本地水位与日志缓存，再按新纪元的全量口径重拉。
 */
export const BOOT_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
