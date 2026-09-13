/**
 * 错误分类与重试策略。
 *
 * 依据接口文档与 M1 实测结果，将保活失败分为 11 类，每类有独立的重试策略。
 */

export type ErrorCategory =
  | "network" // 网络不可达
  | "timeout" // 超时
  | "rate-limit" // 限流
  | "server-error" // 服务端 5xx
  | "auth-expired" // 凭据过期
  | "session-conflict" // 会话冲突（auth_code=7）
  | "protocol-error" // 协议错误（auth_code=8/9）
  | "device-offline" // 设备关机/未就绪
  | "device-forbidden" // 设备禁止连接
  | "intervention-required" // 需人工处理（验证码/MFA）
  | "unknown"; // 未分类

export interface ErrorClassification {
  category: ErrorCategory;
  message: string;
  /** 是否应重试 */
  shouldRetry: boolean;
  /** 重试延迟序列（毫秒），null 表示不重试 */
  retryDelays: number[] | null;
  /** 是否应通知用户 */
  shouldNotify: boolean;
}

/** 重试策略表 */
const RETRY_POLICIES: Record<ErrorCategory, ErrorClassification["retryDelays"]> = {
  "network": [5_000, 15_000, 45_000], // 5s, 15s, 45s × 3 次
  "timeout": [5_000, 15_000, 45_000],
  "rate-limit": [60_000, 180_000], // 60s, 180s × 2 次
  "server-error": [10_000, 30_000], // 10s, 30s × 2 次
  "auth-expired": null, // 触发静默重登，不由保活层重试
  "session-conflict": null, // 不重试不通知
  "protocol-error": null, // 不重试
  "device-offline": null, // 不重试（等设备开机后由定时器触发）
  "device-forbidden": null, // 不重试
  "intervention-required": null, // 不重试，需人工处理
  "unknown": [10_000], // 未知错误重试一次
};

/** 分类错误并返回重试策略 */
export function classifyError(err: unknown): ErrorClassification {
  // 网络错误
  if (
    err instanceof TypeError &&
    (err.message.includes("fetch") || err.message.includes("NetworkError"))
  ) {
    return {
      category: "network",
      message: "网络连接失败",
      shouldRetry: true,
      retryDelays: RETRY_POLICIES["network"],
      shouldNotify: false,
    };
  }

  // 超时
  if (err instanceof Error && err.message.includes("timeout")) {
    return {
      category: "timeout",
      message: "请求超时",
      shouldRetry: true,
      retryDelays: RETRY_POLICIES["timeout"],
      shouldNotify: false,
    };
  }

  // CtyunApiError 的 code 分类
  if (err && typeof err === "object" && "code" in err && typeof err.code === "number") {
    const code = err.code;
    const msg = "message" in err && typeof err.message === "string" ? err.message : "未知错误";

    // 限流
    if (code === 429 || msg.includes("限流") || msg.includes("频繁")) {
      return {
        category: "rate-limit",
        message: "请求过于频繁",
        shouldRetry: true,
        retryDelays: RETRY_POLICIES["rate-limit"],
        shouldNotify: false,
      };
    }

    // 5xx
    if (code >= 500 && code < 600) {
      return {
        category: "server-error",
        message: `服务端错误 (${code})`,
        shouldRetry: true,
        retryDelays: RETRY_POLICIES["server-error"],
        shouldNotify: false,
      };
    }

    // 凭据过期
    if (code === 40001 || msg.includes("登录态") || msg.includes("token")) {
      return {
        category: "auth-expired",
        message: "登录凭据已过期",
        shouldRetry: false,
        retryDelays: null,
        shouldNotify: false, // 触发静默重登
      };
    }
  }

  // Clink auth_code 分类
  if (err && typeof err === "object" && "authCode" in err) {
    const authCode = (err as { authCode: unknown }).authCode;

    if (authCode === 7) {
      return {
        category: "session-conflict",
        message: "会话冲突（可能有其他客户端连接）",
        shouldRetry: false,
        retryDelays: null,
        shouldNotify: false, // 不通知（正常现象）
      };
    }

    if (authCode === 8 || authCode === 9) {
      return {
        category: "protocol-error",
        message: `协议错误 (auth_code=${authCode})`,
        shouldRetry: false,
        retryDelays: null,
        shouldNotify: true,
      };
    }
  }

  // LoginInterventionRequired
  if (err && typeof err === "object" && "kind" in err) {
    return {
      category: "intervention-required",
      message: err instanceof Error ? err.message : "需要人工处理",
      shouldRetry: false,
      retryDelays: null,
      shouldNotify: true,
    };
  }

  // 设备状态
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("关机") || msg.includes("未就绪") || msg.includes("offline")) {
    return {
      category: "device-offline",
      message: "设备未就绪",
      shouldRetry: false,
      retryDelays: null,
      shouldNotify: false,
    };
  }

  if (msg.includes("禁止连接") || msg.includes("forbidden")) {
    return {
      category: "device-forbidden",
      message: "设备禁止连接",
      shouldRetry: false,
      retryDelays: null,
      shouldNotify: true,
    };
  }

  // 未分类
  return {
    category: "unknown",
    message: msg,
    shouldRetry: true,
    retryDelays: RETRY_POLICIES["unknown"],
    shouldNotify: true,
  };
}

/** 格式化错误为用户友好的消息（不含技术词汇） */
export function formatErrorForUser(classification: ErrorClassification): string {
  const prefix = {
    "network": "网络连接失败",
    "timeout": "连接超时",
    "rate-limit": "操作过于频繁，请稍后再试",
    "server-error": "服务暂时不可用",
    "auth-expired": "登录已过期",
    "session-conflict": "检测到其他设备连接",
    "protocol-error": "连接异常",
    "device-offline": "设备未开机",
    "device-forbidden": "设备不可用",
    "intervention-required": classification.message,
    "unknown": "保活失败",
  };

  return prefix[classification.category];
}
