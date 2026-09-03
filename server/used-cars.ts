import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import sharp from "sharp";
import { z } from "zod";
import type { AppDatabase } from "./database.js";

type Row = Record<string, unknown>;
type ProblemFactory = (
  statusCode: number,
  code: string,
  message: string,
  fields?: Record<string, string>,
) => Error;

type UsedCarRouteOptions = {
  problem: ProblemFactory;
  uploadDir: string;
};

const idSchema = z.string().trim().min(1).max(120).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;
const listingStatusSchema = z.enum(["draft", "on_sale", "reserved", "sold", "offline"]);
const energyTypeSchema = z.enum(["petrol", "diesel", "hybrid", "plug_in_hybrid", "electric", "range_extended"]);
const bodyTypeSchema = z.enum(["sedan", "suv", "mpv", "hatchback", "coupe", "pickup"]);
const transmissionSchema = z.enum(["automatic", "manual", "cvt", "dct", "single_speed", "e_cvt"]);
const hotBrandPriority = new Map([
  ["brand-li", 0],
  ["brand-byd", 1],
  ["brand-tesla", 2],
  ["brand-bmw", 3],
  ["brand-mercedes", 4],
]);

function isRealIsoDate(value: string): boolean {
  if (!isoDatePattern.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

const isoDateSchema = z.string().refine(isRealIsoDate, "请使用有效的 YYYY-MM-DD 日期");

const brandSchema = z.object({
  id: idSchema.optional(),
  name: z.string().trim().min(1).max(80),
  logoUrl: z.string().trim().max(500).nullable().optional(),
  initial: z.string().trim().toUpperCase().regex(/^[A-Z#]$/),
  isHot: z.boolean().default(false),
  sortOrder: z.number().int().min(-10_000).max(10_000).default(0),
  isActive: z.boolean().default(true),
});

const modelSchema = z.object({
  id: idSchema.optional(),
  brandId: idSchema,
  name: z.string().trim().min(1).max(100),
  bodyType: bodyTypeSchema,
  energyType: energyTypeSchema,
  coverImageUrl: z.string().trim().max(500).nullable().optional(),
  sortOrder: z.number().int().min(-10_000).max(10_000).default(0),
  isActive: z.boolean().default(true),
});

const listingFields = z.object({
  stockNo: z.string().trim().min(2).max(80).regex(/^[A-Za-z0-9_-]+$/),
  modelId: idSchema,
  title: z.string().trim().min(2).max(160),
  trimName: z.string().trim().min(1).max(120).optional(),
  trim: z.string().trim().min(1).max(120).optional(),
  modelYear: z.number().int().min(1990).max(2100),
  registrationDate: isoDateSchema,
  mileageKm: z.number().int().min(0).max(2_000_000),
  priceFen: z.number().int().min(1).max(100_000_000),
  guidePriceFen: z.number().int().min(1).max(100_000_000).nullable().optional(),
  originalPriceFen: z.number().int().min(0).max(100_000_000).nullable().optional(),
  location: z.string().trim().min(1).max(100),
  exteriorColor: z.string().trim().min(1).max(40).optional(),
  color: z.string().trim().min(1).max(40).optional(),
  interiorColor: z.string().trim().min(1).max(40),
  transferCount: z.number().int().min(0).max(30).optional(),
  energyType: energyTypeSchema,
  transmission: transmissionSchema,
  seats: z.number().int().min(1).max(20),
  highlights: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
  conditionSummary: z.string().trim().max(2_000).optional(),
  defectsDisclosure: z.union([
    z.array(z.string().trim().min(1).max(300)).max(30),
    z.string().trim().max(3_000),
  ]).optional(),
  defects: z.union([
    z.array(z.string().trim().min(1).max(300)).max(30),
    z.string().trim().max(3_000),
  ]).optional(),
  description: z.string().trim().max(5_000).default(""),
  status: listingStatusSchema,
  dataKind: z.enum(["synthetic_demo", "company_inventory"]).optional(),
  featured: z.boolean().optional(),
  isFeatured: z.boolean().optional(),
  sortOrder: z.number().int().min(-10_000).max(10_000).optional(),
  sortPriority: z.number().int().min(-10_000).max(10_000).default(0),
  publishedAt: z.string().datetime().nullable().optional(),
}).superRefine((value, context) => {
  const guidePriceFen = value.guidePriceFen ?? value.originalPriceFen;
  if (guidePriceFen != null && guidePriceFen < value.priceFen) {
    context.addIssue({ code: "custom", path: ["originalPriceFen"], message: "新车指导价不能低于当前售价" });
  }
  if (!value.exteriorColor && !value.color) {
    context.addIssue({ code: "custom", path: ["exteriorColor"], message: "请填写车身颜色" });
  }
});

const createListingSchema = z.object({ id: idSchema.optional() }).and(listingFields);
const updateListingSchema = listingFields;
const patchListingSchema = z.object({
  stockNo: z.string().trim().min(2).max(80).regex(/^[A-Za-z0-9_-]+$/).optional(),
  modelId: idSchema.optional(),
  title: z.string().trim().min(2).max(160).optional(),
  trimName: z.string().trim().min(1).max(120).optional(),
  trim: z.string().trim().min(1).max(120).optional(),
  modelYear: z.number().int().min(1990).max(2100).optional(),
  registrationDate: isoDateSchema.optional(),
  mileageKm: z.number().int().min(0).max(2_000_000).optional(),
  priceFen: z.number().int().min(1).max(100_000_000).optional(),
  guidePriceFen: z.number().int().min(1).max(100_000_000).nullable().optional(),
  originalPriceFen: z.number().int().min(0).max(100_000_000).nullable().optional(),
  location: z.string().trim().min(1).max(100).optional(),
  exteriorColor: z.string().trim().min(1).max(40).optional(),
  color: z.string().trim().min(1).max(40).optional(),
  interiorColor: z.string().trim().min(1).max(40).optional(),
  transferCount: z.number().int().min(0).max(30).optional(),
  energyType: energyTypeSchema.optional(),
  transmission: transmissionSchema.optional(),
  seats: z.number().int().min(1).max(20).optional(),
  highlights: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
  conditionSummary: z.string().trim().max(2_000).optional(),
  defectsDisclosure: z.union([
    z.array(z.string().trim().min(1).max(300)).max(30),
    z.string().trim().max(3_000),
  ]).optional(),
  defects: z.union([
    z.array(z.string().trim().min(1).max(300)).max(30),
    z.string().trim().max(3_000),
  ]).optional(),
  description: z.string().trim().max(5_000).optional(),
  status: listingStatusSchema.optional(),
  dataKind: z.enum(["synthetic_demo", "company_inventory"]).optional(),
  featured: z.boolean().optional(),
  isFeatured: z.boolean().optional(),
  sortOrder: z.number().int().min(-10_000).max(10_000).optional(),
  sortPriority: z.number().int().min(-10_000).max(10_000).optional(),
  publishedAt: z.string().datetime().nullable().optional(),
}).refine((value) => Object.keys(value).length > 0, "至少提供一个要更新的字段");

const imageOrderSchema = z.object({
  images: z.array(z.object({
    id: idSchema,
    sortOrder: z.number().int().min(0).max(10_000),
    isCover: z.boolean().optional(),
  })).min(1).max(100),
}).superRefine((value, context) => {
  if (value.images.filter((item) => item.isCover).length > 1) {
    context.addIssue({ code: "custom", path: ["images"], message: "一辆车只能设置一张封面图" });
  }
  if (new Set(value.images.map((item) => item.id)).size !== value.images.length) {
    context.addIssue({ code: "custom", path: ["images"], message: "图片不能重复" });
  }
});

const imagePatchSchema = z.object({
  sortOrder: z.number().int().min(0).max(10_000).optional(),
  isCover: z.boolean().optional(),
}).refine((value) => Object.keys(value).length > 0, "至少提供一个要更新的字段");

function validationFields(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "body";
    if (!fields[key]) fields[key] = issue.message;
  }
  return fields;
}

function parseBody<T>(schema: z.ZodType<T>, body: unknown, reply: FastifyReply): T | undefined {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  reply.status(400).send({
    error: { code: "VALIDATION_ERROR", message: "二手车信息有误，请检查后重试", fields: validationFields(parsed.error) },
  });
  return undefined;
}

function bool(value: unknown): boolean {
  return Number(value) === 1 || value === true;
}

function jsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function normalizeTextList(value: string[] | string | undefined, fallback: string[] = []): string[] {
  if (value === undefined) return fallback;
  if (Array.isArray(value)) return value;
  return value.split(/[\n，,]/u).map((item) => item.trim()).filter(Boolean);
}

async function findBrand(database: AppDatabase, id: string, forUpdate = false): Promise<Row | undefined> {
  return database.prepare<Row>(`SELECT * FROM used_car_brands WHERE id = ?${forUpdate ? " FOR UPDATE" : ""}`).get(id);
}

async function findModel(database: AppDatabase, id: string, forUpdate = false): Promise<Row | undefined> {
  return database.prepare<Row>(`SELECT * FROM used_car_models WHERE id = ?${forUpdate ? " FOR UPDATE" : ""}`).get(id);
}

function listingSelect(where = ""): string {
  return `
    SELECT l.*,
      m.brand_id, m.name AS model_name, m.body_type AS model_body_type,
      m.energy_type AS model_energy_type, m.cover_image_url AS model_cover_image_url,
      m.is_active AS model_is_active,
      b.name AS brand_name, b.logo_url AS brand_logo_url, b.initial AS brand_initial,
      b.is_hot AS brand_is_hot, b.is_active AS brand_is_active
    FROM used_car_listings l
    JOIN used_car_models m ON m.id = l.model_id
    JOIN used_car_brands b ON b.id = m.brand_id
    ${where}
  `;
}

async function findListing(database: AppDatabase, id: string, forUpdate = false): Promise<Row | undefined> {
  const lockClause = forUpdate ? " FOR UPDATE OF l" : "";
  return database.prepare<Row>(`${listingSelect("WHERE l.id = ?")}${lockClause}`).get(id);
}

async function findImage(database: AppDatabase, id: string, forUpdate = false): Promise<Row | undefined> {
  return database.prepare<Row>(
    `SELECT * FROM used_car_listing_images WHERE id = ?${forUpdate ? " FOR UPDATE" : ""}`,
  ).get(id);
}

function dataKind(row: Row): "synthetic_demo" | "company_inventory" | "operated" {
  if (row.data_kind === "synthetic_demo") return "synthetic_demo";
  if (row.data_kind === "company_inventory") return "company_inventory";
  return bool(row.is_synthetic) ? "synthetic_demo" : "operated";
}

function brandFromRow(row: Row, listingCount = 0, models?: unknown[]) {
  return {
    id: String(row.id),
    name: String(row.name),
    initial: String(row.initial),
    logoUrl: row.logo_url == null ? null : String(row.logo_url),
    isHot: bool(row.is_hot),
    listingCount,
    ...(models ? { models } : {}),
    sortOrder: Number(row.sort_order),
    isActive: bool(row.is_active),
    isSynthetic: bool(row.is_synthetic),
    dataKind: dataKind(row),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function modelFromRow(row: Row, listingCount = 0) {
  return {
    id: String(row.id),
    brandId: String(row.brand_id),
    name: String(row.name),
    bodyType: String(row.body_type),
    energyType: String(row.energy_type),
    coverImageUrl: row.cover_image_url == null ? null : String(row.cover_image_url),
    listingCount,
    sortOrder: Number(row.sort_order),
    isActive: bool(row.is_active),
    isSynthetic: bool(row.is_synthetic),
    dataKind: dataKind(row),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function imageFromRow(row: Row, admin = false) {
  const stored = !bool(row.is_synthetic) && row.storage_key != null && String(row.storage_key).length > 0;
  const syntheticUrl = bool(row.is_synthetic) && row.image_url != null ? String(row.image_url) : null;
  return {
    id: String(row.id),
    url: syntheticUrl ?? `${admin ? "/api/admin" : "/api"}/used-cars/images/${String(row.id)}`,
    mimeType: String(row.mime_type),
    sizeBytes: Number(row.size_bytes),
    width: Number(row.width),
    height: Number(row.height),
    sortOrder: Number(row.sort_order),
    isCover: bool(row.is_cover),
    isStored: stored,
    isSynthetic: bool(row.is_synthetic),
    dataKind: dataKind(row),
    createdAt: String(row.created_at),
  };
}

async function listingImages(database: AppDatabase, listingId: string, admin = false) {
  const rows = await database.prepare<Row>(`
    SELECT * FROM used_car_listing_images
    WHERE listing_id = ?
    ORDER BY is_cover DESC, sort_order, created_at, id
  `).all(listingId);
  return rows.map((row) => imageFromRow(row, admin));
}

async function listingFromRow(database: AppDatabase, row: Row, admin = false) {
  const images = await listingImages(database, String(row.id), admin);
  const coverImageUrl = images.find((image) => image.isCover)?.url
    ?? images[0]?.url
    ?? (row.model_cover_image_url == null ? null : String(row.model_cover_image_url));
  return {
    id: String(row.id),
    stockNo: String(row.stock_no),
    title: String(row.title),
    trimName: String(row.trim_name || row.title),
    trim: String(row.trim_name || row.title),
    brandId: String(row.brand_id),
    brandName: String(row.brand_name),
    brand: {
      id: String(row.brand_id),
      name: String(row.brand_name),
      initial: String(row.brand_initial),
      logoUrl: row.brand_logo_url == null ? null : String(row.brand_logo_url),
      isHot: bool(row.brand_is_hot),
    },
    modelId: String(row.model_id),
    modelName: String(row.model_name),
    model: {
      id: String(row.model_id),
      name: String(row.model_name),
      bodyType: String(row.model_body_type),
      energyType: String(row.model_energy_type),
    },
    modelYear: Number(row.model_year),
    registrationDate: String(row.registration_date),
    mileageKm: Number(row.mileage_km),
    priceFen: Number(row.price_fen),
    guidePriceFen: row.original_price_fen == null ? null : Number(row.original_price_fen),
    originalPriceFen: row.original_price_fen == null ? null : Number(row.original_price_fen),
    location: String(row.location),
    exteriorColor: String(row.exterior_color),
    color: String(row.exterior_color),
    interiorColor: String(row.interior_color ?? "未录入"),
    transferCount: Number(row.transfer_count ?? 0),
    energyType: String(row.energy_type),
    transmission: String(row.transmission),
    seats: Number(row.seats),
    highlights: jsonArray(row.highlights_json),
    conditionSummary: String(row.condition_summary ?? row.description ?? ""),
    defectsDisclosure: jsonArray(row.defects_json),
    defects: jsonArray(row.defects_json),
    description: String(row.description),
    status: String(row.status),
    sortPriority: Number(row.sort_priority),
    sortOrder: Number(row.sort_priority),
    featured: bool(row.is_featured),
    isFeatured: bool(row.is_featured),
    coverImageUrl,
    imageCount: images.length,
    images,
    isSynthetic: bool(row.is_synthetic),
    dataKind: dataKind(row),
    publishedAt: row.published_at == null ? null : String(row.published_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function numberQuery(value: unknown, fallback: number, min: number, max: number): number | undefined {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return undefined;
  return parsed;
}

function optionalNumberQuery(value: unknown, min: number, max: number): number | null | undefined {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return undefined;
  return parsed;
}

async function assertModelAvailable(database: AppDatabase, id: string, problem: ProblemFactory): Promise<Row> {
  const model = await findModel(database, id);
  if (!model) throw problem(404, "USED_CAR_MODEL_NOT_FOUND", "未找到该二手车车型");
  return model;
}

async function uniqueStockNumber(database: AppDatabase, stockNo: string, excludeId?: string): Promise<boolean> {
  const row = excludeId
    ? await database.prepare("SELECT id FROM used_car_listings WHERE stock_no = ? AND id <> ?").get(stockNo, excludeId)
    : await database.prepare("SELECT id FROM used_car_listings WHERE stock_no = ?").get(stockNo);
  return !row;
}

async function removeStoredImage(uploadRoot: string, row: Row): Promise<void> {
  if (row.storage_key == null) return;
  try {
    await unlink(join(uploadRoot, String(row.storage_key)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function multipartField(part: any, name: string): string | undefined {
  const field = part?.fields?.[name];
  if (!field) return undefined;
  if (Array.isArray(field)) {
    const first = field[0];
    return first && "value" in first ? String(first.value) : undefined;
  }
  return "value" in field ? String(field.value) : undefined;
}

async function receiveProcessedImage(request: unknown, problem: ProblemFactory) {
  let part: any;
  try {
    part = await (request as { file: () => Promise<any> }).file();
  } catch {
    throw problem(413, "USED_CAR_IMAGE_TOO_LARGE", "单张图片不能超过 10MB");
  }
  if (!part) throw problem(400, "USED_CAR_IMAGE_REQUIRED", "请选择要上传的图片");
  if (!/^image\/(jpeg|png|webp)$/i.test(part.mimetype)) {
    throw problem(415, "USED_CAR_IMAGE_TYPE_INVALID", "仅支持 JPEG、PNG 或 WebP 图片");
  }
  let source: Buffer;
  try {
    source = await part.toBuffer();
  } catch {
    throw problem(413, "USED_CAR_IMAGE_TOO_LARGE", "单张图片不能超过 10MB");
  }
  if (source.length > 10 * 1024 * 1024) throw problem(413, "USED_CAR_IMAGE_TOO_LARGE", "单张图片不能超过 10MB");
  try {
    const metadata = await sharp(source, { failOn: "error", limitInputPixels: 40_000_000 }).metadata();
    if (!metadata.format || !["jpeg", "png", "webp"].includes(metadata.format)) {
      throw new Error("unsupported image format");
    }
    const processed = await sharp(source, { failOn: "error", limitInputPixels: 40_000_000 })
      .rotate()
      .resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 86, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    return { part, data: processed.data, info: processed.info };
  } catch {
    throw problem(400, "USED_CAR_IMAGE_INVALID", "图片损坏或无法识别，请重新选择");
  }
}

export async function registerUsedCarRoutes(
  app: FastifyInstance,
  database: AppDatabase,
  options: UsedCarRouteOptions,
): Promise<void> {
  const { problem } = options;
  const imageUploadDir = join(options.uploadDir, "used-cars");
  const brandLogoDir = join(imageUploadDir, "logos");
  await mkdir(imageUploadDir, { recursive: true });
  await mkdir(brandLogoDir, { recursive: true });

  app.addHook("onRequest", async (request, reply) => {
    if (
      request.url.startsWith("/api/admin/used-cars")
      && !["GET", "HEAD", "OPTIONS"].includes(request.method)
    ) {
      return reply.status(410).send({
        error: {
          code: "USED_CAR_MARKET_READ_ONLY",
          message: "二手车市场已由汽车租赁替代，历史数据仅保留只读查询",
        },
      });
    }
  });

  app.get("/api/used-cars/catalog", async () => {
    const brands = await database.prepare<Row>(`
      SELECT b.*, COUNT(l.id) AS listing_count
      FROM used_car_brands b
      LEFT JOIN used_car_models m ON m.brand_id = b.id AND m.is_active = 1
      LEFT JOIN used_car_listings l ON l.model_id = m.id AND l.status = 'on_sale'
      WHERE b.is_active = 1
      GROUP BY b.id
      ORDER BY b.initial, b.sort_order DESC, b.name, b.id
    `).all();
    const models = await database.prepare<Row>(`
      SELECT m.*, COUNT(l.id) AS listing_count
      FROM used_car_models m
      JOIN used_car_brands b ON b.id = m.brand_id AND b.is_active = 1
      LEFT JOIN used_car_listings l ON l.model_id = m.id AND l.status = 'on_sale'
      WHERE m.is_active = 1
      GROUP BY m.id
      ORDER BY m.sort_order DESC, m.name, m.id
    `).all();
    const modelsByBrand = new Map<string, ReturnType<typeof modelFromRow>[]>();
    for (const row of models) {
      const brandId = String(row.brand_id);
      const current = modelsByBrand.get(brandId) ?? [];
      current.push(modelFromRow(row, Number(row.listing_count)));
      modelsByBrand.set(brandId, current);
    }
    const brandDtos = brands.map((row) => brandFromRow(
      row,
      Number(row.listing_count),
      modelsByBrand.get(String(row.id)) ?? [],
    ));
    const grouped = new Map<string, typeof brandDtos>();
    for (const brand of brandDtos) {
      const current = grouped.get(brand.initial) ?? [];
      current.push(brand);
      grouped.set(brand.initial, current);
    }
    return {
      data: {
        groups: [...grouped.entries()].map(([initial, groupBrands]) => ({ initial, brands: groupBrands })),
        hotBrands: brandDtos
          .filter((brand) => brand.isHot)
          .sort((left, right) => (hotBrandPriority.get(left.id) ?? 99) - (hotBrandPriority.get(right.id) ?? 99)),
        dataKind: "synthetic_demo",
      },
    };
  });

  app.get<{ Querystring: Record<string, string | undefined> }>("/api/used-cars/listings", async (request, reply) => {
    const page = numberQuery(request.query.page, 1, 1, 100_000);
    const pageSize = numberQuery(request.query.pageSize, 12, 1, 50);
    const priceMinFen = optionalNumberQuery(request.query.priceMinFen, 0, 100_000_000);
    const priceMaxFen = optionalNumberQuery(request.query.priceMaxFen, 0, 100_000_000);
    const maxMileageKm = optionalNumberQuery(request.query.maxMileageKm, 0, 2_000_000);
    const maxAgeYears = optionalNumberQuery(request.query.maxAgeYears, 0, 100);
    if ([page, pageSize, priceMinFen, priceMaxFen, maxMileageKm, maxAgeYears].some((value) => value === undefined)) {
      return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: "分页或筛选参数无效" } });
    }
    if (priceMinFen != null && priceMaxFen != null && priceMinFen > priceMaxFen) {
      return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: "最低价不能高于最高价" } });
    }
    const energyType = request.query.energyType;
    if (energyType && !energyTypeSchema.safeParse(energyType).success) {
      return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: "能源类型无效" } });
    }
    if (request.query.bodyType && !bodyTypeSchema.safeParse(request.query.bodyType).success) {
      return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: "车身类型无效" } });
    }
    const sort = request.query.sort ?? "recommended";
    const sortSql: Record<string, string> = {
      recommended: "l.sort_priority DESC, l.published_at DESC, l.id",
      price_asc: "l.price_fen ASC, l.sort_priority DESC, l.id",
      price_desc: "l.price_fen DESC, l.sort_priority DESC, l.id",
      mileage_asc: "l.mileage_km ASC, l.sort_priority DESC, l.id",
      newest: "l.registration_date DESC, l.published_at DESC, l.id",
    };
    if (!sortSql[sort]) {
      return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: "排序方式无效" } });
    }
    const where = ["l.status = 'on_sale'", "m.is_active = 1", "b.is_active = 1"];
    const parameters: Array<string | number> = [];
    const add = (condition: string, value: string | number | null) => {
      if (value === null || value === "") return;
      where.push(condition);
      parameters.push(value);
    };
    add("b.id = ?", request.query.brandId ?? null);
    add("m.id = ?", request.query.modelId ?? null);
    add("l.energy_type = ?", energyType ?? null);
    add("m.body_type = ?", request.query.bodyType ?? null);
    add("l.price_fen >= ?", priceMinFen ?? null);
    add("l.price_fen <= ?", priceMaxFen ?? null);
    add("l.mileage_km <= ?", maxMileageKm ?? null);
    if (maxAgeYears != null) add("l.model_year >= ?", new Date().getFullYear() - maxAgeYears);
    if (request.query.keyword?.trim()) {
      where.push("(l.title ILIKE ? OR b.name ILIKE ? OR m.name ILIKE ?)");
      const keyword = `%${request.query.keyword.trim()}%`;
      parameters.push(keyword, keyword, keyword);
    }
    const whereSql = `WHERE ${where.join(" AND ")}`;
    const totalRow = await database.prepare<Row>(`
      SELECT COUNT(*) AS count
      FROM used_car_listings l
      JOIN used_car_models m ON m.id = l.model_id
      JOIN used_car_brands b ON b.id = m.brand_id
      ${whereSql}
    `).get(...parameters);
    const total = Number(totalRow?.count ?? 0);
    const rows = await database.prepare<Row>(`${listingSelect(whereSql)} ORDER BY ${sortSql[sort]} LIMIT ? OFFSET ?`)
      .all(...parameters, pageSize!, (page! - 1) * pageSize!);
    return {
      data: { items: await Promise.all(rows.map((row) => listingFromRow(database, row))), total, page, pageSize },
    };
  });

  app.get<{ Params: { id: string } }>("/api/used-cars/listings/:id", async (request) => {
    const row = await findListing(database, request.params.id);
    if (!row || String(row.status) !== "on_sale" || !bool(row.model_is_active) || !bool(row.brand_is_active)) {
      throw problem(404, "USED_CAR_NOT_AVAILABLE", "该二手车车源不存在或已下架");
    }
    return { data: await listingFromRow(database, row) };
  });

  const sendImage = async (id: string, reply: FastifyReply, publicOnly: boolean) => {
    const row = await database.prepare<Row>(`
      SELECT i.*, l.status, m.is_active AS model_is_active, b.is_active AS brand_is_active
      FROM used_car_listing_images i
      JOIN used_car_listings l ON l.id = i.listing_id
      JOIN used_car_models m ON m.id = l.model_id
      JOIN used_car_brands b ON b.id = m.brand_id
      WHERE i.id = ?
    `).get(id);
    if (!row || (publicOnly && (String(row.status) !== "on_sale" || !bool(row.model_is_active) || !bool(row.brand_is_active)))) {
      throw problem(404, "USED_CAR_IMAGE_NOT_AVAILABLE", "图片不存在或车源已下架");
    }
    if (bool(row.is_synthetic) && row.image_url != null) return reply.redirect(String(row.image_url));
    if (row.storage_key == null) throw problem(404, "USED_CAR_IMAGE_NOT_AVAILABLE", "图片文件不存在");
    reply.type(String(row.mime_type)).header("Cache-Control", publicOnly ? "public, max-age=86400" : "private, max-age=3600");
    return reply.send(createReadStream(join(imageUploadDir, String(row.storage_key))));
  };

  app.get<{ Params: { id: string } }>("/api/used-cars/images/:id", async (request, reply) => (
    sendImage(request.params.id, reply, true)
  ));

  const sendBrandLogo = async (id: string, reply: FastifyReply, publicOnly: boolean) => {
    const row = await findBrand(database, id);
    if (!row || (publicOnly && !bool(row.is_active))) {
      throw problem(404, "USED_CAR_BRAND_LOGO_NOT_AVAILABLE", "品牌标识不存在");
    }
    const logoUrl = String(row.logo_url);
    const managedUrl = `/api/used-cars/brands/${id}/logo`;
    if (logoUrl !== managedUrl) return reply.redirect(logoUrl);
    reply.type("image/jpeg").header("Cache-Control", publicOnly ? "public, max-age=86400" : "private, max-age=3600");
    return reply.send(createReadStream(join(brandLogoDir, `${id}.jpg`)));
  };

  app.get<{ Params: { id: string } }>("/api/used-cars/brands/:id/logo", async (request, reply) => (
    sendBrandLogo(request.params.id, reply, true)
  ));

  app.get("/api/admin/used-cars/brands", async () => {
    const rows = await database.prepare<Row>(`
      SELECT b.*,
        (SELECT COUNT(*) FROM used_car_models m WHERE m.brand_id = b.id) AS model_count,
        (SELECT COUNT(*) FROM used_car_listings l JOIN used_car_models m ON m.id = l.model_id WHERE m.brand_id = b.id) AS listing_count
      FROM used_car_brands b ORDER BY b.initial, b.sort_order DESC, b.name, b.id
    `).all();
    return { data: rows.map((row) => ({ ...brandFromRow(row, Number(row.listing_count)), modelCount: Number(row.model_count) })) };
  });

  app.get<{ Params: { id: string } }>("/api/admin/used-cars/brands/:id", async (request) => {
    const row = await findBrand(database, request.params.id);
    if (!row) throw problem(404, "USED_CAR_BRAND_NOT_FOUND", "未找到该二手车品牌");
    return { data: brandFromRow(row) };
  });

  app.get<{ Params: { id: string } }>("/api/admin/used-cars/brands/:id/logo", async (request, reply) => (
    sendBrandLogo(request.params.id, reply, false)
  ));

  app.post<{ Params: { id: string } }>("/api/admin/used-cars/brands/:id/logo", async (request, reply) => {
    const row = await findBrand(database, request.params.id);
    if (!row) throw problem(404, "USED_CAR_BRAND_NOT_FOUND", "未找到该二手车品牌");
    const processed = await receiveProcessedImage(request, problem);
    const filename = `${request.params.id}.jpg`;
    await writeFile(join(brandLogoDir, filename), processed.data);
    await database.prepare("UPDATE used_car_brands SET logo_url = ?, updated_at = ? WHERE id = ?")
      .run(`/api/used-cars/brands/${request.params.id}/logo`, new Date().toISOString(), request.params.id);
    const updated = await findBrand(database, request.params.id);
    if (!updated) throw problem(404, "USED_CAR_BRAND_NOT_FOUND", "未找到该二手车品牌");
    return reply.status(201).send({ data: brandFromRow(updated) });
  });

  app.delete<{ Params: { id: string } }>("/api/admin/used-cars/brands/:id/logo", async (request) => {
    const row = await findBrand(database, request.params.id);
    if (!row) throw problem(404, "USED_CAR_BRAND_NOT_FOUND", "未找到该二手车品牌");
    try {
      await unlink(join(brandLogoDir, `${request.params.id}.jpg`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const fallback = `/assets/used-cars/logos/${request.params.id}.webp`;
    await database.prepare("UPDATE used_car_brands SET logo_url = ?, updated_at = ? WHERE id = ?")
      .run(fallback, new Date().toISOString(), request.params.id);
    const updated = await findBrand(database, request.params.id);
    if (!updated) throw problem(404, "USED_CAR_BRAND_NOT_FOUND", "未找到该二手车品牌");
    return { data: brandFromRow(updated) };
  });

  app.post("/api/admin/used-cars/brands", async (request, reply) => {
    const body = parseBody(brandSchema, request.body, reply);
    if (!body) return;
    const id = body.id ?? `brand-${randomUUID()}`;
    if (await findBrand(database, id)) throw problem(409, "USED_CAR_BRAND_ID_EXISTS", "品牌 ID 已存在");
    if (await database.prepare("SELECT id FROM used_car_brands WHERE name = ?").get(body.name)) {
      throw problem(409, "USED_CAR_BRAND_NAME_EXISTS", "品牌名称已存在");
    }
    const now = new Date().toISOString();
    const logoUrl = body.logoUrl ?? `/assets/used-cars/logos/${id}.webp`;
    await database.prepare(`
      INSERT INTO used_car_brands (
        id, name, logo_url, initial, is_hot, sort_order, is_active, is_synthetic, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(id, body.name, logoUrl, body.initial, body.isHot ? 1 : 0, body.sortOrder, body.isActive ? 1 : 0, now, now);
    const row = await findBrand(database, id);
    if (!row) throw problem(500, "USED_CAR_BRAND_CREATE_FAILED", "二手车品牌创建失败");
    return reply.status(201).send({ data: brandFromRow(row) });
  });

  app.put<{ Params: { id: string } }>("/api/admin/used-cars/brands/:id", async (request, reply) => {
    const body = parseBody(brandSchema.omit({ id: true }), request.body, reply);
    if (!body) return;
    const current = await findBrand(database, request.params.id);
    if (!current) throw problem(404, "USED_CAR_BRAND_NOT_FOUND", "未找到该二手车品牌");
    if (await database.prepare("SELECT id FROM used_car_brands WHERE name = ? AND id <> ?").get(body.name, request.params.id)) {
      throw problem(409, "USED_CAR_BRAND_NAME_EXISTS", "品牌名称已存在");
    }
    await database.prepare(`
      UPDATE used_car_brands SET name = ?, logo_url = ?, initial = ?, is_hot = ?, sort_order = ?,
        is_active = ?, updated_at = ? WHERE id = ?
    `).run(body.name, body.logoUrl ?? String(current.logo_url), body.initial, body.isHot ? 1 : 0, body.sortOrder, body.isActive ? 1 : 0, new Date().toISOString(), request.params.id);
    const updated = await findBrand(database, request.params.id);
    if (!updated) throw problem(404, "USED_CAR_BRAND_NOT_FOUND", "未找到该二手车品牌");
    return { data: brandFromRow(updated) };
  });

  app.delete<{ Params: { id: string } }>("/api/admin/used-cars/brands/:id", async (request) => {
    const row = await database.transaction(async (tx) => {
      const current = await findBrand(tx, request.params.id, true);
      if (!current) throw problem(404, "USED_CAR_BRAND_NOT_FOUND", "未找到该二手车品牌");
      const inUse = await tx.prepare("SELECT id FROM used_car_models WHERE brand_id = ? LIMIT 1").get(request.params.id);
      if (inUse) throw problem(409, "USED_CAR_BRAND_IN_USE", "品牌下仍有车型，请先停用或删除车型");
      await tx.prepare("DELETE FROM used_car_brands WHERE id = ?").run(request.params.id);
      return current;
    });
    if (String(row.logo_url) === `/api/used-cars/brands/${request.params.id}/logo`) {
      try {
        await unlink(join(brandLogoDir, `${request.params.id}.jpg`));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return { data: { id: request.params.id, deleted: true } };
  });

  app.get<{ Querystring: { brandId?: string; includeInactive?: string } }>("/api/admin/used-cars/models", async (request) => {
    const where: string[] = [];
    const parameters: string[] = [];
    if (request.query.brandId) { where.push("m.brand_id = ?"); parameters.push(request.query.brandId); }
    if (request.query.includeInactive === "false") where.push("m.is_active = 1");
    const rows = await database.prepare<Row>(`
      SELECT m.*, b.name AS brand_name,
        (SELECT COUNT(*) FROM used_car_listings l WHERE l.model_id = m.id) AS listing_count
      FROM used_car_models m JOIN used_car_brands b ON b.id = m.brand_id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY b.initial, b.sort_order DESC, m.sort_order DESC, m.name, m.id
    `).all(...parameters);
    return { data: rows.map((row) => ({ ...modelFromRow(row, Number(row.listing_count)), brandName: String(row.brand_name) })) };
  });

  app.get<{ Params: { id: string } }>("/api/admin/used-cars/models/:id", async (request) => {
    const row = await findModel(database, request.params.id);
    if (!row) throw problem(404, "USED_CAR_MODEL_NOT_FOUND", "未找到该二手车车型");
    return { data: modelFromRow(row) };
  });

  app.post("/api/admin/used-cars/models", async (request, reply) => {
    const body = parseBody(modelSchema, request.body, reply);
    if (!body) return;
    if (!await findBrand(database, body.brandId)) throw problem(404, "USED_CAR_BRAND_NOT_FOUND", "未找到该二手车品牌");
    const id = body.id ?? `model-${randomUUID()}`;
    if (await findModel(database, id)) throw problem(409, "USED_CAR_MODEL_ID_EXISTS", "车型 ID 已存在");
    if (await database.prepare("SELECT id FROM used_car_models WHERE brand_id = ? AND name = ?").get(body.brandId, body.name)) {
      throw problem(409, "USED_CAR_MODEL_NAME_EXISTS", "该品牌下车型名称已存在");
    }
    const now = new Date().toISOString();
    await database.prepare(`
      INSERT INTO used_car_models (
        id, brand_id, name, body_type, energy_type, cover_image_url, sort_order,
        is_active, is_synthetic, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(id, body.brandId, body.name, body.bodyType, body.energyType, body.coverImageUrl ?? null, body.sortOrder, body.isActive ? 1 : 0, now, now);
    const row = await findModel(database, id);
    if (!row) throw problem(500, "USED_CAR_MODEL_CREATE_FAILED", "二手车车型创建失败");
    return reply.status(201).send({ data: modelFromRow(row) });
  });

  app.put<{ Params: { id: string } }>("/api/admin/used-cars/models/:id", async (request, reply) => {
    const body = parseBody(modelSchema.omit({ id: true }), request.body, reply);
    if (!body) return;
    if (!await findModel(database, request.params.id)) throw problem(404, "USED_CAR_MODEL_NOT_FOUND", "未找到该二手车车型");
    if (!await findBrand(database, body.brandId)) throw problem(404, "USED_CAR_BRAND_NOT_FOUND", "未找到该二手车品牌");
    if (await database.prepare("SELECT id FROM used_car_models WHERE brand_id = ? AND name = ? AND id <> ?")
      .get(body.brandId, body.name, request.params.id)) {
      throw problem(409, "USED_CAR_MODEL_NAME_EXISTS", "该品牌下车型名称已存在");
    }
    await database.prepare(`
      UPDATE used_car_models SET brand_id = ?, name = ?, body_type = ?, energy_type = ?, cover_image_url = ?,
        sort_order = ?, is_active = ?, updated_at = ? WHERE id = ?
    `).run(body.brandId, body.name, body.bodyType, body.energyType, body.coverImageUrl ?? null, body.sortOrder, body.isActive ? 1 : 0, new Date().toISOString(), request.params.id);
    const updated = await findModel(database, request.params.id);
    if (!updated) throw problem(404, "USED_CAR_MODEL_NOT_FOUND", "未找到该二手车车型");
    return { data: modelFromRow(updated) };
  });

  app.delete<{ Params: { id: string } }>("/api/admin/used-cars/models/:id", async (request) => {
    await database.transaction(async (tx) => {
      if (!await findModel(tx, request.params.id, true)) {
        throw problem(404, "USED_CAR_MODEL_NOT_FOUND", "未找到该二手车车型");
      }
      const inUse = await tx.prepare("SELECT id FROM used_car_listings WHERE model_id = ? LIMIT 1").get(request.params.id);
      if (inUse) throw problem(409, "USED_CAR_MODEL_IN_USE", "车型下仍有车源，请先停用或删除车源");
      await tx.prepare("DELETE FROM used_car_models WHERE id = ?").run(request.params.id);
    });
    return { data: { id: request.params.id, deleted: true } };
  });

  app.get<{ Querystring: Record<string, string | undefined> }>("/api/admin/used-cars/listings", async (request, reply) => {
    const page = numberQuery(request.query.page, 1, 1, 100_000);
    const pageSize = numberQuery(request.query.pageSize, 20, 1, 100);
    if (page === undefined || pageSize === undefined) {
      return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: "分页参数无效" } });
    }
    const where: string[] = [];
    const parameters: string[] = [];
    if (request.query.brandId) { where.push("b.id = ?"); parameters.push(request.query.brandId); }
    if (request.query.modelId) { where.push("m.id = ?"); parameters.push(request.query.modelId); }
    if (request.query.status) {
      if (!listingStatusSchema.safeParse(request.query.status).success) {
        return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: "车源状态无效" } });
      }
      where.push("l.status = ?"); parameters.push(request.query.status);
    }
    if (request.query.keyword?.trim()) {
      where.push("(l.title ILIKE ? OR l.stock_no ILIKE ? OR b.name ILIKE ? OR m.name ILIKE ?)");
      const keyword = `%${request.query.keyword.trim()}%`;
      parameters.push(keyword, keyword, keyword, keyword);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const totalRow = await database.prepare<Row>(`
      SELECT COUNT(*) AS count FROM used_car_listings l
      JOIN used_car_models m ON m.id = l.model_id JOIN used_car_brands b ON b.id = m.brand_id ${whereSql}
    `).get(...parameters);
    const total = Number(totalRow?.count ?? 0);
    const rows = await database.prepare<Row>(`${listingSelect(whereSql)} ORDER BY l.updated_at DESC, l.id LIMIT ? OFFSET ?`)
      .all(...parameters, pageSize, (page - 1) * pageSize);
    return {
      data: { items: await Promise.all(rows.map((row) => listingFromRow(database, row, true))), total, page, pageSize },
    };
  });

  app.get<{ Params: { id: string } }>("/api/admin/used-cars/listings/:id", async (request) => {
    const row = await findListing(database, request.params.id);
    if (!row) throw problem(404, "USED_CAR_LISTING_NOT_FOUND", "未找到该二手车车源");
    return { data: await listingFromRow(database, row, true) };
  });

  app.post("/api/admin/used-cars/listings", async (request, reply) => {
    const body = parseBody(createListingSchema, request.body, reply);
    if (!body) return;
    const id = body.id ?? `listing-${randomUUID()}`;
    const now = new Date().toISOString();
    const publishedAt = body.status === "on_sale" ? (body.publishedAt ?? now) : (body.publishedAt ?? null);
    const guidePriceFen = body.guidePriceFen !== undefined ? body.guidePriceFen : (body.originalPriceFen ?? null);
    const exteriorColor = body.color ?? body.exteriorColor!;
    const trimName = body.trimName ?? body.trim ?? body.title;
    const conditionSummary = body.conditionSummary ?? body.description;
    const defects = normalizeTextList(body.defectsDisclosure ?? body.defects);
    const dataKindValue = body.dataKind ?? "company_inventory";
    const featured = body.featured ?? body.isFeatured ?? false;
    const sortPriority = body.sortOrder ?? body.sortPriority;
    const listing = await database.transaction(async (tx) => {
      await tx.prepare("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))").get(`used-car-stock:${body.stockNo}`);
      const model = await assertModelAvailable(tx, body.modelId, problem);
      if (body.energyType !== String(model.energy_type)) {
        throw problem(400, "USED_CAR_ENERGY_TYPE_MISMATCH", "车源能源类型必须与所选车型一致", {
          energyType: `所选车型能源类型为 ${String(model.energy_type)}`,
        });
      }
      if (await findListing(tx, id)) throw problem(409, "USED_CAR_LISTING_ID_EXISTS", "车源 ID 已存在");
      if (!await uniqueStockNumber(tx, body.stockNo)) throw problem(409, "USED_CAR_STOCK_NO_EXISTS", "库存编号已存在");
      await tx.prepare(`
        INSERT INTO used_car_listings (
          id, stock_no, model_id, title, trim_name, model_year, registration_date, mileage_km,
          price_fen, original_price_fen, location, exterior_color, interior_color,
          transfer_count, energy_type, transmission, seats, highlights_json, condition_summary,
          defects_json, description, status, sort_priority, is_featured, data_kind, is_synthetic,
          published_at, created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
      `).run(
        id, body.stockNo, body.modelId, body.title, trimName, body.modelYear, body.registrationDate,
        body.mileageKm, body.priceFen, guidePriceFen, body.location,
        exteriorColor, body.interiorColor, body.transferCount ?? 0, body.energyType, body.transmission, body.seats,
        JSON.stringify(body.highlights), conditionSummary, JSON.stringify(defects), body.description,
        body.status, sortPriority, featured ? 1 : 0, dataKindValue, dataKindValue === "synthetic_demo" ? 1 : 0,
        publishedAt, now, now,
      );
      const row = await findListing(tx, id);
      if (!row) throw problem(500, "USED_CAR_LISTING_CREATE_FAILED", "二手车车源创建失败");
      return listingFromRow(tx, row, true);
    });
    return reply.status(201).send({ data: listing });
  });

  const updateListing = async (
    id: string,
    values: z.infer<typeof updateListingSchema>,
    targetDatabase: AppDatabase = database,
  ) => {
    return targetDatabase.transaction(async (tx) => {
      const current = await findListing(tx, id, true);
      if (!current) throw problem(404, "USED_CAR_LISTING_NOT_FOUND", "未找到该二手车车源");
      await tx.prepare("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))").get(`used-car-stock:${values.stockNo}`);
      const model = await assertModelAvailable(tx, values.modelId, problem);
      if (values.energyType !== String(model.energy_type)) {
        throw problem(400, "USED_CAR_ENERGY_TYPE_MISMATCH", "车源能源类型必须与所选车型一致", {
          energyType: `所选车型能源类型为 ${String(model.energy_type)}`,
        });
      }
      if (!await uniqueStockNumber(tx, values.stockNo, id)) {
        throw problem(409, "USED_CAR_STOCK_NO_EXISTS", "库存编号已存在");
      }
      const now = new Date().toISOString();
      const existingPublishedAt = current.published_at == null ? null : String(current.published_at);
      const publishedAt = values.status === "on_sale"
        ? (values.publishedAt ?? existingPublishedAt ?? now)
        : (values.publishedAt ?? existingPublishedAt);
      const guidePriceFen = values.guidePriceFen !== undefined
        ? values.guidePriceFen
        : values.originalPriceFen !== undefined
          ? values.originalPriceFen
          : current.original_price_fen == null ? null : Number(current.original_price_fen);
      if (guidePriceFen != null && guidePriceFen < values.priceFen) {
        throw problem(400, "VALIDATION_ERROR", "新车指导价不能低于当前售价", { guidePriceFen: "不能低于当前售价" });
      }
      const trimName = values.trimName ?? values.trim ?? String(current.trim_name || values.title);
      const exteriorColor = values.color ?? values.exteriorColor ?? String(current.exterior_color);
      const transferCount = values.transferCount ?? Number(current.transfer_count ?? 0);
      const conditionSummary = values.conditionSummary ?? String(current.condition_summary ?? values.description);
      const currentDefects = jsonArray(current.defects_json);
      const defects = normalizeTextList(values.defectsDisclosure ?? values.defects, currentDefects);
      const dataKindValue = values.dataKind ?? String(current.data_kind ?? (bool(current.is_synthetic) ? "synthetic_demo" : "company_inventory"));
      const featured = values.featured ?? values.isFeatured ?? bool(current.is_featured);
      const sortPriority = values.sortOrder ?? values.sortPriority;
      await tx.prepare(`
        UPDATE used_car_listings SET stock_no = ?, model_id = ?, title = ?, trim_name = ?, model_year = ?,
          registration_date = ?, mileage_km = ?, price_fen = ?, original_price_fen = ?, location = ?,
          exterior_color = ?, interior_color = ?, transfer_count = ?, energy_type = ?, transmission = ?, seats = ?,
          highlights_json = ?, condition_summary = ?, defects_json = ?, description = ?, status = ?,
          sort_priority = ?, is_featured = ?, data_kind = ?, is_synthetic = ?, published_at = ?, updated_at = ?
        WHERE id = ?
      `).run(
        values.stockNo, values.modelId, values.title, trimName, values.modelYear, values.registrationDate,
        values.mileageKm, values.priceFen, guidePriceFen, values.location,
        exteriorColor, values.interiorColor, transferCount, values.energyType, values.transmission, values.seats,
        JSON.stringify(values.highlights), conditionSummary, JSON.stringify(defects), values.description,
        values.status, sortPriority, featured ? 1 : 0, dataKindValue, dataKindValue === "synthetic_demo" ? 1 : 0,
        publishedAt, now, id,
      );
      const updated = await findListing(tx, id);
      if (!updated) throw problem(404, "USED_CAR_LISTING_NOT_FOUND", "未找到该二手车车源");
      return listingFromRow(tx, updated, true);
    });
  };

  app.put<{ Params: { id: string } }>("/api/admin/used-cars/listings/:id", async (request, reply) => {
    const body = parseBody(updateListingSchema, request.body, reply);
    if (!body) return;
    return { data: await updateListing(request.params.id, body) };
  });

  app.patch<{ Params: { id: string } }>("/api/admin/used-cars/listings/:id", async (request, reply) => {
    const patch = parseBody(patchListingSchema, request.body, reply);
    if (!patch) return;
    const result = await database.transaction(async (tx) => {
      const current = await findListing(tx, request.params.id, true);
      if (!current) throw problem(404, "USED_CAR_LISTING_NOT_FOUND", "未找到该二手车车源");
      const currentDto = await listingFromRow(tx, current, true);
      const guidePriceFen = patch.guidePriceFen !== undefined
        ? patch.guidePriceFen
        : patch.originalPriceFen !== undefined ? patch.originalPriceFen : currentDto.guidePriceFen;
      const trimName = patch.trimName ?? patch.trim ?? currentDto.trimName;
      const color = patch.color ?? patch.exteriorColor ?? currentDto.exteriorColor;
      const defects = patch.defectsDisclosure ?? patch.defects ?? currentDto.defectsDisclosure;
      const featured = patch.featured ?? patch.isFeatured ?? currentDto.featured;
      const sortOrder = patch.sortOrder ?? patch.sortPriority ?? currentDto.sortOrder;
      const candidate = {
        stockNo: patch.stockNo ?? currentDto.stockNo,
        modelId: patch.modelId ?? currentDto.modelId,
        title: patch.title ?? currentDto.title,
        trimName,
        modelYear: patch.modelYear ?? currentDto.modelYear,
        registrationDate: patch.registrationDate ?? currentDto.registrationDate,
        mileageKm: patch.mileageKm ?? currentDto.mileageKm,
        priceFen: patch.priceFen ?? currentDto.priceFen,
        guidePriceFen,
        originalPriceFen: guidePriceFen,
        location: patch.location ?? currentDto.location,
        exteriorColor: color,
        interiorColor: patch.interiorColor ?? currentDto.interiorColor,
        transferCount: patch.transferCount ?? currentDto.transferCount,
        energyType: patch.energyType ?? currentDto.energyType,
        transmission: patch.transmission ?? currentDto.transmission,
        seats: patch.seats ?? currentDto.seats,
        highlights: patch.highlights ?? currentDto.highlights,
        conditionSummary: patch.conditionSummary ?? currentDto.conditionSummary,
        defectsDisclosure: defects,
        description: patch.description ?? currentDto.description,
        status: patch.status ?? currentDto.status,
        dataKind: patch.dataKind ?? currentDto.dataKind,
        featured,
        sortOrder,
        sortPriority: sortOrder,
        publishedAt: patch.publishedAt === undefined ? currentDto.publishedAt : patch.publishedAt,
      };
      const checked = updateListingSchema.safeParse(candidate);
      if (!checked.success) {
        return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: "二手车信息有误", fields: validationFields(checked.error) } });
      }
      return updateListing(request.params.id, checked.data, tx);
    });
    if (reply.sent) return;
    return { data: result };
  });

  app.delete<{ Params: { id: string } }>("/api/admin/used-cars/listings/:id", async (request) => {
    const images = await database.transaction(async (tx) => {
      if (!await findListing(tx, request.params.id, true)) {
        throw problem(404, "USED_CAR_LISTING_NOT_FOUND", "未找到该二手车车源");
      }
      const rows = await tx.prepare<Row>(
        "SELECT * FROM used_car_listing_images WHERE listing_id = ? FOR UPDATE",
      ).all(request.params.id);
      await tx.prepare("DELETE FROM used_car_listings WHERE id = ?").run(request.params.id);
      return rows;
    });
    for (const row of images) await removeStoredImage(imageUploadDir, row);
    return { data: { id: request.params.id, deleted: true } };
  });

  app.post<{ Params: { id: string } }>("/api/admin/used-cars/listings/:id/images", async (request, reply) => {
    if (!await findListing(database, request.params.id)) {
      throw problem(404, "USED_CAR_LISTING_NOT_FOUND", "未找到该二手车车源");
    }
    const processed = await receiveProcessedImage(request, problem);
    const part = processed.part;
    const requestedSort = Number(multipartField(part, "sortOrder"));
    const coverField = multipartField(part, "isCover");
    const id = `used-car-image-${randomUUID()}`;
    const storageKey = `${randomUUID()}.jpg`;
    await writeFile(join(imageUploadDir, storageKey), processed.data, { flag: "wx" });
    try {
      const image = await database.transaction(async (tx) => {
        if (!await findListing(tx, request.params.id, true)) {
          throw problem(404, "USED_CAR_LISTING_NOT_FOUND", "未找到该二手车车源");
        }
        const countRow = await tx.prepare<Row>(
          "SELECT COUNT(*) AS count FROM used_car_listing_images WHERE listing_id = ?",
        ).get(request.params.id);
        const existingCount = Number(countRow?.count ?? 0);
        if (existingCount >= 30) throw problem(409, "USED_CAR_IMAGE_LIMIT_REACHED", "每辆车最多维护 30 张图片");
        const maxSortRow = await tx.prepare<Row>(`
          SELECT COALESCE(MAX(sort_order), -1) AS max_sort
          FROM used_car_listing_images WHERE listing_id = ?
        `).get(request.params.id);
        const maxSort = Number(maxSortRow?.max_sort ?? -1);
        const sortOrder = Number.isInteger(requestedSort) && requestedSort >= 0 ? requestedSort : maxSort + 1;
        const isCover = existingCount === 0 || coverField === "true" || coverField === "1";
        if (isCover) {
          await tx.prepare("UPDATE used_car_listing_images SET is_cover = 0 WHERE listing_id = ?").run(request.params.id);
        }
        await tx.prepare(`
          INSERT INTO used_car_listing_images (
            id, listing_id, storage_key, image_url, mime_type, size_bytes, width, height,
            sort_order, is_cover, is_synthetic, created_at
          ) VALUES (?, ?, ?, ?, 'image/jpeg', ?, ?, ?, ?, ?, 0, ?)
        `).run(
          id, request.params.id, storageKey, `/api/used-cars/images/${id}`, processed.data.length, processed.info.width,
          processed.info.height, sortOrder, isCover ? 1 : 0, new Date().toISOString(),
        );
        const created = await findImage(tx, id);
        if (!created) throw problem(500, "USED_CAR_IMAGE_CREATE_FAILED", "二手车图片创建失败");
        return created;
      });
      return reply.status(201).send({ data: imageFromRow(image, true) });
    } catch (error) {
      await unlink(join(imageUploadDir, storageKey)).catch(() => undefined);
      throw error;
    }
  });

  app.put<{ Params: { id: string } }>("/api/admin/used-cars/listings/:id/images", async (request, reply) => {
    const body = parseBody(imageOrderSchema, request.body, reply);
    if (!body) return;
    const images = await database.transaction(async (tx) => {
      if (!await findListing(tx, request.params.id, true)) {
        throw problem(404, "USED_CAR_LISTING_NOT_FOUND", "未找到该二手车车源");
      }
      for (const item of body.images) {
        const row = await findImage(tx, item.id, true);
        if (!row || String(row.listing_id) !== request.params.id) {
          throw problem(404, "USED_CAR_IMAGE_NOT_FOUND", "部分图片不属于该车源");
        }
      }
      const requestedCover = body.images.find((item) => item.isCover);
      if (requestedCover) {
        await tx.prepare("UPDATE used_car_listing_images SET is_cover = 0 WHERE listing_id = ?").run(request.params.id);
      }
      for (const item of body.images) {
        await tx.prepare("UPDATE used_car_listing_images SET sort_order = ? WHERE id = ? AND listing_id = ?")
          .run(item.sortOrder, item.id, request.params.id);
      }
      if (requestedCover) {
        await tx.prepare("UPDATE used_car_listing_images SET is_cover = 1 WHERE id = ?").run(requestedCover.id);
      }
      return listingImages(tx, request.params.id, true);
    });
    return { data: images };
  });

  app.patch<{ Params: { listingId: string; imageId: string } }>(
    "/api/admin/used-cars/listings/:listingId/images/:imageId",
    async (request, reply) => {
      const body = parseBody(imagePatchSchema, request.body, reply);
      if (!body) return;
      const image = await database.transaction(async (tx) => {
        if (!await findListing(tx, request.params.listingId, true)) {
          throw problem(404, "USED_CAR_LISTING_NOT_FOUND", "未找到该二手车车源");
        }
        const row = await findImage(tx, request.params.imageId, true);
        if (!row || String(row.listing_id) !== request.params.listingId) {
          throw problem(404, "USED_CAR_IMAGE_NOT_FOUND", "未找到该车辆图片");
        }
        if (body.isCover) {
          await tx.prepare("UPDATE used_car_listing_images SET is_cover = 0 WHERE listing_id = ?").run(request.params.listingId);
        }
        await tx.prepare(`
          UPDATE used_car_listing_images SET sort_order = ?, is_cover = ? WHERE id = ?
        `).run(
          body.sortOrder ?? Number(row.sort_order),
          body.isCover === undefined ? Number(row.is_cover) : body.isCover ? 1 : 0,
          request.params.imageId,
        );
        const countRow = await tx.prepare<Row>(
          "SELECT COUNT(*) AS count FROM used_car_listing_images WHERE listing_id = ? AND is_cover = 1",
        ).get(request.params.listingId);
        const coverCount = Number(countRow?.count ?? 0);
        if (coverCount === 0) {
          const first = await tx.prepare<Row>(
            "SELECT id FROM used_car_listing_images WHERE listing_id = ? ORDER BY sort_order, created_at, id LIMIT 1",
          ).get(request.params.listingId);
          if (first) await tx.prepare("UPDATE used_car_listing_images SET is_cover = 1 WHERE id = ?").run(String(first.id));
        }
        const updated = await findImage(tx, request.params.imageId);
        if (!updated) throw problem(404, "USED_CAR_IMAGE_NOT_FOUND", "未找到该车辆图片");
        return updated;
      });
      return { data: imageFromRow(image, true) };
    },
  );

  app.delete<{ Params: { listingId: string; imageId: string } }>(
    "/api/admin/used-cars/listings/:listingId/images/:imageId",
    async (request) => {
      const result = await database.transaction(async (tx) => {
        if (!await findListing(tx, request.params.listingId, true)) {
          throw problem(404, "USED_CAR_LISTING_NOT_FOUND", "未找到该二手车车源");
        }
        const row = await findImage(tx, request.params.imageId, true);
        if (!row || String(row.listing_id) !== request.params.listingId) {
          throw problem(404, "USED_CAR_IMAGE_NOT_FOUND", "未找到该车辆图片");
        }
        const wasCover = bool(row.is_cover);
        await tx.prepare("DELETE FROM used_car_listing_images WHERE id = ?").run(request.params.imageId);
        if (wasCover) {
          const next = await tx.prepare<Row>(
            "SELECT id FROM used_car_listing_images WHERE listing_id = ? ORDER BY sort_order, created_at, id LIMIT 1",
          ).get(request.params.listingId);
          if (next) await tx.prepare("UPDATE used_car_listing_images SET is_cover = 1 WHERE id = ?").run(String(next.id));
        }
        return { row, images: await listingImages(tx, request.params.listingId, true) };
      });
      await removeStoredImage(imageUploadDir, result.row);
      return { data: { id: request.params.imageId, deleted: true, images: result.images } };
    },
  );

  app.get<{ Params: { id: string } }>("/api/admin/used-cars/images/:id", async (request, reply) => (
    sendImage(request.params.id, reply, false)
  ));
}
