/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// Exercise the actual PDF measurement function with deterministic layout geometry.
// Browser pagination/rendering is covered separately by long-manuscript-fixture.tsx.
const filename = path.join(__dirname, '../src/components/EditorShell.tsx');
const source = fs.readFileSync(filename, 'utf8');
const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const measurement = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'measurePdfExportLayout');
assert.ok(measurement);
const code = ts.transpileModule(measurement.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;

async function check(pages, vertical) {
  let removed = false;
  const width = 100;
  const pitch = vertical ? width : 120;
  const flow = {
    scrollWidth: pages * pitch - 1,
    getBoundingClientRect: () => ({ right: pages * pitch }),
    querySelectorAll: () => [{
      closest: () => null,
      textContent: 'Final chapter',
      getBoundingClientRect: () => ({ left: (pages - 1) * pitch, right: pitch })
    }]
  };
  const contentWindow = { getBoundingClientRect: () => ({ width, left: 0 }) };
  const root = {
    querySelector: (selector) => selector === '.pdf-export-content-window' ? contentWindow : flow,
    remove: () => { removed = true; }
  };
  const dependencies = {
    createPdfExportDom: (snapshot) => { assert.equal(snapshot.pageCount, 1); return root; },
    document: { body: { append: () => {} } },
    window: { getComputedStyle: () => ({ columnGap: '20px' }) },
    nextAnimationFrame: async () => {},
    waitForPdfExportDom: async () => {},
    ensureVerticalFlowLayout: async () => {},
    measureOccupiedVerticalPages: () => pages
  };
  const measure = new Function(...Object.keys(dependencies), `${code}\nreturn measurePdfExportLayout;`)(...Object.values(dependencies));
  const snapshot = { project: { pageSettings: { writingMode: vertical ? 'vertical' : 'horizontal' } } };
  if (Number.isFinite(pages)) {
    const result = await measure(snapshot);
    assert.equal(result.pageCount, pages, 'PDF measurement must not silently truncate long manuscripts');
    assert.equal(result.sectionTitles.length, pages);
    assert.equal(result.sectionTitles.at(-1), 'Final chapter');
  } else {
    await assert.rejects(measure(snapshot), /PDF/);
  }
  assert.ok(removed, 'Temporary measurement DOM must always be removed');
}

(async () => {
  for (const pages of [1, 159, 160, 161, 220, 501, Infinity, NaN]) {
    await check(pages, false);
    await check(pages, true);
  }
  console.log('16 PDF measurement boundary checks passed (mock geometry; not raster export).');
})().catch((error) => { console.error(error); process.exitCode = 1; });
