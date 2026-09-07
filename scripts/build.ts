export {}

const result = await Bun.build({
  entrypoints: ["src/index.ts"],
  compile: { outfile: "dist/aipass-browser-provider" },
  external: ["chromium-bidi/*"],
  plugins: [{
    name: "embed-playwright-metadata",
    setup(build) {
      build.onLoad({ filter: /playwright-core\/lib\/coreBundle\.js$/ }, async ({ path }) => {
        let contents = await Bun.file(path).text()
        // AIPassport build modification: bundle these JSON files instead of
        // retaining Playwright's filesystem reads from the build machine.
        for (const name of ["package", "browsers"]) {
          const pattern = new RegExp(`require\\(import_path\\d+\\.default\\.join\\(packageRoot, "${name}\\.json"\\)\\)`, "g")
          if (contents.match(pattern)?.length !== 1)
            throw new Error(`review Playwright ${name}.json bundling after dependency changes`)
          contents = contents.replace(pattern, `require("../${name}.json")`)
        }
        return { contents, loader: "js" }
      })
    },
  }],
})
if (!result.success) throw new AggregateError(result.logs, "executable build failed")
