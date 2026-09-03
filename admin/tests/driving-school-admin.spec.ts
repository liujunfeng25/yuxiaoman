import { expect, test, type Page, type Route } from "@playwright/test";

type Trace = {
  schoolQueries: Array<Record<string, string>>;
  schoolCreate?: Record<string, unknown>;
  schoolPatch?: Record<string, unknown>;
  schoolDelete?: string;
  imageCreate?: Record<string, unknown>;
  trainingCreate?: Record<string, unknown>;
  offerCreate?: Record<string, unknown>;
  offerPatch?: Record<string, unknown>;
  offerDelete?: string;
  inquiryQueries: Array<Record<string, string>>;
  inquiryReads: string[];
  inquiryPatch?: Record<string, unknown>;
};

const image = { id: "image-a", url: "https://example.test/school-a.jpg", caption: "训练场", isCover: true, sortOrder: 0 };
const trainingClass = { licenseClassCode: "C1", name: "小型汽车", supportedModes: ["initial", "upgrade"], applicationModes: ["initial", "upgrade"], trainingCapabilityNote: "独立训练场", catalogConditions: ["符合公安部申领条件"], schoolConditions: [], conditions: ["符合公安部申领条件"], status: "active", updatedAt: "2026-08-22T09:00:00.000Z" };
const offerA = { id: "offer-a", licenseClassCode: "C1", name: "C1 基础培训", priceType: "fixed", minPriceFen: 328800, maxPriceFen: 328800, applicationModes: ["initial"], unit: "人/期", includedItems: ["基础训练"], excludedItems: ["补考费"], description: "公开报价", validFrom: "2026-08-01", validUntil: "2026-12-31", status: "active", sortOrder: 0, updatedAt: "2026-08-22T09:00:00.000Z" };

function school(id: string, name: string, dataKind: "demo" | "real" = "demo") {
  const location = { poiId: `poi-${id}`, title: name, address: "天津市南开区示范路 1 号", district: "南开区", latitude: 39.12, longitude: 117.18, source: dataKind === "demo" ? "demo" : "tencent" };
  return {
    id,
    name,
    legalName: dataKind === "real" ? `${name}有限公司` : null,
    description: "驾校公开简介",
    dataKind,
    isDemo: dataKind === "demo",
    district: location.district,
    address: location.address,
    location,
    publicPhone: "022-88886666",
    internalContact: { name: "内部负责人", phone: "13900009999" },
    coverImage: image,
    images: [image],
    trainingClasses: [trainingClass],
    offers: id === "school-a" ? [offerA] : [],
    startingPriceFen: id === "school-a" ? 328800 : null,
    tags: [dataKind === "demo" ? "演示数据" : "已核验"],
    facilities: ["训练场", "休息区"],
    openHours: "08:00-18:00",
    regulatory: { type: "filing", number: dataKind === "demo" ? "DEMO-001" : "TJ-2026-001", authority: "天津市交通运输主管部门", sourceUrl: dataKind === "demo" ? null : "https://example.test/regulatory", sourceLabel: dataKind === "demo" ? "演示备案资料" : "主管部门公开信息", validFrom: "2026-01-01", validUntil: "2027-12-31", verifiedAt: dataKind === "demo" ? null : "2026-08-01T00:00:00.000Z", status: dataKind === "demo" ? "demo" : "verified", capabilityLevel: "level_3" },
    isActive: true,
    isPublished: id === "school-a",
    publishedAt: id === "school-a" ? "2026-08-20T09:00:00.000Z" : null,
    inquiryAvailable: true,
    sortPriority: 0,
    updatedAt: "2026-08-22T09:00:00.000Z",
    offerUpdatedAt: "2026-08-22T09:00:00.000Z",
  };
}

