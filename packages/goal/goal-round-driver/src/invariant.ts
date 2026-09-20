/** Package-owned goal-round prompt invariants. @module @deepseek-ai/dsh-goal-round-driver/invariant */

import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { foldGoal, type FoldedGoal, type GoalMessageSource, type GoalView } from '@deepseek-ai/dsh-goal'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { renderGoalRoundPrompt } from './prompt.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-goal-round-driver'

/** Cordis companion plugin name. */
export const name = 'goal-round-driver-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Round policy the companion validates against; must match the driver's own. */
export interface Config {
  /** Completion-protocol text the driver renders; empty means the default protocol. */
  roundProtocol?: string
}

/** Schemastery config for the companion. */
export const Config: z<Config> = z.object({
  roundProtocol: z.string(),
})

/** Resolved protocol text, empty when the deployment supplied none. */
interface InstallOptions {
  readonly roundProtocol: string
}

/** Attribute strict goal-fold failures to this companion's reconstruction. */
function foldChecked(events: readonly SessionEvent[], fail: InvariantFailure): FoldedGoal {
  try {
    return foldGoal(events)
  } catch (error: unknown) {
    /* v8 ignore next -- the strict goal decoder throws Error instances */
    const message = error instanceof Error ? error.message : String(error)
    return fail(`cannot reconstruct the goal before a continuation message: ${message}`)
  }
}

/** Recreate the live-shaped view consumed by the package's pure prompt renderer. */
function goalView(folded: FoldedGoal, source: GoalMessageSource, fail: InvariantFailure): GoalView {
  const goal = folded.goal
  if (goal === undefined || folded.createdAt === undefined || folded.updatedAt === undefined
    || goal.phase !== 'active' || goal.id !== source.goalId || goal.revision !== source.revision
    || source.round !== folded.roundsStarted + 1 || source.round > goal.maxGoalRounds) {
    return fail(`goal round ${source.round} cannot be reconstructed from the preceding durable goal state`)
  }
  return {
    ...goal,
    roundsStarted: folded.roundsStarted,
    createdAt: folded.createdAt,
    updatedAt: folded.updatedAt,
    activation: 'armed',
  }
}

/**
 * Validate one continuation message against its durable prefix and the
 * configured protocol.
 */
function validateEvent(
  prior: readonly SessionEvent[],
  event: SessionEvent,
  fail: InvariantFailure,
  options: InstallOptions,
): void {
  if (event.type !== 'user/message') return
  const source = event.data.source
  if (source.kind !== 'goal' || source.round <= 0) return
  const view = goalView(foldChecked(prior, fail), source, fail)
  const expected = renderGoalRoundPrompt(view, source.round, {
    ...options.roundProtocol === '' ? {} : { protocol: options.roundProtocol },
  })
  if (!isDeepStrictEqual(event.data.content, expected)) {
    fail(`goal round ${source.round} content does not match the configured continuation prompt`)
  }
}

/** Build the installer that checks existing sessions and every candidate event. */
function installer(options: InstallOptions): InvariantInstaller {
  return Object.assign((ctx: Context, fail: InvariantFailure) => {
    for (const session of ctx.sessions.list()) {
      const prior: SessionEvent[] = []
      // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
      for (const event of session.snapshotEvents()) {
        validateEvent(prior, event, fail, options)
        prior.push(event)
      }
    }
    /* jscpd:ignore-start -- package companions share dispatch and registration plumbing */
    ctx.on('internal/dispatch', (_mode, eventName, args) => {
      if (eventName !== 'session/event') return
      const [session, event] = args as [Session, SessionEvent]
      // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
      validateEvent(session.snapshotEvents(), event, fail, options)
    }, { global: true })
  }, { inject: ['sessions'] })
  /* jscpd:ignore-end */
}

/**
 * Register the goal-round-driver invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @param config - round policy that must match the driver's own.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context, config: Config = {}): Promise<() => void> => {
  const roundProtocol = config.roundProtocol ?? ''
  if (typeof roundProtocol !== 'string') throw new TypeError('roundProtocol must be a string')
  return Promise.resolve(ctx.invariants.register(PACKAGE_NAME, installer({ roundProtocol })))
}
