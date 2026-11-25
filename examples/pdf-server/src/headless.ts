/**
 * Headless PDF annotation — no MCP App viewer required.
 * Uses pdf.js for text search and pdf-lib for writing /Highlight annots.
 */

import fs from "node:fs";
import path from "node:path";
import "../pdfjs-polyfill.js";
import {
  getDocument,
  VerbosityLevel,
  version as PDFJS_VERSION,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentProxy } from "pdfjs-dist/types/src/display/api.js";
import { PDFDocument } from "@cantoo/pdf-lib";
import {
  addAnnotationDicts,
  convertFromModelCoords,
  type PdfAnnotationDef,
  type Rect,
} from "./pdf-annotations.js";

const STANDARD_FONT_DATA_URL = `https://unpkg.com/pdfjs-dist@${PDFJS_VERSION}/standard_fonts/`;

class FetchStandardFontDataFactory {
  baseUrl: string | null;
  constructor({ baseUrl = null }: { baseUrl?: string | null }) {
    this.baseUrl = baseUrl;
  }
  async fetch({ filename }: { filename: string }): Promise<Uint8Array> {
    if (!this.baseUrl) throw new Error("standardFontDataUrl not provided");
    const url = `${this.baseUrl}${filename}`;
    const res = await globalThis.fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }
}

export interface HeadlessCommand {
  action:
    | "highlight_text"
    | "add_annotations"
    | "get_text"
    | "clear_annotations"
    | "add_legend";
  page?: number;
  query?: string;
  color?: string;
  /** Persisted in PDF /Contents — sidebar in Preview (⌘⌥4) */
  content?: string;
  /** Which occurrence to highlight (0 = first in reading order). Default 0. */
  matchIndex?: number;
  /** If true, highlight every match on the page. Default false. */
  allMatches?: boolean;
  /**
   * Only search between this section header and the next (or sectionEnd).
   * E.g. "Fundamentals" or "1 · Fundamentals".
   */
  section?: string;
  /** End boundary; default = next "N · " section header after section start. */
  sectionEnd?: string;
  /** Match must appear after this text (within section/page). */
  afterText?: string;
  /** Match must appear before this text (within section/page). */
  beforeText?: string;
  annotations?: Record<string, unknown>[];
  /** For add_legend: lines of text (each may include a leading color swatch word) */
  lines?: string[];
  title?: string;
}

export interface HeadlessResult {
  filePath: string;
  highlightsAdded: number;
  annotationsAdded: number;
  messages: string[];
}

