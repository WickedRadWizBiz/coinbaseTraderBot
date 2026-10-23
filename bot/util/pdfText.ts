// Minimal PDF text extraction, enough to read Kalshi's fee schedule (kalshi.com/docs/kalshi-fee-schedule.pdf): plain and
// FlateDecode objects and object streams, simple and Type0 (Identity-H) fonts with ToUnicode CMaps, glyph widths, the
// text operators (Tj, TJ, ', ") and positioning (cm, q/Q, Tm, Td, TD, T*, TL), and form XObjects. Not a general reader:
// no encryption, no Type3 fonts, no other filters. Each run of text comes back with its page and position, so callers
// can rebuild lines and table rows.

import zlib from 'zlib';

export interface PdfTextItem {
  page: number;
  /** Start of the run in page space (points, origin bottom left). */
  x: number;
  y: number;
  /** End of the run along the baseline, from the glyph widths. */
  x2: number;
  size: number;
  text: string;
}

type Obj = { dict: string; stream?: Buffer };
type Mat = [number, number, number, number, number, number];

const mul = (a: Mat, b: Mat): Mat => [
  a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5],
];
const ID: Mat = [1, 0, 0, 1, 0, 0];

interface Font { bytes: 1 | 2; map: Map<number, string>; widths: Map<number, number>; dw: number }

const MAX_STREAM = 32 * 1024 * 1024;

