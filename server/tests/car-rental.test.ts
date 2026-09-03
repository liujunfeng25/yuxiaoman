import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { FastifyInstance } from "fastify";
import sharp from "sharp";
import { createDevelopmentSession } from "../auth.js";
import { buildApp } from "../app.js";
import { seedCarRentalDemoData } from "../car-rental-db.js";
import type { Database } from "../db.js";
import { createTestDatabase } from "./test-database.js";

process.env.NODE_ENV = "test";
process.env.YUXIAOMAN_ENV = "test";
process.env.YUXIAOMAN_ALLOW_DEMO_AUTH_FALLBACK = "true";

type Json = Record<string, any>;
const FIXED_NOW = new Date("2026-08-22T00:00:00.000Z");
const PICKUP_AT = "2026-08-24T10:00:00+08:00";
const RETURN_AT = "2026-08-27T10:00:00+08:00";

async function fixture(prefix = "car_rental"): Promise<{ app: FastifyInstance; database: Database; close: () => Promise<void> }> {
  const database = await createTestDatabase(prefix);
  const root = mkdtempSync(join(tmpdir(), "yuxiaoman-rental-"));
  const app = await buildApp({
    database,
    uploadDir: join(root, "uploads"),
    insuranceUploadDir: join(root, "insurance"),
    now: () => FIXED_NOW,
    slotNow: () => FIXED_NOW,
    carRentalCalculateDrivingRoute: async (_origin, destination) => ({
      distanceKm: destination.longitude > 117.3 ? 4.2 : destination.longitude > 117.2 ? 6.5 : 8.3,
      driveMinutes: 18,
      distanceBasis: "driving_route",
      distanceSource: "tencent_matrix",
    }),
  });
  await app.ready();
  return { app, database, close: async () => { await app.close(); await database.close(); rmSync(root, { recursive: true, force: true }); } };
}

function count(database: Database, table: string): Promise<number> {
  return database.prepare<Json>(`SELECT COUNT(*) AS count FROM ${table}`).get().then((row) => Number(row?.count ?? 0));
}
function bearer(token: string) { return { authorization: `Bearer ${token}` }; }
const storeSearch = { serviceMode: "store_pickup", storeId: "rental-store-hexi", pickupAt: PICKUP_AT, returnAt: RETURN_AT };
const demoAddress = { poiId: "demo-tianjin-airport", title: "天津滨海国际机场停车区", address: "天津滨海国际机场停车区附近", district: "东丽区", latitude: 39.13, longitude: 117.35, source: "demo" };

async function createQuote(app: FastifyInstance, extra: Json = {}, headers?: Record<string, string>) {
  const response = await app.inject({ method: "POST", url: "/api/car-rental/quotes", headers, payload: { ...storeSearch, modelId: "model-li-l7", addOptionalProtection: false, ...extra } });
  assert.equal(response.statusCode, 200, response.body);
  return response.json<Json>().data;
}
async function createOrder(app: FastifyInstance, quoteId: string, key: string, headers?: Record<string, string>) {
  return app.inject({ method: "POST", url: "/api/car-rental/orders", headers, payload: { quoteId, driverName: "演示驾驶员", driverPhone: "13800138000", licenseConfirmed: true, idempotencyKey: key } });
}

async function multipartImage(app: FastifyInstance, url: string, image: Buffer, fields: Record<string, string> = {}) {
  const boundary = `----rental-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="rental.png"\r\nContent-Type: image/png\r\n\r\n`), image, Buffer.from(`\r\n--${boundary}--\r\n`));
  return app.inject({ method: "POST", url, headers: { "content-type": `multipart/form-data; boundary=${boundary}` }, payload: Buffer.concat(chunks) });
}

