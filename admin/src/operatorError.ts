const DEFAULT_OPERATOR_ERROR = "操作失败，请稍后重试";

const TECHNICAL_MESSAGE_PATTERNS = [
  /(?:failed\s+to\s+fetch|network(?:\s+request)?\s+failed|networkerror|fetcherror)/i,
  /(?:unauthorized|forbidden|internal\s+server\s+error|bad\s+gateway|service\s+unavailable)/i,
  /(?:typeerror|referenceerror|syntaxerror|aborterror|econnrefused|enotfound|etimedout)/i,
  /\b(?:error|exception|endpoint|payload|response|request[_-]?id|trace[_-]?id|correlation[_-]?id)\b/i,
  /\b(?:api|url|uri|id|json|sql|jwt|http|https|token|stack|trace|bearer|authorization|debug|fatal)\b/i,
  /\b(?:GET|POST|PUT|PATCH|DELETE|OPTIONS)\s+\S+/,
  /\b(?:4\d\d|5\d\d)\s+(?:error|failed|failure)\b/i,
  /\b(?:E\d{3,}|ERR(?:OR)?[_-][A-Z0-9_-]+|[A-Z0-9]{2,}_[A-Z0-9_]{2,})\b/,
  /\b[a-z]+(?:[A-Z][A-Za-z0-9]*)+\b/,
];

const PRIVATE_DETAIL_PATTERNS = [
  /(?:https?|wss?|file):\/\//i,
  /\b(?:www\.)?[A-Za-z0-9-]+\.(?:com|cn|net|org|io)(?:\/|\b)/i,
  /\b(?:localhost|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?(?:\/|\b)/i,
  /(?:^|[\s"'(])\/(?:api|admin|backoffice|graphql|v\d+)(?:\/|\b)/i,
  /[A-Za-z]:\\(?:[^\s\\]+\\)+/,
  /(?:^|\n)\s*at\s+(?:\S+\s+)?\(?[^\n]+:\d+:\d+\)?/m,
  /\b(?:node_modules|webpack|vite|source map)\b/i,
  /\b[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs):\d+(?::\d+)?\b/i,
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i,
  /\b[A-Za-z0-9_-]{32,}\b/,
  /(?:令牌|密钥|凭证)\s*[:：=]\s*\S{4,}/,
  /(?:状态码|响应码|status\s*code)\s*[:：=]?\s*[45]\d\d/i,
  /[{}\[\]]\s*["']?[A-Za-z_$][\w$-]*["']?\s*:/,
  /<\/?[A-Za-z][^>]*>/,
];

function messageFrom(reason: unknown): string {
  if (typeof reason === "string") return reason;
  if (reason instanceof Error) return reason.message;
  if (!reason || typeof reason !== "object") return "";
  const value = reason as { message?: unknown; error?: unknown };
  if (typeof value.message === "string") return value.message;
  if (typeof value.error === "string") return value.error;
  if (value.error && typeof value.error === "object") {
    const nestedMessage = (value.error as { message?: unknown }).message;
    if (typeof nestedMessage === "string") return nestedMessage;
  }
  return "";
}

export function isSafeOperatorMessage(message: unknown): message is string {
  if (typeof message !== "string") return false;
  const value = message.trim();
  if (!value || value.length > 240 || !/[\u3400-\u9fff]/u.test(value)) return false;
  if (/[\r\n\t\u0000-\u001f\u007f]/u.test(value)) return false;
  return ![...TECHNICAL_MESSAGE_PATTERNS, ...PRIVATE_DETAIL_PATTERNS].some((pattern) => pattern.test(value));
}

/**
 * Keeps intentional Chinese business errors visible while preventing transport,
 * authentication and implementation details from reaching an operator-facing UI.
 */
export function operatorErrorMessage(reason: unknown, fallback = DEFAULT_OPERATOR_ERROR): string {
  const safeFallback = isSafeOperatorMessage(fallback) ? fallback.trim() : DEFAULT_OPERATOR_ERROR;
  const candidate = messageFrom(reason).trim();
  return isSafeOperatorMessage(candidate) ? candidate : safeFallback;
}
