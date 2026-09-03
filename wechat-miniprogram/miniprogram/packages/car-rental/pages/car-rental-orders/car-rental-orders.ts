import { api } from "../../../../services/api";
import type { CarRentalOrder } from "../../../../types";
import { dateTimeLabel, fen, rentalStatus } from "../../utils/rental";

type OrderItem = CarRentalOrder & { statusLabel: string; statusTone: string; pickupLabel: string; totalLabel: string; placeLabel: string };
type Data = { orders: OrderItem[]; loading: boolean; error: string };

function orderItem(order: CarRentalOrder): OrderItem {
  const status = rentalStatus(order.status);
  return {
    ...order,
    statusLabel: status.label,
    statusTone: status.tone,
    pickupLabel: dateTimeLabel(order.pickupAt),
    totalLabel: fen(order.quote.breakdown.prepaidTotalFen),
    placeLabel: order.fulfillmentMode === "home_delivery" ? order.deliveryAddress?.title || "同址送取" : order.store.name,
  };
}

Page<Data>({
  data: { orders: [], loading: true, error: "" },
  onShow() { void this.load(); },
  onPullDownRefresh() { void this.load(true); },
  async load(fromPullDown = false) {
    this.setData({ loading: true, error: "" });
    try {
      const orders = (await api.carRentalOrders()).map(orderItem).sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
      this.setData({ orders });
    } catch (error) {
      this.setData({ error: error instanceof Error ? error.message : "租车订单暂时无法读取", orders: [] });
    } finally {
      this.setData({ loading: false });
      if (fromPullDown) wx.stopPullDownRefresh();
    }
  },
  openOrder(event) {
    const id = String(event.currentTarget.dataset.id || "");
    if (id) wx.navigateTo({ url: `/packages/car-rental/pages/car-rental-order-detail/car-rental-order-detail?id=${encodeURIComponent(id)}` });
  },
  modelImageError(event) {
    const index = Number(event.currentTarget.dataset.index || 0);
    if (this.data.orders[index]?.model.imageUrl !== "/assets/brand/hero-car-generic.png") {
      this.setData({ [`orders[${index}].model.imageUrl`]: "/assets/brand/hero-car-generic.png" } as unknown as Partial<Data>);
    }
  },
  goRent() { wx.redirectTo({ url: "/packages/car-rental/pages/car-rental-home/car-rental-home" }); },
  retry() { void this.load(); },
});
