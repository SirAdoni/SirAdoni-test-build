const IMAGE_EXTENSION_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
};

export function dataImageUrlToFile(dataUrl: string, fileStem: string): File {
  const match = dataUrl.trim().match(/^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i);
  if (!match?.[1] || !match[2]) throw new Error("The generated image was not valid image data.");

  const mimeType = match[1].toLowerCase();
  const extension = IMAGE_EXTENSION_BY_MIME[mimeType];
  if (!extension) throw new Error(`Generated image format ${mimeType} is not supported.`);

  let binary: string;
  try {
    binary = atob(match[2].replace(/\s+/g, ""));
  } catch {
    throw new Error("The generated image contained invalid base64 data.");
  }

  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);

  const safeStem =
    fileStem
      .trim()
      .replace(/[^a-z0-9_-]+/gi, "-")
      .replace(/(^-|-$)/g, "") || "image";
  return new File([bytes], `${safeStem}.${extension}`, { type: mimeType });
}
