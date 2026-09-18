import type { APIRoute } from 'astro';
import { runCurationGoal } from '../../../lib/curation-run';
import { importCurationTsv } from '../../../lib/provider-import';
import { completeCurationJob, createCurationJob, failCurationJob, getCurationJob, getRunningCurationJob, updateCurationJob } from '../../../lib/curation-job';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

function jobPayload(job: ReturnType<typeof getCurationJob>) {
  if (!job) return null;
  const now = Date.now();
  const finishedAt = job.finishedAt ? Date.parse(job.finishedAt) : now;
  const scanStartedAt = Date.parse(job.scanStartedAt);
  return {
    ok: true,
    jobId: job.jobId,
    status: job.status,
    phase: job.phase,
    phases: job.phases,
    targetCount: job.targetCount,
    timers: {
      totalMs: Math.max(0, finishedAt - Date.parse(job.createdAt)),
      scanMs: Math.max(0, finishedAt - scanStartedAt),
      scanNumber: job.scanNumber,
      running: job.status === 'running',
    },
    // La vista previa también viaja cuando el job falla: los proveedores ya encontrados se muestran.
    ...(job.status !== 'completed' && job.preview ? { preview: job.preview } : {}),
    ...(job.status === 'completed' ? job.result : {}),
    ...(job.status === 'failed' ? { error: job.error } : {}),
  };
}

export const GET: APIRoute = async ({ url }) => {
  const jobId = url.searchParams.get('job_id');
  if (!jobId) return json({ ok: false, error: 'Falta job_id.' }, 400);
  const job = getCurationJob(jobId);
  if (!job) return json({ ok: false, error: 'La búsqueda ya no está disponible.' }, 404);
  return json(jobPayload(job));
};

export const POST: APIRoute = async ({ request }) => {
  let payload: Record<string, unknown>;
  try {
    payload = await request.json() as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: 'El cuerpo de la solicitud no es JSON válido.' }, 400);
  }

  if (payload.action === 'import') {
    if (typeof payload.tsv !== 'string' || !payload.tsv.trim()) return json({ ok: false, error: 'Falta el lote TSV para importar.' }, 400);
    const result = await importCurationTsv(payload.tsv);
    return json(result.body, result.status);
  }

  const city = typeof payload.city === 'string' ? payload.city : '';
  const category = typeof payload.category === 'string' ? payload.category : '';
  const instructions = typeof payload.instructions === 'string' ? payload.instructions : undefined;
  const requestedTarget = typeof payload.targetCount === 'number' ? payload.targetCount : Number(payload.targetCount);
  const targetCount = Number.isFinite(requestedTarget) ? Math.max(1, Math.min(100, Math.trunc(requestedTarget))) : 20;
  if (!city.trim() || !category.trim()) return json({ ok: false, error: 'Ciudad y categoría son obligatorias.' }, 400);

  const runningJob = getRunningCurationJob(city, category);
  if (runningJob) return json({ ...jobPayload(runningJob), reused: true }, 202);

  const job = createCurationJob({ city: city.trim(), category: category.trim(), targetCount });
  void (async () => {
    try {
      // Se usan los mismos valores recortados con los que se registró el job, para que la búsqueda
      // y la clave de "un job por ciudad y categoría" nunca se separen.
      const result = await runCurationGoal({
        city: job.city,
        category: job.category,
        instructions,
        targetCount,
        jobId: job.jobId,
        onPhase: (phase, detail, progress, preview) => updateCurationJob(job.jobId, phase, detail, progress, preview),
      });
      const { acceptedRows: _acceptedRows, discoveredCandidates: _discoveredCandidates, ...publicResult } = result;
      completeCurationJob(job.jobId, publicResult);
    } catch (error) {
      failCurationJob(job.jobId, error instanceof Error ? error.message : 'La búsqueda terminó por un error inesperado del agente.');
    }
  })();
  return json(jobPayload(job), 202);
};
