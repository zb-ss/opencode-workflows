import fs from 'node:fs'

const NATIVE_EXECUTABLE_MAGICS = [
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]), // ELF
  Buffer.from([0xfe, 0xed, 0xfa, 0xce]), // Mach-O 32-bit
  Buffer.from([0xfe, 0xed, 0xfa, 0xcf]), // Mach-O 64-bit
  Buffer.from([0xce, 0xfa, 0xed, 0xfe]), // Mach-O 32-bit reversed
  Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), // Mach-O 64-bit reversed
  Buffer.from([0xca, 0xfe, 0xba, 0xbe]), // Mach-O universal
  Buffer.from([0xbe, 0xba, 0xfe, 0xca]), // Mach-O universal reversed
  Buffer.from([0xca, 0xfe, 0xba, 0xbf]), // Mach-O universal 64-bit
  Buffer.from([0xbf, 0xba, 0xfe, 0xca]), // Mach-O universal 64-bit reversed
] as const

export function assertNativePublicationExecutable(descriptor: number, label: string): void {
  const header = Buffer.alloc(4)
  const bytesRead = fs.readSync(descriptor, header, 0, header.length, 0)
  if (bytesRead !== header.length || !NATIVE_EXECUTABLE_MAGICS.some(magic => header.equals(magic))) {
    throw new Error(`${label} must be a supported native executable; scripts and shebang interpreters are rejected`)
  }
}
