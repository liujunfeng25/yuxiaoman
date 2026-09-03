import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { FastifyInstance } from "fastify";
import sharp from "sharp";
import { buildApp } from "../app.js";
import type { Database } from "../db.js";
import { seedUsedCarDemoData } from "../used-car-db.js";
import { createTestDatabase } from "./test-database.js";

type Json = Record<string, any>;

async function fixture(): Promise<{
  app: FastifyInstance;
  database: Database;
  uploadDir: string;
  close: () => Promise<void>;
}> {
  const database = await createTestDatabase("used_cars");
  const uploadDir = mkdtempSync(join(tmpdir(), "yuxiaoman-used-cars-"));
  const app = await buildApp({ database, uploadDir });
  await app.ready();
  return {
    app,
    database,
    uploadDir,
    close: async () => {
      await app.close();
      await database.close();
      rmSync(uploadDir, { recursive: true, force: true });
    },
  };
}

async function count(database: Database, table: string): Promise<number> {
  return Number((await database.prepare<Json>(`SELECT COUNT(*) AS count FROM ${table}`).get())?.count);
}

async function uploadListingImage(
  app: FastifyInstance,
  listingId: string,
  image: Buffer,
  mimeType: string,
  values: { isCover?: boolean; sortOrder?: number } = {},
) {
  const boundary = `----used-car-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [];
  if (values.isCover !== undefined) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="isCover"\r\n\r\n${values.isCover}\r\n`,
    ));
  }
  if (values.sortOrder !== undefined) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="sortOrder"\r\n\r\n${values.sortOrder}\r\n`,
    ));
  }
  chunks.push(
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="vehicle-image"\r\nContent-Type: ${mimeType}\r\n\r\n`),
    image,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  return app.inject({
    method: "POST",
    url: `/api/admin/used-cars/listings/${listingId}/images`,
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat(chunks),
  });
}

async function uploadBrandLogo(app: FastifyInstance, brandId: string, image: Buffer, mimeType: string) {
  const boundary = `----used-car-logo-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="logo"\r\nContent-Type: ${mimeType}\r\n\r\n`),
    image,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return app.inject({
    method: "POST",
    url: `/api/admin/used-cars/brands/${brandId}/logo`,
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: body,
  });
}

function newListingPayload(modelId: string, status = "draft", energyType = "petrol") {
  return {
    stockNo: `TEST-${Math.random().toString(16).slice(2, 10)}`,
    modelId,
    title: "2025款 测试车型 精品车源",
    modelYear: 2025,
    registrationDate: "2025-03-08",
    mileageKm: 6800,
    priceFen: 16880000,
    originalPriceFen: 21980000,
    location: "天津·河西区",
    exteriorColor: "珍珠白",
    interiorColor: "深灰色",
    energyType,
    transmission: "automatic",
    seats: 5,
    highlights: ["合成测试车源", "支持复检"],
    description: "自动化测试创建的合成车源，不对应真实车辆。",
    status,
    sortPriority: 5,
  };
}

