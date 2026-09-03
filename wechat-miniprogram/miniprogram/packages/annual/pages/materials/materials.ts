type Material = { id: string; name: string; copy: string; done: boolean };
type Data = { materials: Material[] };
Page<Data>({
  data: { materials: [
    { id: "license", name: "机动车行驶证", copy: "正副页完整、信息清晰", done: false },
    { id: "insurance", name: "有效期内交强险", copy: "可携带电子保单作为演示", done: false },
    { id: "identity", name: "车主身份证明", copy: "代办人同时携带本人证件", done: false },
    { id: "triangle", name: "三角警示牌", copy: "到站前请放置在车内", done: false },
  ] },
  toggle(event) { const id = event.currentTarget.dataset.id as string; this.setData({ materials: this.data.materials.map((item) => item.id === id ? { ...item, done: !item.done } : item) }); },
  book() { wx.navigateTo({ url: "/packages/annual/pages/service-mode/service-mode" }); },
});
