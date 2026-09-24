// Cancelar una búsqueda la termina al instante y no deja que nada la reviva.
import assert from 'node:assert/strict';
import { cancelCurationJob, completeCurationJob, createCurationJob, failCurationJob, getCurationJob, getRunningCurationJob, isCurationCancelled, updateCurationJob } from '../src/lib/curation-job.ts';
import { CURATION_CANCELLED, runCurationGoal } from '../src/lib/curation-run.ts';
import { killJobChildren } from '../src/lib/gemini.ts';

const job = createCurationJob({ city: 'Bogotá', category: 'Repostería', targetCount: 20 });
updateCurationJob(job.jobId, 'researching', 'Buscando: pastelería', { current: 1, total: 4 }, { tsv: 'h\nfila', discovered: 1, contactable: 1, model: 'm', rejectedRows: [], rows: [] });
assert.equal(isCurationCancelled(job.jobId), false);

assert.equal(cancelCurationJob(job.jobId), true);
const cancelled = getCurationJob(job.jobId)!;
assert.equal(cancelled.status, 'failed');
assert.equal(cancelled.cancelled, true);
assert.ok(cancelled.finishedAt);
assert.equal(cancelled.preview?.discovered, 1, 'lo encontrado hasta ahora se conserva');
assert.equal(getRunningCurationJob('Bogotá', 'Repostería'), undefined, 'la ciudad queda libre para buscar otra vez');
assert.equal(isCurationCancelled(job.jobId), true);

// Lo que llegue después del cancelo no lo revive ni lo tapa.
failCurationJob(job.jobId, 'otro error');
completeCurationJob(job.jobId, { tsv: '', accepted: 0, rejected: 0 } as never);
updateCurationJob(job.jobId, 'ready' as never, 'x');
assert.equal(getCurationJob(job.jobId)!.status, 'failed');
assert.equal(getCurationJob(job.jobId)!.error, 'Búsqueda cancelada.');
assert.equal(cancelCurationJob(job.jobId), false, 'cancelar dos veces no hace nada');
assert.equal(cancelCurationJob('no-existe'), false);
assert.equal(killJobChildren('no-existe'), 0);

// La corrida se corta antes de lanzar nada.
const phases: string[] = [];
await assert.rejects(
  runCurationGoal({ city: 'Bogotá', category: 'Repostería', targetCount: 5, jobId: job.jobId, isCancelled: () => true, onPhase: (phase) => phases.push(phase) }),
  new RegExp(CURATION_CANCELLED),
);
assert.deepEqual(phases, [], 'no arrancó ningún escaneo');

console.log('curation cancel tests passed');