test("二手车迁移和种子幂等生成 15 品牌、46 车型及精确状态库存", async () => {
  const { database, close } = await fixture();
  try {
    assert.equal(await count(database, "used_car_brands"), 15);
    assert.equal(await count(database, "used_car_models"), 46);
    assert.equal(await count(database, "used_car_listings"), 30);
    assert.equal(await count(database, "used_car_listing_images"), 60);

    const catalogRows = await database.prepare<Json>(`
      SELECT b.name AS brand_name, m.name AS model_name
      FROM used_car_brands b JOIN used_car_models m ON m.brand_id = b.id
      ORDER BY b.name, m.name
    `).all();
    const actualCatalog = new Map<string, string[]>();
    for (const row of catalogRows) {
      const models = actualCatalog.get(row.brand_name) ?? [];
      models.push(row.model_name);
      actualCatalog.set(row.brand_name, models);
    }
    const expectedCatalog: Record<string, string[]> = {
      奥迪: ["A4L", "A6L", "Q5L"],
      宝马: ["3系", "5系", "X3"],
      奔驰: ["C级", "E级", "GLC"],
      比亚迪: ["秦PLUS DM-i", "宋PLUS DM-i", "汉DM-i", "唐DM-i", "海豹06 DM-i"],
      本田: ["雅阁", "CR-V", "奥德赛"],
      大众: ["迈腾", "途观L", "ID.4 X"],
      丰田: ["凯美瑞", "RAV4荣放", "汉兰达"],
      红旗: ["H5", "HS5"],
      极氪: ["001", "007", "7X"],
      理想: ["L6", "L7", "L8", "L9"],
      特斯拉: ["Model 3", "Model Y"],
      问界: ["M5", "M7", "M9"],
      蔚来: ["ET5", "ET5T", "ES6"],
      小鹏: ["MONA M03", "P7i", "G6", "G9"],
      小米汽车: ["SU7", "YU7"],
    };
    assert.deepEqual([...actualCatalog.keys()].sort(), Object.keys(expectedCatalog).sort());
    for (const [brand, models] of Object.entries(expectedCatalog)) {
      assert.deepEqual([...(actualCatalog.get(brand) ?? [])].sort(), [...models].sort(), brand);
    }

    const statuses = await database.prepare<Json>(`
      SELECT status, COUNT(*) AS count FROM used_car_listings GROUP BY status ORDER BY status
    `).all();
    assert.deepEqual(Object.fromEntries(statuses.map((row) => [row.status, Number(row.count)])), {
      draft: 2,
      offline: 1,
      on_sale: 24,
      reserved: 1,
      sold: 2,
    });
    assert.equal(Number((await database.prepare<Json>(
      "SELECT COUNT(*) AS count FROM used_car_listings WHERE model_id = 'model-li-l7'",
    ).get())?.count), 4);
    const orphanCount = await database.prepare<Json>(`
      SELECT
        (SELECT COUNT(*) FROM used_car_models m LEFT JOIN used_car_brands b ON b.id = m.brand_id WHERE b.id IS NULL)
        + (SELECT COUNT(*) FROM used_car_listings l LEFT JOIN used_car_models m ON m.id = l.model_id WHERE m.id IS NULL)
        + (SELECT COUNT(*) FROM used_car_listing_images i LEFT JOIN used_car_listings l ON l.id = i.listing_id WHERE l.id IS NULL)
        AS count
    `).get();
    assert.equal(Number(orphanCount?.count), 0);

    await seedUsedCarDemoData(database);
    assert.equal(await count(database, "used_car_brands"), 15);
    assert.equal(await count(database, "used_car_models"), 46);
    assert.equal(await count(database, "used_car_listings"), 30);
  } finally {
    await close();
  }
});

