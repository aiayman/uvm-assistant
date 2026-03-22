const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const extensionConfig = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  format: 'cjs',
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  platform: 'node',
  outfile: 'dist/extension.js',
  external: ['vscode'],
  logLevel: 'info',
  plugins: [
    {
      name: 'copy-wasm',
      setup(build) {
        build.onEnd(() => {
          // Copy tree-sitter WASM files to dist
          const wasmDir = path.join(__dirname, 'node_modules', 'web-tree-sitter');
          const distDir = path.join(__dirname, 'dist');
          if (!fs.existsSync(distDir)) {
            fs.mkdirSync(distDir, { recursive: true });
          }
          const wasmFile = path.join(wasmDir, 'tree-sitter.wasm');
          if (fs.existsSync(wasmFile)) {
            fs.copyFileSync(wasmFile, path.join(distDir, 'tree-sitter.wasm'));
          }
          // Copy SV grammar WASM if present
          const grammarSrc = path.join(__dirname, 'grammars', 'tree-sitter-systemverilog.wasm');
          if (fs.existsSync(grammarSrc)) {
            fs.copyFileSync(grammarSrc, path.join(distDir, 'tree-sitter-systemverilog.wasm'));
          }
        });
      },
    },
  ],
};

/** @type {import('esbuild').BuildOptions} */
const dataFlowWebviewConfig = {
  entryPoints: ['webview/diagram.ts'],
  bundle: true,
  format: 'iife',
  minify: production,
  sourcemap: !production,
  platform: 'browser',
  outfile: 'dist/webview/diagram.js',
  logLevel: 'info',
  plugins: [
    {
      name: 'copy-webview-assets',
      setup(build) {
        build.onEnd(() => {
          const distWebview = path.join(__dirname, 'dist', 'webview');
          if (!fs.existsSync(distWebview)) {
            fs.mkdirSync(distWebview, { recursive: true });
          }
          // Copy CSS files
          for (const css of ['diagram.css', 'blockDiagram.css']) {
            const src = path.join(__dirname, 'webview', css);
            if (fs.existsSync(src)) {
              fs.copyFileSync(src, path.join(distWebview, css));
            }
          }
        });
      },
    },
  ],
};

/** @type {import('esbuild').BuildOptions} */
const blockWebviewConfig = {
  entryPoints: ['webview/blockDiagram.ts'],
  bundle: true,
  format: 'iife',
  minify: production,
  sourcemap: !production,
  platform: 'browser',
  outfile: 'dist/webview/blockDiagram.js',
  logLevel: 'info',
};

async function main() {
  if (watch) {
    const extCtx = await esbuild.context(extensionConfig);
    const dfCtx = await esbuild.context(dataFlowWebviewConfig);
    const blkCtx = await esbuild.context(blockWebviewConfig);
    await Promise.all([extCtx.watch(), dfCtx.watch(), blkCtx.watch()]);
    console.log('Watching for changes...');
  } else {
    await Promise.all([
      esbuild.build(extensionConfig),
      esbuild.build(dataFlowWebviewConfig),
      esbuild.build(blockWebviewConfig),
    ]);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
