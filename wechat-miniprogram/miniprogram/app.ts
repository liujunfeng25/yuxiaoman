import { getStoredRole } from "./services/storage";
import { ensureSession } from "./services/session";
import type { AppRole } from "./types";

App<{ role: AppRole }>({
  globalData: {
    role: getStoredRole(),
  },
  onLaunch() {
    // Pre-warm the owner session without delaying the first page. Every API
    // request also awaits the same singleton, so an early page load is safe.
    void ensureSession().catch(() => {
      // Release requests surface authentication failures through the page's
      // existing API error path. Development may use server-gated demo auth.
    });
  },
});