async function installDrivingSchoolMock(page: Page, delays: { schoolAOffers?: number } = {}) {
  const trace: Trace = { schoolQueries: [], inquiryQueries: [], inquiryReads: [] };
  let schools = [school("school-a", "海河演示驾校"), school("school-b", "津门真实驾校", "real")];
  let offers: Record<string, Array<Record<string, unknown>>> = { "school-a": [offerA], "school-b": [{ ...offerA, id: "offer-b", name: "B 校专属报价", minPriceFen: 298800, maxPriceFen: 298800 }] };
  let inquiries = [
    { id: "inquiry-1", inquiryCode: "DS202608220001", status: "new", school: { id: "school-a", name: "海河演示驾校" }, licenseClassCode: "C1", applicationMode: "initial", contactNameMasked: "李**", maskedPhone: "138****1111", contactWindow: "evening", internalNote: null, isSynthetic: false, submittedAt: "2026-08-22T10:00:00.000Z", updatedAt: "2026-08-22T10:00:00.000Z" },
    { id: "inquiry-2", inquiryCode: "DS202608220002", status: "withdrawn", school: { id: "school-b", name: "津门真实驾校" }, licenseClassCode: "C6", applicationMode: "upgrade", contactNameMasked: "王**", maskedPhone: "139****2222", contactWindow: "afternoon", internalNote: "用户已撤回", isSynthetic: false, submittedAt: "2026-08-21T10:00:00.000Z", updatedAt: "2026-08-22T11:00:00.000Z" },
  ];
  const detailFor = (id: string) => ({
    ...inquiries.find((item) => item.id === id)!,
    contact: id === "inquiry-1" ? { name: "李明", phone: "13800001111", message: "想了解周末班" } : { name: "王丽", phone: "13900002222", message: "" },
    disclosure: { recipientName: "驭小满驾校服务团队" },
    events: [{ id: "event-1", action: "sensitive_detail_read", actorType: "admin", detail: {}, createdAt: "2026-08-22T10:05:00.000Z" }],
  });
  const fulfill = (route: Route, data: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ data }) });
  const list = <T>(items: T[]) => ({ items, pagination: { page: 1, pageSize: 100, total: items.length } });
  const previewFor = (id: string) => {
    const source = schools.find((item) => item.id === id)!;
    const { internalContact: _internalContact, ...publicSchool } = source;
    const publicOffers = (offers[id] || []).filter((item) => item.status === "active");
    const numericOffers = publicOffers.filter((item) => item.priceType !== "inquiry" && typeof item.minPriceFen === "number");
    const startingPriceFen = numericOffers.length ? Math.min(...numericOffers.map((item) => Number(item.minPriceFen))) : null;
    const summary = { ...publicSchool, offers: undefined, startingPriceFen };
    const detail = { ...publicSchool, offers: publicOffers, startingPriceFen };
    return {
      savedAt: source.updatedAt,
      revision: `rev-${id}-${publicOffers.length}`,
      summary,
      detail,
      visibility: { listVisible: Boolean(source.isPublished), detailVisible: Boolean(source.isPublished), inquiryAvailable: Boolean(source.isPublished && source.inquiryAvailable), reasons: source.isPublished ? [] : ["学校尚未发布"] },
      checklist: [
        { key: "active", label: "学校记录已启用", status: source.isActive ? "pass" : "fail", section: "base", message: source.isActive ? "可参与公开目录" : "请启用学校记录" },
        { key: "phone", label: "公开电话", status: source.publicPhone ? "pass" : "fail", section: "base", message: source.publicPhone ? "小程序可主动拨号" : "请补充公开电话" },
        { key: "cover", label: "列表封面", status: source.coverImage ? "pass" : "fail", section: "media", message: source.coverImage ? "封面已配置" : "请配置封面" },
        { key: "offer", label: "匹配的启用报价", status: publicOffers.length ? "pass" : "fail", section: "offers", message: publicOffers.length ? "报价可公开" : "请启用至少一项报价" },
      ],
      offerMappings: (offers[id] || []).map((item) => ({ offerId: item.id, listMinimumCandidate: item.status === "active" && item.priceType !== "inquiry", detailVisible: item.status === "active", inquirySelectable: item.status === "active", reasons: item.status === "active" ? [] : ["报价已停用"] })),
      testPaths: { list: `/packages/driving-school/pages/list/index?schoolId=${id}`, detail: `/packages/driving-school/pages/detail/index?id=${id}`, inquiry: `/packages/driving-school/pages/inquiry/index?schoolId=${id}` },
    };
  };

  await page.route("**/api/backoffice/session", (route) => fulfill(route, { account: { id: "test-platform-admin", displayName: "测试平台管理员", role: "platform_admin" }, subject: null, capabilities: ["platform.admin"], expiresAt: "2027-01-01T00:00:00.000Z" }));
  await page.route("**/api/admin/stations", (route) => fulfill(route, []));
  await page.route("**/api/admin/inspection-price-plans", (route) => fulfill(route, []));
  await page.route("**/api/locations/suggestions**", (route) => fulfill(route, [{ poiId: "poi-new", title: "新建驾校位置", address: "天津市河西区友谊路 10 号", district: "河西区", latitude: 39.09, longitude: 117.2, source: "demo", locationProof: "signed-location-proof" }]));

  await page.route("**/api/admin/driving-school-inquiries**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace("/api/admin/driving-school-inquiries", "");
    if (!path && request.method() === "GET") {
      trace.inquiryQueries.push(Object.fromEntries(url.searchParams.entries()));
      let result = inquiries;
      const status = url.searchParams.get("status");
      const schoolId = url.searchParams.get("schoolId");
      const code = url.searchParams.get("licenseClassCode");
      if (status) result = result.filter((item) => item.status === status);
      if (schoolId) result = result.filter((item) => item.school.id === schoolId);
      if (code) result = result.filter((item) => item.licenseClassCode === code);
      return fulfill(route, list(result));
    }
    const id = path.slice(1);
    if (id && request.method() === "GET") { trace.inquiryReads.push(id); return fulfill(route, detailFor(id)); }
    if (id && request.method() === "PATCH") {
      trace.inquiryPatch = request.postDataJSON() as Record<string, unknown>;
      inquiries = inquiries.map((item) => item.id === id ? { ...item, ...trace.inquiryPatch, updatedAt: "2026-08-22T12:00:00.000Z" } as typeof item : item);
      return fulfill(route, inquiries.find((item) => item.id === id));
    }
    return fulfill(route, { message: `Unhandled inquiry mock ${request.method()} ${path}` }, 404);
  });

  await page.route("**/api/admin/driving-schools**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace("/api/admin/driving-schools", "");
    const parts = path.split("/").filter(Boolean);
    const id = parts[0];
    const relation = parts[1];
    const relationId = parts[2];
    const method = request.method();
    if (!path && method === "GET") {
      trace.schoolQueries.push(Object.fromEntries(url.searchParams.entries()));
      let result = schools;
      const q = url.searchParams.get("q")?.toLowerCase();
      const dataKind = url.searchParams.get("dataKind");
      const status = url.searchParams.get("status");
      if (q) result = result.filter((item) => `${item.name}${item.legalName || ""}${item.address}`.toLowerCase().includes(q));
      if (dataKind) result = result.filter((item) => item.dataKind === dataKind);
      if (status) result = result.filter((item) => (status === "published") === Boolean(item.isPublished));
      return fulfill(route, list(result));
    }
    if (!path && method === "POST") {
      trace.schoolCreate = request.postDataJSON() as Record<string, unknown>;
      const body = trace.schoolCreate;
      const created = { ...school("school-new", String(body.name || "新驾校")), ...body, id: "school-new", district: (body.location as { district: string }).district, address: (body.location as { address: string }).address, trainingClasses: [], images: [], offers: [], coverImage: null, isPublished: false, publishedAt: null };
      schools = [...schools, created as ReturnType<typeof school>];
      return fulfill(route, created, 201);
    }
    if (id && !relation && method === "GET") return fulfill(route, schools.find((item) => item.id === id));
    if (id && !relation && method === "PATCH") {
      trace.schoolPatch = request.postDataJSON() as Record<string, unknown>;
      schools = schools.map((item) => item.id === id ? { ...item, ...trace.schoolPatch } as typeof item : item);
      return fulfill(route, schools.find((item) => item.id === id));
    }
    if (id && !relation && method === "DELETE") { trace.schoolDelete = id; schools = schools.filter((item) => item.id !== id); return route.fulfill({ status: 204, body: "" }); }
    if (id && relation === "publish" && method === "POST") { schools = schools.map((item) => item.id === id ? { ...item, isPublished: true, publishedAt: "2026-08-23T08:00:00.000Z" } : item); return fulfill(route, schools.find((item) => item.id === id)); }
    if (id && relation === "unpublish" && method === "POST") { schools = schools.map((item) => item.id === id ? { ...item, isPublished: false, publishedAt: null } : item); return fulfill(route, schools.find((item) => item.id === id)); }
    if (id && relation === "preview" && method === "GET") return fulfill(route, previewFor(id));
    if (id && relation === "images" && !relationId && method === "GET") return fulfill(route, { items: schools.find((item) => item.id === id)?.images || [] });
    if (id && relation === "images" && !relationId && method === "POST") { trace.imageCreate = request.postDataJSON() as Record<string, unknown>; return fulfill(route, { id: "image-new", ...trace.imageCreate }, 201); }
    if (id && relation === "images" && relationId && method === "PATCH") return fulfill(route, { id: relationId, ...request.postDataJSON() });
    if (id && relation === "images" && relationId && method === "DELETE") return route.fulfill({ status: 204, body: "" });
    if (id && relation === "training-classes" && !relationId && method === "GET") return fulfill(route, { items: schools.find((item) => item.id === id)?.trainingClasses || [] });
    if (id && relation === "training-classes" && !relationId && method === "POST") { trace.trainingCreate = request.postDataJSON() as Record<string, unknown>; return fulfill(route, { ...trainingClass, ...trace.trainingCreate }, 201); }
    if (id && relation === "training-classes" && relationId && method === "PATCH") return fulfill(route, { ...trainingClass, licenseClassCode: relationId, ...request.postDataJSON() });
    if (id && relation === "training-classes" && relationId && method === "DELETE") return route.fulfill({ status: 204, body: "" });
    if (id && relation === "offers" && !relationId && method === "GET") { if (id === "school-a" && delays.schoolAOffers) await new Promise((resolve) => setTimeout(resolve, delays.schoolAOffers)); return fulfill(route, { items: offers[id] || [] }); }
    if (id && relation === "offers" && !relationId && method === "POST") { trace.offerCreate = request.postDataJSON() as Record<string, unknown>; const created = { id: "offer-new", ...trace.offerCreate, updatedAt: "2026-08-23T08:00:00.000Z" }; offers[id] = [...(offers[id] || []), created]; return fulfill(route, created, 201); }
    if (id && relation === "offers" && relationId && method === "PATCH") { trace.offerPatch = request.postDataJSON() as Record<string, unknown>; offers[id] = (offers[id] || []).map((item) => item.id === relationId ? { ...item, ...trace.offerPatch } : item); return fulfill(route, offers[id].find((item) => item.id === relationId)); }
    if (id && relation === "offers" && relationId && method === "DELETE") { trace.offerDelete = relationId; offers[id] = (offers[id] || []).filter((item) => item.id !== relationId); return route.fulfill({ status: 204, body: "" }); }
    return fulfill(route, { message: `Unhandled school mock ${method} ${path}` }, 404);
  });
  return trace;
}