export function pdfText(buf: Buffer): PdfTextItem[] {
  const s = buf.toString('latin1');
  const objs = new Map<number, Obj>();
  // Top-level objects. A stream's data runs to the first "endstream" after it (the length can be indirect).
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    const start = m.index + m[0].length;
    const end = s.indexOf('endobj', start);
    if (end < 0) break;
    const body = s.slice(start, end);
    const si = body.search(/\bstream\r?\n/);
    if (si >= 0) {
      const dataStart = start + si + body.slice(si).match(/^stream\r?\n/)![0].length;
      let dataEnd = s.lastIndexOf('endstream', end);
      if (dataEnd < dataStart) dataEnd = end;
      let raw = buf.subarray(dataStart, dataEnd);
      if (raw.length && raw[raw.length - 1] === 0x0a) raw = raw.subarray(0, raw.length - (raw[raw.length - 2] === 0x0d ? 2 : 1));
      objs.set(Number(m[1]), { dict: body.slice(0, si), stream: raw });
    } else objs.set(Number(m[1]), { dict: body });
    re.lastIndex = end;
  }
  const decoded = (o: Obj): Buffer | undefined => {
    if (!o.stream) return undefined;
    if (!/\/Filter\s*\[?\s*\/FlateDecode/.test(o.dict)) return /\/Filter/.test(o.dict) ? undefined : o.stream;
    // Capped: a small stream that inflates without end is refused, not followed.
    try { return zlib.inflateSync(o.stream, { maxOutputLength: MAX_STREAM }); } catch { try { return zlib.inflateRawSync(o.stream.subarray(2), { maxOutputLength: MAX_STREAM }); } catch { return undefined; } }
  };
  // Objects inside object streams.
  for (const o of [...objs.values()]) {
    if (!/\/Type\s*\/ObjStm/.test(o.dict)) continue;
    const d = decoded(o);
    const n = Number(o.dict.match(/\/N\s+(\d+)/)?.[1]), first = Number(o.dict.match(/\/First\s+(\d+)/)?.[1]);
    if (!d || !(n > 0) || !(first >= 0)) continue;
    const t = d.toString('latin1');
    const head = t.slice(0, first).trim().split(/\s+/).map(Number);
    for (let i = 0; i < n; i++) {
      const num = head[2 * i], off = head[2 * i + 1], next = i + 1 < n ? head[2 * i + 3] : t.length - first;
      if (!objs.has(num)) objs.set(num, { dict: t.slice(first + off, first + next) });
    }
  }

  const deref = (v: string | undefined): string | undefined => {
    const r = v?.trim().match(/^(\d+)\s+\d+\s+R$/);
    return r ? objs.get(Number(r[1]))?.dict : v;
  };
  const refNum = (v: string | undefined): number | undefined => {
    const r = v?.trim().match(/^(\d+)\s+\d+\s+R/);
    return r ? Number(r[1]) : undefined;
  };

  const fonts = new Map<number, Font>();
  const font = (num: number): Font => {
    const hit = fonts.get(num);
    if (hit) return hit;
    const d = objs.get(num)?.dict ?? '';
    const type0 = /\/Subtype\s*\/Type0/.test(d);
    const f: Font = { bytes: type0 ? 2 : 1, map: new Map(), widths: new Map(), dw: type0 ? 1000 : 500 };
    const tu = refNum(value(d, 'ToUnicode'));
    const cm = tu !== undefined ? objs.get(tu) : undefined;
    const cmap = cm ? decoded(cm)?.toString('latin1') : undefined;
    if (cmap) parseCMap(cmap, f);
    if (type0) {
      const desc = deref(arrayFirst(value(d, 'DescendantFonts'))) ?? '';
      const dw = Number(value(desc, 'DW'));
      if (Number.isFinite(dw)) f.dw = dw;
      const w = deref(value(desc, 'W'));
      if (w) parseCidWidths(w, f.widths);
    } else {
      const fc = Number(value(d, 'FirstChar'));
      const ws = deref(value(d, 'Widths'));
      if (Number.isFinite(fc) && ws) ws.replace(/^\s*\[|\]\s*$/g, '').trim().split(/\s+/).forEach((x, i) => f.widths.set(fc + i, Number(x)));
    }
    fonts.set(num, f);
    return f;
  };

  const out: PdfTextItem[] = [];
  const runContent = (content: string, resources: string, ctm0: Mat, page: number, depth: number) => {
    const fontRefs = dictEntries(deref(value(resources, 'Font')) ?? '');
    const xobjRefs = dictEntries(deref(value(resources, 'XObject')) ?? '');
    let ctm = ctm0;
    const stack: Mat[] = [];
    let tm: Mat = ID, tlm: Mat = ID;
    let f: Font | undefined, size = 0, leading = 0, cs = 0, ws = 0, th = 1;
    const ops: string[] = [];
    const show = (raw: string, adjust?: Array<string | number>) => {
      if (!f) return;
      const parts = adjust ?? [raw];
      let text = '';
      const start = mul(tm, ctm);
      for (const p of parts) {
        if (typeof p === 'number') {
          const dx = (-p / 1000) * size * th;
          if (p < -250) text += ' ';
          tm = mul([1, 0, 0, 1, dx, 0], tm);
          continue;
        }
        const bytes = p;
        for (let i = 0; i + f.bytes <= bytes.length; i += f.bytes) {
          const code = f.bytes === 2 ? (bytes.charCodeAt(i) << 8) | bytes.charCodeAt(i + 1) : bytes.charCodeAt(i);
          const ch = f.map.get(code) ?? (f.bytes === 1 ? String.fromCharCode(code) : '');
          text += ch;
          const w = (f.widths.get(code) ?? f.dw) / 1000;
          const adv = (w * size + cs + (ch === ' ' ? ws : 0)) * th;
          tm = mul([1, 0, 0, 1, adv, 0], tm);
        }
      }
      const end = mul(tm, ctm);
      if (text) out.push({ page, x: start[4], y: start[5], x2: end[4], size: Math.abs(size * Math.hypot(start[0], start[1])), text });
    };
    const toks = tokenize(content);
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.kind !== 'op') { ops.push(t.v as never); continue; }
      const a = ops.splice(0) as unknown as Array<any>;
      const n = (k: number) => Number(a[a.length - k]);
      switch (t.v) {
        case 'q': stack.push(ctm); break;
        case 'Q': ctm = stack.pop() ?? ctm; break;
        case 'cm': ctm = mul([n(6), n(5), n(4), n(3), n(2), n(1)], ctm); break;
        case 'BT': tm = ID; tlm = ID; break;
        case 'Tf': { const r = fontRefs.get(String(a[a.length - 2]).replace(/^\//, '')); f = r !== undefined ? font(r) : undefined; size = n(1); break; }
        case 'Tc': cs = n(1); break;
        case 'Tw': ws = n(1); break;
        case 'Tz': th = n(1) / 100; break;
        case 'TL': leading = n(1); break;
        case 'Tm': tm = tlm = [n(6), n(5), n(4), n(3), n(2), n(1)]; break;
        case 'Td': tm = tlm = mul([1, 0, 0, 1, n(2), n(1)], tlm); break;
        case 'TD': leading = -n(1); tm = tlm = mul([1, 0, 0, 1, n(2), n(1)], tlm); break;
        case 'T*': tm = tlm = mul([1, 0, 0, 1, 0, -leading], tlm); break;
        case 'Tj': show(String(a[a.length - 1] ?? '')); break;
        case "'": tm = tlm = mul([1, 0, 0, 1, 0, -leading], tlm); show(String(a[a.length - 1] ?? '')); break;
        case '"': ws = n(3); cs = n(2); tm = tlm = mul([1, 0, 0, 1, 0, -leading], tlm); show(String(a[a.length - 1] ?? '')); break;
        case 'TJ': { const arr = a[a.length - 1]; if (Array.isArray(arr)) show('', arr); break; }
        case 'Do': {
          const r = xobjRefs.get(String(a[a.length - 1]).replace(/^\//, ''));
          const xo = r !== undefined ? objs.get(r) : undefined;
          if (!xo || depth > 4 || !/\/Subtype\s*\/Form/.test(xo.dict)) break;
          const body = decoded(xo);
          if (!body) break;
          const mm = value(xo.dict, 'Matrix')?.replace(/[[\]]/g, '').trim().split(/\s+/).map(Number);
          const fm: Mat = mm && mm.length === 6 ? (mm as Mat) : ID;
          runContent(body.toString('latin1'), deref(value(xo.dict, 'Resources')) ?? resources, mul(fm, ctm), page, depth + 1);
          break;
        }
        default: break;
      }
    }
  };

  // Pages in order, through the page tree from the catalog; resources are inherited.
  const catalog = [...objs.values()].find((o) => /\/Type\s*\/Catalog/.test(o.dict));
  const pages: Array<{ dict: string; resources: string }> = [];
  const walk = (num: number | undefined, inherited: string, seen: Set<number>) => {
    if (num === undefined || seen.has(num)) return;
    seen.add(num);
    const d = objs.get(num)?.dict ?? '';
    const res = deref(value(d, 'Resources')) ?? inherited;
    if (/\/Type\s*\/Pages\b/.test(d)) {
      for (const k of (value(d, 'Kids') ?? '').matchAll(/(\d+)\s+\d+\s+R/g)) walk(Number(k[1]), res, seen);
    } else if (/\/Type\s*\/Page\b/.test(d)) pages.push({ dict: d, resources: res });
  };
  walk(refNum(value(catalog?.dict ?? '', 'Pages')), '', new Set());
  pages.forEach((p, i) => {
    const c = value(p.dict, 'Contents') ?? '';
    const refs = [...c.matchAll(/(\d+)\s+\d+\s+R/g)].map((m) => Number(m[1]));
    const content = refs.map((r) => { const o = objs.get(r); return o ? decoded(o)?.toString('latin1') ?? '' : ''; }).join('\n');
    runContent(content, p.resources, ID, i + 1, 0);
  });
  return out;
}

/** The text of each page as lines: runs on the same baseline (within a third of the font size) joined left to right,
 *  with a space where the gap between runs is wider than a fifth of the font size. */
export function pdfLines(items: PdfTextItem[]): Array<{ page: number; y: number; text: string; runs: PdfTextItem[] }> {
  const out: Array<{ page: number; y: number; text: string; runs: PdfTextItem[] }> = [];
  const byPage = new Map<number, PdfTextItem[]>();
  for (const it of items) { const l = byPage.get(it.page) ?? []; l.push(it); byPage.set(it.page, l); }
  for (const [page, list] of [...byPage].sort((a, b) => a[0] - b[0])) {
    const sorted = [...list].sort((a, b) => b.y - a.y || a.x - b.x);
    const lines: Array<{ y: number; runs: PdfTextItem[] }> = [];
    for (const it of sorted) {
      const l = lines.find((x) => Math.abs(x.y - it.y) <= Math.max(1, it.size / 3));
      if (l) l.runs.push(it); else lines.push({ y: it.y, runs: [it] });
    }
    for (const l of lines.sort((a, b) => b.y - a.y)) {
      const runs = l.runs.sort((a, b) => a.x - b.x);
      let text = '';
      let end = -Infinity;
      for (const r of runs) {
        if (text && r.x - end > r.size / 5 && !text.endsWith(' ') && !r.text.startsWith(' ')) text += ' ';
        text += r.text;
        end = Math.max(end, r.x2);
      }
      out.push({ page, y: l.y, text: text.replace(/\s+/g, ' ').trim(), runs });
    }
  }
  return out.filter((l) => l.text);
}

// ---- helpers ----------------------------------------------------------------------------------------------------

/** The raw value of a dictionary key (a name, number, reference, array or nested dictionary), or undefined. */
function value(dict: string, key: string): string | undefined {
  const re = new RegExp(`/${key}(?![A-Za-z0-9])`);
  const m = re.exec(dict);
  if (!m) return undefined;
  let i = m.index + m[0].length;
  while (i < dict.length && /\s/.test(dict[i])) i++;
  const c = dict[i];
  if (c === '[' || (c === '<' && dict[i + 1] === '<')) {
    const open = c === '[' ? '[' : '<<', close = c === '[' ? ']' : '>>';
    let depth = 0, j = i;
    while (j < dict.length) {
      if (dict.startsWith(open, j)) { depth++; j += open.length; continue; }
      if (dict.startsWith(close, j)) { depth--; j += close.length; if (depth === 0) break; continue; }
      j++;
    }
    return dict.slice(i, j);
  }
  const r = dict.slice(i).match(/^(\d+\s+\d+\s+R|\/[^\s/<>[\]()]+|[-+]?[\d.]+|\([^)]*\)|<[0-9A-Fa-f\s]*>|true|false|null)/);
  return r?.[1];
}

function arrayFirst(v: string | undefined): string | undefined {
  return v?.replace(/^\s*\[/, '').trim().match(/^(\d+\s+\d+\s+R)/)?.[1] ?? v;
}

/** /Name 12 0 R entries of a resource dictionary. */
function dictEntries(d: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of d.matchAll(/\/([^\s/<>[\]()]+)\s+(\d+)\s+\d+\s+R/g)) m.set(e[1], Number(e[2]));
  return m;
}

function hexToStr(h: string): string {
  const clean = h.replace(/[^0-9A-Fa-f]/g, '');
  let out = '';
  for (let i = 0; i + 1 < clean.length; i += 2) out += String.fromCharCode(parseInt(clean.slice(i, i + 2), 16));
  if (clean.length % 2) out += String.fromCharCode(parseInt(clean.slice(-1) + '0', 16));
  return out;
}

function utf16(h: string): string {
  const clean = h.replace(/[^0-9A-Fa-f]/g, '');
  let out = '';
  for (let i = 0; i + 3 < clean.length; i += 4) out += String.fromCharCode(parseInt(clean.slice(i, i + 4), 16));
  return out;
}

function parseCMap(c: string, f: Font): void {
  const cs = c.match(/begincodespacerange\s*<([0-9A-Fa-f]+)>/);
  if (cs) f.bytes = cs[1].length > 2 ? 2 : 1;
  for (const block of c.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const p of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g)) f.map.set(parseInt(p[1], 16), utf16(p[2]));
  }
  for (const block of c.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const p of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<[0-9A-Fa-f]*>|\[[^\]]*\])/g)) {
      const lo = parseInt(p[1], 16), hi = parseInt(p[2], 16);
      if (!(hi >= lo) || hi - lo > 65535) continue;
      if (p[3].startsWith('[')) {
        const list = [...p[3].matchAll(/<([0-9A-Fa-f]*)>/g)].map((x) => utf16(x[1]));
        for (let k = lo; k <= hi && k - lo < list.length; k++) f.map.set(k, list[k - lo]);
      } else {
        const base = p[3].slice(1, -1);
        const head = base.slice(0, -4), last = parseInt(base.slice(-4) || '0', 16);
        for (let k = lo; k <= hi; k++) f.map.set(k, utf16(head + (last + k - lo).toString(16).padStart(4, '0')));
      }
    }
  }
}

