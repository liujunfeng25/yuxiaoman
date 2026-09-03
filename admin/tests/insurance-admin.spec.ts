import { expect, test, type Page, type Route } from "@playwright/test";

type InsuranceTrace = {
  listStatuses: string[];
  handoffBody?: Record<string, unknown>;
  closeBody?: Record<string, unknown>;
  mediaReads: number;
};

async function installInsuranceApiMock(page: Page) {
  const trace: InsuranceTrace = { listStatuses: [], mediaReads: 0 };
  const partner = {
    id: "partner-demo-haihe",
    name: "海河演示保险服务中心",
    recipientName: "海河演示保险服务中心运营组",
    active: true,
    isDefault: true,
  };
  const disclosureResponse = {
    mode: "demo",
    activePartnerId: partner.id,
    partners: [partner],
    disclosure: {
      acceptsRealData: false,
      version: "demo-v1.0",
      partnerName: partner.name,
      dataScope: ["联系人", "联系电话", "车辆信息", "行驶证影像"],
      purpose: "仅用于本次续保对接与联系",
      retention: "线索关闭后 30 日内删除",
      consentText: `我同意驭小满将上述资料提供给${partner.name}，仅用于本次续保对接。`,
      contactEtaText: "工作时段内 30 分钟响应",
    },
  };
  let detail = {
    id: "insurance-lead-1",
    leadCode: "INS202608160001",
    status: "new",
    source: "web-owner-services",
    vehicle: { id: "vehicle-1", plateNumber: "津A·X1234", modelName: "2024 款示例新能源轿车" },
    contactNameMasked: "李先生",
    maskedPhone: "138****1111",
    renewalWindow: "within_30_days",
    contactWindow: "evening",
    partnerName: null as string | null,
    submittedAt: "2026-08-16T10:20:00.000Z",
    handedOffAt: null as string | null,
    closedAt: null as string | null,
    contact: { name: "李明", phone: "13800001111" },
    disclosure: {
      version: "demo-v1.0",
      partnerName: partner.name,
      dataScope: ["联系人", "联系电话", "车辆信息", "行驶证影像"],
      purpose: "仅用于本次续保对接与联系",
      retention: "线索关闭后 30 日内删除",
      consentText: `我同意驭小满将上述资料提供给${partner.name}，仅用于本次续保对接。`,
      acceptedAt: "2026-08-16T10:19:50.000Z",
    },
    media: {
      available: true,
      filename: "driving-license-demo.png",
      mimeType: "image/png",
      sizeBytes: 68,
      deleteAfter: "2026-09-15T10:20:00.000Z",
    },
    events: [
      { action: "lead_created", actorType: "owner", createdAt: "2026-08-16T10:20:00.000Z" },
      { action: "sensitive_detail_read", actorType: "admin", createdAt: "2026-08-16T10:21:00.000Z" },
    ],
  };

  const fulfill = (route: Route, data: unknown, status = 200) => route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify({ data }),
  });

  await page.addInitScript(() => {
    const trackedWindow = window as typeof window & {
      __insuranceFetches?: Array<{ url: string; credentials: RequestCredentials | undefined }>;
      __insuranceCopiedText?: string;
    };
    trackedWindow.__insuranceFetches = [];
    trackedWindow.__insuranceCopiedText = "";
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (value: string) => { trackedWindow.__insuranceCopiedText = value; } },
    });
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/api/admin/insurance/")) {
        trackedWindow.__insuranceFetches?.push({ url, credentials: init?.credentials });
      }
      return originalFetch(input, init);
    };
  });

  await page.route("**/api/admin/insurance/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace("/api/admin/insurance", "");
    const method = request.method();

    if (path === "/partners/disclosure" && method === "GET") return fulfill(route, disclosureResponse);
    if (path === "/partners/disclosure" && method === "PUT") return fulfill(route, disclosureResponse);
    if (path === "/leads" && method === "GET") {
      trace.listStatuses.push(url.searchParams.get("status") || "all");
      const item = {
        id: detail.id,
        leadCode: detail.leadCode,
        status: detail.status,
        source: detail.source,
        vehicle: detail.vehicle,
        contactNameMasked: detail.contactNameMasked,
        maskedPhone: detail.maskedPhone,
        renewalWindow: detail.renewalWindow,
        contactWindow: detail.contactWindow,
        partnerName: detail.partnerName,
        submittedAt: detail.submittedAt,
        handedOffAt: detail.handedOffAt,
        closedAt: detail.closedAt,
      };
      const status = url.searchParams.get("status");
      const items = !status || status === detail.status ? [item] : [];
      return fulfill(route, { items, total: items.length, mode: "demo" });
    }
    if (path === `/leads/${detail.id}/media` && method === "GET") {
      trace.mediaReads += 1;
      const onePixelPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
      return route.fulfill({ status: 200, contentType: "image/png", body: onePixelPng });
    }
    if (path === `/leads/${detail.id}/handoff` && method === "POST") {
      trace.handoffBody = request.postDataJSON() as Record<string, unknown>;
      detail = {
        ...detail,
        status: "handed_off",
        partnerName: partner.name,
        handedOffAt: "2026-08-16T11:00:00.000Z",
        events: [...detail.events, { action: "lead_handed_off", actorType: "admin", createdAt: "2026-08-16T11:00:00.000Z" }],
      };
      return fulfill(route, detail);
    }
    if (path === `/leads/${detail.id}/close` && method === "POST") {
      trace.closeBody = request.postDataJSON() as Record<string, unknown>;
      detail = {
        ...detail,
        status: "closed",
        closedAt: "2026-08-16T11:12:00.000Z",
        events: [...detail.events, { action: "lead_closed", actorType: "admin", createdAt: "2026-08-16T11:12:00.000Z" }],
      };
      return fulfill(route, detail);
    }
    if (path === `/leads/${detail.id}` && method === "GET") return fulfill(route, detail);

    return fulfill(route, { error: { message: `Unhandled insurance mock ${method} ${path}` } }, 404);
  });

  return trace;
}

