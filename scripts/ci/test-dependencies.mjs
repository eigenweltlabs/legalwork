// One source/input graph for portable and native test selection. A pinned ref
// reads Git blobs directly, so historical replays never use today's source graph.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceFile = /\.[cm]?[jt]sx?$/;
export const isTestFile = file => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file);
export const isTestInput = (area, file) => (file.startsWith(`apps/${area}/`) || /^(?:packages\/|patches\/)/.test(file))
  && !file.endsWith('.md') && file !== 'apps/server/src/core-skills.ts';

function inputs(area, root, ref) {
  const paths = [`apps/${area}/`, 'packages/'];
  const files = execFileSync('git', ref ? ['ls-tree', '-rz', '--name-only', ref, '--', ...paths]
    : ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...paths], { cwd: root, encoding: 'utf8' })
    .split('\0').filter(Boolean).filter(file => ref || existsSync(path.join(root, file)));
  const textFiles = files.filter(file => file !== 'apps/server/src/core-skills.ts'
    && (sourceFile.test(file) || /(?:^|\/)(?:package|tsconfig)\.json$/.test(file)));
  if (!ref) return { files, text: new Map(textFiles.map(file => [file, readFileSync(path.join(root, file), 'utf8')])) };
  const bytes = execFileSync('git', ['cat-file', '--batch'], { cwd: root,
    input: textFiles.map(file => `${ref}:${file}\n`).join(''), maxBuffer: 128 * 1024 * 1024 });
  let offset = 0;
  const text = new Map();
  for (const file of textFiles) {
    const end = bytes.indexOf(10, offset), header = bytes.subarray(offset, end).toString();
    if (!/^[a-f0-9]+ blob \d+$/.test(header)) throw Error(`Cannot read ${ref}:${file}`);
    const size = Number(header.split(' ')[2]);
    text.set(file, bytes.subarray(end + 1, end + 1 + size).toString());
    offset = end + 1 + size + 1;
  }
  return { files, text };
}

