import fs from 'node:fs'
import path from 'node:path'

import { withLock } from '../../lib/fencing-lease.ts'

const [lockDir, barrier, workerId, mode] = process.argv.slice(2)
if (!lockDir || !barrier || !workerId || !mode) process.exit(2)

try {
  if (mode === 'race') {
    // Simple race worker: signal ready, wait for go, try to acquire lock.
    fs.writeFileSync(path.join(barrier, `ready-${workerId}`), '')
    while (!fs.existsSync(path.join(barrier, 'go'))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2)

    withLock(lockDir, () => {
      fs.writeFileSync(path.join(barrier, `entered-${workerId}`), '')
      while (!fs.existsSync(path.join(barrier, `release-${workerId}`))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2)
    })
    process.stdout.write(JSON.stringify({ won: true, worker: workerId }))
  } else if (mode === 'delayed') {
    // Delayed worker: signal ready, wait for go, acquire lock and hold it.
    fs.writeFileSync(path.join(barrier, `ready-${workerId}`), '')
    while (!fs.existsSync(path.join(barrier, 'go'))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2)

    withLock(lockDir, () => {
      fs.writeFileSync(path.join(barrier, `entered-${workerId}`), '')
      while (!fs.existsSync(path.join(barrier, `release-${workerId}`))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2)
    })
    process.stdout.write(JSON.stringify({ won: true, worker: workerId }))
  } else {
    process.exit(2)
  }
} catch (error) {
  process.stdout.write(JSON.stringify({ won: false, code: (error as { code?: string }).code ?? 'error', worker: workerId }))
  process.exitCode = 1
}