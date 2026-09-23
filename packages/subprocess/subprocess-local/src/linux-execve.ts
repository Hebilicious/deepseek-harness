/** Lazy libc execve and descriptor bindings used by the one-shot Linux bootstrap. */

import { constants } from 'node:fs'
import { getSystemErrorMessage, getSystemErrorName } from 'node:util'
import { SUBPROCESS_CONTROL_FD } from '@deepseek-ai/dsh-subprocess/control'
import { createLazyRequire } from '@deepseek-ai/dsh-lazy-require'

const requireKoffi = createLazyRequire<typeof import('koffi')['default']>('koffi', import.meta.url)

/** Replace the current process image while preserving the supplied argv and environment. */
export type LinuxExecve = (
  file: string,
  argv: string[],
  env: Record<string, string>,
  control?: 'pipe',
) => never

type NativeExecve = (
  file: string,
  argv: Array<string | null>,
  envp: Array<string | null>,
) => number

type NativeFcntl = (fd: number, command: number, argument: number) => number

/** Descriptor flags belong to one descriptor; status flags belong to the shared open file description. */
const STANDARD_FILE_DESCRIPTORS = [0, 1, 2] as const
const F_GETFD = 1
const F_SETFD = 2
const F_GETFL = 3
const F_SETFL = 4
const FD_CLOEXEC = 1

let cachedExecve: LinuxExecve | undefined

function systemError(errno: number, syscall: string, path?: string): Error {
  const uvError = -errno
  const code = getSystemErrorName(uvError)
  const detail = getSystemErrorMessage(uvError)
  const subject = path === undefined ? syscall : `${syscall} '${path}'`
  const error = Object.assign(new Error(`${code}: ${detail}, ${subject}`), {
    code,
    errno: uvError,
    syscall,
  })
  return path === undefined ? error : Object.assign(error, { path })
}

/**
 * Load libc's execve and fcntl symbols on first use and retain the native bindings.
 * The target inherits fd 0 through fd 2 with close-on-exec and O_NONBLOCK cleared:
 * a piped standard stream is non-blocking for the runner runtime and its loaders,
 * which would make the target's own writes fail with EAGAIN on a full pipe, while
 * a directly spawned child receives the same descriptors blocking.
 * @returns a process-replacing execve operation that throws Node-style errors on failure.
 */
export function loadLinuxExecve(): LinuxExecve {
  if (cachedExecve !== undefined) return cachedExecve
  const koffi = requireKoffi()
  const libc = koffi.load(null)
  const nativeExecve = libc.func(
    'int execve(const char *pathname, const char **argv, const char **envp)',
  ) as NativeExecve
  const nativeFcntl = libc.func(
    'int fcntl(int fd, int cmd, int arg)',
  ) as NativeFcntl

  /** Clear one inherited flag on a descriptor while preserving the remaining flags. */
  const clearInheritedFlag = (fd: number, command: number, setCommand: number, flag: number): void => {
    const flags = nativeFcntl(fd, command, 0)
    if (flags === -1) throw systemError(koffi.errno(), 'fcntl')
    if ((flags & flag) === 0) return
    if (nativeFcntl(fd, setCommand, flags & ~flag) === -1) {
      throw systemError(koffi.errno(), 'fcntl')
    }
  }
  cachedExecve = (file, argv, env, control) => {
    const descriptors = control === 'pipe'
      ? [...STANDARD_FILE_DESCRIPTORS, SUBPROCESS_CONTROL_FD]
      : STANDARD_FILE_DESCRIPTORS
    for (const fd of descriptors) {
      clearInheritedFlag(fd, F_GETFD, F_SETFD, FD_CLOEXEC)
      clearInheritedFlag(fd, F_GETFL, F_SETFL, constants.O_NONBLOCK)
    }
    nativeExecve(
      file,
      [...argv, null],
      [...Object.entries(env).map(([key, value]) => `${key}=${value}`), null],
    )
    throw systemError(koffi.errno(), 'execve', file)
  }
  return cachedExecve
}
