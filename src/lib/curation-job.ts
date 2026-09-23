import { randomUUID } from 'node:crypto';
import type { CurationLivePreview, GeminiCurationResult } from './gemini';

export const CURATION_PHASE_DEFINITIONS = [
  { key: 'queued', label: 'Solicitud recibida' },
  { key: 'preparing', label: 'Preparando búsqueda' },
  { key: 'researching', label: 'Investigación web en curso' },
  { key: 'ready', label: 'Vista previa lista' },
] as const;

export type CurationPhaseKey = typeof CURATION_PHASE_DEFINITIONS[number]['key'];
export type CurationPhaseState = 'pending' | 'active' | 'done' | 'error';

export type CurationJobPhase = {
  key: CurationPhaseKey;
  label: string;
  state: CurationPhaseState;
  detail: string;
  progress?: { current: number; total: number; label?: string };
  startedAt?: string;
  finishedAt?: string;
};

export type CurationJob = {
  jobId: string;
  city: string;
  category: string;
  targetCount: number;
  status: 'running' | 'completed' | 'failed';
  phase: CurationPhaseKey;
  phases: CurationJobPhase[];
  result?: GeminiCurationResult;
  preview?: CurationLivePreview;
  error?: string;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
  scanNumber: number;
  scanStartedAt: string;
};

// El registro vive en globalThis: `astro dev` invalida el módulo en cada cambio de archivo y, con un
// Map de módulo, un job en vuelo quedaba invisible para la siguiente petición. Eso permitía lanzar un
// segundo job para la misma ciudad/categoría y duplicar los procesos de WebSearch.
const globalRegistry = globalThis as typeof globalThis & { __curationJobs?: Map<string, CurationJob> };
const jobs: Map<string, CurationJob> = globalRegistry.__curationJobs ??= new Map<string, CurationJob>();
// Un resultado terminado espera a que el panel vuelva a preguntar: si el equipo del operador se
// suspendió a mitad de la búsqueda, puede tardar horas en volver, y el resultado ya pagado no debe
// haberse borrado para entonces. Son pocos trabajos al día; la memoria no es el límite.
const JOB_TTL_MS = 24 * 60 * 60 * 1000;

function timestamp() {
  return new Date().toISOString();
}

/** Un job vivo que lleva demasiado tiempo sin noticias es un job muerto: se marca para no bloquear la ciudad. */
const STALE_RUNNING_MS = 15 * 60 * 1000;

function pruneJobs() {
  const now = Date.now();
  for (const [jobId, job] of jobs) {
    const age = now - Date.parse(job.updatedAt);
    if (job.status === 'running') {
      if (age > STALE_RUNNING_MS) {
        job.status = 'failed';
        job.error = 'La búsqueda quedó sin respuesta del agente y se cerró para liberar la ciudad y categoría.';
        job.finishedAt = timestamp();
        job.updatedAt = job.finishedAt;
      }
      continue;
    }
    if (age > JOB_TTL_MS) jobs.delete(jobId);
  }
}

export function createCurationJob(input: { city: string; category: string; targetCount?: number }) {
  pruneJobs();
  const now = timestamp();
  const job: CurationJob = {
    jobId: randomUUID(),
    city: input.city,
    category: input.category,
    targetCount: input.targetCount ?? 20,
    status: 'running',
    phase: 'queued',
    phases: CURATION_PHASE_DEFINITIONS.map((phase, index) => ({
      ...phase,
      state: index === 0 ? 'active' : 'pending',
      detail: index === 0 ? 'La búsqueda fue recibida.' : 'Pendiente',
      progress: phase.key === 'researching' ? { current: 0, total: 4, label: 'Buscando candidatos' } : undefined,
      startedAt: index === 0 ? now : undefined,
    })),
    createdAt: now,
    updatedAt: now,
    scanNumber: 0,
    scanStartedAt: now,
  };
  jobs.set(job.jobId, job);
  return job;
}

export function updateCurationJob(jobId: string, phase: Exclude<CurationPhaseKey, 'queued' | 'ready'>, detail: string, progress?: { current: number; total: number; label?: string }, preview?: CurationLivePreview) {
  const job = jobs.get(jobId);
  if (!job || job.status !== 'running') return;
  const now = timestamp();
  const targetIndex = CURATION_PHASE_DEFINITIONS.findIndex(item => item.key === phase);
  job.phases = job.phases.map((item, index) => {
    if (index < targetIndex) return { ...item, state: 'done', detail: item.detail === 'Pendiente' ? 'Completado.' : item.detail, finishedAt: item.finishedAt ?? now };
    if (index === targetIndex) return { ...item, state: 'active', detail, progress: progress ?? item.progress, startedAt: item.startedAt ?? now };
    return { ...item, state: 'pending', detail: 'Pendiente', progress: item.key === 'researching' ? { current: 0, total: 4, label: 'Buscando candidatos' } : undefined, startedAt: undefined, finishedAt: undefined };
  });
  job.phase = phase;
  const scanMatch = detail.match(/escaneo\s+(\d+)/i);
  if (scanMatch) {
    const scanNumber = Number(scanMatch[1]);
    if (Number.isFinite(scanNumber) && scanNumber !== job.scanNumber) {
      job.scanNumber = scanNumber;
      job.scanStartedAt = now;
    }
  }
  if (preview) job.preview = preview;
  job.updatedAt = now;
}

export function completeCurationJob(jobId: string, result: GeminiCurationResult) {
  const job = jobs.get(jobId);
  if (!job) return;
  const now = timestamp();
  job.phases = job.phases.map(item => ({
    ...item,
    state: 'done',
    detail: item.key === 'ready' ? `${result.accepted} aceptados, ${result.rejected} rechazados.` : item.detail === 'Pendiente' ? 'Completado.' : item.detail,
    startedAt: item.startedAt ?? now,
    finishedAt: now,
  }));
  job.status = 'completed';
  job.phase = 'ready';
  job.result = result;
  job.finishedAt = now;
  job.preview = undefined;
  job.updatedAt = now;
}

export function failCurationJob(jobId: string, error: string) {
  const job = jobs.get(jobId);
  if (!job) return;
  const now = timestamp();
  job.phases = job.phases.map(item => item.key === job.phase
    ? { ...item, state: 'error', detail: 'La fase no pudo completarse.', finishedAt: now }
    : item);
  job.status = 'failed';
  job.error = error;
  job.finishedAt = now;
  job.updatedAt = now;
  // `job.preview` se conserva a propósito: aunque la búsqueda falle, los proveedores ya encontrados
  // deben seguir visibles en la interfaz.
}

export function getCurationJob(jobId: string) {
  pruneJobs();
  return jobs.get(jobId);
}

export function getRunningCurationJob(city: string, category: string) {
  pruneJobs();
  const cityKey = city.trim().toLocaleLowerCase();
  const categoryKey = category.trim().toLocaleLowerCase();
  return [...jobs.values()].find(job => job.status === 'running'
    && job.city.trim().toLocaleLowerCase() === cityKey
    && job.category.trim().toLocaleLowerCase() === categoryKey);
}
