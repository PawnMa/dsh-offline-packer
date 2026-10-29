/**
 * Headless smoke test for the module shape of client.js: no browser needed.
 *
 * Proves the loader contract (id, factory(require) -> {inject, apply}), that only
 * `react` is required, and that apply() registers exactly one `settings.section`
 * whose label follows navigator.language.
 */
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const source = readFileSync(new URL('../../client.js', import.meta.url), 'utf8')
const failures = []
function check(name, passed, detail) {
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!passed) failures.push(name)
}

function load(language) {
  let module = null
  const required = []
  const sandbox = {
    window: { __ModuleLoader__: { load: (value) => { module = value } } },
    navigator: { language },
    setTimeout,
    clearTimeout,
    AbortController,
    URLSearchParams,
    fetch: async () => { throw new Error('fetch is not used by the factory itself') },
  }
  runInNewContext(source, sandbox, { filename: 'client.js' })
  const React = {
    createElement: () => ({}),
    useState: () => [undefined, () => {}],
    useEffect: () => {},
    useMemo: () => undefined,
    useRef: () => ({ current: null }),
    useCallback: (fn) => fn,
  }
  const exported = module.factory((name) => {
    required.push(name)
    if (name === 'react') return React
    throw new Error(`unexpected require(${name})`)
  })
  return { module, exported, required }
}

const zh = load('zh-CN')
check('loader call carries the plugin id', zh.module?.id === 'dsh-offline-packer', String(zh.module?.id))
check('factory returns inject: [slots]', JSON.stringify(zh.exported?.inject) === JSON.stringify(['slots']), JSON.stringify(zh.exported?.inject))
check('factory returns apply()', typeof zh.exported?.apply === 'function')
check('only react is required', JSON.stringify(zh.required) === JSON.stringify(['react']), JSON.stringify(zh.required))

const registrations = []
const ctx = { slots: { inject: (name, fn) => fn(), register: (options, component) => registrations.push({ options, component }) } }
zh.exported.apply(ctx)
check('apply registers one section', registrations.length === 1, String(registrations.length))
const entry = registrations[0]
check('section name is settings.section', entry?.options?.name === 'settings.section', String(entry?.options?.name))
check('section id is offline-packer', entry?.options?.id === 'offline-packer', String(entry?.options?.id))
check('section order is 60', entry?.options?.order === 60, String(entry?.options?.order))
check('zh label is 离线打包', entry?.options?.label?.() === '离线打包', String(entry?.options?.label?.()))
check('component is a function', typeof entry?.component === 'function')

// A replayed injection on the same context must not register a second section.
zh.exported.apply(ctx)
check('duplicate apply on the same ctx is ignored', registrations.length === 1, String(registrations.length))

const en = load('en-US')
const enRegistrations = []
en.exported.apply({ slots: { inject: (name, fn) => fn(), register: (options, component) => enRegistrations.push({ options, component }) } })
check('en label is Offline Packager', enRegistrations[0]?.options?.label?.() === 'Offline Packager', String(enRegistrations[0]?.options?.label?.()))

console.log(`\n${failures.length === 0 ? 'ALL PASS' : `FAILURES: ${failures.length}`}`)
process.exit(failures.length === 0 ? 0 : 1)