function parseCidWidths(w: string, out: Map<number, number>): void {
  const toks = w.replace(/^\s*\[|\]\s*$/g, '').match(/\[[^\]]*\]|[-+]?[\d.]+/g) ?? [];
  for (let i = 0; i < toks.length;) {
    const first = Number(toks[i]);
    const next = toks[i + 1];
    if (next?.startsWith('[')) {
      next.slice(1, -1).trim().split(/\s+/).filter(Boolean).forEach((x, k) => out.set(first + k, Number(x)));
      i += 2;
    } else {
      const last = Number(next), width = Number(toks[i + 2]);
      if (Number.isFinite(last) && Number.isFinite(width) && last - first < 65536) for (let k = first; k <= last; k++) out.set(k, width);
      i += 3;
    }
  }
}

type Tok = { kind: 'num' | 'name' | 'str' | 'arr' | 'op' | 'other'; v: unknown };

/** Content stream tokens: operands (numbers, names, strings as byte strings, arrays) and operators. */
function tokenize(s: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const ws = (c: string) => c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === '\f' || c === '\0';
  const delim = (c: string) => '()<>[]{}/%'.includes(c);
  const readString = (): string => {
    let depth = 1, r = '';
    i++;
    while (i < s.length && depth > 0) {
      const c = s[i];
      if (c === '\\') {
        const n = s[i + 1];
        const esc: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };
        if (n in esc) { r += esc[n]; i += 2; continue; }
        if (/[0-7]/.test(n)) { const m = s.slice(i + 1, i + 4).match(/^[0-7]{1,3}/)![0]; r += String.fromCharCode(parseInt(m, 8)); i += 1 + m.length; continue; }
        if (n === '\r' || n === '\n') { i += n === '\r' && s[i + 2] === '\n' ? 3 : 2; continue; }
        i++; continue;
      }
      if (c === '(') depth++;
      if (c === ')') { depth--; if (depth === 0) { i++; break; } }
      r += c;
      i++;
    }
    return r;
  };
  const readValue = (): unknown => {
    const c = s[i];
    if (c === '(') return readString();
    if (c === '<' && s[i + 1] !== '<') { const e = s.indexOf('>', i); const h = s.slice(i + 1, e); i = e + 1; return hexToStr(h); }
    if (c === '[') {
      i++;
      const arr: unknown[] = [];
      while (i < s.length) {
        while (i < s.length && ws(s[i])) i++;
        if (s[i] === ']') { i++; break; }
        const before = i;
        const v = readValue();
        if (v !== undefined) arr.push(v);
        if (i === before) i++;
      }
      return arr;
    }
    if (c === '<' && s[i + 1] === '<') {
      let depth = 0;
      while (i < s.length) {
        if (s.startsWith('<<', i)) { depth++; i += 2; continue; }
        if (s.startsWith('>>', i)) { depth--; i += 2; if (depth === 0) break; continue; }
        i++;
      }
      return { dict: true };
    }
    if (c === '/') { let j = i + 1; while (j < s.length && !ws(s[j]) && !delim(s[j])) j++; const v = s.slice(i, j); i = j; return v; }
    let j = i;
    while (j < s.length && !ws(s[j]) && !delim(s[j])) j++;
    const word = s.slice(i, j);
    i = j;
    if (/^[-+]?(\d+\.?\d*|\.\d+)$/.test(word)) return Number(word);
    return { op: word };
  };
  while (i < s.length) {
    const c = s[i];
    if (ws(c)) { i++; continue; }
    if (c === '%') { while (i < s.length && s[i] !== '\n' && s[i] !== '\r') i++; continue; }
    const before = i;
    const v = readValue();
    if (i === before) { i++; continue; }
    if (v && typeof v === 'object' && 'op' in (v as object)) {
      const op = (v as { op: string }).op;
      if (op === 'BI') { const e = s.indexOf('EI', i); i = e < 0 ? s.length : e + 2; continue; }
      out.push({ kind: 'op', v: op });
    } else if (typeof v === 'number') out.push({ kind: 'num', v });
    else if (typeof v === 'string') out.push({ kind: v.startsWith('/') ? 'name' : 'str', v });
    else if (Array.isArray(v)) out.push({ kind: 'arr', v });
    else out.push({ kind: 'other', v });
  }
  return out;
}