test("车险线索从直接加载、脱敏筛选到敏感资料读取、转交与关闭形成闭环", async ({ page }) => {
  const trace = await installInsuranceApiMock(page);
  await page.setViewportSize({ width: 1440, height: 920 });
  await page.goto("/");

  await page.getByRole("button", { name: "车险线索" }).click();
  await expect(page.getByRole("heading", { name: "车险线索与合规转交" })).toBeVisible();
  await expect(page.getByText("从用户授权到合作方转交，全程可追溯")).toBeVisible();
  await expect(page.getByText("演示模式").first()).toBeVisible();
  await expect(page.getByText("INS202608160001")).toBeVisible();
  await expect(page.getByText("138****1111")).toBeVisible();
  await expect(page.getByText("13800001111")).not.toBeVisible();
  await expect(page.getByRole("table").getByText("30 天内", { exact: true })).toBeVisible();
  await expect(page.getByText("晚上 18:00–21:00")).toBeVisible();
  await expect(page.getByLabel("保险运营密码")).toHaveCount(0);

  await page.getByRole("button", { name: "新线索", exact: true }).click();
  await expect.poll(() => trace.listStatuses.at(-1)).toBe("new");
  await page.getByRole("row", { name: /INS202608160001/ }).click();
  const drawer = page.getByLabel("车险线索详情");
  await expect(drawer.getByText("敏感信息读取已留痕")).toBeVisible();
  await expect(drawer.getByText("13800001111")).toBeVisible();
  await expect(drawer.getByText("已取得本次转交授权")).toBeVisible();
  await expect(drawer.getByText("用户提交续保对接需求")).toBeVisible();
  await expect(drawer.getByLabel("关闭结果")).toHaveCount(0);

  await drawer.getByRole("button", { name: "复制转交摘要" }).click();
  await expect(drawer.getByText("转交摘要已复制")).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __insuranceCopiedText?: string }).__insuranceCopiedText)).toContain("INS202608160001");

  await drawer.getByRole("button", { name: "查看行驶证" }).click();
  await expect(drawer.getByRole("img", { name: "线索行驶证影像" })).toBeVisible();
  expect(trace.mediaReads).toBe(1);

  await drawer.getByLabel("转交合作方").selectOption("partner-demo-haihe");
  await drawer.getByRole("button", { name: "确认已转交" }).click();
  await expect.poll(() => trace.handoffBody?.partnerId).toBe("partner-demo-haihe");
  await expect(drawer.getByText("已转交至 海河演示保险服务中心")).toBeVisible();

  await drawer.getByLabel("关闭结果").selectOption("completed_referral");
  await drawer.getByRole("button", { name: "关闭线索", exact: true }).click();
  await expect.poll(() => trace.closeBody?.result).toBe("completed_referral");
  await expect(drawer.locator(".insurance-action-lock.completed").getByText("线索已关闭", { exact: true })).toBeVisible();

  await drawer.getByRole("button", { name: "关闭线索详情" }).click();
  await expect(page.getByText("从用户授权到合作方转交，全程可追溯")).toBeVisible();

  const calls = await page.evaluate(() => (window as typeof window & { __insuranceFetches?: Array<{ url: string; credentials?: string }> }).__insuranceFetches || []);
  expect(calls.length).toBeGreaterThanOrEqual(7);
  expect(calls.some((call) => call.url.endsWith("/session"))).toBe(false);
  expect(calls.every((call) => call.credentials === undefined)).toBe(true);
});

