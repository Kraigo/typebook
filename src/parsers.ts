import { unzipSync, strFromU8 } from "fflate";

export interface ParsedBook {
  title: string;
  text: string; // paragraphs separated by "\n"
}

const BLOCK_TAGS = new Set([
  "p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "li", "blockquote", "pre",
  "section", "article", "tr", "dd", "dt", "figcaption", "br", "hr",
  // fb2
  "title", "subtitle", "v", "stanza", "epigraph", "text-author", "empty-line", "cite",
]);
const SKIP_TAGS = new Set(["script", "style", "head", "binary", "rt", "rp"]);

/** Extract plain text from a DOM subtree, inserting newlines between blocks. */
function domToText(root: Node): string {
  const out: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === 3) {
      out.push(node.nodeValue ?? "");
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = (node as Element).localName.toLowerCase();
    if (SKIP_TAGS.has(tag)) return;
    const block = BLOCK_TAGS.has(tag);
    if (block) out.push("\n");
    for (let c = node.firstChild; c; c = c.nextSibling) walk(c);
    if (block) out.push("\n");
  };
  walk(root);
  return out.join("");
}

function decodeBytes(bytes: Uint8Array, hint?: string): string {
  if (hint) {
    try {
      return new TextDecoder(hint).decode(bytes);
    } catch {}
  }
  // BOMs
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1251").decode(bytes);
  }
}

