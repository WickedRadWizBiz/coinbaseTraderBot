import assert from 'node:assert/strict';
import path from 'path';
import zlib from 'zlib';
import { test } from 'node:test';
import { loadConfig } from '../bot/config';
import { orderFee, takerFee } from '../bot/fees';
import { FeeBook, feeTypeMultipliers, parsePublishedSchedule, readPublishedSchedulePdf, tableCheck, type PublishedSchedule } from '../bot/kalshi/feeSchedule';
import type { KalshiRest } from '../bot/kalshi/rest';
import { KalshiRest as Rest } from '../bot/kalshi/rest';
import { parseSeriesFees } from '../bot/kalshi/wire';
import { MarketData, Recorder } from '../bot/marketdata/marketData';
import { pdfLines, pdfText } from '../bot/util/pdfText';
import { tmpDir } from './helpers';

// ---- a small PDF drawn the way the published schedule is: a Type0 (Identity-H) font with a ToUnicode CMap, one glyph
// per Tj with Td moves, compressed content; plus a simple font with literal strings and a TJ array with kerning.
const hex = (s: string) => [...s].map((c) => c.charCodeAt(0).toString(16).padStart(4, '0')).join('');
const glyphs = (x: number, y: number, s: string) => `BT /F1 10 Tf 1 0 0 1 ${x} ${y} Tm ${[...s].map((c, i) => `${i ? '5 0 Td ' : ''}<${hex(c)}> Tj`).join(' ')} ET`;
const simple = (x: number, y: number, s: string) => `BT /F2 10 Tf ${x} ${y} Td (${s.replace(/[()\\]/g, (m) => `\\${m}`)}) Tj ET`;

function makePdf(pages: string[][]): Buffer {
  const parts: Buffer[] = [Buffer.from('%PDF-1.7\n%\xb5\xb6\n')];
  let n = 0;
  const obj = (body: string) => { n++; parts.push(Buffer.from(`${n} 0 obj\n${body}\nendobj\n`, 'latin1')); return n; };
  const stream = (dict: string, text: string) => {
    n++;
    const data = zlib.deflateSync(Buffer.from(text, 'latin1'));
    parts.push(Buffer.from(`${n} 0 obj\n<<${dict}/Filter/FlateDecode/Length ${data.length}>>\nstream\n`), data, Buffer.from('\nendstream\nendobj\n'));
    return n;
  };
  const cmap = stream('', '/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /T-UCS def 1 begincodespacerange <0000> <FFFF> endcodespacerange 1 beginbfrange <0000> <00FF> <0000> endbfrange endcmap end end');
  const cid = obj('<</Type/Font/Subtype/CIDFontType2/BaseFont/AAAAAA+Test/CIDToGIDMap/Identity/CIDSystemInfo<</Registry(Adobe)/Ordering(Identity)/Supplement 0>>/DW 500>>');
  const f1 = obj(`<</Type/Font/Subtype/Type0/BaseFont/AAAAAA+Test/Encoding/Identity-H/DescendantFonts[${cid} 0 R]/ToUnicode ${cmap} 0 R>>`);
  const f2 = obj('<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>');
  const pagesNum = n + pages.length * 2 + 1;
  const kids: number[] = [];
  for (const ops of pages) {
    const c = stream('', ops.join('\n'));
    kids.push(obj(`<</Type/Page/Parent ${pagesNum} 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 ${f1} 0 R/F2 ${f2} 0 R>>>>/Contents ${c} 0 R>>`));
  }
  obj(`<</Type/Pages/Count ${pages.length}/Kids[${kids.map((k) => `${k} 0 R`).join(' ')}]>>`);
  obj(`<</Type/Catalog/Pages ${pagesNum} 0 R>>`);
  parts.push(Buffer.from('trailer\n<<>>\n%%EOF\n'));
  return Buffer.concat(parts);
}

