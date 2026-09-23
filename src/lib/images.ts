/** Extensions the webview can display — mirrors `image_mime` in Rust. */
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "ico"]);

/** True when `path` is an image we can preview (by extension). */
export function isImagePath(path: string | null | undefined): boolean {
  if (!path) return false;
  const base = path.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot < 1) return false;
  return IMAGE_EXT.has(base.slice(dot + 1).toLowerCase());
}

/** Human-readable byte size of a base64 data URL's payload. */
export function dataUrlSize(dataUrl: string): string {
  const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const bytes =
    Math.floor((b64.length * 3) / 4) - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
