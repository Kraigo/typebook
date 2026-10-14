// Text normalization (on import) and per-settings transformation (on open).

export interface TextOptions {
  removePunct: boolean;
  lowercase: boolean;
  simplifyQuotes: boolean;
}

/** Normalize raw book text: unify whitespace, one paragraph per line, no empty lines. */
export function normalize(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/[­​-‍⁠﻿]/g, "") // soft hyphen, zero-width
    .replace(/[\t  -   　]/g, " ")
    .split("\n")
    .map((l) => l.replace(/ {2,}/g, " ").trim())
    .filter((l) => l.length > 0)
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
  const push = (s: string, at: number) => {
    for (const ch of s) {
      const prev = out[out.length - 1];
      if (ch === " " && (prev === undefined || prev === " " || prev === "\n")) continue;
      if (ch === "\n") {
        if (prev === undefined || prev === "\n") continue;
        if (prev === " ") { out.pop(); map.pop(); }
      }
      out.push(ch);
      map.push(at);
    }
  };

  for (let i = 0; i < src.length; i++) {
    let ch = src[i]!;
    // Keep apostrophes and hyphens inside words (мʼясо, будь-який).
    const inWord = LETTER.test(src[i - 1] ?? "") && LETTER.test(src[i + 1] ?? "");
    if (inWord && APOS.test(ch)) {
      // Ukrainian apostrophe, as produced by the Ukrainian keyboard layout.
      if (o.simplifyQuotes) ch = "ʼ";
    } else if (o.removePunct && PUNCT.test(ch)) {
      if (inWord && HYPHEN.test(ch)) ch = "-";
      else { push(" ", i); continue; }
    } else if (o.simplifyQuotes && QUOTE_MAP[ch]) {
      ch = QUOTE_MAP[ch]!;
    }
    if (o.lowercase) ch = ch.toLowerCase();
    push(ch, i);
  }
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