const SCHEDULE_PDF = () => makePdf([
  [
    glyphs(50, 700, 'Trading Fees'),
    glyphs(50, 680, 'fees = round up(M x 0.07 x C x P x (1-P))'),
    glyphs(50, 660, 'round up = rounds up such that the fee + positionCost is rounded to a centicent'),
    glyphs(50, 640, 'Maker Fees'),
    simple(50, 620, 'fees = round up(M x 0.0175 x C x P x (1-P))'),
    glyphs(50, 40, 'Last updated and effective: July 7, 2026'),
  ],
  [
    glyphs(50, 700, 'General Trading Fees Table'),
    simple(50, 680, '$0.05 $0.01 $5.00 $0.34'),
    simple(50, 660, '$0.50 $0.02 $50.00 $1.75'),
    glyphs(50, 600, 'Non-Standard Fees'),
    glyphs(300, 590, 'Maker Taker'),
    glyphs(50, 570, 'KXATPMATCH ATP Tennis Match 1 1'),
    'BT /F2 10 Tf 50 550 Td [(KXBTCY) -3000 (BTC price range EOY) -3000 (0) -3000 (0)] TJ ET',
    // A row and the page footer on one baseline.
    glyphs(50, 530, 'KXNFLMVP 1 1'),
    glyphs(300, 530, 'Last updated and effective: July 7, 2026'),
    glyphs(50, 500, 'Perpetual Futures Fees'),
  ],
]);

test('pdf text: Type0 glyph runs, simple fonts, escapes and TJ kerning come back as lines in reading order', () => {
  const lines = pdfLines(pdfText(SCHEDULE_PDF())).map((l) => `${l.page}|${l.text}`);
  assert.deepEqual(lines.slice(0, 6), [
    '1|Trading Fees',
    '1|fees = round up(M x 0.07 x C x P x (1-P))',
    '1|round up = rounds up such that the fee + positionCost is rounded to a centicent',
    '1|Maker Fees',
    '1|fees = round up(M x 0.0175 x C x P x (1-P))',
    '1|Last updated and effective: July 7, 2026',
  ]);
  assert.ok(lines.includes('2|KXBTCY BTC price range EOY 0 0'), lines.join('\n'));
  assert.ok(lines.includes('2|KXNFLMVP 1 1 Last updated and effective: July 7, 2026'), lines.join('\n'));
});

const LINES = [
  'Trading Fees',
  'orderbook unless they are included in our “Maker Fees” section.',
  'fees = round up(M x 0.07 x C x P x (1-P))',
  'round up = rounds up such that the fee + positionCost is rounded to a centicent',
  'Maker Fees',
  'fees = round up(M x 0.0175 x C x P x (1-P))',
  'Last updated and effective: July 7, 2026',
  'General Trading Fees Table (See below for fees on specific markets)',
  '$0.01 $0.01 $1.00 $0.07', '$0.20 $0.02 $20.00 $1.12', '$0.50 $0.02 $50.00 $1.75', '$0.95 $0.01 $95.00 $0.34',
  'Non-Standard Fees',
  'Maker Taker',
  'Series Multipler Multiplier',
  'KXATPMATCH ATP Tennis Match 1 1',
  'KXBTCY BTC price range EOY 0 0',
  'Will the Citrini scenario', 'KXCITRINI 0 0', 'materialize?',
  "KKXXMMEANRWMAODR LDCUP Men's World Cup winner 11 11",
  'KXNFLMVP 1 1 Last updated and effective: July 7, 2026',
  'KXNCAAFB12 Big 12 Champion 1 1',
  'KXMVE Combos (excluding uncorrelated NFL combos) 2 1',
  'KXDUP Listed twice 1 1', 'KXDUP Listed twice 0 1',
  'Perpetual Futures Fees',
  'KXAFTER Not in the table 1 1',
];

test('published schedule: rates, rounding, effective date, fee table and the non-standard series', () => {
  const p = parsePublishedSchedule(LINES, 1) as PublishedSchedule;
  assert.ok(!('error' in p));
  assert.equal(p.effective, 'July 7, 2026');
  assert.equal(p.takerRate, 0.07);
  assert.equal(p.makerRate, 0.0175);
  assert.equal(p.centicent, true);
  assert.deepEqual(p.nonStandard, {
    KXATPMATCH: { maker: 1, taker: 1 }, KXBTCY: { maker: 0, taker: 0 }, KXCITRINI: { maker: 0, taker: 0 },
    KXMVE: { maker: 2, taker: 1 }, KXNCAAFB12: { maker: 1, taker: 1 }, KXNFLMVP: { maker: 1, taker: 1 },
  });
  assert.deepEqual(p.conflicts, ['KXDUP']);
  assert.equal(p.table.length, 4);
  // The bot's formula, at the published rate and a whole-cent grid, reproduces Kalshi's published table.
  assert.deepEqual(tableCheck(p), { rows: 4, matched: 4, firstMiss: undefined });
  assert.equal(tableCheck({ ...p, takerRate: 0.08 }).firstMiss, '$0.01: the bot computes $0.01 / $0.08, the table says $0.01 / $0.07');
});

