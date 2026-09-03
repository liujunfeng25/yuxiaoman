export const DRIVER_VERIFICATION_CODE_LENGTH = 6;

export function normalizeDriverVerificationCode(value: unknown): string {
  return String(value || "").replace(/\D/gu, "").slice(0, DRIVER_VERIFICATION_CODE_LENGTH);
}

function visualGroup(value: string): string {
  return value.padEnd(3, "·").split("").join(" ");
}

export function driverVerificationCodeGroups(value: unknown): [string, string] {
  const code = normalizeDriverVerificationCode(value);
  return [visualGroup(code.slice(0, 3)), visualGroup(code.slice(3, 6))];
}

export function driverVerificationCodeReady(value: unknown): boolean {
  return /^\d{6}$/u.test(normalizeDriverVerificationCode(value));
}