test("公共目录按首字母分组并输出约定 DTO 与理想 L7 车源数", async () => {
  const { app, close } = await fixture();
  try {
    const response = await app.inject({ method: "GET", url: "/api/used-cars/catalog" });
    assert.equal(response.statusCode, 200, response.body);
    const catalog = response.json<Json>().data;
    const brands = catalog.groups.flatMap((group: Json) => group.brands);
    const models = brands.flatMap((brand: Json) => brand.models);
    assert.equal(brands.length, 15);
    assert.equal(models.length, 46);
    assert.deepEqual(
      catalog.hotBrands.map((brand: Json) => brand.id),
      ["brand-li", "brand-byd", "brand-tesla", "brand-bmw", "brand-mercedes"],
    );
    assert.equal(catalog.dataKind, "synthetic_demo");
    assert.ok(catalog.groups.every((group: Json) => /^[A-Z#]$/.test(group.initial)));
    assert.ok(brands.every((brand: Json) => typeof brand.logoUrl === "string" && brand.logoUrl.includes(brand.id)));
    assert.ok(brands.every((brand: Json) => typeof brand.isHot === "boolean" && typeof brand.listingCount === "number"));
    assert.deepEqual(
      catalog.groups.find((group: Json) => group.initial === "B").brands.map((brand: Json) => brand.name),
      ["宝马", "奔驰", "本田", "比亚迪"],
    );

    const li = brands.find((brand: Json) => brand.id === "brand-li");
    assert.ok(li);
    const l7 = li.models.find((model: Json) => model.id === "model-li-l7");
    assert.deepEqual(
      { name: l7.name, bodyType: l7.bodyType, energyType: l7.energyType, listingCount: l7.listingCount },
      { name: "L7", bodyType: "suv", energyType: "range_extended", listingCount: 4 },
    );
  } finally {
    await close();
  }
});

test("公共车源仅展示 on_sale，支持筛选分页排序且非公开详情统一返回 404", async () => {
  const { app, database, close } = await fixture();
  try {
    const all = await app.inject({ method: "GET", url: "/api/used-cars/listings?page=1&pageSize=50" });
    assert.equal(all.statusCode, 200, all.body);
    const page = all.json<Json>().data;
    assert.equal(page.total, 24);
    assert.equal(page.page, 1);
    assert.equal(page.pageSize, 50);
    assert.equal(page.items.length, 24);
    assert.ok(page.items.every((item: Json) => item.status === "on_sale" && item.isSynthetic && item.dataKind === "synthetic_demo"));
    assert.ok(page.items.every((item: Json) => item.brand?.id && item.model?.id && Array.isArray(item.images)));

    const l7 = await app.inject({
      method: "GET",
      url: "/api/used-cars/listings?brandId=brand-li&modelId=model-li-l7&pageSize=10&sort=price_asc",
    });
    assert.equal(l7.statusCode, 200, l7.body);
    const l7Items = l7.json<Json>().data.items;
    assert.equal(l7.json<Json>().data.total, 4);
    assert.deepEqual(
      l7Items.map((item: Json) => item.priceFen),
      [...l7Items.map((item: Json) => item.priceFen)].sort((left, right) => left - right),
    );
    const detail = await app.inject({ method: "GET", url: `/api/used-cars/listings/${l7Items[0].id}` });
    assert.equal(detail.statusCode, 200, detail.body);
    assert.equal(detail.json<Json>().data.images.length, 2);

    const privateRow = await database.prepare<Json>(
      "SELECT id FROM used_car_listings WHERE status <> 'on_sale' ORDER BY id LIMIT 1",
    ).get();
    assert.ok(privateRow);
    for (const id of [privateRow.id, "used-car-listing-missing"]) {
      const hidden = await app.inject({ method: "GET", url: `/api/used-cars/listings/${id}` });
      assert.equal(hidden.statusCode, 404, hidden.body);
      assert.equal(hidden.json<Json>().error.code, "USED_CAR_NOT_AVAILABLE");
    }

    const invalid = await app.inject({ method: "GET", url: "/api/used-cars/listings?page=0&sort=unknown" });
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.json<Json>().error.code, "VALIDATION_ERROR");
  } finally {
    await close();
  }
});

test("旧二手车后台数据保留只读，所有写入方法统一拒绝", async () => {
  const { app, close } = await fixture();
  try {
    const historical = await app.inject({ method: "GET", url: "/api/admin/used-cars/listings?page=1&pageSize=1" });
    assert.equal(historical.statusCode, 200, historical.body);
    assert.equal(historical.json<Json>().data.items.length, 1);

    const writes = [
      { method: "POST", url: "/api/admin/used-cars/brands", payload: {} },
      { method: "PUT", url: "/api/admin/used-cars/models/model-li-l7", payload: {} },
      { method: "PATCH", url: "/api/admin/used-cars/listings/used-car-listing-001", payload: {} },
      { method: "DELETE", url: "/api/admin/used-cars/listings/used-car-listing-001" },
    ] as const;
    for (const request of writes) {
      const response = await app.inject(request);
      assert.equal(response.statusCode, 410, response.body);
      assert.equal(response.json<Json>().error.code, "USED_CAR_MARKET_READ_ONLY");
    }
  } finally {
    await close();
  }
});

test("旧二手车图片写入同样只读，公开历史图片仍可读取", async () => {
  const { app, close } = await fixture();
  try {
    const listing = await app.inject({ method: "GET", url: "/api/used-cars/listings/used-car-listing-001" });
    assert.equal(listing.statusCode, 200, listing.body);
    const imageUrl = listing.json<Json>().data.images[0].url;
    const publicImage = await app.inject({ method: "GET", url: imageUrl });
    assert.equal(publicImage.statusCode, 200, publicImage.body);

    const jpeg = await sharp({ create: { width: 900, height: 600, channels: 3, background: "#b9c7d8" } }).jpeg().toBuffer();
    const upload = await uploadListingImage(app, "used-car-listing-001", jpeg, "image/jpeg", { isCover: true });
    assert.equal(upload.statusCode, 410, upload.body);
    assert.equal(upload.json<Json>().error.code, "USED_CAR_MARKET_READ_ONLY");
  } finally {
    await close();
  }
});

test("used-car demo assets serve only real allowlisted images with safe caching", async () => {
  const { app, database, close } = await fixture();
  try {
    const assets = [
      ["/assets/used-cars/logos/brand-li.webp", "image/webp"],
      ["/assets/used-cars/models/model-li-l7.webp", "image/webp"],
      ["/assets/used-cars/listings/used-car-listing-001/01.webp", "image/webp"],
      ["/assets/used-cars/real-sources/models/model-li-l7/cover.webp", "image/webp"],
      ["/assets/used-cars/logos/audi.svg", "image/svg+xml; charset=utf-8"],
    ] as const;

    for (const [url, contentType] of assets) {
      const response = await app.inject({ method: "GET", url });
      assert.equal(response.statusCode, 200, `${url}: ${response.body}`);
      assert.equal(response.headers["content-type"], contentType);
      assert.equal(response.headers["cache-control"], "public, max-age=86400, stale-while-revalidate=604800");
      assert.equal(response.headers["cross-origin-resource-policy"], "cross-origin");
      assert.equal(response.headers["x-content-type-options"], "nosniff");
      assert.ok(response.headers.etag);
      assert.equal(Number(response.headers["content-length"]), response.rawPayload.length);
      assert.ok(response.rawPayload.length > 0);
    }
    const svg = await app.inject({ method: "GET", url: "/assets/used-cars/logos/audi.svg" });
    assert.equal(svg.headers["content-security-policy"], "default-src 'none'; style-src 'unsafe-inline'; sandbox");

    const contractUrls = (await database.prepare<Json>(`
      SELECT logo_url AS url FROM used_car_brands
      UNION ALL SELECT cover_image_url AS url FROM used_car_models
      UNION ALL SELECT image_url AS url FROM used_car_listing_images
    `).all()).map((row) => String(row.url));
    assert.equal(contractUrls.length, 121);
    for (const url of contractUrls) {
      const response = await app.inject({ method: "HEAD", url });
      assert.equal(response.statusCode, 200, url);
      assert.equal(response.headers["content-type"], "image/webp");
      assert.ok(Number(response.headers["content-length"]) > 0, url);
      assert.equal(response.rawPayload.length, 0, url);
    }

    const fresh = await app.inject({ method: "GET", url: assets[0][0] });
    const cached = await app.inject({
      method: "GET",
      url: assets[0][0],
      headers: { "if-none-match": String(fresh.headers.etag) },
    });
    assert.equal(cached.statusCode, 304);
    assert.equal(cached.rawPayload.length, 0);

    const rejected = [
      "/assets/used-cars/missing.webp",
      "/assets/used-cars/BRAND_SOURCES.md",
      "/assets/used-cars/%2e%2e%2fpackage.json",
      "/assets/used-cars/..%5cpackage.json",
      "/assets/used-cars/%252e%252e%252fpackage.json",
    ];
    for (const url of rejected) {
      const response = await app.inject({ method: "GET", url });
      assert.equal(response.statusCode, 404, `${url}: ${response.body}`);
      assert.equal(response.json<Json>().error.code, "USED_CAR_ASSET_NOT_FOUND");
    }
  } finally {
    await close();
  }
});
