import { db, uid } from '../db';

// Note fields reference images with [img:<mediaId>] tokens.
export const IMG_TOKEN_RE = /\[img:([a-zA-Z0-9-]+)\]/g;

/** Extract all media ids referenced by a field text. */
export function mediaIdsIn(text: string): string[] {
  return [...text.matchAll(IMG_TOKEN_RE)].map((m) => m[1]);
}

const MAX_DIMENSION = 1600;
const REENCODE_THRESHOLD = 400 * 1024; // re-encode images bigger than 400 KB

/**
 * Store a pasted/dropped image. Large images are downscaled and re-encoded to
 * WebP so hundreds of screenshots stay comfortable in IndexedDB.
 */
export async function storeImage(file: Blob): Promise<string> {
  let blob = file;
  let mime = file.type || 'image/png';
  if (file.size > REENCODE_THRESHOLD || mime === 'image/bmp') {
    try {
      const compressed = await compressImage(file);
      if (compressed && compressed.size < file.size) {
        blob = compressed;
        mime = 'image/webp';
      }
    } catch {
      // keep the original if compression fails
    }
  }
  const id = uid();
  await db.media.add({ id, blob, mime, createdAt: Date.now() });
  return id;
}

async function compressImage(file: Blob): Promise<Blob | null> {
  const bitmap = await createImageBitmap(file);
  let { width, height } = bitmap;
  if (Math.max(width, height) > MAX_DIMENSION) {
    const scale = MAX_DIMENSION / Math.max(width, height);
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return new Promise<Blob | null>((resolve) =>
    canvas.toBlob((b) => resolve(b), 'image/webp', 0.85),
  );
}

// Object-URL cache so repeated renders don't leak URLs.
const urlCache = new Map<string, string>();

export async function mediaUrl(id: string): Promise<string | null> {
  const cached = urlCache.get(id);
  if (cached) return cached;
  const rec = await db.media.get(id);
  if (!rec) return null;
  const url = URL.createObjectURL(rec.blob);
  urlCache.set(id, url);
  return url;
}

/** Get raw base64 (no data: prefix) + mime for sending to the Gemini API. */
export async function mediaBase64(id: string): Promise<{ base64: string; mime: string } | null> {
  const rec = await db.media.get(id);
  if (!rec) return null;
  const buf = await rec.blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return { base64: btoa(binary), mime: rec.mime };
}

/** Delete media rows that are no longer referenced by any note. */
export async function pruneOrphanMedia(): Promise<number> {
  const referenced = new Set<string>();
  await db.notes.each((n) => {
    for (const id of mediaIdsIn(n.front)) referenced.add(id);
    for (const id of mediaIdsIn(n.back)) referenced.add(id);
  });
  const all = await db.media.toCollection().primaryKeys();
  const orphans = all.filter((id) => !referenced.has(id));
  if (orphans.length) await db.media.bulkDelete(orphans);
  for (const id of orphans) {
    const url = urlCache.get(id);
    if (url) {
      URL.revokeObjectURL(url);
      urlCache.delete(id);
    }
  }
  return orphans.length;
}

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|avif|bmp|tiff?|svg)$/i;

// Some sources (Linux clipboards especially) hand over files with an empty
// MIME type — fall back to the file name.
function looksLikeImage(f: File): boolean {
  return f.type.startsWith('image/') || (!f.type && IMAGE_EXT_RE.test(f.name));
}

/** Extract image files from a paste/drop event, if any. */
export function imageFilesFrom(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  const files: File[] = [];
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind === 'file') {
      const f = item.getAsFile();
      if (f && looksLikeImage(f)) files.push(f);
    }
  }
  // Some platforms populate .files without usable .items entries.
  if (files.length === 0) {
    for (const f of Array.from(dt.files ?? [])) {
      if (looksLikeImage(f)) files.push(f);
    }
  }
  return files;
}
