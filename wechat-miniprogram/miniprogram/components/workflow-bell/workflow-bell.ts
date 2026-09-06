type BellComponentInstance = {
  triggerEvent(name: string, detail?: Record<string, unknown>): void;
};

declare function Component(options: Record<string, unknown> & ThisType<BellComponentInstance>): void;

Component({
  properties: {
    unreadCount: { type: Number, value: 0 },
    compact: { type: Boolean, value: false },
  },
  methods: {
    open() {
      this.triggerEvent("open");
    },
  },
});
