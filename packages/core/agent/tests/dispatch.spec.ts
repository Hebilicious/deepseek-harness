/** Agent-scoped dispatch and prompt-assembly helpers. */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { assembleContextFor, emitAgentEvent } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'

const agent = { id: SessionId('dispatch-subject') } as Agent

describe('agent dispatch helpers', () => {
  it('emits one notification that carries the dispatcher-owned subject', () => {
    const ctx = new Context()
    const seen: Array<{ agent: Agent; status: AgentStatus }> = []
    ctx.on('agent/status', ({ agent: subject, status }) => { seen.push({ agent: subject, status }) })

    emitAgentEvent(ctx, agent, 'agent/status', { status: 'running' })

    expect(seen).toEqual([{ agent, status: 'running' }])
  })

  it('assembles the prompt context with agent and scope set together', () => {
    const signal = new AbortController().signal

    expect(assembleContextFor(agent)).toEqual({ agent, scope: agent })
    expect(assembleContextFor(agent, signal)).toEqual({ agent, scope: agent, signal })
  })
})
