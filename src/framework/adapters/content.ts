import { readFileSync } from "node:fs";
import { extname } from "node:path";
import type { ChatContent, ContentPart, ImageContentPart } from "./types.js";

export function textPart(text: string): ContentPart {
  return { type: "text", text };
}

export function normalizeChatContent(content: ChatContent): ContentPart[] {
  return typeof content === "string" ? [textPart(content)] : content;
}

export function chatContentToText(content: ChatContent): string {
  if (typeof content === "string") return content;
  return content
    .map((part, index) => {
      if (part.type === "text") return part.text;
      return `[image ${index + 1}${part.mime ? ` · ${part.mime}` : ""}]`;
    })
    .join("");
}

export function imageDataUrl(part: ImageContentPart): string {
  if (part.dataUrl) return part.dataUrl;
  if (!part.path) throw new Error("image content part requires dataUrl or path");
  const bytes = readFileSync(part.path);
  return `data:${part.mime || mimeFromPath(part.path)};base64,${bytes.toString("base64")}`;
}

export function imageBase64(part: ImageContentPart): string {
  const dataUrl = imageDataUrl(part);
  const marker = ";base64,";
  const idx = dataUrl.indexOf(marker);
  if (!dataUrl.startsWith("data:") || idx < 0) {
    throw new Error("image dataUrl must be a base64 data URL");
  }
  return dataUrl.slice(idx + marker.length);
}

export function imageMime(part: ImageContentPart): string {
  if (part.mime) return part.mime;
  if (part.dataUrl?.startsWith("data:")) {
    const end = part.dataUrl.indexOf(";");
    if (end > 5) return part.dataUrl.slice(5, end);
  }
  return part.path ? mimeFromPath(part.path) : "image/png";
}

export function mimeFromPath(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".png":
    default:
      return "image/png";
  }
}
