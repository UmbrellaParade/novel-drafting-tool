/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');
const ts = require('typescript');
const { getSchema } = require('@tiptap/core');
const { EditorState, TextSelection } = require('@tiptap/pm/state');
const { history, undo, redo } = require('@tiptap/pm/history');
const StarterKit = require('@tiptap/starter-kit').default;
const Image = require('@tiptap/extension-image').default;

const root = path.resolve(__dirname, '..');
const relativeSource = 'src/components/tiptapExtensions.ts';
function loadExtensions(source, name) {
  const filename = path.join(root, 'src/components', `${name}.cjs`);
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded._compile(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, filename);
  return loaded.exports;
}
const current = loadExtensions(fs.readFileSync(path.join(root, relativeSource), 'utf8'), 'performance-current');
const baselineRef = process.argv.find((arg) => arg.startsWith('--compare='))?.slice('--compare='.length);
const baseline = baselineRef ? loadExtensions(execFileSync('git', ['show', `${baselineRef}:${relativeSource}`], { cwd: root, encoding: 'utf8' }), 'performance-baseline') : null;
const schema = getSchema([StarterKit, Image, current.HorizontalWritingBlockNode, current.ColumnBlockNode, current.QrCardNode, current.RubyTextNode, current.PageBreakBeforeExtension]);
const paragraph = (text) => schema.nodes.paragraph.create(null, text ? schema.text(text) : null);
const makeDoc = (nodes) => schema.nodes.doc.create(null, nodes);
const plugins = (extensions) => extensions.VerticalPunctuationExtension.config.addProseMirrorPlugins.call(extensions.VerticalPunctuationExtension);
const stateFor = (doc, extensions = current) => EditorState.create({ schema, doc, plugins: [...plugins(extensions), history()] });
function decorations(state) {
  const plugin = state.plugins[0];
  return plugin.props.decorations.call(plugin, state);
}
function signature(set) {
  return set.find().map((d) => [d.from, d.to, d.type.attrs.class]).sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2].localeCompare(b[2]));
}
function assertFresh(state) {
  assert.deepEqual(signature(decorations(state)), signature(decorations(stateFor(state.doc))), 'Incremental decorations differ from a fresh rendering');
  if (baseline) assert.deepEqual(signature(decorations(state)), signature(decorations(stateFor(state.doc, baseline))), 'Punctuation differs from the previous implementation');
}

let checked = 0;
let state = stateFor(makeDoc([
  paragraph('東京13……―！！ abc...99'),
  schema.nodes.horizontalWritingBlock.create(null, paragraph('横書き13……―！！。')),
  schema.nodes.blockquote.create(null, paragraph('引用42．．．—！？')),
  paragraph('末尾12')
]));
function apply(transaction) {
  state = state.apply(transaction);
  assertFresh(state);
  checked++;
}
assertFresh(state);
const initial = decorations(state);
apply(state.tr.setSelection(TextSelection.create(state.doc, 3)));
assert.equal(decorations(state), initial, 'Selection-only transactions must reuse decorations');
apply(state.tr.insertText('0', 5));
apply(state.tr.delete(5, 6));
apply(state.tr.split(8));
apply(state.tr.join(state.doc.firstChild.nodeSize));
apply(state.tr.addMark(1, 10, schema.marks.bold.create()));
apply(state.tr.insertText('…', 1).insertText('13', state.doc.content.size - 1));
undo(state, (tr) => apply(tr));
redo(state, (tr) => apply(tr));
const first = state.doc.firstChild;
apply(state.tr.replaceWith(0, first.nodeSize, schema.nodes.horizontalWritingBlock.create(null, first)));
apply(state.tr.replaceWith(0, state.doc.firstChild.nodeSize, state.doc.firstChild.content));
apply(state.tr.replaceWith(0, state.doc.content.size, [paragraph('……13!!'), paragraph('――99？？') ]));

let seed = 91307;
function random(max) {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed % max;
}
for (let i = 0; i < 600; i++) {
  const texts = [];
  state.doc.descendants((node, pos) => { if (node.isText) texts.push({ node, pos }); });
  const { node, pos } = texts[random(texts.length)];
  const from = pos + random(node.nodeSize);
  const to = Math.min(pos + node.nodeSize, from + random(4));
  const replacements = ['1', '13', '123', '…', '..', '．．．', '―', '!?', '！！', '。', '日本語'];
  apply(state.tr.insertText(replacements[random(replacements.length)], from, to));
}

