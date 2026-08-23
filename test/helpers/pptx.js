import { readFileSync } from "node:fs";
import JSZip from "jszip";

export async function openPptx(path) {
  return JSZip.loadAsync(readFileSync(path));
}

export async function readPptxEntry(zip, name) {
  const entry = zip.file(name);
  if (!entry) throw new Error(`Missing PPTX entry: ${name}`);
  return entry.async("string");
}
