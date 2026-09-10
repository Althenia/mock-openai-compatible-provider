#!/usr/bin/env bun

import { runCLI } from "./cli.ts"
import { loginProvider, serveProvider } from "./runtime.ts"

process.exitCode = await runCLI(process.argv.slice(2), undefined, {
  serve: serveProvider,
  login: loginProvider,
})
