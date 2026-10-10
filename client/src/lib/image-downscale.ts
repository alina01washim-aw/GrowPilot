/**
 * Client-side image downscaling before upload.
 *
 * Extracted from the AI assistant's `pickImage`, which had this logic inline.
 * Annotations attach photos too, and two copies of the same canvas dance would
 * inevitably drift — particularly the quality and dimension constants, which
 * determine how much base64 ends up in Mongo.
 *
 * A phone camera photo is 3-5 MB; at 1024 px and JPEG quality 0.85 it lands
 * around 100-200 KB, which is small enough to store inline and still clear enough
 * to see contamination or bruising on a cap.
 */

export const MAX_IMAGE_DIM = 1024;
export const JPEG_QUALITY = 0.85;

export class ImageReadError extends Error {}

/**
 * Reads a File, scales it so the longest edge is at most `maxDim`, and returns a
 * JPEG data URL. Images already smaller than `maxDim` are not upscaled.
 *
 * Rejects rather than resolving to null, so callers must decide what to tell the
 * user instead of silently dropping the attachment.
 */
export function downscaleImage(
  file: File,
  maxDim: number = MAX_IMAGE_DIM,
  quality: number = JPEG_QUALITY,
): Promise<string> {
  if (!file.type.startsWith("image/")) {
    return Promise.reject(new ImageReadError("That file is not an image."));
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onerror = () => reject(new ImageReadError("Could not read the file."));
    reader.onload = () => {
      const img = new Image();

      img.onerror = () => reject(new ImageReadError("Could not decode the image."));
      img.onload = () => {
        // Never above 1: enlarging a small photo only inflates the upload.
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));

        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new ImageReadError("This browser could not process the image."));
          return;
        }
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        // JPEG regardless of input: PNG screenshots of a grow room compress
        // badly and would be several times larger for no visible gain.
        resolve(canvas.toDataURL("image/jpeg", quality));
      };

      img.src = String(reader.result);
    };

    reader.readAsDataURL(file);
  });
}

/** Rough decoded size of a data URL, for showing an upload size to the user. */
export function dataUrlByteSize(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return 0;
  return Math.floor(((dataUrl.length - comma - 1) * 3) / 4);
}