export function testDependencies(area, { root = process.cwd(), ref, runtimeOnly = false } = {}) {
  const require = createRequire(import.meta.url);
  const ts = require(require.resolve('typescript', { paths: ['server', 'app'].map(name => fileURLToPath(new URL(`../../apps/${name}/`, import.meta.url))) }));
  const { files, text } = inputs(area, root, ref), known = new Set(files), parents = new Map(), imports = new Map(), literals = new Map();
  const relative = absolute => path.relative(root, absolute).split(path.sep).join('/');
  const directories = new Set(['.']);
  for (const file of files) for (let dir = path.posix.dirname(file); dir !== '.'; dir = path.posix.dirname(dir)) directories.add(dir);
  const configFile = `apps/${area}/tsconfig.json`;
  const parsed = ts.parseConfigFileTextToJson(configFile, text.get(configFile) ?? '{}');
  if (parsed.error) throw Error(ts.flattenDiagnosticMessageText(parsed.error.messageText, '\n'));
  const options = ts.convertCompilerOptionsFromJson(parsed.config.compilerOptions ?? {}, path.join(root, `apps/${area}`)).options;
  // Workspace exports resolve from authored manifests, including in a checkout
  // with no node_modules and in historical revisions with different exports.
  const leaves = value => typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(leaves) : [];
  const aliases = { ...options.paths }, manifests = new Map();
  for (const [file, content] of text) {
    if (!file.endsWith('/package.json')) continue;
    const pkg = JSON.parse(content);
    if (!pkg.name) continue;
    manifests.set(pkg.name, file);
    const exports = typeof pkg.exports === 'string' ? { '.': pkg.exports } : pkg.exports ?? { '.': pkg.types ?? pkg.main ?? './index.ts' };
    for (const [name, value] of Object.entries(exports)) {
      if (!name.startsWith('.')) continue;
      aliases[pkg.name + name.slice(1)] = [...new Set(leaves(value).filter(target => target.startsWith('./'))
        .map(target => path.resolve(root, path.posix.dirname(file), target)))];
    }
  }
  options.paths = aliases;
  const host = { fileExists: file => known.has(relative(file)), readFile: file => text.get(relative(file)),
    directoryExists: dir => directories.has(relative(dir) || '.'), realpath: file => file,
    getCurrentDirectory: () => root, useCaseSensitiveFileNames: true };
  const cache = ts.createModuleResolutionCache(root, file => file, options);
  const add = (dependency, importer, literal = false) => {
    if (!known.has(dependency)) return;
    if (!parents.has(dependency)) parents.set(dependency, new Set());
    parents.get(dependency).add(importer);
    if (literal && (isTestFile(importer) || importer.includes('.test-support.'))) {
      if (!literals.has(dependency)) literals.set(dependency,new Set());
      literals.get(dependency).add(importer);
    }
  };
  for (const [file, source] of text) {
    if (!sourceFile.test(file)) continue;
    if (!runtimeOnly && file.startsWith(`apps/${area}/`)) {
      add(configFile, file);
      add(`apps/${area}/package.json`, file);
    }
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const isErased = node =>
      ts.isImportDeclaration(node) && (node.importClause?.isTypeOnly
        || node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)
          && !node.importClause.name && node.importClause.namedBindings.elements.length > 0
          && node.importClause.namedBindings.elements.every(element => element.isTypeOnly))
      || ts.isExportDeclaration(node) && (node.isTypeOnly || node.exportClause && ts.isNamedExports(node.exportClause)
        && node.exportClause.elements.length > 0 && node.exportClause.elements.every(element=>element.isTypeOnly));
    const erased = new Set(ast.statements.filter(isErased).map(node => node.moduleSpecifier?.text));
    for(const node of ast.statements) if(node.moduleSpecifier && !isErased(node))erased.delete(node.moduleSpecifier.text);
    for (const imported of ts.preProcessFile(source, true, true).importedFiles) {
      if (runtimeOnly && erased.has(imported.fileName)) continue;
      if (!imports.has(imported.fileName)) imports.set(imported.fileName, new Set());
      imports.get(imported.fileName).add(file);
      const resolved = ts.resolveModuleName(imported.fileName, path.join(root, file), options, host, cache).resolvedModule;
      if (resolved) add(relative(resolved.resolvedFileName), file);
      if (!runtimeOnly) for (const [name, manifest] of manifests) if (imported.fileName === name || imported.fileName.startsWith(name + '/')) add(manifest, file);
    }
    // Native tests often load compiled plugins or fixtures by URL rather than
    // importing them. Include those literal runtime inputs in the same graph.
    if (source.includes('new URL')) {
      const visit = node => {
        if (ts.isNewExpression(node) && node.expression.getText() === 'URL' && node.arguments?.length === 2
          && ts.isStringLiteral(node.arguments[0]) && node.arguments[1].getText() === 'import.meta.url') {
          const name = node.arguments[0].text;
          if (name.startsWith('.')) {
            const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), name));
            if (known.has(target)) add(target, file, true);
            else {
              const resolved = ts.resolveModuleName(name, path.join(root, file), options, host, cache).resolvedModule;
              if (resolved) add(relative(resolved.resolvedFileName), file, true);
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(ast);
    }
  }
  const tests = files.filter(isTestFile);
  return { files: known, sources: text, tests, imports,
    fixtureReaders: changed => [...new Set(changed.flatMap(file=>[...literals.get(file)??[]]))],
    directTests: changed => [...new Set(changed.flatMap(file => [...parents.get(file) ?? []].filter(isTestFile)))].sort(),
    affected(changed) {
    const result = new Set();
    for (const input of changed) {
      const reachable = new Set([input]);
      for (const test of tests) {
        const source = text.get(test);
        if (source?.includes('readFile') && source.includes(path.posix.basename(input))) reachable.add(test);
      }
      for (const file of reachable) for (const parent of parents.get(file) ?? []) reachable.add(parent);
      const stem = path.posix.basename(input).replace(sourceFile, '');
      for (const test of tests) if (reachable.has(test) || path.posix.basename(test).startsWith(stem + '.')) result.add(test);
    }
    return [...result].sort();
  } };
}