async function openDrivingSchoolAdmin(page: Page) {
  await page.goto("/driving-schools");
  await expect(page.getByRole("heading", { name: "驾校服务资料、报价与咨询" })).toBeVisible();
}

test("驾校列表作为唯一资料入口，签名位置新增形成闭环", async ({ page }) => {
  const trace = await installDrivingSchoolMock(page);
  await page.setViewportSize({ width: 1440, height: 920 });
  await openDrivingSchoolAdmin(page);

  await expect(page.getByLabel("运营密码")).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "驾校列表" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab", { name: "服务报价" })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "咨询线索" })).toBeVisible();
  await expect(page.getByRole("button", { name: "管理报价 海河演示驾校" })).toBeVisible();
  await expect(page.getByText("¥3288.00 起")).toBeVisible();
  await expect(page.getByText("13900009999")).not.toBeVisible();

  await page.getByLabel("搜索驾校").fill("津门");
  await page.getByLabel("按数据类型筛选驾校").selectOption("real");
  await page.getByLabel("按发布状态筛选驾校").selectOption("draft");
  await page.getByRole("button", { name: "应用筛选" }).click();
  await expect.poll(() => trace.schoolQueries.at(-1)).toMatchObject({ q: "津门", dataKind: "real", status: "draft" });

  await page.getByRole("button", { name: "清空" }).click();
  await page.getByRole("button", { name: "新增驾校" }).click();
  const drawer = page.getByLabel("新增驾校资料");
  await drawer.getByLabel("驾校展示名称").fill("新建演示驾校");
  await drawer.getByLabel("搜索驾校位置").fill("友谊路");
  await drawer.getByRole("option", { name: /新建驾校位置/ }).click();
  await drawer.getByRole("button", { name: "保存驾校资料" }).click();
  await expect.poll(() => trace.schoolCreate?.name).toBe("新建演示驾校");
  expect((trace.schoolCreate?.location as { locationProof?: string }).locationProof).toBe("signed-location-proof");
  expect((trace.schoolCreate?.inquiryRecipient as { recipientName?: string; purpose?: string }).recipientName).toBe("驭小满驾校服务团队");
  expect((trace.schoolCreate?.inquiryRecipient as { purpose?: string }).purpose).toContain("不向驾校或其他第三方转交");
  const savedDrawer = page.getByLabel("编辑驾校资料");
  await expect(savedDrawer.getByText("资料已保存")).toBeVisible();
  await savedDrawer.getByRole("button", { name: "添加车型" }).click();
  await expect.poll(() => trace.trainingCreate?.licenseClassCode).toBe("C1");
  expect(trace.trainingCreate?.applicationModes).toEqual(["initial"]);
  await savedDrawer.getByLabel("驾校图片地址").fill("https://example.test/new-school.jpg");
  await savedDrawer.getByLabel("驾校图片说明").fill("新训练场");
  await savedDrawer.getByLabel("设为驾校封面").check();
  await savedDrawer.getByRole("button", { name: "添加图片" }).click();
  await expect.poll(() => trace.imageCreate?.url).toBe("https://example.test/new-school.jpg");
  expect(trace.imageCreate?.caption).toBe("新训练场");
  await savedDrawer.getByLabel("驾校公开联系电话").fill("022-77776666");
  await savedDrawer.getByRole("button", { name: "保存驾校资料" }).click();
  await expect.poll(() => trace.schoolPatch?.publicPhone).toBe("022-77776666");
  await savedDrawer.getByRole("button", { name: "关闭编辑驾校资料" }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByLabel("更多操作 新建演示驾校").click();
  await page.getByRole("button", { name: "删除驾校 新建演示驾校" }).click();
  await expect.poll(() => trace.schoolDelete).toBe("school-new");
});

test("单校工作台两次点击内进入分组报价，元输入并显示公开位置", async ({ page }) => {
  const trace = await installDrivingSchoolMock(page, { schoolAOffers: 350 });
  await page.setViewportSize({ width: 1440, height: 900 });
  await openDrivingSchoolAdmin(page);
  await page.getByRole("button", { name: "管理报价 津门真实驾校" }).click();
  await expect(page.getByRole("heading", { name: "津门真实驾校" })).toBeVisible();
  await expect(page).toHaveURL(/schoolId=school-b&section=offers/);
  await expect(page.getByLabel("驾校配置工作台 津门真实驾校")).toBeVisible();
  await expect(page.getByText("B 校专属报价")).toBeVisible();
  await expect(page.getByText("C1 基础培训", { exact: true })).not.toBeVisible();
  await expect(page.getByText("列表最低价候选")).toBeVisible();
  await expect(page.getByText("详情展示", { exact: true })).toBeVisible();
  await expect(page.getByText("咨询可选", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "新增 C1 报价" }).click();
  const drawer = page.getByLabel("新增服务报价");
  await expect(drawer.getByLabel("报价准驾车型")).toHaveValue("C1 · 小型汽车");
  await drawer.getByLabel("报价项目名称").fill("C1 周末培训");
  await drawer.getByLabel("报价最低金额元").fill("2888.88");
  await drawer.getByLabel("报价包含项目").fill("基础训练，周末班");
  await drawer.getByRole("button", { name: "保存报价" }).click();
  await expect.poll(() => trace.offerCreate?.name).toBe("C1 周末培训");
  expect(trace.offerCreate?.minPriceFen).toBe(288888);
  expect(trace.offerCreate?.maxPriceFen).toBe(288888);
  expect(trace.offerCreate?.status).toBe("active");
  await expect(page.getByText("C1 周末培训")).toBeVisible();

  await page.getByRole("button", { name: "编辑报价 C1 周末培训" }).click();
  const editDrawer = page.getByLabel("编辑服务报价");
  await editDrawer.getByLabel("报价状态").selectOption("inactive");
  await editDrawer.getByRole("button", { name: "保存报价" }).click();
  await expect.poll(() => trace.offerPatch?.status).toBe("inactive");
  await expect(page.getByText("报价已停用")).toBeVisible();
  await expect(page.getByText("C1 周末培训")).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "删除报价 C1 周末培训" }).click();
  await expect.poll(() => trace.offerDelete).toBe("offer-new");

  await page.getByRole("button", { name: /预览与发布/ }).click();
  await expect(page).toHaveURL(/schoolId=school-b&section=preview/);
  await expect(page.getByLabel("小程序列表卡片预览")).toContainText("津门真实驾校");
  await expect(page.getByLabel("小程序详情报价预览")).toContainText("B 校专属报价");
  await expect(page.getByLabel("发布检查表")).toContainText("列表可见");

  await page.setViewportSize({ width: 1024, height: 768 });
  const fitsNarrowDesktop = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
  expect(fitsNarrowDesktop).toBe(true);
});

