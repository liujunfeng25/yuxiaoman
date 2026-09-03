import { configureMiniApiEnvironment } from "./configure-mini-api-environment.mjs";

configureMiniApiEnvironment();

await import("../server/index.ts");
