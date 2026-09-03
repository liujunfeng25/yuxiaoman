export const MINI_API_HOST = "0.0.0.0";
export const MINI_API_PORT = "8792";

/**
 * The native mini-program's local entrypoint is intentionally reachable from
 * phones on the developer's LAN. Keep these two values independent from the
 * repository .env, whose loopback HOST remains the safer default for ordinary
 * Web/API development.
 */
export function configureMiniApiEnvironment(environment = process.env) {
  environment.HOST = MINI_API_HOST;
  environment.PORT = MINI_API_PORT;
  environment.YUXIAOMAN_ALLOW_DEMO_AUTH_FALLBACK ??= "true";
  environment.YUXIAOMAN_ALLOW_DIRECT_BACKOFFICE_PASSWORD ??= "true";
  environment.ALLOW_DEMO_RESET ??= "true";
  environment.ALLOW_DEMO_WORKFLOW ??= "true";
  environment.ALLOW_MOCK_PAYMENT ??= "true";

  return { host: MINI_API_HOST, port: Number(MINI_API_PORT) };
}
