import { resolve, join } from 'node:path'

export const picoSdkRevision = '079c6f39023649b154152db30f1d781e884879bc'
export interface RuntimeBuildOptions { project?: string, target?: 'host' | 'pico2', sdk?: string, toolchain?: string, watchdogTest?: boolean, sensors?: boolean }
async function run(args: string[], cwd: string, env = process.env) {
  const child = Bun.spawn(args, { cwd, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const timeout = setTimeout(() => child.kill('SIGKILL'), 120000)
  try {
    const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    if (code !== 0) throw new Error(`${args[0]} exited ${code}:\n${(output + errors).slice(-8000)}`)
    return output.trim()
  }
  finally { clearTimeout(timeout) }
}
/** Local tools only; no shell interpolation, SDK download, firmware flashing or device access. */
export async function buildRuntime(options: RuntimeBuildOptions = {}) {
  const project = resolve(options.project ?? process.cwd())
  const target = options.target ?? 'host'
  if (target !== 'host' && target !== 'pico2') throw new TypeError('Runtime target must be host or pico2')
  if (!await Bun.file(join(project, 'firmware/runtime/CMakeLists.txt')).exists()) throw new Error('Use --project with the drone repository source checkout')
  const directory = join(project, 'storage/runtime-build', target + (options.sensors ? '-sensors' : '') + (options.watchdogTest ? '-watchdog' : ''))
  const env = { ...process.env }
  if (target === 'pico2') {
    const sdk = options.sdk ?? env.PICO_SDK_PATH
    if (!sdk) throw new Error('Provide --sdk or PICO_SDK_PATH with the pinned Pico SDK 2.3.1 checkout')
    env.PICO_SDK_PATH = resolve(sdk)
    if (await run(['git', 'rev-parse', 'HEAD'], env.PICO_SDK_PATH) !== picoSdkRevision) throw new Error('Pico SDK revision does not match the retained build pin')
    // A dirty SDK is not a reproducible input.
    if (await run(['git', 'status', '--porcelain', '--untracked-files=no'], env.PICO_SDK_PATH)) throw new Error('Pico SDK tracked files must be clean')
    if (options.toolchain) env.PICO_TOOLCHAIN_PATH = resolve(options.toolchain)
  }
  else if (options.watchdogTest || options.sensors) throw new Error('Sensor and watchdog firmware profiles are only available for pico2')
  await run(['cmake', '-S', join(project, 'firmware/runtime'), '-B', directory, '-DCMAKE_BUILD_TYPE=Release', `-DDRONE_PICO2=${target === 'pico2' ? 'ON' : 'OFF'}`, `-DDRONE_WATCHDOG_TEST=${options.watchdogTest ? 'ON' : 'OFF'}`, `-DDRONE_SENSOR_BENCH=${options.sensors ? 'ON' : 'OFF'}`], project, env)
  await run(['cmake', '--build', directory, '--parallel', '2'], project, env)
  if (target === 'host') await run(['ctest', '--test-dir', directory, '--output-on-failure'], project, env)
  return { target, directory, artifact: join(directory, target === 'host' ? `drone_runtime_host${process.platform === 'win32' ? '.exe' : ''}` : 'drone_runtime.uf2'), physicalFlightEnabled: false as const }
}