function xmlEncoding(bytes: Uint8Array): string | undefined {
  const head = new TextDecoder("ascii").decode(bytes.subarray(0, 200));
  return head.match(/encoding=["']([\w-]+)["']/i)?.[1];
}

function parseXml(src: string, type: DOMParserSupportedType = "application/xml"): Document {
  const doc = new DOMParser().parseFromString(src, type);
  if (doc.getElementsByTagName("parsererror").length && type !== "text/html") {
    return new DOMParser().parseFromString(src, "text/html");
  }
  return doc;
}

function stripExt(name: string) {
  return name.replace(/\.(fb2\.zip|epub|fb2|zip|txt)$/i, "");
}

// ---------- TXT ----------
function parseTxt(bytes: Uint8Array, name: string): ParsedBook {
  return { title: stripExt(name), text: unwrapLines(decodeBytes(bytes)) };
}

/**
 * Join hard-wrapped lines (fixed-width TXT) back into paragraphs.
 * A line starts a new paragraph after a blank line, when it is indented,
 * starts with a dialogue dash, or the previous line is noticeably short and
 * ends a sentence. Files without hard wraps are returned unchanged.
 */
export function unwrapLines(raw: string): string {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  const lens = lines.map((l) => l.trimEnd().length).filter((n) => n > 0).sort((a, b) => a - b);
  if (lens.length < 10) return raw;
  const width = lens[Math.floor(lens.length * 0.9)]!;
  const median = lens[Math.floor(lens.length / 2)]!;
  // Hard-wrapped text: most lines are long and close to a common width.
  if (width > 150 || median < width * 0.6) return raw;

  const nonEmpty = lines.filter((l) => l.trim());
  const indented = nonEmpty.filter((l) => /^\s/.test(l)).length;
  const indentMarksPara = indented > 0 && indented < nonEmpty.length * 0.6;

  const out: string[] = [];
  let cur = "";
  let prevLen = 0;
  const flush = () => {
    if (cur) out.push(cur);
    cur = "";
  };
  for (const line of lines) {
    const t = line.trim();
    if (!t) {
      flush();
      continue;
    }
    const startsPara =
      !cur ||
      (indentMarksPara && /^\s/.test(line)) ||
      /^[—–-]\s/.test(t) ||
      (prevLen < width * 0.75 && /[.!?…:»"”)]$/.test(cur)) ||
      (prevLen < width * 0.5 && !/[,;-]$/.test(cur));
    if (startsPara) {
      flush();
      cur = t;
    } else if (/\p{L}-$/u.test(cur) && /^\p{Ll}/u.test(t)) {
      cur = cur.slice(0, -1) + t; // word hyphenated across lines
    } else {
      cur += " " + t;
    }
    prevLen = line.trimEnd().length;
  }
  flush();
  return out.join("\n");
}

// ---------- FB2 ----------
function parseFb2(bytes: Uint8Array, name: string): ParsedBook {
  const src = decodeBytes(bytes, xmlEncoding(bytes));
  const doc = parseXml(src);
  const title =
    doc.getElementsByTagName("book-title")[0]?.textContent?.trim() || stripExt(name);
  const bodies = Array.from(doc.getElementsByTagName("body")).filter(
    (b) => !/notes|comments/i.test(b.getAttribute("name") ?? ""),
  );
  const text = bodies.map(domToText).join("\n");
  return { title, text };
}

// ---------- EPUB ----------
function resolvePath(base: string, rel: string): string {
  const parts = (base.includes("/") ? base.slice(0, base.lastIndexOf("/") + 1) : "")
    .concat(decodeURIComponent(rel.split("#")[0] ?? ""))
    .split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "..") out.pop();
    else if (p !== "." && p !== "") out.push(p);
  }
  return out.join("/");
}

function parseEpub(files: Record<string, Uint8Array>, name: string): ParsedBook {
  const get = (p: string) => {
    if (files[p]) return files[p];
    const lower = p.toLowerCase();
    const key = Object.keys(files).find((k) => k.toLowerCase() === lower);
    return key ? files[key] : undefined;
  };
  const container = get("META-INF/container.xml");
  let opfPath = container
    ? parseXml(strFromU8(container)).getElementsByTagName("rootfile")[0]?.getAttribute("full-path")
    : null;
  if (!opfPath) opfPath = Object.keys(files).find((k) => k.endsWith(".opf")) ?? null;
  if (!opfPath) throw new Error("Не знайдено OPF у EPUB");

  const opf = parseXml(decodeBytes(get(opfPath)!));
  const title =
    opf.getElementsByTagNameNS("*", "title")[0]?.textContent?.trim() || stripExt(name);
  const manifest = new Map<string, string>();
  for (const item of Array.from(opf.getElementsByTagNameNS("*", "item"))) {
    manifest.set(item.getAttribute("id") ?? "", item.getAttribute("href") ?? "");
  }
  const spine = Array.from(opf.getElementsByTagNameNS("*", "itemref"))
    .filter((r) => r.getAttribute("linear") !== "no")
    .map((r) => manifest.get(r.getAttribute("idref") ?? ""))
    .filter((h): h is string => !!h);

  const chunks: string[] = [];
  for (const href of spine) {
    const data = get(resolvePath(opfPath, href));
    if (!data) continue;
    const src = decodeBytes(data, xmlEncoding(data));
    const doc = parseXml(src, "application/xhtml+xml");
    const body = doc.getElementsByTagName("body")[0] ?? doc.documentElement;
    chunks.push(domToText(body));
  }
  return { title, text: chunks.join("\n") };
}

// ---------- entry ----------
export async function parseFile(file: File): Promise<ParsedBook> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const name = file.name;
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;

  if (isZip) {
    const files = unzipSync(bytes);
    const keys = Object.keys(files);
    if (keys.some((k) => k.toLowerCase().endsWith(".opf")) || files["mimetype"]) {
      return parseEpub(files, name);
    }
    const fb2 = keys.find((k) => k.toLowerCase().endsWith(".fb2"));
    if (fb2) return parseFb2(files[fb2]!, fb2);
    const txt = keys.find((k) => k.toLowerCase().endsWith(".txt"));
    if (txt) return parseTxt(files[txt]!, txt);
    throw new Error("Невідомий вміст архіву");
  }
  if (/\.fb2$/i.test(name) || /<FictionBook/i.test(new TextDecoder().decode(bytes.subarray(0, 500)))) {
    return parseFb2(bytes, name);
  }
  return parseTxt(bytes, name);
}
