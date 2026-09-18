/**
 * OpenCode Queue Owner Tools Plugin
 *
 * OpenCode invokes every export of a plugin file as a plugin, so the tool
 * factory lives in lib/ and this entry point exports only the plugin factory.
 */

import { tool, type Plugin } from '@opencode-ai/plugin'
import { createOpencodeClient } from '@opencode-ai/sdk/v2/client'

import { createQueueOwnerTools } from '../lib/queue-owner-tools.ts'

export const QueueOwnerTools: Plugin = async input => createQueueOwnerTools(input, { tool, createOpencodeClient })

export default QueueOwnerTools