test("汽车租赁迁移与种子幂等生成 15 品牌、46 车型、3 门店和精确 36 辆车状态", async () => {
  const { database, close } = await fixture("rental_seed");
  try {
    assert.equal(await count(database, "car_rental_brands"), 15);
    assert.equal(await count(database, "car_rental_models"), 46);
    assert.equal(await count(database, "car_rental_model_images"), 46);
    assert.equal(await count(database, "car_rental_stores"), 3);
    assert.equal(await count(database, "car_rental_vehicles"), 36);
    const states = await database.prepare<Json>("SELECT status,COUNT(*) AS count FROM car_rental_vehicles GROUP BY status").all();
    assert.deepEqual(Object.fromEntries(states.map((row) => [row.status, Number(row.count)])), { active: 30, maintenance: 3, offline: 2, retired: 1 });
    assert.equal(Number((await database.prepare<Json>("SELECT COUNT(*) AS count FROM car_rental_vehicles WHERE store_id='rental-store-hexi' AND model_id='model-li-l7' AND status='active'").get())?.count), 3);
    await seedCarRentalDemoData(database);
    assert.equal(await count(database, "car_rental_vehicles"), 36);
    assert.equal(await count(database, "used_car_listings"), 30, "保留旧二手车域，不转换或删除");
  } finally { await close(); }
});

