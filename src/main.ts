import * as db from "./db";
import { parseFile } from "./parsers";
import { normalize, prepare, toProcessed, type Prepared, type TextOptions } from "./text";

// ---------- settings ----------
interface Settings extends TextOptions {
  fontSize: number;
  lines: number;
  stopOnError: boolean;
}
const DEFAULTS: Settings = {
  removePunct: false,
  lowercase: false,
  simplifyQuotes: true,
  stopOnError: false,
  fontSize: 24,
  lines: 4,
};
function loadSettings(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem("typebook.settings") ?? "{}") };
  } catch {
    return { ...DEFAULTS };
  }
}
const settings = loadSettings();
function saveSettings() {
  try {
    localStorage.setItem("typebook.settings", JSON.stringify(settings));
  } catch {}
}

// ---------- dom ----------
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const els = {
  library: $("view-library"),
  typing: $("view-typing"),
  title: $("book-title"),
  list: $<HTMLUListElement>("book-list"),
  empty: $("book-empty"),
  drop: $<HTMLLabelElement>("drop"),
  fileInput: $<HTMLInputElement>("file-input"),
  pasteTitle: $<HTMLInputElement>("paste-title"),
  pasteText: $<HTMLTextAreaElement>("paste-text"),
  status: $("import-status"),
  box: $("typing-box"),
  text: $("typing-text"),
  input: $<HTMLInputElement>("hidden-input"),
  skip: $("btn-skip"),
  restore: $("btn-restore"),
  bar: $("progress-bar"),
  time: $("st-time"),
  wpm: $("st-wpm"),
  cpm: $("st-cpm"),
  acc: $("st-acc"),
  progress: $("st-progress"),
  dialog: $<HTMLDialogElement>("settings"),
};

function applyVisualSettings() {
  document.documentElement.style.setProperty("--font-size", `${settings.fontSize}px`);
  document.documentElement.style.setProperty("--lines", String(settings.lines));
}
applyVisualSettings();

// ---------- library ----------
function setStatus(msg: string, error = false) {
  els.status.textContent = msg;
  els.status.classList.toggle("error", error);
}

async function renderLibrary() {
  const books = await db.listBooks();
  els.list.replaceChildren();
  els.empty.hidden = books.length > 0;
  for (const b of books) {
    const pct = b.length ? (b.pos / b.length) * 100 : 0;
    const li = document.createElement("li");
    li.innerHTML = `
      <div class="info">
        <div class="name"></div>
        <div class="meta">${pct.toFixed(1)}% · ${b.length.toLocaleString("uk")} знаків</div>
        <div class="bar"><div style="width:${pct}%"></div></div>
      </div>
      <button class="btn" data-act="open">${b.pos > 0 ? "Продовжити" : "Почати"}</button>
      <button class="btn ghost" data-act="restart" title="Почати спочатку">↺</button>
      <button class="btn danger" data-act="delete" title="Видалити">✕</button>`;
    li.querySelector(".name")!.textContent = b.title;
    li.addEventListener("click", async (e) => {
      const act = (e.target as HTMLElement).closest("button")?.dataset.act;
      if (act === "open") location.hash = `#book=${b.id}`;
      if (act === "restart" && confirm(`Почати «${b.title}» спочатку?`)) {
        await db.saveMeta({ ...b, pos: 0 });
        renderLibrary();
      }
      if (act === "delete" && confirm(`Видалити «${b.title}»?`)) {
        await db.deleteBook(b.id);
        renderLibrary();
      }
    });
    els.list.append(li);
  }
}

async function importFiles(files: FileList | File[]) {
  for (const file of Array.from(files)) {
    try {
      setStatus(`Імпорт «${file.name}»…`);
      const parsed = await parseFile(file);
      const text = normalize(parsed.text);
      if (!text) throw new Error("файл не містить тексту");
      await db.addBook(parsed.title, text);
      setStatus(`Додано «${parsed.title}»`);
    } catch (err) {
      console.error(err);
      setStatus(`Не вдалося імпортувати «${file.name}»: ${(err as Error).message}`, true);
    }
  }
  renderLibrary();
}

