# 0006. Server libraries: validation, image codec, zip

**Context.** Spec suggests a Fastify zod type provider and leaves the PNG codec to S1/S3. Raw pages may be JPEG/WebP, not only PNG.

**Decision.**
- No `fastify-type-provider-zod` (v7 has peer deps on `@fastify/swagger`/`openapi-types`). Handlers call `schema.safeParse` from `@komaflow/contract` directly; OpenAPI comes from the contract route table. zod stays the single source of schemas.
- Image decoding for PSD: `sharp` 0.34 (prebuilt libvips for win32-x64 and linux-arm64, no compiler). Codec interface is `decode(bytes)` (any allowed type), injected into `@komaflow/psd`; the core has no Node APIs. `pngjs` is the fallback if S3 shows problems (PNG only).
- Zip: `fflate` streaming `Zip`, entries stored (`ZipPassThrough`, no deflate) to spare the Pi CPU; written to `<id>.zip.part`, renamed when complete.
- Creating an export when no page matches → `409 EXPORT_NOT_READY` with `details.skipped_pages` (no empty jobs).
- A page whose blob file is missing on disk fails with code `BLOB_MISSING` in `errors`.

**Consequences.** sharp must be confirmed on the Pi in S3 (`tools/spikes/s3-arm`).
