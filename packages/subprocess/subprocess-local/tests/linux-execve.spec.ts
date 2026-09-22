import { constants } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.doUnmock('@deepseek-ai/dsh-lazy-require')
  vi.resetModules()
})

const F_GETFD = 1
const F_SETFD = 2
const F_GETFL = 3
const F_SETFL = 4
const FD_CLOEXEC = 1

describe.skipIf(process.platform !== 'linux')('Linux libc execve binding', () => {
  it.each([undefined, 'pipe'] as const)('preserves inherited stdio with control %s and reports execve errno', async (control) => {
    const nativeExecve = vi.fn(() => -1)
    const nativeFcntl = vi.fn((fd: number, command: number) => {
      if (command === F_GETFD) return fd === 1 ? 0 : FD_CLOEXEC | (fd === 2 ? 4 : 0)
      if (command === F_GETFL) return fd === 0 || fd === 7 ? constants.O_NONBLOCK : 0
      return 0
    })
    const func = vi.fn((declaration: string) => declaration.includes('execve')
      ? nativeExecve
      : nativeFcntl)
    const load = vi.fn(() => ({ func }))
    const errno = vi.fn(() => 2)
    vi.doMock('@deepseek-ai/dsh-lazy-require', () => ({
      createLazyRequire: () => () => ({ errno, load }),
    }))

    const { loadLinuxExecve } = await import('../src/linux-execve.ts')
    const execve = loadLinuxExecve()
    expect(loadLinuxExecve()).toBe(execve)
    expect(load).toHaveBeenCalledExactlyOnceWith(null)
    expect(func.mock.calls).toEqual([
      ['int execve(const char *pathname, const char **argv, const char **envp)'],
      ['int fcntl(int fd, int cmd, int arg)'],
    ])

    let failure: unknown
    try {
      execve('/missing/tool', ['tool', 'literal arg'], { A: '1', EMPTY: '' }, control)
    } catch (error) {
      failure = error
    }
    expect(nativeFcntl.mock.calls).toEqual([
      [0, F_GETFD, 0],
      [0, F_SETFD, 0],
      [0, F_GETFL, 0],
      [0, F_SETFL, 0],
      [1, F_GETFD, 0],
      [1, F_GETFL, 0],
      [2, F_GETFD, 0],
      [2, F_SETFD, 4],
      [2, F_GETFL, 0],
      ...control === 'pipe'
        ? [[7, F_GETFD, 0], [7, F_SETFD, 0], [7, F_GETFL, 0], [7, F_SETFL, 0]]
        : [],
    ])
    expect(nativeExecve).toHaveBeenCalledExactlyOnceWith(
      '/missing/tool',
      ['tool', 'literal arg', null],
      ['A=1', 'EMPTY=', null],
    )
    expect(errno).toHaveBeenCalledOnce()
    expect(failure).toMatchObject({
      code: 'ENOENT',
      errno: -2,
      syscall: 'execve',
      path: '/missing/tool',
    })
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain("ENOENT: no such file or directory, execve '/missing/tool'")
  })

  it('reports failure to read descriptor flags before replacing the process', async () => {
    const nativeExecve = vi.fn()
    const nativeFcntl = vi.fn(() => -1)
    const func = vi.fn((declaration: string) => declaration.includes('execve')
      ? nativeExecve
      : nativeFcntl)
    const errno = vi.fn(() => 9)
    vi.doMock('@deepseek-ai/dsh-lazy-require', () => ({
      createLazyRequire: () => () => ({ errno, load: () => ({ func }) }),
    }))

    const { loadLinuxExecve } = await import('../src/linux-execve.ts')
    expect(() => loadLinuxExecve()('/bin/tool', ['tool'], {})).toThrow(expect.objectContaining({
      code: 'EBADF',
      errno: -9,
      syscall: 'fcntl',
    }))
    expect(nativeFcntl).toHaveBeenCalledExactlyOnceWith(0, F_GETFD, 0)
    expect(nativeExecve).not.toHaveBeenCalled()
    expect(errno).toHaveBeenCalledOnce()
  })

  it('reports failure to read descriptor status flags before replacing the process', async () => {
    const nativeExecve = vi.fn()
    const nativeFcntl = vi.fn((_fd: number, command: number) => command === F_GETFD ? 0 : -1)
    const func = vi.fn((declaration: string) => declaration.includes('execve')
      ? nativeExecve
      : nativeFcntl)
    const errno = vi.fn(() => 9)
    vi.doMock('@deepseek-ai/dsh-lazy-require', () => ({
      createLazyRequire: () => () => ({ errno, load: () => ({ func }) }),
    }))

    const { loadLinuxExecve } = await import('../src/linux-execve.ts')
    expect(() => loadLinuxExecve()('/bin/tool', ['tool'], {})).toThrow(expect.objectContaining({
      code: 'EBADF',
      errno: -9,
      syscall: 'fcntl',
    }))
    expect(nativeFcntl.mock.calls).toEqual([
      [0, F_GETFD, 0],
      [0, F_GETFL, 0],
    ])
    expect(nativeExecve).not.toHaveBeenCalled()
    expect(errno).toHaveBeenCalledOnce()
  })

  it('reports failure to clear close-on-exec before replacing the process', async () => {
    const nativeExecve = vi.fn()
    const nativeFcntl = vi.fn()
      .mockReturnValueOnce(1)
      .mockReturnValueOnce(-1)
    const func = vi.fn((declaration: string) => declaration.includes('execve')
      ? nativeExecve
      : nativeFcntl)
    const errno = vi.fn(() => 5)
    vi.doMock('@deepseek-ai/dsh-lazy-require', () => ({
      createLazyRequire: () => () => ({ errno, load: () => ({ func }) }),
    }))

    const { loadLinuxExecve } = await import('../src/linux-execve.ts')
    expect(() => loadLinuxExecve()('/bin/tool', ['tool'], {})).toThrow(expect.objectContaining({
      code: 'EIO',
      errno: -5,
      syscall: 'fcntl',
    }))
    expect(nativeFcntl.mock.calls).toEqual([
      [0, F_GETFD, 0],
      [0, F_SETFD, 0],
    ])
    expect(nativeExecve).not.toHaveBeenCalled()
    expect(errno).toHaveBeenCalledOnce()
  })

  it('reports failure to clear non-blocking mode before replacing the process', async () => {
    const nativeExecve = vi.fn()
    const nativeFcntl = vi.fn((_fd: number, command: number) => {
      if (command === F_GETFD) return 0
      if (command === F_GETFL) return constants.O_NONBLOCK
      return -1
    })
    const func = vi.fn((declaration: string) => declaration.includes('execve')
      ? nativeExecve
      : nativeFcntl)
    const errno = vi.fn(() => 5)
    vi.doMock('@deepseek-ai/dsh-lazy-require', () => ({
      createLazyRequire: () => () => ({ errno, load: () => ({ func }) }),
    }))

    const { loadLinuxExecve } = await import('../src/linux-execve.ts')
    expect(() => loadLinuxExecve()('/bin/tool', ['tool'], {})).toThrow(expect.objectContaining({
      code: 'EIO',
      errno: -5,
      syscall: 'fcntl',
    }))
    expect(nativeFcntl.mock.calls).toEqual([
      [0, F_GETFD, 0],
      [0, F_GETFL, 0],
      [0, F_SETFL, 0],
    ])
    expect(nativeExecve).not.toHaveBeenCalled()
    expect(errno).toHaveBeenCalledOnce()
  })
})
