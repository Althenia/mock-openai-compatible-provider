export type SerialStartupOptions = {
  readonly primingPrompts: readonly string[]
  readonly startupIdentity: string
  readonly primedIdentity: string | undefined
  readonly carriesEnvelope: boolean
  readonly reusableSelection: boolean
  readonly prime: (prompt: string, index: number) => Promise<number>
  readonly reset: () => void
  readonly commit: (identity: string) => void
}

/** Runs startup prompts serially and records their identity only after all replies confirm. */
export async function runSerialStartup(options: SerialStartupOptions): Promise<number> {
  const required = options.primingPrompts.length > 0 && (
    options.carriesEnvelope || !options.reusableSelection || options.primedIdentity !== options.startupIdentity
  )
  if (!required) return 0
  options.reset()
  let estimate = 0
  for (const [index, prompt] of options.primingPrompts.entries()) estimate += await options.prime(prompt, index)
  options.commit(options.startupIdentity)
  return estimate
}
