/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const shellPath = path.join(__dirname, '../src/components/EditorShell.tsx');
const shell = ts.createSourceFile(shellPath, fs.readFileSync(shellPath, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const nodes = [];
function visit(node) { nodes.push(node); ts.forEachChild(node, visit); }
visit(shell);
const declaration = name => nodes.find(node => ts.isVariableDeclaration(node) && node.name.getText(shell) === name);
const transpile = source => ts.transpileModule(source, {compilerOptions:{target:ts.ScriptTarget.ES2020, module:ts.ModuleKind.CommonJS}}).outputText;

// Run the actual activity callback with a deterministic clock and React notifier.
const mark = declaration('markTypingActivity').initializer.arguments[0];
let timerId = 0, notifications = 0, locks = 0;
const timers = new Map();
const dependencies = {
  pageStageRef:{current:{scrollTop:400, scrollLeft:0}},
  fastEditingRef:{current:false},
  editingScrollLockRef:{current:null},
  fastEditingTimerRef:{current:null},
  activeEditorRef:{current:{isDestroyed:false, view:{composing:false}}},
  restoreEditingScrollLock:() => { locks++; },
  setLayoutIdleRevision:() => { notifications++; },
  FAST_EDITING_RESET_MS:3000,
  window:{
    setTimeout:(callback, delay) => { timers.set(++timerId, {callback, delay}); return timerId; },
    clearTimeout:id => timers.delete(id)
  }
};
const activity = new Function(...Object.keys(dependencies), `${transpile(`const activity = ${mark.getText(shell)};`)}return activity;`)(...Object.values(dependencies));
const fire = () => { const id = dependencies.fastEditingTimerRef.current; const timer = timers.get(id); assert.ok(timer); timers.delete(id); timer.callback(); };
activity();
assert.equal(notifications, 0, 'Starting typing must not trigger the full React screen');
assert.equal(dependencies.fastEditingRef.current, true);
assert.deepEqual(dependencies.editingScrollLockRef.current, {top:400, left:0});
activity();
assert.equal(timers.size, 1, 'New input replaces the pending idle timer');
assert.equal(notifications, 0);
assert.equal(locks, 2);
dependencies.activeEditorRef.current.view.composing = true;
fire();
assert.equal(notifications, 0, 'A long IME composition must not trigger page layout');
assert.equal(dependencies.fastEditingRef.current, true);
assert.equal(timers.size, 1);
dependencies.activeEditorRef.current.view.composing = false;
fire();
assert.equal(notifications, 1);
assert.equal(dependencies.fastEditingRef.current, false);
assert.equal(dependencies.editingScrollLockRef.current, null);

const pageCode = ['previousPageCount', 'pageFrameCount'].map(name => `const ${declaration(name).getText(shell)};`).join('\n');
const pageCount = new Function('measuredPages', 'activeChapter', 'layoutPageSettings', 'measuredPageCount', 'estimatedPages', `${transpile(pageCode)}return pageFrameCount;`);
const settings = {};
const measured = {chapterId:'book', pageSettings:settings, count:220};
assert.equal(pageCount(measured,{id:'book'},settings,null,167),220);
assert.equal(pageCount(measured,{id:'book'},settings,225,167),225);
assert.equal(pageCount(measured,{id:'book'},settings,219,167),219);
assert.equal(pageCount(measured,{id:'other'},settings,null,167),167);
assert.equal(pageCount(measured,{id:'book'},{},null,167),167);
assert.equal(pageCount(null,{id:'book'},settings,null,1),1);

// The frame was queued while idle; input can begin before it executes.
const effect = nodes.find(node => ts.isCallExpression(node) && node.expression.getText(shell) === 'useEffect' && node.getText(shell).includes('measureOccupiedPreviewPages(prose'));
let frame;
function findFrame(node) {
  if (ts.isCallExpression(node) && node.expression.getText(shell) === 'window.requestAnimationFrame') frame = node.arguments[0];
  ts.forEachChild(node, findFrame);
}
findFrame(effect);
for (const [typing, destroyed, composing] of [[true,false,false],[false,true,false],[false,false,true]]) {
  const measure = new Function('fastEditingRef','activeEditor', `${transpile(`const measure = ${frame.getText(shell)};`)}return measure;`)({current:typing},{isDestroyed:destroyed,view:{composing}});
  assert.doesNotThrow(measure, 'Scheduled work must stop before reading the paper DOM during input');
}

const statsPath = path.join(__dirname, '../src/lib/defaultProject.ts');
const statsAst = ts.createSourceFile(statsPath, fs.readFileSync(statsPath, 'utf8'), ts.ScriptTarget.Latest, true);
const names = ['manuscriptTextStats','countManuscriptCharacters','estimatePageCount','runManuscriptChecks','isValidUrl'];
const printer = ts.createPrinter();
const declarations = statsAst.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text)).map(node => printer.printNode(ts.EmitHint.Unspecified, ts.factory.updateFunctionDeclaration(node, undefined, node.asteriskToken, node.name, node.typeParameters, node.parameters, node.type, node.body), statsAst));
let textReads = 0;
const stats = new Function('stripHtml', `${transpile(declarations.join('\n'))}return {${names.join(',')}};`)(html => { textReads++; return html; });
const project = {chapters:[{content:'東京(とうきょう) 13'},{content:''}],pageSettings:{pageWidthMm:154,pageHeightMm:216,marginLeftMm:15,marginRightMm:15,marginTopMm:22.2,marginBottomMm:18,fontSizePt:10,lineHeight:1.76}};
const summary = stats.manuscriptTextStats(project);
assert.deepEqual(summary,{characters:11,hasEmptyChapter:true});
const checks = stats.runManuscriptChecks(project,summary);
const pages = stats.estimatePageCount(project,summary.characters);
assert.equal(textReads,2,'One text read per chapter is shared by all checks and estimates');
assert.deepEqual(checks,stats.runManuscriptChecks(project));
assert.equal(pages,stats.estimatePageCount(project));
assert.equal(summary.characters,stats.countManuscriptCharacters(project));
console.log('Paper editing guards, stable page counts, queued-frame cancellation, and shared text statistics passed.');
