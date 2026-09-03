import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

const ROUTE_PREFIX = "/assets/used-cars/";
const DEFAULT_ASSET_ROOT = fileURLToPath(new URL("../public/assets/used-cars/", import.meta.url));
const CACHE_CONTROL = "public, max-age=86400, stale-while-revalidate=604800";

const IMAGE_MIME_TYPES: Readonly<Record<string, string>> = {
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  ".webp": "image/webp",
};

function notFound(reply: FastifyReply) {
  return reply.status(404).send({
    error: {
      code: "USED_CAR_ASSET_NOT_FOUND",
      message: "未找到该二手车演示素材",
    },
  });
}

function decodeRequestedPath(request: FastifyRequest): string[] | null {
  const rawPathname = (request.raw.url ?? "").split("?", 1)[0];
  if (!rawPathname.startsWith(ROUTE_PREFIX)) return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPathname.slice(ROUTE_PREFIX.length));
  } catch {
    return null;
  }

  // Reject remaining escapes so double-encoded traversal cannot become active in
  // a downstream proxy, and reject Windows separators/control characters.
  if (!decoded || decoded.includes("%") || /[\\\u0000-\u001f\u007f]/.test(decoded)) return null;
  const segments = decoded.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return null;
  return segments;
}

function isWithinRoot(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot !== ""
    && pathFromRoot !== ".."
    && !pathFromRoot.startsWith(`..${sep}`)
    && !isAbsolute(pathFromRoot);
}

export async function registerUsedCarAssetRoutes(app: FastifyInstance): Promise<void> {
  const assetRoot = await realpath(resolve(DEFAULT_ASSET_ROOT)).catch(() => null);

  app.get("/assets/used-cars/*", async (request, reply) => {
    const segments = decodeRequestedPath(request);
    if (!assetRoot || !segments) return notFound(reply);

    const mimeType = IMAGE_MIME_TYPES[extname(segments.at(-1) ?? "").toLowerCase()];
    if (!mimeType) return notFound(reply);

    const unresolvedPath = resolve(assetRoot, ...segments);
    if (!isWithinRoot(assetRoot, unresolvedPath)) return notFound(reply);

    let actualPath: string;
    try {
      actualPath = await realpath(unresolvedPath);
    } catch {
      return notFound(reply);
    }
    if (!isWithinRoot(assetRoot, actualPath)) return notFound(reply);

    let metadata;
    try {
      metadata = await stat(actualPath);
    } catch {
      return notFound(reply);
    }
    if (!metadata.isFile()) return notFound(reply);

    const etag = `W/\"${metadata.size.toString(16)}-${Math.trunc(metadata.mtimeMs).toString(16)}\"`;
    reply
      .header("Cache-Control", CACHE_CONTROL)
      .header("ETag", etag)
      .header("Last-Modified", metadata.mtime.toUTCString())
      .header("Cross-Origin-Resource-Policy", "cross-origin")
      .header("X-Content-Type-Options", "nosniff")
      .type(mimeType);
    if (mimeType.startsWith("image/svg+xml")) {
      reply.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    }

    if (request.headers["if-none-match"] === etag) return reply.status(304).send();
    return reply.header("Content-Length", metadata.size).send(createReadStream(actualPath));
  });
}
