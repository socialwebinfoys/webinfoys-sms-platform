// Phase 9 frontend test harness — JSX module hooks.
//
// Node cannot import a .jsx file and cannot resolve the extensionless specifiers
// Vite accepts ("./ConfirmDialog"). These hooks close both gaps so the REAL
// components can be imported and rendered in a test, with NO new dependency:
// esbuild is already present as part of vite, and vite is already a devDependency.
//
// It is a compile shim only. Nothing here changes what the components do — the
// same source that ships is what runs.
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { transform } from 'esbuild';

const JS_EXTENSIONS = ['.jsx', '.js', '.mjs'];

// Vite resolves "./Foo" to Foo.jsx; Node requires the extension. Try each in the
// same order Vite would, and otherwise defer to Node's own resolution.
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && !path.extname(specifier)) {
    const parentPath = context.parentURL ? fileURLToPath(context.parentURL) : process.cwd();
    const base = path.resolve(path.dirname(parentPath), specifier);
    for (const ext of JS_EXTENSIONS) {
      if (existsSync(base + ext)) {
        return { url: pathToFileURL(base + ext).href, shortCircuit: true, format: 'module' };
      }
    }
    for (const ext of JS_EXTENSIONS) {
      const indexFile = path.join(base, `index${ext}`);
      if (existsSync(indexFile)) {
        return { url: pathToFileURL(indexFile).href, shortCircuit: true, format: 'module' };
      }
    }
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.endsWith('.jsx') || (url.endsWith('.js') && url.includes('/src/'))) {
    const filename = fileURLToPath(url);
    const source = await readFile(filename, 'utf8');
    const { code } = await transform(source, {
      loader: url.endsWith('.jsx') ? 'jsx' : 'js',
      jsx: 'automatic',
      format: 'esm',
      target: 'node20',
      sourcefile: filename,
      // services/api.js reads import.meta.env, which Vite replaces at build time
      // and Node does not provide. Substituted with the same fallback the source
      // itself uses, so the axios instance is built against a relative '/api'.
      define: { 'import.meta.env.VITE_API_URL': '"/api"' },
    });
    return { format: 'module', shortCircuit: true, source: code };
  }
  return nextLoad(url, context);
}
