import {
  charsToSlots,
  isPlateSlotsComplete,
  keyboardKeysForFocus,
  slotsToValue,
} from "../../utils/plate-keyboard-layout";

type PlateKeyboardInstance = {
  data: {
    slots: string[];
    focusIndex: number;
    keyboardOpen: boolean;
    keys: string[];
    keyRows: string[][];
  };
  properties: {
    plateKind: string;
    slotCount: number;
    value: string;
    disabled: boolean;
  };
  setData(data: Record<string, unknown>, callback?: () => void): void;
  triggerEvent(name: string, detail?: Record<string, unknown>): void;
  syncFromValue(value: string, slotCount: number): void;
  emitChange(): void;
  refreshKeys(focusIndex: number): void;
};

declare function Component(options: Record<string, unknown> & ThisType<PlateKeyboardInstance>): void;

function chunkKeys(keys: string[], size: number): string[][] {
  const rows: string[][] = [];
  for (let index = 0; index < keys.length; index += size) {
    rows.push(keys.slice(index, index + size));
  }
  return rows;
}

Component({
  properties: {
    plateKind: { type: String, value: "blue" },
    slotCount: { type: Number, value: 7 },
    value: { type: String, value: "" },
    disabled: { type: Boolean, value: false },
  },
  data: {
    slots: ["", "", "", "", "", "", ""],
    focusIndex: 0,
    keyboardOpen: false,
    keys: [] as string[],
    keyRows: [] as string[][],
  },
  observers: {
    "value, slotCount"(value: string, slotCount: number) {
      this.syncFromValue(value || "", Number(slotCount) || 7);
    },
    disabled(disabled: boolean) {
      if (disabled && this.data.keyboardOpen) {
        this.setData({ keyboardOpen: false });
      }
    },
  },
  lifetimes: {
    attached(this: PlateKeyboardInstance) {
      this.syncFromValue(this.properties.value || "", Number(this.properties.slotCount) || 7);
    },
  },
  methods: {
    syncFromValue(value: string, slotCount: number) {
      const slots = charsToSlots(value, slotCount);
      const filled = slots.findIndex((char) => !char);
      const focusIndex = filled === -1 ? Math.max(0, slotCount - 1) : filled;
      const keys = keyboardKeysForFocus(focusIndex);
      this.setData({
        slots,
        focusIndex,
        keys,
        keyRows: chunkKeys(keys, focusIndex <= 0 ? 9 : 10),
      });
    },
    refreshKeys(focusIndex: number) {
      const keys = keyboardKeysForFocus(focusIndex);
      this.setData({
        focusIndex,
        keys,
        keyRows: chunkKeys(keys, focusIndex <= 0 ? 9 : 10),
      });
    },
    emitChange() {
      const value = slotsToValue(this.data.slots);
      const complete = isPlateSlotsComplete(value, this.data.slots.length);
      this.triggerEvent("change", { value, complete });
      if (complete) this.triggerEvent("complete", { value });
    },
    openKeyboard() {
      if (this.properties.disabled) return;
      this.refreshKeys(this.data.focusIndex);
      this.setData({ keyboardOpen: true });
    },
    closeKeyboard() {
      this.setData({ keyboardOpen: false });
    },
    tapCell(event: any) {
      if (this.properties.disabled) return;
      const focusIndex = Number(event.currentTarget.dataset.index);
      if (!Number.isInteger(focusIndex) || focusIndex < 0 || focusIndex >= this.data.slots.length) return;
      this.refreshKeys(focusIndex);
      this.setData({ keyboardOpen: true });
    },
    tapKey(event: any) {
      if (this.properties.disabled) return;
      const char = String(event.currentTarget.dataset.key || "");
      if (!char) return;
      const slots = [...this.data.slots];
      const focusIndex = this.data.focusIndex;
      slots[focusIndex] = char;
      const nextFocus = Math.min(focusIndex + 1, slots.length - 1);
      this.setData({ slots }, () => {
        this.refreshKeys(nextFocus);
        this.emitChange();
      });
    },
    tapDelete() {
      if (this.properties.disabled) return;
      const slots = [...this.data.slots];
      let focusIndex = this.data.focusIndex;
      if (slots[focusIndex]) {
        slots[focusIndex] = "";
      } else if (focusIndex > 0) {
        focusIndex -= 1;
        slots[focusIndex] = "";
      }
      this.setData({ slots }, () => {
        this.refreshKeys(focusIndex);
        this.emitChange();
      });
    },
    noop() {},
  },
});