test('published schedule: the column order follows the header; a schedule without the formula is an error', () => {
  const swapped = LINES.map((l) => (l === 'Maker Taker' ? 'Taker Maker' : l));
  assert.deepEqual((parsePublishedSchedule(swapped, 1) as PublishedSchedule).nonStandard.KXMVE, { maker: 1, taker: 2 });
  assert.deepEqual(parsePublishedSchedule(LINES.filter((l) => !l.includes('0.07 x')), 1), { error: 'general trading fee formula not found' });
  assert.deepEqual(readPublishedSchedulePdf(Buffer.from('<html>blocked</html>'), 1), { error: 'not a PDF' });
});

test('published schedule from the PDF itself', () => {
  const p = readPublishedSchedulePdf(SCHEDULE_PDF(), 5) as PublishedSchedule;
  assert.ok(!('error' in p), JSON.stringify(p));
  assert.deepEqual([p.effective, p.takerRate, p.makerRate, p.centicent], ['July 7, 2026', 0.07, 0.0175, true]);
  assert.deepEqual(p.nonStandard, { KXATPMATCH: { maker: 1, taker: 1 }, KXBTCY: { maker: 0, taker: 0 }, KXNFLMVP: { maker: 1, taker: 1 } });
  assert.deepEqual(tableCheck(p), { rows: 2, matched: 2, firstMiss: undefined });
});

test('fee types: the schedule\'s tables as multipliers', () => {
  assert.deepEqual(feeTypeMultipliers('quadratic', 1), { taker: 1, maker: 0 });
  assert.deepEqual(feeTypeMultipliers('quadratic_with_maker_fees', 1), { taker: 1, maker: 1 });
  assert.deepEqual(feeTypeMultipliers('quadratic_with_combo_maker_fees', 1), { taker: 1, maker: 2 });
  assert.equal(feeTypeMultipliers('flat', 1), undefined);
  assert.equal(feeTypeMultipliers(undefined, 1), undefined);
  assert.equal(feeTypeMultipliers('quadratic', undefined), undefined);
  assert.deepEqual(parseSeriesFees({ series: { fee_type: 'quadratic_with_maker_fees', fee_multiplier: 1 } }), { feeType: 'quadratic_with_maker_fees', multiplier: 1 });
});

const PUBLISHED = parsePublishedSchedule(LINES, 1) as PublishedSchedule;

test('fee book: a series is verified once the API gives a fee type the schedule defines', () => {
  const b = new FeeBook(0.01);
  assert.deepEqual(b.verified('KXBTC15M'), { ok: false, why: 'series fee schedule not read yet' });
  b.setSeries('KXBTC15M', { feeType: 'quadratic', multiplier: 1 }, 0);
  assert.deepEqual(b.verified('KXBTC15M'), { ok: true });
  b.setSeries('KXX', { feeType: 'flat', multiplier: 1 }, 0);
  assert.equal(b.verified('KXX').ok, false);
  b.setSeries('KXY', undefined, 0);
  assert.match(b.verified('KXY').why ?? '', /no fee type/);
  // Unverified: priced cautiously (maker fees assumed), so an exit's take-profit math never flatters itself.
  const f = b.feesFor('KXX', undefined);
  assert.deepEqual([f.takerMultiplier, f.makerMultiplier, f.source], [1, 1, 'unverified: cautious']);
});

test('fee book: the API and the published schedule agree, or the higher fee is used', () => {
  const b = new FeeBook(0.01);
  b.setSeries('KXBTC15M', { feeType: 'quadratic', multiplier: 1 }, 0);
  b.setSeries('KXATPMATCH', { feeType: 'quadratic', multiplier: 1 }, 0);
  assert.equal(b.feesFor('KXBTC15M', undefined).source, 'api');
  b.setPublished(PUBLISHED, 0);
  const crypto = b.feesFor('KXBTC15M', undefined);
  assert.deepEqual([crypto.takerMultiplier, crypto.makerMultiplier, crypto.source], [1, 0, 'api, matches the published schedule']);
  // The published table charges ATP matches a maker fee the API did not report: the higher.
  const atp = b.feesFor('KXATPMATCH', undefined);
  assert.deepEqual([atp.takerMultiplier, atp.makerMultiplier, atp.source], [1, 1, 'api and published schedule disagree: the higher']);
  assert.ok(orderFee(10, 0.5, false, atp) > 0);
  b.setSeries('KXATPMATCH', { feeType: 'quadratic_with_maker_fees', multiplier: 1 }, 0);
  assert.equal(b.feesFor('KXATPMATCH', undefined).source, 'api, matches the published schedule');
});

