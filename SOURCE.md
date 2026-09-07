# Source and rebuilding

AIPassport is licensed under **AGPL-3.0-only**. The release's
`aipass-browser-provider-0.1.0-source.tar.gz` contains the application source,
locked dependency manifest, tests, and build/installation scripts from the exact
release commit. The same commit is available through the `v0.1.0` Git tag.
`release.json` identifies that commit, version, compiler, and target.

Keep this document, `LICENSE`, `THIRD_PARTY_NOTICES`, and corresponding source
access with redistributed binaries. Third-party components keep their own
licenses; the project license does not replace them. Provide the corresponding
source to users who interact with a modified network service as required by
AGPL section 13. Do not assume that an inaccessible private repository satisfies
that obligation for users outside the repository's authorized audience.

## Bundled source

Release assets also provide:

| Component | Source revision | Archive |
| --- | --- | --- |
| Bun | `bun-v1.3.14` | `bun-1.3.14-source.tar.gz` |
| Playwright | `v1.62.1` | `playwright-1.62.1-source.tar.gz` |
| WebKit/JavaScriptCore | `5488984d20e0dbfe4be2c3ba8fb18eb81a5e0e8b` | `webkit-5488984d-source.tar.gz` |
| TinyCC | `12882eee073cfe5c7621bcfadf679e1372d4537b` | `tinycc-12882eee-source.tar.gz` |

Bun's `scripts/build/deps/webkit.ts` and `scripts/build/deps/tinycc.ts` identify
the LGPL component revisions. Bun's archive includes its bindings, dependency
declarations, and patches, including `patches/tinycc/tcc.h.patch`. The WebKit
archive includes all library source and build inputs; only the browser test
corpora `JSTests`, `LayoutTests`, `ManualTests`, `PerformanceTests`,
`WebDriverTests`, and `Websites` are excluded. `scripts/archive-webkit.sh`
recreates that archive from the published upstream Git tag, since GitHub's
archive endpoint rejects that repository.

The complete upstream repositories remain available at:

- <https://github.com/oven-sh/bun/tree/bun-v1.3.14>
- <https://github.com/microsoft/playwright/tree/v1.62.1>
- <https://github.com/oven-sh/WebKit/tree/autobuild-5488984d20e0dbfe4be2c3ba8fb18eb81a5e0e8b>
- <https://github.com/oven-sh/tinycc/tree/12882eee073cfe5c7621bcfadf679e1372d4537b>

## Application build

On macOS arm64, use Bun **1.3.14**, the version pinned in the release workflow:

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
bun run test:install
bun run build
bun run test:build
bun run test:release
./dist/aipass-browser-provider --version
```

Google Chrome is a separately installed runtime prerequisite and is not bundled.
The application can also run directly with `bun src/index.ts` followed by a CLI
command. The Playwright source archive includes its upstream build scripts and
notices; the application's lockfile identifies the package used in the build.
`scripts/build.ts` modifies Playwright's bundled JavaScript during compilation:
its `package.json` and `browsers.json` filesystem loads become static imports so
the executable embeds both files instead of depending on the build machine.
The upstream package is unchanged on disk; the build script contains the exact
transformation and rejects unexpected source shapes. `test:build` runs a copied
executable from a temporary directory with repository reads denied on macOS.

## Modified LGPL libraries and relinking

Bun statically links JavaScriptCore/WebKit and TinyCC. Recipients may modify
those components and rebuild/relink; this distribution imposes no additional
restriction on modification or reverse engineering for that purpose.

To rebuild Bun against modified WebKit, use the Bun source tree's prerequisites
and build instructions, place the supplied WebKit source under `vendor/WebKit`,
and run its `bun run build:release:local` command. That script selects local
WebKit rather than downloading the prebuilt library. TinyCC's source and patch
selection are in `scripts/build/deps/tinycc.ts`; update that declaration to your
modified source when rebuilding. These are upstream build paths, not a claim
that this release has rebuilt the entire Bun toolchain locally.

Use the resulting Bun executable to run or recompile the supplied application
source. For a modified Bun executable, update `scripts/build.ts` to use
`compile.executablePath` pointing to that executable, so the compiler does not
download an unmodified runtime. Keep the entry point, metadata embedding, and
externalization of `chromium-bidi/*` in that script. On macOS,
ad-hoc sign the finished executable with `codesign --force --sign -` followed
by its path, as `scripts/build.sh` does; compilation changes the runtime's signed bytes.
Full source is provided rather than an object-only relinking package.

## Updating notices

`LICENSE` and `THIRD_PARTY_NOTICES` are generated from canonical/upstream text by
`bun scripts/sync-notices.ts --webkit-source PATH`, with `PATH` pointing to the
accompanying WebKit source archive; use `--check` to compare without writing. The
archive is checksum-verified before its original notice text is read. The
generator normalizes line endings and trailing whitespace, not license wording. Review
the component inventory, source revisions, and `third-party/sources.sha256`
whenever the bundled runtime or dependencies change. Do not edit copyright or
license text manually, and do not replace failed retrievals with placeholders.
