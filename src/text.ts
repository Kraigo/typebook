// Text normalization (on import) and per-settings transformation (on open).

export interface TextOptions {
  removePunct: boolean;
  simplifyQuotes: boolean;
}

// Control/format/private-use/unassigned chars (soft hyphen, zero-width, LRM/RLM, BOM…)
// except "\n", plus glyphs that render as blank "fillers".
const INVISIBLE = /[^\P{C}\n]|[\u2800\u3164\u115f\u1160\uffa0]/gu;
// Something actually worth typing; paragraphs without it are dropped.
const VISIBLE = /[\p{L}\p{N}\p{P}\p{S}]/u;
// Any whitespace except the paragraph separator.
const SPACE = /[^\S\n]/g;

/** Normalize raw book text: unify whitespace, one paragraph per line, no blank lines. */
export function normalize(raw: string): string {
  return raw
    .replace(/\r\n?|[\u2028\u2029\u0085]/g, "\n")
    .replace(INVISIBLE, "")
    .replace(SPACE, " ")
    .split("\n")
    .map((l) => l.replace(/ {2,}/g, " ").trim())
    .filter((l) => VISIBLE.test(l))
    .join("\n");
}

const QUOTE_MAP: Record<string, string> = {
  "«": '"', "»": '"', "„": '"', "“": '"', "”": '"', "‟": '"', "″": '"',
  "‘": "'", "’": "'", "‚": "'", "‛": "'", "ʼ": "'", "`": "'", "´": "'", "′": "'",
  "—": "-", "–": "-", "‒": "-", "―": "-", "‐": "-", "‑": "-", "−": "-",
  "…": "...", "•": "-", "×": "x",
};

const LETTER = /[\p{L}\p{N}]/u;
const PUNCT = /[\p{P}\p{S}]/u;
const APOS = /['’ʼ`‘´]/;
const HYPHEN = /[-‐‑]/;

export interface Prepared {
  text: string;
  /** map[i] = index in source text of processed char i */
  map: Int32Array;
}

export function prepare(src: string, o: TextOptions): Prepared {
  const out: string[] = [];
  const map: number[] = [];
  let paraStart = 0; // index in `out` where the current paragraph begins
  let paraVisible = false;
  const push = (s: string, at: number) => {
    for (const ch of s) {
      if (ch === "\n" && !paraVisible) {
        // Drop paragraphs with nothing to type in them.
        out.length = map.length = paraStart;
        continue;
      }
      const prev = out[out.length - 1];
      if (ch === " " && (prev === undefined || prev === " " || prev === "\n")) continue;
      if (ch === "\n") {
        if (prev === undefined || prev === "\n") continue;
        if (prev === " ") { out.pop(); map.pop(); }
      }
      out.push(ch);
      map.push(at);
      if (ch === "\n") {
        paraStart = out.length;
        paraVisible = false;
      } else if (!paraVisible && VISIBLE.test(ch)) paraVisible = true;
    }
  };

  for (let i = 0; i < src.length; i++) {
    let ch = src[i]!;
    const at = i;
    // Astral chars (emoji etc.) can't be typed, and the engine works in UTF-16 units: drop them.
    if (/[\ud800-\udbff]/.test(ch) && /[\udc00-\udfff]/.test(src[i + 1] ?? "")) {
      i++;
      continue;
    }
    // Books imported before stricter normalization may still contain these.
    if (ch.match(INVISIBLE)) continue;
    if (ch !== "\n" && ch.match(SPACE)) ch = " ";
    // Keep apostrophes and hyphens inside words (мʼясо, будь-який).
    const inWord = LETTER.test(src[at - 1] ?? "") && LETTER.test(src[at + 1] ?? "");
    if (inWord && APOS.test(ch)) {
      // Ukrainian apostrophe, as produced by the Ukrainian keyboard layout.
      if (o.simplifyQuotes) ch = "ʼ";
    } else if (o.removePunct && PUNCT.test(ch)) {
      if (inWord && HYPHEN.test(ch)) ch = "-";
      else { push(" ", at); continue; }
    } else if (o.simplifyQuotes && QUOTE_MAP[ch]) {
      ch = QUOTE_MAP[ch]!;
    }
    push(ch, at);
  }
  if (!paraVisible) out.length = map.length = paraStart;
  while (out.length && (out[out.length - 1] === " " || out[out.length - 1] === "\n")) {
    out.pop(); map.pop();
  }
  return { text: out.join(""), map: Int32Array.from(map) };
}

/** First processed index whose source index is >= srcPos. */
export function toProcessed(map: Int32Array, srcPos: number): number {
  let lo = 0, hi = map.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (map[mid]! < srcPos) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