test("车险披露配置以严格一至八编号驱动三个客户端实时预览态", async ({ page }) => {
  await installInsuranceApiMock(page);
  await page.setViewportSize({ width: 1440, height: 920 });
  await page.goto("/");
  await page.getByRole("button", { name: "车险线索" }).click();

  const disclosureConfig = page.locator("details.insurance-disclosure-config");
  await expect(disclosureConfig).toBeVisible();
  await disclosureConfig.locator(":scope > summary").click();
  await expect(disclosureConfig).toHaveAttribute("open", "");

  const fieldMappings = [
    { number: "1", label: "接收合作方" },
    { number: "2", label: "资料接收主体" },
    { number: "3", label: "授权资料范围" },
    { number: "4", label: "使用目的" },
    { number: "5", label: "保存期限" },
    { number: "6", label: "预计联系时效" },
    { number: "7", label: "用户授权文案" },
  ];
  const configGrid = disclosureConfig.locator(".insurance-config-grid");
  for (const fieldMapping of fieldMappings) {
    const control = configGrid.getByLabel(fieldMapping.label, { exact: true });
    await expect(control).toHaveCount(1);
    const field = control.locator("..");
    await expect(field).toHaveCount(1);
    await expect(field.locator(":scope > span").first()).toHaveText(
      new RegExp(`^\\s*${fieldMapping.number}\\s*${fieldMapping.label}\\s*$`, "u"),
    );
  }

  const disclosureVersion = disclosureConfig.locator(".insurance-config-version");
  await expect(disclosureVersion).toHaveText(/^\s*8\s*披露版本/u);

  const mapping = disclosureConfig.locator("details.insurance-client-impact");
  await expect(mapping).toHaveCount(1);
  await expect(mapping).not.toHaveAttribute("open", "");

  const mappingSummary = mapping.locator(":scope > summary");
  await expect(mappingSummary).toContainText("客户端实时预览");
  await expect(mappingSummary).toContainText("当前已保存");
  await expect(mappingSummary).toContainText("8 项映射");
  await mappingSummary.click();
  await expect(mapping).toHaveAttribute("open", "");

  const previewStates = [
    { state: "disclosure-basic", label: "授权基础信息实时预览", title: "授权基础信息" },
    { state: "disclosure-consent", label: "资料授权确认实时预览", title: "资料授权确认" },
    { state: "receipt", label: "提交成功凭证实时预览", title: "提交成功凭证" },
  ];
  const previewGallery = mapping.locator('.insurance-impact-gallery[aria-label="客户端实时预览"]');
  await expect(previewGallery).toHaveCount(1);
  for (const previewState of previewStates) {
    const preview = previewGallery.locator(`[data-preview-state="${previewState.state}"]`);
    await expect(preview).toHaveCount(1);
    await expect(preview).toHaveAttribute("aria-label", previewState.label);
    await expect(preview).toBeVisible();
    await expect(preview.getByText(previewState.title, { exact: true })).toBeVisible();
  }
  await expect(mapping.locator("img")).toHaveCount(0);

  const legendMappings = [
    ...fieldMappings.map(({ number, label }) => ({ number, label })),
    { number: "8", label: "披露版本" },
  ];
  const legendItems = mapping.locator(".insurance-impact-legend > li");
  await expect(legendItems).toHaveCount(8);
  for (const [index, legendMapping] of legendMappings.entries()) {
    const item = legendItems.nth(index);
    await expect(item.locator(":scope > b")).toHaveText(legendMapping.number);
    await expect(item.locator("strong").first()).toHaveText(legendMapping.label);
  }

  const pins = previewGallery.locator(".insurance-impact-pin");
  await expect(pins).toHaveCount(8);
  expect((await pins.allTextContents()).map((value) => value.trim()).sort()).toEqual(
    legendMappings.map(({ number }) => number).sort(),
  );
  for (const number of legendMappings.map(({ number }) => number)) {
    await expect(previewGallery.locator(`.insurance-impact-pin[data-impact-number="${number}"]`)).toHaveCount(1);
  }
  for (const card of await previewGallery.locator(".insurance-live-preview-card").all()) {
    expect(await card.locator(".insurance-impact-pin").count()).toBeGreaterThan(0);
  }

  const previewFieldNames = {
    partnerName: "partner-name",
    recipientName: "recipient-name",
    dataScope: "data-scope",
    purpose: "purpose",
    retention: "retention",
    contactEtaText: "contact-eta",
    consentText: "consent-text",
    version: "version",
  } as const;
  type PreviewFieldName = keyof typeof previewFieldNames;
  const previewField = (name: PreviewFieldName) => previewGallery.locator(`[data-preview-field="${previewFieldNames[name]}"]`);
  const previewText = async (name: PreviewFieldName) => {
    const field = previewField(name);
    expect(await field.count()).toBeGreaterThan(0);
    return (await field.allTextContents()).join("\n");
  };
  const initialValues = {
    partnerName: "海河演示保险服务中心",
    recipientName: "海河演示保险服务中心运营组",
    purpose: "仅用于本次续保对接与联系",
    retention: "线索关闭后 30 日内删除",
    contactEtaText: "工作时段内 30 分钟响应",
    consentText: "我同意驭小满将上述资料提供给海河演示保险服务中心，仅用于本次续保对接。",
    version: "demo-v1.0",
  };
  for (const [name, value] of Object.entries(initialValues)) {
    expect(await previewText(name)).toContain(value);
  }
  for (const item of ["联系人", "联系电话", "车辆信息", "行驶证影像"]) {
    expect(await previewText("dataScope")).toContain(item);
  }

  await expect(configGrid.getByLabel("接收合作方", { exact: true })).toHaveValue("partner-demo-haihe");
  await expect(configGrid.getByLabel("资料接收主体", { exact: true })).toHaveValue(initialValues.recipientName);
  await expect(configGrid.getByLabel("使用目的", { exact: true })).toHaveValue(initialValues.purpose);
  await expect(configGrid.getByLabel("保存期限", { exact: true })).toHaveValue(initialValues.retention);
  await expect(configGrid.getByLabel("预计联系时效", { exact: true })).toHaveValue(initialValues.contactEtaText);
  await expect(configGrid.getByLabel("用户授权文案", { exact: true })).toHaveValue(initialValues.consentText);
  await expect(configGrid.getByLabel("授权资料范围", { exact: true })).toHaveValue("联系人，联系电话，车辆信息，行驶证影像");

  const nextValues = {
    recipientName: "津门续保服务二组",
    purpose: "核验续保需求并安排专员回访",
    retention: "服务完成后 90 日内删除",
    contactEtaText: "2 个工作小时内联系",
    consentText: "我同意将所列资料提供给指定接收方，仅用于本次续保对接。",
    dataScope: "身份证明，车辆资料，续保时间",
  };
  await configGrid.getByLabel("资料接收主体", { exact: true }).fill(nextValues.recipientName);
  await configGrid.getByLabel("使用目的", { exact: true }).fill(nextValues.purpose);
  await configGrid.getByLabel("保存期限", { exact: true }).fill(nextValues.retention);
  await configGrid.getByLabel("预计联系时效", { exact: true }).fill(nextValues.contactEtaText);
  await configGrid.getByLabel("用户授权文案", { exact: true }).fill(nextValues.consentText);
  await configGrid.getByLabel("授权资料范围", { exact: true }).fill(nextValues.dataScope);

  await expect(mappingSummary).toContainText("草稿未保存");
  await expect(previewField("version")).toContainText("保存后生成新版本");

  for (const [name, value] of Object.entries(nextValues).filter(([name]) => name !== "dataScope") as Array<[Exclude<PreviewFieldName, "partnerName" | "version" | "dataScope">, string]>) {
    await expect.poll(() => previewText(name)).toContain(value);
  }
  for (const item of ["身份证明", "车辆资料", "续保时间"]) {
    await expect.poll(() => previewText("dataScope")).toContain(item);
  }
  expect(await previewText("partnerName")).toContain(initialValues.partnerName);
  expect(await previewText("recipientName")).not.toContain(initialValues.recipientName);
  expect(await previewText("purpose")).not.toContain(initialValues.purpose);
  expect(await previewText("retention")).not.toContain(initialValues.retention);
  expect(await previewText("contactEtaText")).not.toContain(initialValues.contactEtaText);
  expect(await previewText("consentText")).not.toContain(initialValues.consentText);
  const updatedScope = await previewText("dataScope");
  for (const item of ["联系人", "联系电话", "车辆信息", "行驶证影像"]) expect(updatedScope).not.toContain(item);
  await expect(mapping.locator("img")).toHaveCount(0);

  await mappingSummary.click();
  await expect(mapping).not.toHaveAttribute("open", "");
  for (const previewState of previewStates) {
    await expect(previewGallery.locator(`[data-preview-state="${previewState.state}"]`)).not.toBeVisible();
  }
});
