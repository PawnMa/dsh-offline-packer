/**
 * Minimal job registry for long-running packaging work.
 *
 * The web UI starts a job through POST, then polls `GET /api/job?id=`. Each job
 * keeps a bounded log ring so a chatty packaging run cannot grow the process
 * memory without bound.
 */

const MAX_JOBS = 50
const MAX_LOG_LINES = 800
const MAX_CONCURRENT = 2

/** @type {Map<string, Job>} */
const jobs = new Map()
let sequence = 0

/**
 * @typedef {object} Job
 * @property {string} id
 * @property {string} kind
 * @property {'running'|'done'|'error'} status
 * @property {{phase: string, percent: number|null}} progress
 * @property {string[]} logs
 * @property {unknown} [result]
 * @property {{code?: string, message: string}} [error]
 * @property {number} startedAt
 * @property {number} [finishedAt]
 */

/** Count jobs still running. */
function runningCount() {
  let n = 0
  for (const job of jobs.values()) if (job.status === 'running') n += 1
  return n
}

/** Drop the oldest finished jobs until at most MAX_JOBS remain. */
function prune() {
  if (jobs.size <= MAX_JOBS) return
  const finished = [...jobs.values()]
    .filter((job) => job.status !== 'running')
    .sort((a, b) => (a.finishedAt ?? a.startedAt) - (b.finishedAt ?? b.startedAt))
  for (const job of finished) {
    if (jobs.size <= MAX_JOBS) break
    jobs.delete(job.id)
  }
}

/**
 * Start one asynchronous job.
 *
 * @param kind - stable kind string reported to the UI.
 * @param runner - async work; receives a `log(message)` sink, a `progress(phase, percent)`
 *   sink, and resolves to the result.
 * @returns the job id, or an error object when the concurrency bound is reached.
 */
export function createJob(kind, runner) {
  if (runningCount() >= MAX_CONCURRENT) {
    return { error: { code: 'JOB_BUSY', message: `已有 ${MAX_CONCURRENT} 个打包任务在运行，请等待其中一个完成` } }
  }
  sequence += 1
  const id = `${Date.now().toString(36)}-${sequence.toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  /** @type {Job} */
  const job = { id, kind, status: 'running', progress: { phase: '排队中', percent: 0 }, logs: [], startedAt: Date.now() }
  jobs.set(id, job)
  const log = (message) => {
    const text = String(message ?? '')
    for (const line of text.split('\n')) {
      job.logs.push(line)
      if (job.logs.length > MAX_LOG_LINES) job.logs.splice(0, job.logs.length - MAX_LOG_LINES)
    }
  }
  const progress = (phase, percent) => {
    job.progress = {
      phase: String(phase ?? ''),
      percent: typeof percent === 'number' && Number.isFinite(percent) ? Math.max(0, Math.min(100, Math.round(percent))) : null,
    }
  }
  log(`job ${id} (${kind}) started`)
  Promise.resolve()
    .then(() => runner(log, progress))
    .then(
      (result) => {
        job.status = 'done'
        job.progress = { phase: '完成', percent: 100 }
        job.result = result
        job.finishedAt = Date.now()
        log(`job ${id} finished in ${job.finishedAt - job.startedAt} ms`)
        prune()
      },
      (error) => {
        job.status = 'error'
        job.progress = { phase: '失败', percent: job.progress?.percent ?? null }
        job.error = {
          code: typeof error?.code === 'string' ? error.code : 'INTERNAL',
          message: error instanceof Error ? error.message : String(error),
        }
        job.finishedAt = Date.now()
        log(`job ${id} failed: ${job.error.code}: ${job.error.message}`)
        prune()
      },
    )
  return { id }
}

/** Read one job in a JSON-safe shape, or null. */
export function getJob(id) {
  const job = jobs.get(String(id))
  if (job === undefined) return null
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    progress: job.progress,
    logs: job.logs.slice(),
    result: job.result,
    error: job.error,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  }
}

/** List every retained job, newest first. */
export function listJobs() {
  return [...jobs.values()]
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((job) => ({
      id: job.id,
      kind: job.kind,
      status: job.status,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
    }))
}
