import { CURATION_HEADERS, parseCurationTsv, validateCurationBatch } from './curation';

const GEMINI_INTERACTIONS_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';

const rowSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    display_name: { type: 'string' },
    category: { type: 'string' },
    segment: { type: 'string' },
    city: { type: 'string' },
    zone: { type: 'string' },
    scale: { type: 'string' },
    formality: { type: 'string' },
    rating: { type: 'string' },
    review_count: { type: 'string' },
    reputation_platform: { type: 'string' },
    curation_level: { type: 'string' },
    curation_reason: { type: 'string' },
    phone: { type: 'string' },
    instagram: { type: 'string' },
    email: { type: 'string' },
    source_url: { type: 'string' },
    verification_date: { type: 'string' },
  },
};

const responseSchema = {
  type: 'object',
  properties: {
    rows: { type: 'array', items: rowSchema },
    research_summary: { type: 'string' },
  },
  required: ['rows', 'research_summary'],
};

type GeminiRow = {
  id: string;
  display_name: string;
  category: string;
  segment: string;
  city: string;
  zone: string;
  scale: string;
  formality: string;
  rating: string | number;
  review_count: string | number;
  reputation_platform: string;
  curation_level: string;
  curation_reason: string;
  phone: string;
  instagram: string;
  email: string;
  source_url: string;
  verification_date: string;
};

function env(name: string): string | undefined {
  return import.meta.env[name] ?? process.env[name];
}

function cell(value: unknown): string {
  return String(value ?? 'Sin dato')
    .replace(/[\t\r\n]+/g, ' ')
    .replace(/\|/g, '/')
    .trim() || 'Sin dato';
}

function extractOutputText(body: Record<string, unknown>): string | undefined {
  if (typeof body.output_text === 'string') return body.output_text;
  if (typeof body.outputText === 'string') return body.outputText;
  if (Array.isArray(body.outputs)) {
    for (const output of [...body.outputs].reverse()) {
      if (typeof output === 'object' && output !== null && typeof (output as Record<string, unknown>).text === 'string') return (output as Record<string, string>).text;
    }
  }
  if (Array.isArray(body.steps)) {
    for (const step of [...body.steps].reverse()) {
      const record = step as Record<string, unknown>;
      if (Array.isArray(record.content)) {
        const textPart = record.content.find(part => typeof part === 'object' && part !== null && typeof (part as Record<string, unknown>).text === 'string');
        if (textPart && typeof (textPart as Record<string, unknown>).text === 'string') return (textPart as Record<string, string>).text;
      }
    }
  }
  return undefined;
}

function toTsv(rows: GeminiRow[]): string {
  const today = new Date().toISOString().slice(0, 10);
  const lines = rows.map((row, index) => [
    cell(row.id || `GEN-00-${String(index + 1).padStart(3, '0')}`),
    cell(row.display_name),
    cell(row.category),
    cell(row.segment),
    cell(row.city),
    cell(row.zone),
    cell(row.scale),
    cell(row.formality),
    Number(row.rating).toFixed(1),
    String(Math.trunc(Number(row.review_count))),
    cell(row.reputation_platform),
    cell(row.curation_level),
    cell(row.curation_reason),
    cell(row.phone),
    cell(row.instagram),
    cell(row.email),
    cell(row.source_url),
    /^\d{4}-\d{2}-\d{2}$/.test(row.verification_date) ? row.verification_date : today,
  ]);
  return [CURATION_HEADERS.join('\t'), ...lines.map(line => line.join('\t'))].join('\n');
}

export type GeminiCurationResult = {
  tsv: string;
  researchSummary: string;
  model: string;
  accepted: number;
  rejected: number;
  rejectedRows: ReturnType<typeof validateCurationBatch>['rejected'];
};

export async function curateProviders(input: { city: string; category: string; instructions?: string }): Promise<GeminiCurationResult> {
  const apiKey = env('GEMINI_API_KEY');
  if (!apiKey) throw new Error('GEMINI_NOT_CONFIGURED');
  const model = env('GEMINI_AGENT_MODEL') || 'gemini-3.8-flash';
  const city = input.city.trim();
  const category = input.category.trim();
  if (!city || !category) throw new Error('CITY_AND_CATEGORY_REQUIRED');

  const prompt = `Actúa como agente de investigación y curaduría de proveedores para eventos en Colombia.
Investiga en la web proveedores reales de la ciudad "${city}" para la categoría "${category}".
${input.instructions?.trim() ? `Instrucciones adicionales del operador: ${input.instructions.trim()}` : ''}

Entrega entre 3 y 8 candidatos, solo si puedes verificar evidencia suficiente.
Usa únicamente negocios existentes y no inventes teléfonos, correos, calificaciones, reseñas o URLs.
La URL debe ser la ficha o perfil directo del negocio, no una página de resultados de búsqueda.
Cumple: calificación mínima 4.5; Tipo 1 (lugares/restaurantes) requiere mínimo 50 reseñas; Tipo 2 (servicios por encargo) requiere mínimo 15 reseñas.
Nivel A corresponde a 50 o más reseñas. Nivel B solo se permite para Tipo 2 con 15 a 49 reseñas.
Si un dato no es público usa exactamente "Sin dato"; para Instagram ausente usa "Sin Redes".
La justificación debe incluir la calificación, cantidad de reseñas, plataforma, evidencia publicada de servicios para eventos y actividad publicada dentro de los últimos 12 meses.
Los IDs deben tener formato ABC-CC-###, donde CC es el código: Lugar 01, Comida y Bebida 02, Música 03, Servicios Especializados 04, Entretenimiento 05, Decoración temática 06, Fotografía y Video 07, Invitación digital 08, Menaje y mantelería 09, Carpas y mobiliario 10.
No incluyas encabezados, markdown ni explicaciones fuera del JSON solicitado.`;

  const response = await fetch(GEMINI_INTERACTIONS_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      model,
      input: prompt,
      tools: [{ type: 'google_search' }, { type: 'url_context' }],
      response_format: { type: 'text', mime_type: 'application/json', schema: responseSchema },
    }),
  });
  const body = await response.json() as Record<string, unknown>;
  if (!response.ok) {
    console.error('Gemini curation request failed', response.status, typeof body.error === 'object' ? body.error : 'unknown error');
    throw new Error('GEMINI_REQUEST_FAILED');
  }

  const outputText = extractOutputText(body);
  if (!outputText) throw new Error('GEMINI_EMPTY_RESPONSE');
  let parsed: { rows?: GeminiRow[]; research_summary?: string };
  try {
    parsed = JSON.parse(outputText) as { rows?: GeminiRow[]; research_summary?: string };
  } catch {
    throw new Error('GEMINI_INVALID_JSON');
  }
  if (!Array.isArray(parsed.rows) || parsed.rows.length === 0) throw new Error('GEMINI_NO_ROWS');

  const tsv = toTsv(parsed.rows);
  const validation = validateCurationBatch(parseCurationTsv(tsv));
  return {
    tsv,
    researchSummary: parsed.research_summary || 'Investigación completada; revisa las fuentes antes de importar.',
    model,
    accepted: validation.accepted.length,
    rejected: validation.rejected.length,
    rejectedRows: validation.rejected,
  };
}