test('fee book: the published rates are what the fees are computed with', () => {
  const b = new FeeBook(0.01);
  b.setSeries('KXBTC15M', { feeType: 'quadratic', multiplier: 1 }, 0);
  assert.equal(b.setPublished({ ...PUBLISHED, takerRate: 0.08 }, 0).changed, true);
  assert.equal(takerFee(100, 0.5, b.feesFor('KXBTC15M', undefined)), 2);
  assert.equal(b.setPublished({ ...PUBLISHED, takerRate: 0.08 }, 1).changed, false);
  // A failed read keeps the last good schedule.
  b.setPublished({ error: 'HTTP 429' }, 2);
  assert.equal(b.feesFor('KXBTC15M', undefined).takerRate, 0.08);
  assert.equal(b.status(['KXBTC15M']).published.error, 'HTTP 429');
});

test('fee book: scheduled series changes (type and multiplier) and event overrides take effect at their time', () => {
  const b = new FeeBook(0.01);
  const t0 = 1_000_000;
  b.setSeries('KXBTC15M', { feeType: 'quadratic', multiplier: 1 }, t0);
  b.setSeriesChanges('KXBTC15M', [{ feeType: 'quadratic_with_maker_fees', multiplier: 1.5, scheduledTs: t0 + 1000 }]);
  assert.deepEqual([b.feesFor('KXBTC15M', undefined, t0 + 500).takerMultiplier, b.feesFor('KXBTC15M', undefined, t0 + 500).makerMultiplier], [1, 0]);
  assert.deepEqual([b.feesFor('KXBTC15M', undefined, t0 + 2000).takerMultiplier, b.feesFor('KXBTC15M', undefined, t0 + 2000).makerMultiplier], [1.5, 1.5]);
  // An event on a fee holiday, cleared later; other events and other series' overrides are untouched or dropped.
  b.setEventChanges([
    { eventTicker: 'KXBTC15M-E1', seriesTicker: 'KXBTC15M', type: null, multiplier: 0, scheduledTs: t0 },
    { eventTicker: 'KXBTC15M-E1', seriesTicker: 'KXBTC15M', type: null, multiplier: null, scheduledTs: t0 + 5000 },
    { eventTicker: 'KXNFL-E9', seriesTicker: 'KXNFL', type: null, multiplier: 0, scheduledTs: t0 },
  ], (s) => s === 'KXBTC15M', t0);
  assert.equal(b.feesFor('KXBTC15M', 'KXBTC15M-E1', t0 + 100).takerMultiplier, 0);
  assert.equal(b.feesFor('KXBTC15M', 'KXBTC15M-E2', t0 + 100).takerMultiplier, 1);
  assert.equal(b.feesFor('KXBTC15M', 'KXBTC15M-E1', t0 + 6000).takerMultiplier, 1.5);
  assert.equal(b.status(['KXBTC15M']).eventOverrides, 1);
});

test('fee book: each live fill is checked against the schedule (exact, a rebate of earlier rounding, or a mismatch)', () => {
  const b = new FeeBook(0.01);
  b.setSeries('KXBTC15M', { feeType: 'quadratic', multiplier: 1 }, 0);
  const fill = (charged: number, count = 10, isTaker = true) => b.checkFill({ ticker: 'KXBTC15M-E-1', series: 'KXBTC15M', count, sidePrice: 0.5, isTaker, charged, ts: 1 });
  // 10 at 50c taker: 17.5c, on a whole-cent grid 18c.
  assert.equal(fill(0.18).result, 'exact');
  assert.equal(fill(0.17).result, 'rebate');
  const bad = fill(0.3);
  assert.equal(bad.result, 'mismatch');
  assert.match(bad.note ?? '', /charged \$0\.300000 for 10 @ 0\.5 taker, the schedule says \$0\.180000/);
  // A maker fill on a series with no maker fee: charged nothing.
  assert.equal(fill(0, 10, false).result, 'exact');
  const s = b.status(['KXBTC15M']);
  assert.deepEqual([s.fills.checked, s.fills.exact, s.fills.rebate, s.fills.mismatch], [4, 2, 1, 1]);
  assert.deepEqual(s.series[0].fills, { checked: 4, mismatch: 1 });
});

