# Source and rebuilding

AIPassport is licensed under **AGPL-3.0-only**. The release's
`aipass-browser-provider-0.1.2-complete-source.tar.gz` consolidates the application
source archive, bundled-component source archives, license/notices, rebuilding
instructions, installer, and offline checksums. Its nested
`aipass-browser-provider-0.1.2-source.tar.gz` contains the application source,
locked dependency manifest, tests, and build/installation scripts from the exact
release commit. The same commit is available through the `v0.1.2` Git tag.
The included `release.json` identifies that commit, version, compiler, and target.
The existing `v0.1.0` and `v0.1.1` releases remain unchanged. Supporting files for `v0.1.2`
are inside its complete source bundle rather than separate release attachments.

Keep this document, `LICENSE`, `THIRD_PARTY_NOTICES`, and corresponding source
access with redistributed binaries. Third-party components keep their own
licenses; the project license does not replace them. Provide the corresponding
source to users who interact with a modified network service as required by
AGPL section 13. Do not assume that an inaccessible private repository satisfies
that obligation for users outside the repository's authorized audience.

## Bundled source

The complete source archive also contains:

| Component | Source revision | Archive |
| --- | --- | --- |
| Bun | `bun-v1.4.2` | `bun-1.4.2-source.tar.gz` |
| Playwright | `v1.62.1` | `playwright-1.62.1-source.tar.gz` |
| WebKit/JavaScriptCore | `2e2aa2290fac856d6f451ceacb58f7f5b44dd057` | `webkit-2e2aa229-source.tar.gz` |
| TinyCC | `05f0fafaa3be31e31d7b4b5c17dc60f62c991171` | `tinycc-05f0fafa-source.tar.gz` |

Bun's `scripts/build/deps/webkit.ts` and `scripts/build/deps/tinycc.ts` identify
the LGPL component revisions. Bun's archive includes its bindings, dependency
declarations, and patches, including `patches/tinycc/tcc.h.patch`. The WebKit
archive includes all library source and build inputs; only the browser test
corpora `JSTests`, `LayoutTests`, `ManualTests`, `PerformanceTests`,
`WebDriverTests`, and `Websites` are excluded. `scripts/archive-webkit.sh`
recreates that archive from the published upstream Git tag, since GitHub's
archive endpoint rejects that repository.

Rust registry crate sources are not vendored in Bun's Git archive. Each Rust
registry section in `THIRD_PARTY_NOTICES` identifies its versioned `.crate`
source-download URL and SHA-256 checksum from Bun's supplied `Cargo.lock`.
Those archives provide the crate sources, including MPL-2.0 components such as
`selectors`. Preserve these source-obtainment notices with redistributed binaries.

The complete upstream repositories remain available at:

- <https://github.com/oven-sh/bun/tree/bun-v1.4.2>
- <https://github.com/microsoft/playwright/tree/v1.62.1>
- <https://github.com/oven-sh/WebKit/tree/autobuild-2e2aa2290fac856d6f451ceacb58f7f5b44dd057>
- <https://github.com/oven-sh/tinycc/tree/05f0fafaa3be31e31d7b4b5c17dc60f62c991171>

## Application build

On macOS arm64, use Bun **1.4.2**, the version pinned in the release workflow:

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

The Rust inventory includes every registry crate in Bun's pinned `Cargo.lock`,
including transitive dependencies of `bcrypt`, `getrandom`, and the vendored
`rust-argon2` and `lol_html` forks. This is a conservative cross-platform,
build, and test dependency superset, not a claim that every listed crate is
linked into the macOS executable. The two vendored forks retain their separately
identified upstream license texts; Bun's own workspace crates use Bun's notices.
Crate archives are verified against lockfile checksums before their original
license and notice text is included. Unknown sources and missing license text
stop generation rather than silently reducing the inventory.

`third-party/rust-notice-supplements.json` records reviewed exceptions for exact
crate versions whose license text is outside the usual archive paths. Each
exception must match the crate's declared license and packaged Git revision.
It identifies either an original archive member (`r-efi`'s `AUTHORS`) or a
checksum-pinned upstream document. Repository documents use the crate's recorded
revision; `selectors` uses the canonical MPL 2.0 text linked by its source header.

`LICENSE` and `THIRD_PARTY_NOTICES` are generated from canonical/upstream text by
`bun scripts/sync-notices.ts --bun-source BUN_ARCHIVE --webkit-source WEBKIT_ARCHIVE`,
using the accompanying Bun and WebKit archives; use `--check` to compare without
writing. Both source archives are checksum-verified. The generator normalizes
line endings and trailing whitespace, not license wording. Review
the component inventory, source revisions, notice supplements, and `third-party/sources.sha256`
whenever the bundled runtime or dependencies change. Do not edit copyright or
license text manually, and do not replace failed retrievals with placeholders.
