const OWNER_HOME_URL = "/pages/home/home";
const RENTAL_HOME_URL = "/packages/car-rental/pages/car-rental-home/car-rental-home";

declare function getCurrentPages(): unknown[];

type NavigateBack = (options: { delta?: number; fail?: () => void }) => void;

function navigateBack(options: { delta: number; fail: () => void }): void {
  (wx.navigateBack as NavigateBack)(options);
}

function stackDepth(): number {
  return getCurrentPages().length;
}

export function leaveRentalHome(): void {
  if (stackDepth() > 1) {
    navigateBack({
      delta: 1,
      fail: () => wx.switchTab({ url: OWNER_HOME_URL }),
    });
    return;
  }
  wx.switchTab({ url: OWNER_HOME_URL });
}

export function backOrRentalHome(delta = 1): void {
  if (stackDepth() > delta) {
    navigateBack({
      delta,
      fail: () => wx.redirectTo({ url: RENTAL_HOME_URL }),
    });
    return;
  }
  wx.redirectTo({ url: RENTAL_HOME_URL });
}
