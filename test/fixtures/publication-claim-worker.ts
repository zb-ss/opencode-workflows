import { PublicationStore } from '../../lib/publication-store.ts'

const SETTLEMENT = { attempts: 200, delay_ms: 5, timeout_ms: 1000 }
const STORE_OPTIONS = { mode: 'read_write' as const, settlement: SETTLEMENT }

const EMPTY_EVENT_DETAIL = {
  exit_code: null,
  signal: null,
  duration_ms: 0,
  stdout_bytes: 0,
  stderr_bytes: 0,
  stdout_sha256: null,
  stderr_sha256: null,
  output_truncated: false,
  output_redacted: false,
  request_acknowledged: false,
  forced_status: null,
  invocation_attempted: false,
  spawn_uncertain: false,
  termination_uncertain: false,
} as const

function waitUntil(timestamp: number): void {
  const remaining = timestamp - Date.now()
  if (remaining <= 0) return
  const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
  Atomics.wait(signal, 0, 0, remaining)
}

function requiredArgument(value: string | undefined, label: string): string {
  if (!value) throw new Error(`missing ${label}`)
  return value
}

async function main(): Promise<unknown> {
  const [mode, configDirectory, rootSessionId, startAtText, first, second] = process.argv.slice(2)
  const env = { ...process.env, OPENCODE_CONFIG_DIR: requiredArgument(configDirectory, 'config directory') }
  const store = new PublicationStore(
    requiredArgument(rootSessionId, 'root session ID'),
    env,
    () => new Date(),
    STORE_OPTIONS,
  )
  const startAt = Number(requiredArgument(startAtText, 'start timestamp'))
  if (!Number.isSafeInteger(startAt)) throw new Error('invalid start timestamp')
  waitUntil(startAt)

  if (mode === 'claim') {
    return await store.claimExecutionForDispatch(
      requiredArgument(first, 'artifact ID'),
      requiredArgument(second, 'artifact digest'),
      {
        occurred_at: '2026-07-15T12:00:01.000Z',
        detail: EMPTY_EVENT_DETAIL,
      },
    )
  }
  if (mode === 'artifact') {
    const encodedArtifact = requiredArgument(first, 'encoded artifact')
    const maximum = Number(requiredArgument(second, 'maximum artifact count'))
    return await store.createArtifact(
      JSON.parse(Buffer.from(encodedArtifact, 'base64url').toString('utf8')),
      maximum,
    )
  }
  throw new Error('unknown worker mode')
}

try {
  process.stdout.write(JSON.stringify({ ok: true, result: await main() }))
} catch (error) {
  process.stdout.write(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }))
}
