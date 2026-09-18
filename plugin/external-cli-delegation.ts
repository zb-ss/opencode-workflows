/**
 * OpenCode External CLI Delegation Plugin
 *
 * Provider CLIs run as argv-only child processes after OpenCode permission
 * approval. Run records and bounded process output are isolated by session.
 *
 * OpenCode invokes every export of a plugin file as a plugin, so the runtime
 * lives in lib/ and this entry point exports only the plugin factory.
 */

import { tool, type Plugin } from '@opencode-ai/plugin'

import { createExternalCliDelegationTools } from '../lib/external-cli-delegation.ts'

export const ExternalCliDelegation: Plugin = async () => createExternalCliDelegationTools({ tool })

export default ExternalCliDelegation