// Test DOM sync work without a browser: count which image node views are touched.
const animationFrames = [];
global.window = { requestAnimationFrame: (callback) => (animationFrames.push(callback), animationFrames.length), cancelAnimationFrame() {} };
class ElementStub {}
class ImageStub extends ElementStub {
  style = { removeProperty() {} };
  setAttribute() {}
  removeAttribute() {}
  closest() { return null; }
}
global.HTMLElement = ElementStub;
global.HTMLImageElement = ImageStub;
const imageNodes = Array.from({ length: 100 }, (_, index) => schema.nodes.image.create({ src: `image-${index}`, width: 240, height: 320 }));
let imageState = stateFor(makeDoc([paragraph('先頭'), ...imageNodes, paragraph('末尾')]));
const touched = [];
const view = { state: imageState, nodeDOM: (pos) => (touched.push(pos), new ImageStub()), dom: { dispatchEvent() {} } };
const imagePlugin = current.ImageDimensionSyncExtension.config.addProseMirrorPlugins.call(current.ImageDimensionSyncExtension)[0];
const imageView = imagePlugin.spec.view(view);
animationFrames.shift()();
assert.equal(touched.length, 100);
function updateImages(tr) {
  touched.length = 0;
  const previous = imageState;
  imageState = imageState.apply(tr);
  view.state = imageState;
  imageView.update(view, previous);
}
updateImages(imageState.tr.insertText('文字', 1));
assert.equal(touched.length, 0, 'Typing must not write image dimensions');
const imagePosition = imageState.doc.firstChild.nodeSize + 50;
const imageNode = imageState.doc.nodeAt(imagePosition);
updateImages(imageState.tr.setNodeMarkup(imagePosition, undefined, { ...imageNode.attrs, width: 360 }));
assert.deepEqual(touched, [imagePosition], 'Resizing must only touch the changed image');
updateImages(imageState.tr.insert(imagePosition, schema.nodes.image.create({ src: 'new', width: 120, height: 160 })));
assert.deepEqual(touched, [imagePosition]);
updateImages(imageState.tr.delete(imagePosition, imagePosition + 1));
assert.deepEqual(touched, []);
imageView.destroy();

const nodes = [];
for (let i = 0; i < 3000; i++) {
  nodes.push(paragraph(`第${i}節。東京13世は……「行こう！！」― 雨の街を歩きます。${'日本語の本文を入力します。'.repeat(3)}`));
  if (i % 50 === 0) {
    nodes.push(schema.nodes.image.create({ src: `test-${i}`, width: 240, height: 320 }));
    nodes.push(schema.nodes.qrCard.create({ title: '公式サイト', url: 'https://example.com', width: 240 }));
  }
}
const bigDoc = makeDoc(nodes);
const positions = {};
bigDoc.descendants((node, pos) => { if (['image', 'qrCard'].includes(node.type.name) && positions[node.type.name] === undefined) positions[node.type.name] = pos; });
function bench(extensions) {
  const results = {};
  for (const scenario of ['selection', 'typing', 'image', 'qrCard']) {
    let sample = stateFor(bigDoc, extensions);
    const durations = [];
    for (let i = 0; i < 80; i++) {
      let tr = sample.tr;
      if (scenario === 'selection') tr = tr.setSelection(TextSelection.create(sample.doc, i % 20 + 1));
      else if (scenario === 'typing') tr = tr.insertText(String(i % 10), 2, 3);
      else {
        const pos = positions[scenario];
        tr = tr.setNodeMarkup(pos, undefined, { ...sample.doc.nodeAt(pos).attrs, width: 240 + i });
      }
      const start = performance.now();
      sample = sample.apply(tr);
      // ProseMirror reads decorations while updating the view.
      decorations(sample);
      durations.push(performance.now() - start);
    }
    durations.sort((a, b) => a - b);
    results[scenario] = { medianMs: +durations[40].toFixed(3), p95Ms: +durations[76].toFixed(3) };
  }
  return results;
}
const result = { regressionChecks: checked, characters: bigDoc.textContent.length, paragraphs: 3000, images: 60, qrCards: 60, scope: 'ProseMirror transaction + punctuation decorations only; excludes browser layout, paint and file export', ...(baseline ? { baselineRef, before: bench(baseline) } : {}), after: bench(current) };
console.log(JSON.stringify(result, null, 2));
fs.mkdirSync(path.join(root, '.next'), { recursive: true });
fs.writeFileSync(path.join(root, '.next', 'editor-performance.json'), JSON.stringify(result, null, 2));
