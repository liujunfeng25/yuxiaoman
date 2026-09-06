type SummaryComponentInstance = {
  triggerEvent(name: string, detail?: Record<string, unknown>): void;
};

declare function Component(options: Record<string, unknown> & ThisType<SummaryComponentInstance>): void;

Component({
  properties: {
    title: { type: String, value: "履约督办" },
    actionText: { type: String, value: "查看待办" },
    openCount: { type: Number, value: 0 },
    dueSoonCount: { type: Number, value: 0 },
    overdueCount: { type: Number, value: 0 },
    nextDueLabel: { type: String, value: "" },
    loading: { type: Boolean, value: false },
  },
  methods: {
    open() {
      this.triggerEvent("open");
    },
  },
});