test('fee book: the account\'s rounding grid is learned from the fees Kalshi charges, and kept', () => {
  const file = path.join(tmpDir(), 'fee_schedule.json');
  const b = new FeeBook(0.01, file);
  b.setSeries('KXBTC15M', { feeType: 'quadratic', multiplier: 1 }, 0);
  // 1 contract at 50c: 1.75c on a $0.0001 grid, 2c on a $0.01 one. Whole-cent fees (100 contracts: $1.75) tell nothing.
  const fill = (charged: number, count = 1) => b.checkFill({ ticker: 'KXBTC15M-E-1', series: 'KXBTC15M', count, sidePrice: 0.5, isTaker: true, charged, ts: 1 });
  assert.equal(fill(1.75, 100).learned, undefined);
  assert.equal(fill(0.0175).learned, undefined);
  assert.equal(fill(0.0175).learned, undefined);
  assert.equal(fill(0.0175).learned, 0.0001);
  assert.equal(b.precision(), 0.0001);
  assert.equal(b.feesFor('KXBTC15M', undefined).balancePrecision, 0.0001);
  assert.equal(fill(0.0175).result, 'exact');
  const again = new FeeBook(0.01, file);
  assert.equal(again.precision(), 0.0001);
  assert.deepEqual(again.status([]).precision, { configured: 0.01, learned: 0.0001, using: 0.0001, votes: { direct: 4, fcm: 0 } });
});

test('market data: reads the published schedule PDF; a failed read keeps the last good one', async () => {
  const dir = tmpDir();
  const cfg = loadConfig({ DASHBOARD_TOKEN: 'x'.repeat(40), DATA_DIR: dir, SPOT_FEED: 'false', DOMINANCE_FEED: 'false', PERPS_FEED: 'false', TA_CANDLES: 'false' });
  const md = new MarketData(cfg, { getSeriesFees: async () => undefined, getOpenMarkets: async () => [] } as unknown as KalshiRest, undefined, new Recorder(path.join(dir, 'rec')));
  const urls: string[] = [];
  const events: unknown[] = [];
  md.on('fee_schedule', (e) => events.push(e));
  await md.checkPublishedSchedule((async (u: string) => { urls.push(u); return new Response(SCHEDULE_PDF(), { status: 200, headers: { etag: '"abc"' } }); }) as unknown as typeof fetch);
  assert.deepEqual(urls, ['https://kalshi.com/docs/kalshi-fee-schedule.pdf']);
  let st = md.feeStatus().published;
  assert.deepEqual([st.effective, st.takerRate, st.makerRate, st.nonStandardListed, st.error], ['July 7, 2026', 0.07, 0.0175, 3, null]);
  assert.deepEqual(events, [{ changed: true, error: undefined }]);
  await md.checkPublishedSchedule((async () => new Response('slow down', { status: 429 })) as unknown as typeof fetch);
  st = md.feeStatus().published;
  assert.deepEqual([st.effective, st.error], ['July 7, 2026', 'HTTP 429']);
  // Kept on disk for the next start.
  const md2 = new MarketData(cfg, {} as KalshiRest, undefined, new Recorder(path.join(dir, 'rec')));
  assert.equal(md2.feeStatus().published.effective, 'July 7, 2026');
});

test('event fee changes: every page, nulls kept as "clear"', async () => {
  const urls: string[] = [];
  const pages = [
    { event_fee_changes: [{ id: '1', event_ticker: 'KXBTC15M-E1', series_ticker: 'KXBTC15M', fee_type_override: null, fee_multiplier_override: 0, scheduled_ts: '2026-10-23T00:00:00Z' }], cursor: 'c2' },
    { event_fee_changes: [{ id: '2', event_ticker: 'KXBTC15M-E1', series_ticker: 'KXBTC15M', fee_type_override: 'quadratic', fee_multiplier_override: null, scheduled_ts: '2026-10-24T00:00:00Z' }], cursor: '' },
  ];
  const rest = new Rest({
    baseUrl: 'https://x.test/trade-api/v2',
    fetchImpl: (async (u: string) => { urls.push(u); return new Response(JSON.stringify(pages[urls.length - 1]), { status: 200 }); }) as unknown as typeof fetch,
  });
  const out = await rest.getEventFeeChanges();
  assert.equal(urls.length, 2);
  assert.ok(urls[0].includes('/events/fee_changes?limit=1000') && urls[1].includes('cursor=c2'), urls.join(' '));
  assert.deepEqual(out, [
    { eventTicker: 'KXBTC15M-E1', seriesTicker: 'KXBTC15M', type: null, multiplier: 0, scheduledTs: Date.parse('2026-10-23T00:00:00Z') },
    { eventTicker: 'KXBTC15M-E1', seriesTicker: 'KXBTC15M', type: 'quadratic', multiplier: null, scheduledTs: Date.parse('2026-10-24T00:00:00Z') },
  ]);
});
