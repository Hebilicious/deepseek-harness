import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { launchLinuxScope, probeLinuxNative } from '../src/linux-scope.ts'
import { targetEnvironment } from '../src/runner-launch.ts'
import { bindManagedProcess, spawnSubprocess } from '../src/spawn.ts'
import type { LocalSubprocessHandle } from '../src/spawn.ts'

/** One 64 KiB pipe buffer plus headroom, so the target cannot complete one write() atomically. */
const OUTPUT_BYTES = 200_000

// The target reports the O_NONBLOCK bit of its own inherited fd 1 and then writes
// more than one pipe buffer with writes it must be able to complete. Both facts
// reach the parent through stderr, which stays short enough to fit any buffer.
const TARGET_SCRIPT = [
  "const fs = require('node:fs')",
  "const fdinfo = fs.readFileSync('/proc/self/fdinfo/1', 'utf8')",
  'const octal = /flags:\\s+(\\w+)/u.exec(fdinfo)[1]',
  'const nonBlocking = (Number.parseInt(octal, 8) & fs.constants.O_NONBLOCK) !== 0',
  "fs.writeSync(2, 'nonblocking=' + String(nonBlocking) + '\\n')",
  `const written = fs.writeSync(1, Buffer.alloc(${String(OUTPUT_BYTES)}, 0x78))`,
  "fs.writeSync(2, 'written=' + String(written) + '\\n')",
].join('\n')

const scratch = mkdtempSync(join(tmpdir(), 'dsh-stdio-blocking-'))
afterAll(() => { rmSync(scratch, { recursive: true, force: true }) })

function spec(): SubprocessSpawnSpec {
  return {
    argv: [process.execPath, '-e', TARGET_SCRIPT],
    cwd: scratch,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: 64_000 },
      stderr: { maxBytes: 64_000 },
    },
    graceMs: 3_000,
  }
}

interface TargetReport {
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdoutBytes: number
  stderr: string
}

async function runTarget(handle: LocalSubprocessHandle): Promise<TargetReport> {
  try {
    const outcome = await handle.done
    const stdout = handle.collected.stdout?.readFrom(0)
    // nextOffset is the whole-stream byte total, not the retained tail window.
    return {
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      stdoutBytes: stdout?.nextOffset ?? 0,
      stderr: handle.collected.stderr?.readFrom(0).text ?? '',
    }
  } finally {
    handle.terminate()
    await Promise.allSettled([handle.done, handle.waitForExit()])
  }
}

function expectCompleteBlockingWrite(report: TargetReport): void {
  expect(report).toEqual({
    exitCode: 0,
    signal: null,
    stdoutBytes: OUTPUT_BYTES,
    stderr: `nonblocking=false\nwritten=${String(OUTPUT_BYTES)}\n`,
  })
}

const linux = process.platform === 'linux'
const scopeAvailable = linux && probeLinuxNative()

describe.skipIf(!linux)('Linux target standard descriptors', () => {
  it.skipIf(!scopeAvailable)('keeps a scope-launched target writing on blocking descriptors', async () => {
    const request = spec()
    const report = await runTarget(bindManagedProcess(
      request,
      launchLinuxScope(request, targetEnvironment(request)),
    ))
    expectCompleteBlockingWrite(report)
  }, 30_000)

  it('keeps a fallback target writing on blocking descriptors', async () => {
    expectCompleteBlockingWrite(await runTarget(spawnSubprocess(spec())))
  }, 30_000)
})