test("目录、门店和指定车型报价返回稳定 DTO，押金不计入应付", async () => {
  const { app, close } = await fixture("rental_catalog");
  try {
    const catalogResponse = await app.inject({ method: "GET", url: "/api/car-rental/catalog" });
    assert.equal(catalogResponse.statusCode, 200, catalogResponse.body);
    const catalog = catalogResponse.json<Json>().data;
    const brands = catalog.groups.flatMap((group: Json) => group.brands);
    const models = brands.flatMap((brand: Json) => brand.models);
    assert.equal(brands.length, 15);
    assert.equal(models.length, 46);
    assert.ok(brands.every((brand: Json) => brand.logoUrl && /^[A-Z#]$/.test(brand.initial)));
    assert.equal(models.find((model: Json) => model.id === "model-li-l7").availableCount, 3);

    const stores = await app.inject({ method: "GET", url: "/api/car-rental/stores" });
    assert.equal(stores.statusCode, 200, stores.body);
    assert.equal(stores.json<Json>().data.length, 3);
    assert.match(stores.json<Json>().data[0].name, /滨海机场/u);

    const offers = await app.inject({ method: "POST", url: "/api/car-rental/offers/search", payload: storeSearch });
    assert.equal(offers.statusCode, 200, offers.body);
    const page = offers.json<Json>().data;
    assert.equal(page.billableDays, 3);
    const l7 = page.items.find((item: Json) => item.model.id === "model-li-l7");
    assert.ok(l7);
    assert.equal(l7.dailyRateFen, 49_800);
    assert.equal(l7.totalFeeFen, 170_900);
    assert.equal(l7.isExactModel, true);

    const quote = await createQuote(app);
    assert.equal(quote.feeBreakdown.rentalFeeFen, 149_400);
    assert.equal(quote.feeBreakdown.basicProtectionFeeFen, 18_000);
    assert.equal(quote.feeBreakdown.prepFeeFen, 3_500);
    assert.equal(quote.feeBreakdown.totalFeeFen, 170_900);
    assert.equal(quote.deposits.totalDepositFen, 1_000_000);
    assert.equal(quote.deposits.includedInPayable, false);
    assert.equal(quote.model.images.length, 1);
  } finally { await close(); }
});

test("日期覆盖价优先，送车按真实单程路线计费且无真实路线时拒绝报价", async () => {
  const { app, database, close } = await fixture("rental_route");
  try {
    await database.prepare("INSERT INTO car_rental_rate_overrides (id,rate_plan_id,date,daily_rate_fen,is_available,note,created_at,updated_at) VALUES ('override-test','rental-rate-model-li-l7','2026-08-24',88800,1,'测试覆盖价',?,?)").run(FIXED_NOW.toISOString(), FIXED_NOW.toISOString());
    const quote = await createQuote(app, { serviceMode: "home_delivery", storeId: undefined, deliveryAddress: demoAddress });
    assert.equal(quote.store.id, "rental-store-hexi");
    assert.equal(quote.route.distanceSource, "tencent_matrix");
    assert.equal(quote.route.oneWayDistanceKm, 4.2);
    assert.equal(quote.feeBreakdown.deliveryFeeFen, 4_100, "¥29 含3km，额外2km×¥6");
    assert.equal(quote.feeBreakdown.rentalFeeFen, 188_400);

    const root = mkdtempSync(join(tmpdir(), "yuxiaoman-rental-route-fail-"));
    const failing = await buildApp({ database, uploadDir: join(root, "uploads"), insuranceUploadDir: join(root, "insurance"), now: () => FIXED_NOW, slotNow: () => FIXED_NOW,
      carRentalCalculateDrivingRoute: async () => ({ distanceKm: null, driveMinutes: null, distanceBasis: "no_origin", distanceSource: "not_calculated", mapErrorCode: "TEST_UNAVAILABLE" }) });
    await failing.ready();
    const unavailable = await failing.inject({ method: "POST", url: "/api/car-rental/quotes", payload: { serviceMode: "home_delivery", pickupAt: PICKUP_AT, returnAt: RETURN_AT, deliveryAddress: demoAddress, modelId: "model-li-l7", addOptionalProtection: false } });
    assert.equal(unavailable.statusCode, 503, unavailable.body);
    assert.equal(unavailable.json<Json>().error.code, "RENTAL_REAL_ROUTE_REQUIRED");
    await failing.close(); rmSync(root, { recursive: true, force: true });
  } finally { await close(); }
});

test("报价创建订单、模拟支付与取消均幂等并释放容量", async () => {
  const { app, database, close } = await fixture("rental_order");
  try {
    const quote = await createQuote(app);
    const first = await createOrder(app, quote.id, "rental-order-key-0001");
    assert.equal(first.statusCode, 201, first.body);
    const order = first.json<Json>().data;
    assert.equal(order.status, "pending_payment");
    assert.equal(order.driverPhoneMasked, "138****8000");
    const repeat = await createOrder(app, quote.id, "rental-order-key-0001");
    assert.equal(repeat.statusCode, 200, repeat.body);
    assert.equal(repeat.json<Json>().data.id, order.id);

    const paid = await app.inject({ method: "POST", url: `/api/car-rental/orders/${order.id}/mock-pay`, payload: { idempotencyKey: "rental-pay-key-0001" } });
    assert.equal(paid.statusCode, 200, paid.body);
    assert.equal(paid.json<Json>().data.status, "confirmed");
    const paidAgain = await app.inject({ method: "POST", url: `/api/car-rental/orders/${order.id}/mock-pay`, payload: { idempotencyKey: "rental-pay-key-0001" } });
    assert.equal(paidAgain.statusCode, 200, paidAgain.body);
    assert.equal(await count(database, "car_rental_mock_payments"), 1);

    const cancelled = await app.inject({ method: "POST", url: `/api/car-rental/orders/${order.id}/cancel`, payload: { reason: "演示取消" } });
    assert.equal(cancelled.statusCode, 200, cancelled.body);
    assert.equal(cancelled.json<Json>().data.status, "cancelled");
    const quoteAfter = await createQuote(app);
    assert.ok(quoteAfter.id);
  } finally { await close(); }
});

test("容量在串行化事务内防超租，报价过期和无驾照确认均失败", async () => {
  const { app, database, close } = await fixture("rental_capacity");
  try {
    await database.prepare("UPDATE car_rental_vehicles SET status='maintenance' WHERE model_id='model-li-l7' AND id<>'rental-vehicle-004'").run();
    const quoteA = await createQuote(app);
    const quoteB = await createQuote(app);
    const orderA = await createOrder(app, quoteA.id, "capacity-order-key-a");
    assert.equal(orderA.statusCode, 201, orderA.body);
    const orderB = await createOrder(app, quoteB.id, "capacity-order-key-b");
    assert.equal(orderB.statusCode, 409, orderB.body);
    assert.equal(orderB.json<Json>().error.code, "RENTAL_MODEL_UNAVAILABLE");

    const invalidLicense = await app.inject({ method: "POST", url: "/api/car-rental/orders", payload: { quoteId: quoteB.id, driverName: "测试用户", driverPhone: "13800138000", licenseConfirmed: false, idempotencyKey: "invalid-license-key" } });
    assert.equal(invalidLicense.statusCode, 400, invalidLicense.body);

    await app.inject({ method: "POST", url: `/api/car-rental/orders/${orderA.json<Json>().data.id}/cancel`, payload: {} });
    const expiredQuote = await createQuote(app);
    await database.prepare("UPDATE car_rental_quote_snapshots SET expires_at='2026-08-21T00:00:00.000Z' WHERE id=?").run(expiredQuote.id);
    const expiredOrder = await createOrder(app, expiredQuote.id, "expired-quote-order-key");
    assert.equal(expiredOrder.statusCode, 409, expiredOrder.body);
    assert.equal(expiredOrder.json<Json>().error.code, "RENTAL_QUOTE_EXPIRED");
  } finally { await close(); }
});

test("订单按服务端身份隔离，后台可分配车辆并按状态机推进", async () => {
  const { app, database, close } = await fixture("rental_admin_order");
  try {
    const ownerA = await createDevelopmentSession(database, { userId: "rental-owner-a" });
    const ownerB = await createDevelopmentSession(database, { userId: "rental-owner-b" });
    const quote = await createQuote(app, {}, bearer(ownerA.token));
    const created = await createOrder(app, quote.id, "owner-a-order-key", bearer(ownerA.token));
    assert.equal(created.statusCode, 201, created.body);
    const orderId = created.json<Json>().data.id;
    const crossRead = await app.inject({ method: "GET", url: `/api/car-rental/orders/${orderId}`, headers: bearer(ownerB.token) });
    assert.equal(crossRead.statusCode, 404, crossRead.body);
    await app.inject({ method: "POST", url: `/api/car-rental/orders/${orderId}/mock-pay`, headers: bearer(ownerA.token), payload: { idempotencyKey: "owner-a-payment-key" } });

    const assigned = await app.inject({ method: "POST", url: `/api/admin/car-rental/orders/${orderId}/assign-vehicle`, payload: { vehicleId: "rental-vehicle-004" } });
    assert.equal(assigned.statusCode, 200, assigned.body);
    assert.equal(assigned.json<Json>().data.assignedVehicle.id, "rental-vehicle-004");
    for (const status of ["ready_for_pickup", "in_use", "return_pending", "completed"]) {
      const response = await app.inject({ method: "POST", url: `/api/admin/car-rental/orders/${orderId}/transition`, payload: { status, note: "自动化测试推进" } });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json<Json>().data.status, status);
    }
    const adjustment = await app.inject({ method: "POST", url: `/api/admin/car-rental/orders/${orderId}/adjustments`, payload: { amountFen: 2800, note: "超时演示费用" } });
    assert.equal(adjustment.statusCode, 201, adjustment.body);
    const detail = await app.inject({ method: "GET", url: `/api/admin/car-rental/orders/${orderId}` });
    assert.ok(detail.json<Json>().data.events.length >= 6);
    assert.equal(detail.json<Json>().data.adjustments.length, 1);
    const auditRows = await database.prepare<Json>(`
      SELECT action,before_json,after_json,metadata_json
      FROM backoffice_audit_events
      WHERE action LIKE 'car_rental.order.%'
      ORDER BY occurred_at,id
    `).all();
    assert.deepEqual(auditRows.map((row) => row.action), [
      "car_rental.order.vehicle_assigned",
      "car_rental.order.status_changed",
      "car_rental.order.status_changed",
      "car_rental.order.status_changed",
      "car_rental.order.status_changed",
      "car_rental.order.adjustment_created",
    ]);
    const serializedAudit = JSON.stringify(auditRows);
    assert.doesNotMatch(serializedAudit, /自动化测试推进|超时演示费用|13800138000/u);
    assert.equal(auditRows.every((row) => row.metadata_json.presentation.category === "car_rental"), true);
  } finally { await close(); }
});

test("后台品牌车标与车型图片 multipart 上传会压缩持久化并维护唯一封面", async () => {
  const { app, database, close } = await fixture("rental_images");
  try {
    const brand = await app.inject({ method: "PUT", url: "/api/admin/car-rental/brands/brand-li", payload: { name: "理想", initial: "L", isHot: true, sortOrder: 100, isActive: true } });
    assert.equal(brand.statusCode, 200, brand.body);
    assert.match(brand.json<Json>().data.logoUrl, /brand-li/u, "缺省 logoUrl 保留旧值");
    const image = await sharp({ create: { width: 2600, height: 1800, channels: 3, background: { r: 31, g: 99, b: 164 } } }).png().withMetadata({ orientation: 6 }).toBuffer();
    const logo = await multipartImage(app, "/api/admin/car-rental/brands/brand-li/logo", image);
    assert.equal(logo.statusCode, 201, logo.body);
    assert.equal(logo.json<Json>().data.logoUrl, "/api/car-rental/brands/brand-li/logo");
    const logoRead = await app.inject({ method: "GET", url: "/api/car-rental/brands/brand-li/logo" });
    assert.equal(logoRead.statusCode, 200, logoRead.body);
    assert.equal(logoRead.headers["content-type"], "image/webp");

    const uploaded = await multipartImage(app, "/api/admin/car-rental/models/model-li-l7/images", image, { isCover: "true", sortOrder: "9" });
    assert.equal(uploaded.statusCode, 201, uploaded.body);
    const rentalImage = uploaded.json<Json>().data;
    assert.equal(rentalImage.isCover, true);
    assert.ok(rentalImage.width <= 2048 && rentalImage.height <= 2048);
    assert.equal(rentalImage.mimeType, "image/webp");
    assert.equal(Number((await database.prepare<Json>("SELECT COUNT(*) AS count FROM car_rental_model_images WHERE model_id='model-li-l7' AND is_cover=1").get())?.count), 1);
    const read = await app.inject({ method: "GET", url: rentalImage.url });
    assert.equal(read.statusCode, 200, read.body);
    assert.equal(read.headers["content-type"], "image/webp");

    const removed = await app.inject({ method: "DELETE", url: `/api/admin/car-rental/models/model-li-l7/images/${rentalImage.id}` });
    assert.equal(removed.statusCode, 200, removed.body);
    const replacement = await database.prepare<Json>("SELECT m.cover_image_url,(SELECT COUNT(*) FROM car_rental_model_images i WHERE i.model_id=m.id AND i.is_cover=1) AS covers FROM car_rental_models m WHERE m.id='model-li-l7'").get();
    assert.equal(Number(replacement?.covers), 1);
    assert.notEqual(replacement?.cover_image_url, rentalImage.url);
    const auditRows = await database.prepare<Json>(`
      SELECT action,before_json,after_json,metadata_json
      FROM backoffice_audit_events
      WHERE action LIKE 'car_rental.brand.%' OR action LIKE 'car_rental.model_image.%'
      ORDER BY occurred_at,id
    `).all();
    assert.ok(auditRows.some((row) => row.action === "car_rental.brand.logo_updated"));
    assert.ok(auditRows.some((row) => row.action === "car_rental.model_image.added"));
    assert.ok(auditRows.some((row) => row.action === "car_rental.model_image.removed"));
    assert.doesNotMatch(JSON.stringify(auditRows), /\/api\/car-rental\/images|storage_key|\.webp/u);
  } finally { await close(); }
});

test("租赁语义审计忽略读取、无差异保存和内部备注，并脱敏电话与完整车牌", async () => {
  const { app, database, close } = await fixture("rental_semantic_audit");
  try {
    const read = await app.inject({ method: "GET", url: "/api/admin/car-rental/vehicles" });
    assert.equal(read.statusCode, 200, read.body);
    assert.equal(Number((await database.prepare<Json>("SELECT COUNT(*) AS count FROM backoffice_audit_events WHERE action LIKE 'car_rental.%'").get())?.count), 0);

    const vehicle = (await database.prepare<Json>("SELECT * FROM car_rental_vehicles WHERE id='rental-vehicle-004'").get())!;
    const vehiclePayload = {
      stockNo: vehicle.stock_no,
      modelId: vehicle.model_id,
      storeId: vehicle.store_id,
      plateNumber: "津A98765",
      color: vehicle.color,
      modelYear: Number(vehicle.model_year),
      mileageKm: Number(vehicle.mileage_km),
      status: vehicle.status,
    };
    const vehicleUpdate = await app.inject({ method: "PUT", url: "/api/admin/car-rental/vehicles/rental-vehicle-004", payload: vehiclePayload });
    assert.equal(vehicleUpdate.statusCode, 200, vehicleUpdate.body);
    const semanticCount = Number((await database.prepare<Json>("SELECT COUNT(*) AS count FROM backoffice_audit_events WHERE action LIKE 'car_rental.%'").get())?.count);
    assert.equal(semanticCount, 1);

    const noChange = await app.inject({ method: "PUT", url: "/api/admin/car-rental/vehicles/rental-vehicle-004", payload: vehiclePayload });
    assert.equal(noChange.statusCode, 200, noChange.body);
    assert.equal(Number((await database.prepare<Json>("SELECT COUNT(*) AS count FROM backoffice_audit_events WHERE action LIKE 'car_rental.%'").get())?.count), semanticCount);

    const store = (await database.prepare<Json>("SELECT * FROM car_rental_stores WHERE id='rental-store-hexi'").get())!;
    const storeUpdate = await app.inject({
      method: "PUT",
      url: "/api/admin/car-rental/stores/rental-store-hexi",
      payload: {
        name: store.name,
        district: store.district,
        address: store.address,
        latitude: Number(store.latitude),
        longitude: Number(store.longitude),
        openHours: store.open_hours,
        phone: "13800138000",
        isActive: Boolean(store.is_active),
        sortOrder: Number(store.sort_order),
        deliveryBaseFeeFen: Number(store.delivery_base_fee_fen),
        deliveryIncludedKm: Number(store.delivery_included_km),
        deliveryPerKmFen: Number(store.delivery_per_km_fen),
        deliveryMaxRadiusKm: Number(store.delivery_max_radius_km),
      },
    });
    assert.equal(storeUpdate.statusCode, 200, storeUpdate.body);

    const quote = await createQuote(app);
    const order = await createOrder(app, quote.id, "audit-note-order-key");
    assert.equal(order.statusCode, 201, order.body);
    const beforeNoteCount = Number((await database.prepare<Json>("SELECT COUNT(*) AS count FROM backoffice_audit_events WHERE action LIKE 'car_rental.%'").get())?.count);
    const note = await app.inject({ method: "PUT", url: `/api/admin/car-rental/orders/${order.json<Json>().data.id}/internal-note`, payload: { internalNote: "驾驶员手机号 13900001111，需特殊处理" } });
    assert.equal(note.statusCode, 200, note.body);
    assert.equal(Number((await database.prepare<Json>("SELECT COUNT(*) AS count FROM backoffice_audit_events WHERE action LIKE 'car_rental.%'").get())?.count), beforeNoteCount);

    const auditRows = await database.prepare<Json>("SELECT before_json,after_json,metadata_json FROM backoffice_audit_events WHERE action LIKE 'car_rental.%'").all();
    const serialized = JSON.stringify(auditRows);
    assert.doesNotMatch(serialized, /津A98765|13800138000|13900001111|需特殊处理/u);
    assert.match(serialized, /津A\*\*\*5/u);
    const auditResponse = await app.inject({ method: "GET", url: "/api/admin/audit-events?category=car_rental&pageSize=20" });
    assert.equal(auditResponse.statusCode, 200, auditResponse.body);
    const auditItems = auditResponse.json<Json>().data.items as Json[];
    assert.ok(auditItems.some((item) => item.actionLabel === "修改车队车辆"));
    assert.ok(auditItems.some((item) => item.actionLabel === "修改租赁门店"));
    assert.equal(auditItems.every((item) => item.category.label === "汽车租赁" && !String(item.summary).includes("car_rental.")), true);
  } finally { await close(); }
});

test("租赁业务变更在语义审计写入失败时整体回滚", async () => {
  const { app, database, close } = await fixture("rental_audit_atomicity");
  try {
    await database.execute(`
      CREATE OR REPLACE FUNCTION fail_car_rental_audit_insert() RETURNS trigger AS $$
      BEGIN
        IF NEW.action LIKE 'car_rental.%' THEN
          RAISE EXCEPTION 'forced rental audit failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER fail_car_rental_audit_insert
      BEFORE INSERT ON backoffice_audit_events
      FOR EACH ROW EXECUTE FUNCTION fail_car_rental_audit_insert();
    `);
    const response = await app.inject({
      method: "PUT",
      url: "/api/admin/car-rental/brands/brand-li",
      payload: { name: "理想汽车", initial: "L", isHot: true, sortOrder: 100, isActive: true },
    });
    assert.equal(response.statusCode, 500, response.body);
    const brand = await database.prepare<Json>("SELECT name FROM car_rental_brands WHERE id='brand-li'").get();
    assert.equal(brand?.name, "理想");
    assert.equal(Number((await database.prepare<Json>("SELECT COUNT(*) AS count FROM backoffice_audit_events WHERE action LIKE 'car_rental.%'").get())?.count), 0);
  } finally { await close(); }
});
