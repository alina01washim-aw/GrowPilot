import { Schema, model, type InferSchemaType } from "mongoose";

/**
 * Photos attached to an annotation, in their own collection.
 *
 * Kept separate from `batchAnnotation` on purpose. The chart overlay and the
 * knowledge base both list many annotations at once, and a downscaled JPEG is
 * still 100-200 KB of base64 — embedding them would mean every list query drags
 * megabytes across the wire to render pins nobody has clicked yet. Annotations
 * hold only `imageIds`, and an image is fetched when its note is opened.
 *
 * Base64 in Mongo rather than object storage: this is a single-farm deployment
 * with no bucket configured, and the AI assistant already stores photos the same
 * way. If image volume ever grows past a few hundred, GridFS is the next step —
 * the `data` field is the only thing that would have to change.
 */

const batchAnnotationImageSchema = new Schema(
  {
    batchId: { type: String, required: true },
    /** Set once the parent annotation exists; images can be uploaded first. */
    annotationId: { type: String, default: null },
    mimeType: { type: String, required: true, default: "image/jpeg" },
    /** Base64 payload, already downscaled client-side (1024 px, JPEG q0.85). */
    data: { type: String, required: true },
    byteSize: { type: Number, default: 0 },
    createdAt: { type: Date, default: () => new Date() },
  },
  { versionKey: false },
);

// Cleanup when an annotation or a whole batch is deleted.
batchAnnotationImageSchema.index({ annotationId: 1 });
batchAnnotationImageSchema.index({ batchId: 1 });

export type BatchAnnotationImageDocument = InferSchemaType<typeof batchAnnotationImageSchema>;

export const BatchAnnotationImageModel = model(
  "BatchAnnotationImage",
  batchAnnotationImageSchema,
);
