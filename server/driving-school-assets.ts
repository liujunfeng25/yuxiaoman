import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

const ROUTE_PREFIX = "/assets/driving-schools/";
const DEFAULT_ASSET_ROOT = fileURLToPath(new URL("../public/assets/driving-schools/", import.meta.url));
const MIME_TYPES: Readonly<Record<string, string>> = {
  ".avif": "image/avif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

function notFound(reply: FastifyReply) {
  return reply.status(404).send({
    error: { code: "DRIVING_SCHOOL_ASSET_NOT_FOUND", message: "未找到该驾校演示素材" },
  });
}

function requestedSegments(request: FastifyRequest): string[] | null {
  const pathname = (request.raw.url ?? "").split("?", 1)[0];
  if (!pathname.startsWith(ROUTE_PREFIX)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname.slice(ROUTE_PREFIX.length));
  } catch {
    return null;
  }
  if (!decoded || decoded.includes("%") || /[\\\u0000-\u001f\u007f]/u.test(decoded)) return null;
  const segments = decoded.split("/");
  return segments.some((segment) => !segment || segment === "." || segment === "..") ? null : segments;
}

function withinRoot(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot !== ""
    && pathFromRoot !== ".."
    && !pathFromRoot.startsWith(`..${sep}`)
    && !isAbsolute(pathFromRoot);
}

export async function registerDrivingSchoolAssetRoutes(app: FastifyInstance): Promise<void> {
  const assetRoot = await realpath(resolve(DEFAULT_ASSET_ROOT)).catch(() => null);
  app.get("/assets/driving-schools/*", async (request, reply) => {
    const segments = requestedSegments(request);
    if (!assetRoot || !segments) return notFound(reply);
    const mime = MIME_TYPES[extname(segments.at(-1) ?? "").toLowerCase()];
    if (!mime) return notFound(reply);
    const unresolved = resolve(assetRoot, ...segments);
    if (!withinRoot(assetRoot, unresolved)) return notFound(reply);
    const actual = await realpath(unresolved).catch(() => null);
    if (!actual || !withinRoot(assetRoot, actual)) return notFound(reply);
    const metadata = await stat(actual).catch(() => null);
    if (!metadata?.isFile()) return notFound(reply);
    const etag = `W/\"${metadata.size.toString(16)}-${Math.trunc(metadata.mtimeMs).toString(16)}\"`;
    reply
      .header("Cache-Control", "public, max-age=86400, stale-while-revalidate=604800")
      .header("ETag", etag)
      .header("Last-Modified", metadata.mtime.toUTCString())
      .header("Cross-Origin-Resource-Policy", "cross-origin")
      .header("X-Content-Type-Options", "nosniff")
      .type(mime);
    if (request.headers["if-none-match"] === etag) return reply.status(304).send();
    return reply.header("Content-Length", metadata.size).send(createReadStream(actual));
  });
}
