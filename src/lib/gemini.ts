import { CURATION_HEADERS, parseCurationTsv, validateCurationBatch } from './curation';

const GEMINI_INTERACTIONS_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';

const responseSchema = {
  type: 'object',
  properties: {
    tsv: { type: 'string', description: 'TSV con el encabezado y filas de curaduría.' },
    research_summary: { type: 'string' },
  },
  required: ['tsv', 'research_summary'],
};

function env(name: string): string | undefined {
  return import.meta.env[name] ?? process.env[name];
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
Devuelve un objeto JSON con exactamente dos campos: "tsv" y "research_summary". En "tsv" incluye la línea de encabezados exacta ${JSON.stringify(CURATION_HEADERS.join('\t'))}, seguida de una fila por candidato con las 18 columnas separadas por tabulaciones. No uses tablas Markdown; no uses barras verticales dentro de las celdas. No incluyas explicaciones fuera del JSON solicitado.`;

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
  let parsed: { tsv?: string; research_summary?: string };
  try {
    parsed = JSON.parse(outputText) as { tsv?: string; research_summary?: string };
  } catch {
    throw new Error('GEMINI_INVALID_JSON');
  }
  if (typeof parsed.tsv !== 'string' || !parsed.tsv.trim()) throw new Error('GEMINI_NO_ROWS');
  const tsv = parsed.tsv;
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
