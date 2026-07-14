/**
 * @deprecated Install plugin/external-cli-delegation.ts instead. The plugin
 * owns the delegate_command tool ID and the other delegation tools. This
 * wrapper remains only for installations that still load the standalone ID.
 */

import { tool, type ToolContext } from '@opencode-ai/plugin'

import { executeDelegateCommand } from '../plugin/external-cli-delegation.ts'

export default tool({
  description: 'Execute a /delegate subcommand. Pass the full command string in "input".',
  args: {
    input: tool.schema.string().default('').describe('Raw arguments, for example "status claude --auth" or "ask claude Explain this flow"'),
  },
  async execute(args: { input: string }, context: ToolContext) {
    try {
      return JSON.stringify(await executeDelegateCommand(args.input.trim(), context), null, 2)
    } catch (error) {
      if (context.abort.aborted) throw error
      const message = error instanceof Error ? error.message : String(error)
      return JSON.stringify({ success: false, error: `delegate_command crashed: ${message}` })
    }
  },
})
