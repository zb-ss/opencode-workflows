import fs from 'node:fs'
import path from 'node:path'

import { FencingLeaseStore } from '../../lib/fencing-lease.ts'

const [leaseDir, barrier, workerId, durationMs] = process.argv.slice(2)
if (!leaseDir || !barrier || !workerId || !durationMs) process.exit(2)

try {
  fs.writeFileSync(path.join(barrier, `ready-${workerId}`), '')
  while (!fs.existsSync(path.join(barrier, 'go'))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2)

  const store = new FencingLeaseStore({
    lease_directory: leaseDir,
    owner: `proc-${workerId}`,
    lease_duration_ms: Number(durationMs),
    now: Date.now,
  })
  const handle = store.acquire()
  process.stdout.write(JSON.stringify({ won: true, generation: handle.lease.fencing_generation, owner: handle.lease.owner }))
  // Do NOT release — the lease file must persist so only one worker can win
} catch (error) {
  process.stdout.write(JSON.stringify({ won: false, code: (error as { code?: string }).code ?? 'error' }))
  process.exitCode = 1
}