interface TextSpan {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

async function loadPdfJs(filePath: string): Promise<PDFDocumentProxy> {
  const data = new Uint8Array(await fs.promises.readFile(filePath));
  return getDocument({
    data,
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
    StandardFontDataFactory: FetchStandardFontDataFactory,
    verbosity: VerbosityLevel.ERRORS,
  }).promise;
}

function itemHeight(transform: number[]): number {
  return Math.max(
    Math.hypot(transform[2], transform[3]),
    Math.abs(transform[0]),
  );
}

/** Extract text spans with PDF user-space rects (bottom-left origin). */
async function getPageTextSpans(
  pdf: PDFDocumentProxy,
  pageNum: number,
): Promise<TextSpan[]> {
  const page = await pdf.getPage(pageNum);
  const content = await page.getTextContent();
  const spans: TextSpan[] = [];

  for (const item of content.items) {
    if (!("str" in item) || !item.str) continue;
    const t = item.transform;
    const h = itemHeight(t);
    const w =
      typeof item.width === "number" && item.width > 0
        ? item.width
        : item.str.length * h * 0.5;
    spans.push({
      str: item.str,
      x: t[4],
      y: t[5] - h * 0.85,
      width: w,
      height: h,
    });
  }
  return spans;
}

/** One occurrence → rects for that match (may span multiple lines). */
function rectsForOccurrence(
  spans: TextSpan[],
  offsets: number[],
  idx: number,
  queryLen: number,
): Rect[] {
  const end = idx + queryLen;
  let si = 0;
  while (si < spans.length - 1 && offsets[si + 1]! <= idx) si++;
  let ei = si;
  while (ei < spans.length - 1 && offsets[ei + 1]! < end) ei++;

  const startSpan = spans[si]!;
  const endSpan = spans[ei]!;
  const startOff = idx - offsets[si]!;
  const endOff = end - offsets[ei]!;
  const charW0 = startSpan.width / Math.max(startSpan.str.length, 1);
  const charW1 = endSpan.width / Math.max(endSpan.str.length, 1);
  const rects: Rect[] = [];

  if (si === ei) {
    rects.push({
      x: startSpan.x + startOff * charW0,
      y: startSpan.y,
      width: Math.max((endOff - startOff) * charW0, 2),
      height: startSpan.height,
    });
  } else {
    rects.push({
      x: startSpan.x + startOff * charW0,
      y: startSpan.y,
      width: Math.max(startSpan.width - startOff * charW0, 2),
      height: startSpan.height,
    });
    for (let m = si + 1; m < ei; m++) {
      const sp = spans[m]!;
      rects.push({ x: sp.x, y: sp.y, width: sp.width, height: sp.height });
    }
    if (endOff > 0) {
      rects.push({
        x: endSpan.x,
        y: endSpan.y,
        width: Math.max(endOff * charW1, 2),
        height: endSpan.height,
      });
    }
  }
  return rects;
}

/** Build concatenated page text + char offsets (reading order). */
function buildPageTextIndex(spans: TextSpan[]): {
  full: string;
  lowerFull: string;
  offsets: number[];
} {
  const full = spans.map((s) => s.str).join("");
  const offsets: number[] = [0];
  for (const s of spans) {
    offsets.push(offsets[offsets.length - 1]! + s.str.length);
  }
  return { full, lowerFull: full.toLowerCase(), offsets };
}

/** Next numbered cheatsheet section header after `from` (e.g. "2 · Resistor"). */
const NEXT_SECTION_RE = /\d+\s*[·.\u00b7]\s*/g;

/**
 * Character range [start, end) for a named section on one page.
 * Returns null if section header not found.
 */
export function resolveSectionRange(
  full: string,
  section: string,
  sectionEnd?: string,
): { start: number; end: number } | null {
  const lower = full.toLowerCase();
  const start = lower.indexOf(section.toLowerCase());
  if (start === -1) return null;

  let end = full.length;
  if (sectionEnd) {
    const endIdx = lower.indexOf(
      sectionEnd.toLowerCase(),
      start + section.length,
    );
    if (endIdx !== -1) end = endIdx;
  } else {
    NEXT_SECTION_RE.lastIndex = start + section.length;
    const next = NEXT_SECTION_RE.exec(full);
    if (next && next.index > start) end = next.index;
  }
  return { start, end };
}

export interface TextSearchOptions {
  matchIndex?: number;
  allMatches?: boolean;
  /** Restrict search to [start, end) char indices in page text. */
  charRange?: { start: number; end: number };
  /** Match index must fall after this substring (within charRange or page). */
  afterText?: string;
  /** Match index must fall before this substring. */
  beforeText?: string;
}

/** All occurrences of query on a page (reading order), optionally scoped. */
export async function findTextMatchesHeadless(
  pdf: PDFDocumentProxy,
  pageNum: number,
  query: string,
  options: TextSearchOptions = {},
): Promise<Rect[][]> {
  const spans = await getPageTextSpans(pdf, pageNum);
  if (spans.length === 0) return [];

  const { full, lowerFull, offsets } = buildPageTextIndex(spans);
  const lowerQuery = query.toLowerCase();

  let rangeStart = options.charRange?.start ?? 0;
  let rangeEnd = options.charRange?.end ?? full.length;

  if (options.afterText) {
    const a = lowerFull.indexOf(options.afterText.toLowerCase(), rangeStart);
    if (a === -1) return [];
    rangeStart = Math.max(rangeStart, a);
  }
  if (options.beforeText) {
    const b = lowerFull.indexOf(options.beforeText.toLowerCase(), rangeStart);
    if (b === -1) return [];
    rangeEnd = Math.min(rangeEnd, b);
  }

  const matches: Rect[][] = [];
  let pos = rangeStart;
  while (pos < rangeEnd) {
    const idx = lowerFull.indexOf(lowerQuery, pos);
    if (idx === -1 || idx >= rangeEnd) break;
    pos = idx + 1;
    matches.push(rectsForOccurrence(spans, offsets, idx, query.length));
  }
  return matches;
}

/** Find occurrence matchIndex (default 0) on a page. */
export async function findTextRectsHeadless(
  pdf: PDFDocumentProxy,
  pageNum: number,
  query: string,
  matchIndex = 0,
  options: Omit<TextSearchOptions, "matchIndex" | "allMatches"> = {},
): Promise<Rect[]> {
  const matches = await findTextMatchesHeadless(pdf, pageNum, query, {
    ...options,
    matchIndex,
  });
  return matches[matchIndex] ?? [];
}

async function getPageText(
  pdf: PDFDocumentProxy,
  pageNum: number,
): Promise<string> {
  const page = await pdf.getPage(pageNum);
  const content = await page.getTextContent();
  return content.items.map((item) => ("str" in item ? item.str : "")).join("");
}

function asAnnotation(def: Record<string, unknown>): PdfAnnotationDef | null {
  if (!def.id || !def.type || !def.page) return null;
  return def as unknown as PdfAnnotationDef;
}

/** Remove every annotation from every page (highlights, notes, etc.). */
export async function clearAllAnnotations(filePath: string): Promise<number> {
  const resolved = path.resolve(filePath);
  const bytes = new Uint8Array(await fs.promises.readFile(resolved));
  const pdfDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  let removed = 0;
  for (const page of pdfDoc.getPages()) {
    const annots = page.node.Annots();
    if (!annots) continue;
    removed += annots.size();
    while (annots.size() > 0) annots.remove(0);
  }
  const out = await pdfDoc.save();
  await fs.promises.writeFile(resolved, out);
  return removed;
}

/** Build a freetext legend block (model coords: top-left origin). */
function buildLegendAnnotations(
  page: number,
  pageHeight: number,
  title: string,
  lines: string[],
): PdfAnnotationDef[] {
  const lineH = 11;
  const pad = 6;
  const boxH = pad * 2 + 12 + lines.length * lineH;
  const boxW = 220;
  const modelX = 8;
  const modelY = 8;

  const anns: PdfAnnotationDef[] = [
    {
      type: "rectangle",
      id: `legend_box_${Date.now()}`,
      page,
      x: modelX,
      y: modelY,
      width: boxW,
      height: boxH,
      color: "#333333",
      fillColor: "#ffffff",
    },
    {
      type: "freetext",
      id: `legend_title_${Date.now()}`,
      page,
      x: modelX + pad,
      y: modelY + pad,
      content: title,
      fontSize: 9,
      color: "#111111",
    },
  ];

  lines.forEach((line, i) => {
    anns.push({
      type: "freetext",
      id: `legend_line_${Date.now()}_${i}`,
      page,
      x: modelX + pad,
      y: modelY + pad + 12 + i * lineH,
      content: line,
      fontSize: 8,
      color: "#222222",
    });
  });

  return anns.map((a) => convertFromModelCoords(a, pageHeight));
}

/**
 * Apply headless commands and write annotations directly to the PDF file.
 */
export async function applyHeadlessCommands(
  filePath: string,
  commandsIn: HeadlessCommand[],
): Promise<HeadlessResult> {
  const resolved = path.resolve(filePath);
  const messages: string[] = [];
  let commands = [...commandsIn];

  if (commands.some((c) => c.action === "clear_annotations")) {
    const n = await clearAllAnnotations(resolved);
    messages.push(`removed ${n} annotation(s)`);
    commands = commands.filter((c) => c.action !== "clear_annotations");
    if (commands.length === 0) {
      return {
        filePath: resolved,
        highlightsAdded: 0,
        annotationsAdded: 0,
        messages,
      };
    }
  }

  const pdfJs = await loadPdfJs(resolved);
  const numPages = pdfJs.numPages;

  const toAdd: PdfAnnotationDef[] = [];
  let highlightsAdded = 0;
  let annotationsAdded = 0;

  for (const cmd of commands) {
    if (cmd.action === "add_legend") {
      const pg = cmd.page ?? 1;
      const page = await pdfJs.getPage(pg);
      const pageHeight = page.getViewport({ scale: 1 }).height;
      const title = cmd.title ?? "Highlight key";
      const lines = cmd.lines ?? [];
      const legendAnns = buildLegendAnnotations(pg, pageHeight, title, lines);
      toAdd.push(...legendAnns);
      annotationsAdded += legendAnns.length;
      messages.push(`legend (${lines.length} lines) on page ${pg}`);
      continue;
    }

    if (cmd.action === "get_text") {
      const pg = cmd.page ?? 1;
      const text = await getPageText(pdfJs, pg);
      messages.push(`Page ${pg} text (${text.length} chars)`);
      continue;
    }

    if (cmd.action === "highlight_text") {
      if (!cmd.query) {
        messages.push("skip: highlight_text missing query");
        continue;
      }
      const pages =
        cmd.page != null
          ? [cmd.page]
          : Array.from({ length: numPages }, (_, i) => i + 1);

      for (const pg of pages) {
        const pageText = await getPageText(pdfJs, pg);
        let charRange: { start: number; end: number } | undefined;
        if (cmd.section) {
          const range = resolveSectionRange(
            pageText,
            cmd.section,
            cmd.sectionEnd,
          );
          if (!range) {
            messages.push(
              `no section "${cmd.section}" on page ${pg} — skipped "${cmd.query}"`,
            );
            continue;
          }
          charRange = range;
        }

        const matches = await findTextMatchesHeadless(pdfJs, pg, cmd.query, {
          charRange,
          afterText: cmd.afterText,
          beforeText: cmd.beforeText,
        });
        if (matches.length === 0) {
          const scope = cmd.section ? ` in section "${cmd.section}"` : "";
          messages.push(`no match "${cmd.query}" on page ${pg}${scope}`);
          continue;
        }

        const picked = cmd.allMatches
          ? matches
          : [matches[cmd.matchIndex ?? 0]].filter((m) => m && m.length > 0);

        if (picked.length === 0) {
          messages.push(
            `no match "${cmd.query}" on page ${pg} at index ${cmd.matchIndex ?? 0} (${matches.length} in scope)`,
          );
          continue;
        }

        for (let mi = 0; mi < picked.length; mi++) {
          const rects = picked[mi]!;
          const id = `hl_${Date.now()}_${pg}_${highlightsAdded}`;
          toAdd.push({
            type: "highlight",
            id,
            page: pg,
            rects,
            color: cmd.color ?? "#ffff00",
            content: cmd.content ?? cmd.query,
          });
          highlightsAdded++;
          const scope = cmd.section ? ` §"${cmd.section}"` : "";
          const occLabel = cmd.allMatches
            ? `occ ${mi + 1}/${picked.length}`
            : `occ ${(cmd.matchIndex ?? 0) + 1}/${matches.length}`;
          messages.push(
            `highlight "${cmd.query}" on page ${pg}${scope} (${occLabel}, ${rects.length} rects)`,
          );
        }
      }
      continue;
    }

    if (cmd.action === "add_annotations") {
      for (const raw of cmd.annotations ?? []) {
        const ann = asAnnotation(raw);
        if (!ann) continue;
        const page = await pdfJs.getPage(ann.page);
        const pageHeight = page.getViewport({ scale: 1 }).height;
        toAdd.push(convertFromModelCoords(ann, pageHeight));
        annotationsAdded++;
      }
      continue;
    }

    messages.push(`skip: unknown action ${(cmd as HeadlessCommand).action}`);
  }

  await pdfJs.destroy();

  if (toAdd.length === 0) {
    return { filePath: resolved, highlightsAdded, annotationsAdded, messages };
  }

  const bytes = new Uint8Array(await fs.promises.readFile(resolved));
  const pdfDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  await addAnnotationDicts(pdfDoc, toAdd);
  const out = await pdfDoc.save();
  await fs.promises.writeFile(resolved, out);

  messages.push(`wrote ${toAdd.length} annotation(s) to ${resolved}`);
  return { filePath: resolved, highlightsAdded, annotationsAdded, messages };
}
