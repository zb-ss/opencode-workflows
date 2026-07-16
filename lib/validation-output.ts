import crypto from 'node:crypto'

import {
  containsSensitiveContent,
  SENSITIVE_CONTENT_STREAM_OVERLAP_BYTES,
} from './sensitive-content.ts'
import type { ValidationRunResult } from './validation-types.ts'

export interface CapturedOutput {
  chunks: Buffer[]
  hash: ReturnType<typeof crypto.createHash>
  sensitive: boolean
  sensitiveTail: Buffer
  totalBytes: number
  storedBytes: number
}

export function capturedOutput(): CapturedOutput {
  return {
    chunks: [],
    hash: crypto.createHash('sha256'),
    sensitive: false,
    sensitiveTail: Buffer.alloc(0),
    totalBytes: 0,
    storedBytes: 0,
  }
}

export function appendOutput(output: CapturedOutput, chunk: Buffer, remaining: number): number {
  output.hash.update(chunk)
  const sensitiveWindow = Buffer.concat([output.sensitiveTail, chunk])
  if (containsSensitiveContent(sensitiveWindow.toString('utf8'))) output.sensitive = true
  output.sensitiveTail = Buffer.from(
    sensitiveWindow.subarray(Math.max(0, sensitiveWindow.length - SENSITIVE_CONTENT_STREAM_OVERLAP_BYTES)),
  )
  output.totalBytes = Math.min(Number.MAX_SAFE_INTEGER, output.totalBytes + chunk.length)
  if (remaining <= 0) return 0
  const stored = chunk.subarray(0, Math.min(chunk.length, remaining))
  output.chunks.push(stored)
  output.storedBytes += stored.length
  return stored.length
}

export function outputText(output: CapturedOutput): string {
  return Buffer.concat(output.chunks, output.storedBytes).toString('utf8')
}

export function redactValidationOutput(
  result: ValidationRunResult,
  outputSensitive: boolean,
): ValidationRunResult {
  if (!outputSensitive && !containsSensitiveContent(result.stdout) && !containsSensitiveContent(result.stderr)) return result
  return {
    ...result,
    status: 'failed',
    stdout: '',
    stderr: 'Validation output was redacted because it matched credential-like content.',
    output_redacted: true,
  }
}