test("预览严格使用已保存版本，保存后刷新且深链可恢复", async ({ page }) => {
  const trace = await installDrivingSchoolMock(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openDrivingSchoolAdmin(page);
  await page.getByRole("button", { name: "配置与预览 海河演示驾校" }).click();
  await page.getByLabel("驾校展示名称").fill("未保存的新名称");
  await expect(page.getByText("当前有未保存修改", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /预览与发布/ }).click();
  await expect(page.getByLabel("小程序列表卡片预览")).toContainText("海河演示驾校");
  await expect(page.getByLabel("小程序列表卡片预览")).not.toContainText("未保存的新名称");
  await expect(page.getByLabel("发布检查表").getByRole("button", { name: /已保存版本/ })).toBeDisabled();

  await page.getByRole("button", { name: /基础资料/ }).click();
  await page.getByRole("button", { name: "保存资料" }).click();
  await expect.poll(() => trace.schoolPatch?.name).toBe("未保存的新名称");
  await expect(page.getByText("资料已保存，预览已刷新")).toBeVisible();
  await page.getByRole("button", { name: /预览与发布/ }).click();
  await expect(page.getByLabel("小程序列表卡片预览")).toContainText("未保存的新名称");

  await page.reload();
  await expect(page.getByLabel("驾校配置工作台 未保存的新名称")).toBeVisible();
  await expect(page).toHaveURL(/schoolId=school-a&section=preview/);
});

test("仅修改营业时间不会覆盖咨询披露配置", async ({ page }) => {
  const trace = await installDrivingSchoolMock(page);
  await openDrivingSchoolAdmin(page);
  await page.getByRole("button", { name: "配置与预览 海河演示驾校" }).click();
  await page.getByRole("button", { name: /图库与营业/ }).click();
  await page.getByLabel("驾校营业时间").fill("周一至周日 07:30-19:00");
  await page.getByRole("button", { name: "保存资料" }).click();
  await expect.poll(() => trace.schoolPatch?.openHours).toBe("周一至周日 07:30-19:00");
  expect(trace.schoolPatch).not.toHaveProperty("inquiryRecipient");
});

test("咨询默认脱敏，显式读取留痕、日期筛选、状态备注与撤回锁定", async ({ page }) => {
  const trace = await installDrivingSchoolMock(page);
  await page.setViewportSize({ width: 1360, height: 900 });
  await openDrivingSchoolAdmin(page);
  await page.getByRole("tab", { name: "咨询线索" }).click();

  await expect(page.getByText("138****1111")).toBeVisible();
  await expect(page.getByText("13800001111")).not.toBeVisible();
  await expect(page.getByText("个人资料不转交、不导出")).toBeVisible();
  await page.getByLabel("咨询开始日期").fill("2026-08-20");
  await page.getByLabel("咨询结束日期").fill("2026-08-23");
  await page.getByLabel("按咨询状态筛选").selectOption("new");
  await page.getByRole("button", { name: "应用筛选" }).click();
  await expect.poll(() => trace.inquiryQueries.at(-1)).toMatchObject({ status: "new", dateFrom: "2026-08-20", dateTo: "2026-08-23" });

  await page.getByRole("button", { name: "查看敏感详情 DS202608220001" }).click();
  const detail = page.getByLabel("咨询敏感详情");
  await expect(detail.getByTestId("sensitive-contact-phone")).toHaveText("13800001111");
  await expect(detail.getByTestId("fixed-inquiry-recipient")).toHaveText("驭小满驾校服务团队");
  expect(trace.inquiryReads).toContain("inquiry-1");
  await detail.getByLabel("咨询处理状态").selectOption("contacting");
  await detail.getByLabel("咨询联系备注").fill("已由平台内部电话联系，等待回复");
  await detail.getByRole("button", { name: "保存跟进" }).click();
  await expect.poll(() => trace.inquiryPatch).toMatchObject({ status: "contacting", internalNote: "已由平台内部电话联系，等待回复" });
  await detail.getByRole("button", { name: "关闭咨询敏感详情" }).click();

  await page.getByRole("button", { name: "清空" }).click();
  await page.getByRole("button", { name: "查看撤回记录 DS202608220002" }).click();
  const withdrawn = page.getByLabel("咨询撤回记录");
  await expect(withdrawn.getByText("用户已撤回咨询")).toBeVisible();
  await expect(withdrawn.getByText("联系方式已在撤回时清除")).toBeVisible();
  await expect(withdrawn.getByTestId("sensitive-contact-phone")).toHaveCount(0);
  await expect(withdrawn.getByRole("button", { name: "保存跟进" })).toBeDisabled();
  await expect(withdrawn.getByLabel("咨询联系备注")).toBeDisabled();
  await expect(withdrawn.getByRole("button", { name: /转交|导出/ })).toHaveCount(0);
});
