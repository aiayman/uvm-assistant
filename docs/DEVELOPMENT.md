# Development

How to build, package, release, and extend UVM-Assistant. For the internals, see
[ARCHITECTURE.md](ARCHITECTURE.md).

---

## Setup

```bash
npm install
```

Node 20+ is required for packaging (`vsce`). If you use nvm:

```bash
export PATH="$HOME/.nvm/versions/node/v20.19.5/bin:$PATH"
```

## Scripts

| Command | What it does |
|---|---|
| `npm run compile` | Development build → `dist/` |
| `npm run watch` | Rebuild on change (extension + both webviews) |
| `npm run build` | Production build (minified, no sourcemaps) |
| `npm run lint` | `tsc --noEmit` — type check only, emits nothing |
| `npm run package` | `vsce package` → `uvm-assistant-<version>.vsix` |

`esbuild.js` produces three bundles: the extension (`dist/extension.js`, CJS, `vscode`
external) and the two webviews (`dist/webview/diagram.js` and `blockDiagram.js`, IIFE,
browser platform). Its plugins copy `tree-sitter.wasm`, the optional SystemVerilog
grammar from `grammars/`, and the webview CSS into `dist/`.

There is no test suite.

## Debugging

`F5` in VS Code launches an Extension Development Host using `.vscode/launch.json`.
Webview code is debugged through the host's own devtools:
`Ctrl+Shift+P` → `Developer: Open Webview Developer Tools`.

Test projects live outside the repo at `/home/ayman/siework/uvm-assistant_tests/`.

## Release

```bash
# 1. Bump "version" in package.json

# 2. Build and package
export PATH="$HOME/.nvm/versions/node/v20.19.5/bin:$PATH"
npm run build
npx vsce package --no-dependencies          # → uvm-assistant-X.Y.Z.vsix

# 3. Install locally to verify
code --install-extension uvm-assistant-X.Y.Z.vsix --force

# 4. Commit, push, tag
git add -A
git commit -m "vX.Y.Z: <summary>"
git push
git tag vX.Y.Z
git push origin vX.Y.Z
```

Pushing a `v*` tag triggers `.github/workflows/release.yml`, which builds the VSIX on CI
and attaches it to a generated GitHub release. The tag is what publishes — a plain push
to `main` does not.

### Conventions

- **Always bump the version before a release push.** Never reuse a tagged version.
- Commit, push, and tag as one step once a VSIX is built and verified.
- Keep [CHANGELOG.md](../CHANGELOG.md) in step with the version bump.
- `.vsix` files are gitignored build artifacts. Don't accumulate them — every tagged
  release already carries its VSIX on GitHub.

---

## Known issues and technical debt

1. **Missing icon assets.** `uvmTypeIcon()` in `src/utils/uvmClassifier.ts` returns names
   for the reg-model roles added in v1.18.0 — `uvm-subscriber`, `uvm-reg-block`, `uvm-reg`,
   `uvm-reg-sequence`, `uvm-reg-adapter`, `uvm-reg-predictor` — but no such SVGs exist in
   `resources/`. The UVM Classes tree shows a blank icon for those types.
2. **Dead constants** in `webview/diagram.ts`: `TRACK_SPACING`, `BLOCK_ARROW_GAP`,
   `PERIMETER_MARGIN`, `PORT_R` — leftovers from the channel-based router.
3. **No tests.** Zero coverage; every change is verified by hand against the test projects.
4. **Tree-sitter grammar is optional.** `grammars/tree-sitter-systemverilog.wasm` is not
   in the repo, so in practice the regex fallback does the real work. The tree-sitter path
   is exercised only if someone drops the grammar in.
5. **Mapping table dialogs are bare HTML** — no validation, no path autocomplete.
6. **Override matching is by class name only.** Two components sharing a name across
   projects will collide in `.uvm-assistant.json`.
7. **Field-based containment is heuristic.** `FIELD_RE` matches `type name;` at indentation,
   which can pick up non-component fields and miss ones declared unusually.

## Ideas / not yet started

- Coverage and `uvm_reg` map visualization in the data flow diagram.
- Jump from a lint diagnostic to the relevant diagram block.
- Per-project `.uvm-assistant.json` instead of one file at the workspace root.
