/**
 * OpenCode loads a path plugin by calling every distinct export of the module
 * as a plugin factory with the PluginInput, and rejects non-function exports.
 * A helper exported from plugin/ is therefore executed at startup: a class
 * fails the whole file, and a second factory registers its hooks twice.
 * Shared code belongs in lib/, and each plugin file exports one factory.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const previousConfigDir = process.env.OPENCODE_CONFIG_DIR
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-module-contract-'))
process.env.OPENCODE_CONFIG_DIR = configDir

const pluginDirectory = fileURLToPath(new URL('../../plugin/', import.meta.url))
const pluginFiles = fs.readdirSync(pluginDirectory)
  .filter(name => name.endsWith('.ts'))
  .sort()

describe('OpenCode plugin module contract', () => {
  after(() => {
    if (previousConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
    else process.env.OPENCODE_CONFIG_DIR = previousConfigDir
    fs.rmSync(configDir, { recursive: true, force: true })
  })

  it('discovers the plugin entry points', () => {
    assert.ok(pluginFiles.length > 0)
  })

  for (const name of pluginFiles) {
    it(`${name} exports exactly one plugin factory`, async () => {
      const module = await import(pathToFileURL(path.join(pluginDirectory, name)).href) as Record<string, unknown>
      const factories = [...new Set(Object.values(module))]

      assert.equal(
        factories.length,
        1,
        `${name} exports ${Object.keys(module).join(', ')}; OpenCode invokes each distinct export as a plugin`,
      )
      assert.equal(typeof factories[0], 'function')
      assert.doesNotMatch(Function.prototype.toString.call(factories[0]), /^class\b/)
    })
  }
})
