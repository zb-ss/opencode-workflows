#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (error) {
    throw new Error(`${filePath}: ${error.message}`)
  }
}

function stripDocumentationKeys(value) {
  if (Array.isArray(value)) return value.map(stripDocumentationKeys)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !key.startsWith('_'))
      .map(([key, child]) => [key, stripDocumentationKeys(child)]),
  )
}

function formatErrors(errors) {
  return (errors ?? []).map((error) => {
    const location = error.instancePath || '/'
    return `  ${location} ${error.message}`
  }).join('\n')
}

function validatorFor(schemaPath) {
  const ajv = new Ajv2020({ allErrors: true, strict: false })
  ajv.addFormat('date-time', true)
  const schemaDirectory = path.join(REPO_ROOT, 'schema')
  if (fs.existsSync(schemaDirectory)) {
    for (const name of fs.readdirSync(schemaDirectory).sort()) {
      if (!name.endsWith('.json')) continue
      const schema = readJson(path.join(schemaDirectory, name))
      if (!schema.$id || !ajv.getSchema(schema.$id)) ajv.addSchema(schema)
    }
  }
  const schema = readJson(schemaPath)
  return schema.$id && ajv.getSchema(schema.$id) ? ajv.getSchema(schema.$id) : ajv.compile(schema)
}

export function validateFile(filePath, schemaPath, options = {}) {
  const validate = validatorFor(schemaPath)
  const raw = readJson(filePath)
  const value = options.stripDocumentation === false ? raw : stripDocumentationKeys(raw)
  if (!validate(value)) {
    throw new Error(`${filePath} is invalid:\n${formatErrors(validate.errors)}`)
  }
}

function parseArgs(args) {
  const parsed = { configs: [], manifests: [] }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--config' && args[index + 1]) parsed.configs.push(path.resolve(args[++index]))
    else if (arg === '--manifest' && args[index + 1]) parsed.manifests.push(path.resolve(args[++index]))
    else throw new Error(`Unknown or incomplete option: ${arg}`)
  }
  return parsed
}

export function main(args = process.argv.slice(2)) {
  const options = parseArgs(args)
  const workflowsSchema = path.join(REPO_ROOT, 'schema', 'workflows.schema.json')
  const manifestSchema = path.join(REPO_ROOT, 'schema', 'install-manifest.schema.json')
  const modeSchema = path.join(REPO_ROOT, 'schema', 'mode.schema.json')
  const checks = []

  if (options.configs.length === 0 && options.manifests.length === 0) {
    checks.push({ file: path.join(REPO_ROOT, 'workflows.json.template'), schema: workflowsSchema })
    for (const name of fs.readdirSync(path.join(REPO_ROOT, 'mode')).sort()) {
      if (name.endsWith('.json')) checks.push({ file: path.join(REPO_ROOT, 'mode', name), schema: modeSchema })
    }
    const definitionSchema = path.join(REPO_ROOT, 'schema', 'workflow-definition.schema.json')
    if (fs.existsSync(definitionSchema)) {
      for (const name of fs.readdirSync(path.join(REPO_ROOT, 'workflow')).sort()) {
        if (name.endsWith('.json')) checks.push({ file: path.join(REPO_ROOT, 'workflow', name), schema: definitionSchema })
      }
    }
    for (const name of fs.readdirSync(path.join(REPO_ROOT, 'schema')).sort()) {
      if (name.endsWith('.json')) validatorFor(path.join(REPO_ROOT, 'schema', name))
    }
  }

  for (const file of options.configs) checks.push({ file, schema: workflowsSchema })
  for (const file of options.manifests) {
    checks.push({ file, schema: manifestSchema, stripDocumentation: false })
  }

  for (const check of checks) {
    validateFile(check.file, check.schema, { stripDocumentation: check.stripDocumentation })
    console.log(`valid: ${path.relative(REPO_ROOT, check.file) || path.basename(check.file)}`)
  }
  console.log(`Configuration validation passed (${checks.length} files).`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