els.fileInput.addEventListener("change", () => {
  if (els.fileInput.files) importFiles(els.fileInput.files);
  els.fileInput.value = "";
});
els.drop.addEventListener("dragover", (e) => {
  e.preventDefault();
  els.drop.classList.add("over");
});
els.drop.addEventListener("dragleave", () => els.drop.classList.remove("over"));
els.drop.addEventListener("drop", (e) => {
  e.preventDefault();
  els.drop.classList.remove("over");
  if (e.dataTransfer?.files.length) importFiles(e.dataTransfer.files);
});
$("paste-add").addEventListener("click", async () => {
  const text = normalize(els.pasteText.value);
  if (!text) return setStatus("Текст порожній", true);
  const title = els.pasteTitle.value.trim() || text.slice(0, 40);
  await db.addBook(title, text);
  els.pasteText.value = els.pasteTitle.value = "";
  setStatus(`Додано «${title}»`);
  renderLibrary();
});

// ---------- typing engine ----------
const WINDOW_BEFORE = 600;
const WINDOW_AFTER = 3000;
const IDLE_MS = 5000; // a pause longer than this stops the timer
const APOS = /^['’ʼ`‘´]$/;

const BAD = 0 as const, OK = 1 as const, SKIP = 2 as const;
type Mark = typeof BAD | typeof OK | typeof SKIP;

interface Session {
  meta: db.BookMeta;
  source: string;
  prep: Prepared;
  start: number; // processed index where this session began
  typed: Mark[]; // state of indices start..cursor-1
  winStart: number;
  winEnd: number;
  spans: HTMLSpanElement[];
  inner: HTMLDivElement;
  keystrokes: number;
  errors: number;
  activeMs: number;
  lastKey: number;
  dirty: boolean;
}
let s: Session | null = null;

const cursor = () => s!.start + s!.typed.length;

function committed(): number {
  const i = s!.typed.indexOf(BAD);
  return s!.start + (i === -1 ? s!.typed.length : i);
}

function startSession(meta: db.BookMeta, source: string, at?: number) {
  const prep = prepare(source, settings);
  let start = at ?? toProcessed(prep.map, meta.pos);
  // Rewind to the beginning of the word.
  while (start > 0 && start < prep.text.length && !/[ \n]/.test(prep.text[start - 1]!)) start--;
  const inner = document.createElement("div");
  inner.className = "typing-inner";
  els.text.replaceChildren(inner);
  s = {
    meta, source, prep, start, typed: [],
    winStart: 0, winEnd: 0, spans: [], inner,
    keystrokes: 0, errors: 0, activeMs: 0, lastKey: 0, dirty: false,
  };
  renderWindow();
  updateStats();
}

function classFor(i: number): string {
  const c = cursor();
  let cls = s!.prep.text[i] === "\n" ? "nl" : "";
  if (i < s!.start) cls += " ok";
  else if (i < c) {
    const m = s!.typed[i - s!.start];
    if (m === OK) cls += " ok";
    else if (m === SKIP) cls += " skip";
    else cls += " bad" + (/[ \n]/.test(s!.prep.text[i]!) ? " sp" : "");
  } else if (i === c) cls += " cur";
  return cls.trim();
}

/** End index (position of "\n" or text length) of the paragraph containing i. */
function paraEnd(i: number): number {
  const e = s!.prep.text.indexOf("\n", i);
  return e === -1 ? s!.prep.text.length : e;
}

function renderWindow() {
  const { text } = s!.prep;
  const c = cursor();
  // Start the window at a paragraph start if possible, otherwise at a word start.
  let ws = Math.max(0, c - WINDOW_BEFORE);
  const para = text.lastIndexOf("\n", c - 1);
  if (para >= 0 && c - para < WINDOW_BEFORE * 3) ws = Math.min(ws, para + 1);
  else while (ws > 0 && text[ws - 1] !== " " && text[ws - 1] !== "\n") ws--;
  s!.winStart = ws;
  s!.winEnd = Math.min(text.length, c + WINDOW_AFTER);

  const frag = document.createDocumentFragment();
  s!.spans = [];
  let div: HTMLDivElement | null = null;
  const openPara = () => {
    div = document.createElement("div");
    div.className = "para";
    frag.append(div);
  };
  for (let i = s!.winStart; i < s!.winEnd; i++) {
    if (!div) openPara();
    const span = document.createElement("span");
    const ch = text[i]!;
    span.textContent = ch === "\n" ? "↵" : ch;
    span.className = classFor(i);
    s!.spans.push(span);
    div!.append(span);
    if (ch === "\n") div = null;
  }
  if (s!.winEnd === text.length) {
    // End-of-text sentinel so the cursor has somewhere to sit.
    if (!div) openPara();
    const end = document.createElement("span");
    end.textContent = " ";
    end.className = c === text.length ? "cur" : "";
    s!.spans.push(end);
    div!.append(end);
  }
  s!.inner.replaceChildren(frag);
  scrollToCursor();
}

function refresh(i: number) {
  const span = s!.spans[i - s!.winStart];
  if (!span) return;
  if (i >= s!.prep.text.length) span.className = i === cursor() ? "cur" : "";
  else span.className = classFor(i);
}

function scrollToCursor() {
  const span = s!.spans[cursor() - s!.winStart];
  if (!span) return;
  const lh = settings.fontSize * 1.6;
  const keepLine = settings.lines >= 3 ? 1 : 0;
  const top = lineTop(cursor())!;
  const y = Math.max(0, top - lh * keepLine);
  s!.inner.style.transform = `translateY(${-y}px)`;
  updateRail(y);
}

/** Top of the visual line containing char i, in untransformed inner coordinates. */
function lineTop(i: number): number | undefined {
  const span = s!.spans[i - s!.winStart];
  if (!span) return undefined;
  const lh = settings.fontSize * 1.6;
  // Rect difference is unaffected by the inner transform (both move together).
  const top = span.getBoundingClientRect().top - s!.inner.getBoundingClientRect().top;
  return Math.round(top / lh) * lh;
}

/** Start of the paragraph containing i. */
function paraStart(i: number): number {
  return s!.prep.text.lastIndexOf("\n", i - 1) + 1;
}

/**
 * Paragraph right above the current one, if it was skipped in this session.
 * Returns where "restore" should rewind to.
 */
function restoreTarget(): number | null {
  const ps = paraStart(cursor());
  const nl = ps - 1; // the "\n" ending the previous paragraph
  if (nl < s!.start || s!.typed[nl - s!.start] !== SKIP) return null;
  return Math.max(paraStart(nl), s!.start);
}

/** Position the ✕ (skip current paragraph) and ↺ (restore skipped one) buttons beside the text. */
function updateRail(scrollY: number) {
  const lh = settings.fontSize * 1.6;
  const visible = lh * settings.lines;
  const base = els.text.offsetTop - scrollY;
  const place = (btn: HTMLElement, top: number | undefined) => {
    const y = top === undefined ? -1 : top - scrollY;
    btn.hidden = y < 0 || y >= visible - 1;
    if (!btn.hidden) btn.style.top = `${base + top! + (lh - 28) / 2}px`;
  };
  const c = cursor();
  if (c >= s!.prep.text.length) els.skip.hidden = true;
  else {
    // First line of the current paragraph, or the top visible line if it scrolled away.
    const first = lineTop(Math.max(paraStart(c), s!.winStart));
    place(els.skip, first === undefined ? undefined : Math.max(first, scrollY));
  }
  const r = restoreTarget();
  place(els.restore, r === null ? undefined : lineTop(paraStart(c) - 1));
}

function ensureWindow() {
  const c = cursor();
  if (c < s!.winStart || (c > s!.winEnd - 1000 && s!.winEnd < s!.prep.text.length)) renderWindow();
}

function afterMove() {
  s!.dirty = true;
  ensureWindow();
  scrollToCursor();
  updateStats();
}

function tick(now: number) {
  if (s!.lastKey && now - s!.lastKey < IDLE_MS) s!.activeMs += now - s!.lastKey;
  s!.lastKey = now;
}

function typeChar(ch: string) {
  if (!s) return;
  const { text } = s.prep;
  const c = cursor();
  if (c >= text.length) return;
  tick(performance.now());
  const expected = text[c]!;
  const ok =
    ch === expected ||
    (expected === "\n" && (ch === " " || ch === "\n")) ||
    (APOS.test(expected) && APOS.test(ch)); // any apostrophe variant is fine
  s.keystrokes++;
  if (!ok) s.errors++;
  if (!ok && settings.stopOnError) {
    const span = s.spans[c - s.winStart];
    span?.classList.add("bad");
    setTimeout(() => span && (span.className = classFor(c)), 150);
    updateStats();
    return;
  }
  s.typed.push(ok ? OK : BAD);
  refresh(c);
  refresh(c + 1);
  afterMove();
  if (cursor() >= text.length) saveProgress();
}

/** Mark everything from the cursor up to (and including) the "\n" at `end` as skipped. */
function skipTo(end: number) {
  if (!s) return;
  const c = cursor();
  const target = Math.min(end + 1, s.prep.text.length);
  if (target <= c) return;
  for (let i = c; i < target; i++) s.typed.push(SKIP);
  for (let i = c; i <= target; i++) refresh(i);
  s.lastKey = 0; // don't count the jump as typing time
  afterMove();
  saveProgress();
}

/** Rewind the cursor to `target`, dropping everything typed after it. */
function rewindTo(target: number) {
  if (!s) return;
  const c = cursor();
  if (target >= c || target < s.start) return;
  s.typed.length = target - s.start;
  for (let i = target; i <= c; i++) refresh(i);
  s.lastKey = 0;
  afterMove();
  saveProgress();
}

function backspace(word: boolean) {
  if (!s || s.typed.length === 0) return;
  const { text } = s.prep;
  let n = 1;
  if (s.typed[s.typed.length - 1] === SKIP) {
    // Undo a whole skipped block at once.
    n = 0;
    while (n < s.typed.length && s.typed[s.typed.length - 1 - n] === SKIP) n++;
  } else if (word) {
    let i = cursor() - 1;
    while (i > s.start && /[ \n]/.test(text[i]!)) i--;
    while (i > s.start && !/[ \n]/.test(text[i - 1]!)) i--;
    n = cursor() - Math.max(i, s.start);
  }
  for (let k = 0; k < n; k++) {
    s.typed.pop();
    refresh(cursor() + 1);
    refresh(cursor());
  }
  afterMove();
}

function fmtTime(ms: number): string {
  const t = Math.floor(ms / 1000);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return (h ? `${h}:` : "") + `${mm}:${String(sec).padStart(2, "0")}`;
}

/** Active typing time. The current gap counts while it's short, so the clock ticks smoothly. */
function updateTimer() {
  if (!s) return;
  const gap = s.lastKey ? performance.now() - s.lastKey : Infinity;
  const running = gap < IDLE_MS && document.activeElement === els.input;
  els.time.textContent = fmtTime(s.activeMs + (gap < 1000 ? gap : 0));
  els.time.classList.toggle("paused", s.activeMs > 0 && !running);
}
setInterval(updateTimer, 200);

function updateStats() {
  if (!s) return;
  updateTimer();
  const correct = s.typed.reduce<number>((n, m) => n + (m === OK ? 1 : 0), 0);
  const minutes = s.activeMs / 60000;
  const cpm = minutes > 0.02 ? correct / minutes : 0;
  els.cpm.textContent = String(Math.round(cpm));
  els.wpm.textContent = String(Math.round(cpm / 5));
  els.acc.textContent = s.keystrokes
    ? (((s.keystrokes - s.errors) / s.keystrokes) * 100).toFixed(1)
    : "100";
  const len = s.prep.text.length || 1;
  const pct = (cursor() / len) * 100;
  els.progress.textContent = pct.toFixed(2);
  els.bar.style.width = `${pct}%`;
}

async function saveProgress() {
  if (!s || !s.dirty) return;
  s.dirty = false;
  const c = committed();
  const pos = c >= s.prep.map.length ? s.source.length : s.prep.map[c]!;
  s.meta = { ...s.meta, pos, openedAt: Date.now() };
  await db.saveMeta(s.meta);
}
setInterval(saveProgress, 3000);
addEventListener("visibilitychange", () => document.hidden && saveProgress());
addEventListener("pagehide", () => saveProgress());

// ---------- input ----------
function focusTyping() {
  els.input.focus({ preventScroll: true });
}
els.box.addEventListener("mousedown", (e) => {
  e.preventDefault();
  focusTyping();
});
els.skip.addEventListener("click", () => s && skipTo(paraEnd(cursor())));
els.restore.addEventListener("click", () => {
  const t = s && restoreTarget();
  if (t !== null && t !== undefined) rewindTo(t);
});
els.input.addEventListener("focus", () => els.box.classList.add("focused"));
els.input.addEventListener("blur", () => {
  els.box.classList.remove("focused");
  if (s) s.lastKey = 0; // pause timer
  saveProgress();
});
els.input.addEventListener("keydown", (e) => {
  if (e.isComposing) return;
  if (e.key === "Escape") {
    els.input.blur();
    return;
  }
  if (e.key === "Tab") {
    e.preventDefault();
    if (s) skipTo(paraEnd(cursor()));
    return;
  }
  if (e.key === "Backspace") {
    e.preventDefault();
    backspace(e.ctrlKey || e.altKey || e.metaKey);
    return;
  }
  if (e.key === "Enter") {
    e.preventDefault();
    typeChar("\n");
    return;
  }
  if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    typeChar(e.key);
  }
});
// Fallback for virtual keyboards / IME that don't produce useful keydown events.
els.input.addEventListener("input", () => {
  const v = els.input.value;
  els.input.value = "";
  for (const ch of v) typeChar(ch);
});

