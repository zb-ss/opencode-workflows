/**
 * OpenCode Epic Owner Tools Plugin
 *
 * OpenCode invokes every export of a plugin file as a plugin, so the tool
 * factory lives in lib/ and this entry point exports only the plugin factory.
 */

import { tool, type Plugin } from '@opencode-ai/plugin'

import { createEpicOwnerTools } from '../lib/epic-owner-tools.ts'

export const EpicOwnerTools: Plugin = async input => createEpicOwnerTools(input, { tool })

export default EpicOwnerTools