// ---------- settings dialog ----------
const opt = {
  punct: $<HTMLInputElement>("opt-punct"),
  lower: $<HTMLInputElement>("opt-lower"),
  quotes: $<HTMLInputElement>("opt-quotes"),
  stop: $<HTMLInputElement>("opt-stop"),
  size: $<HTMLInputElement>("opt-size"),
  sizeVal: $("opt-size-val"),
  lines: $<HTMLInputElement>("opt-lines"),
  linesVal: $("opt-lines-val"),
};
function syncSettingsForm() {
  opt.punct.checked = settings.removePunct;
  opt.lower.checked = settings.lowercase;
  opt.quotes.checked = settings.simplifyQuotes;
  opt.stop.checked = settings.stopOnError;
  opt.size.value = String(settings.fontSize);
  opt.sizeVal.textContent = `${settings.fontSize}px`;
  opt.lines.value = String(settings.lines);
  opt.linesVal.textContent = String(settings.lines);
}
syncSettingsForm();
$("nav-settings").addEventListener("click", () => {
  syncSettingsForm();
  els.dialog.showModal();
});
function onTextOptionChange() {
  settings.removePunct = opt.punct.checked;
  settings.lowercase = opt.lower.checked;
  settings.simplifyQuotes = opt.quotes.checked;
  saveSettings();
  if (s) {
    s.dirty = true;
    saveProgress().then(() => s && startSession(s.meta, s.source));
  }
}
for (const el of [opt.punct, opt.lower, opt.quotes]) el.addEventListener("change", onTextOptionChange);
opt.stop.addEventListener("change", () => {
  settings.stopOnError = opt.stop.checked;
  saveSettings();
});
for (const el of [opt.size, opt.lines]) {
  el.addEventListener("input", () => {
    settings.fontSize = Number(opt.size.value);
    settings.lines = Number(opt.lines.value);
    syncSettingsForm();
    applyVisualSettings();
    saveSettings();
    if (s) scrollToCursor();
  });
}
els.dialog.addEventListener("close", () => {
  if (!els.typing.hidden) focusTyping();
});

// ---------- routing ----------
$("nav-library").addEventListener("click", () => (location.hash = ""));

async function route() {
  await saveProgress();
  const id = location.hash.match(/^#book=(.+)$/)?.[1];
  if (id) {
    const [meta, text] = await Promise.all([db.getMeta(id), db.getText(id)]);
    if (meta && text !== undefined) {
      els.library.hidden = true;
      els.typing.hidden = false;
      els.title.textContent = meta.title;
      document.title = `${meta.title} — Typebook`;
      meta.openedAt = Date.now();
      db.saveMeta(meta);
      startSession(meta, text);
      focusTyping();
      return;
    }
  }
  s = null;
  els.typing.hidden = true;
  els.library.hidden = false;
  els.title.textContent = "";
  document.title = "Typebook — сліпий друк по книгах";
  renderLibrary();
}
addEventListener("hashchange", route);
addEventListener("resize", () => s && scrollToCursor());
route();
