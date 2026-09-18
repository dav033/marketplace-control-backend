import { extractOutputText } from './gemini';

const GEMINI_INTERACTIONS_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';

const env = (name: string) => import.meta.env[name as keyof ImportMetaEnv] ?? process.env[name];

const responseSchema = {
  type: 'object',
  properties: {
    subject: { type: 'string' },
    body_text: { type: 'string' },
    confidence: { type: 'number' },
    facts_used: { type: 'array', items: { type: 'string' } },
  },
  required: ['subject', 'body_text', 'confidence', 'facts_used'],
};

export type OutreachContext = {
  displayName: string;
  contactName?: string | null;
  category: string;
  city: string;
  rating?: number | null;
  reviewCount?: number | null;
  websiteUrl?: string | null;
  discoverySource?: string | null;
  notes?: string | null;
  registrationUrl?: string;
  objective: string;
};

export type PersonalizedOutreach = {
  subject: string;
  bodyText: string;
  confidence: number;
  factsUsed: string[];
  model: string;
};

export async function generatePersonalizedOutreach(input: OutreachContext): Promise<PersonalizedOutreach> {
  const apiKey = env('GEMINI_API_KEY');
  if (!apiKey) throw new Error('GEMINI_NOT_CONFIGURED');

  const model = env('GEMINI_AGENT_MODEL') || 'gemini-3.8-flash';
  const context = JSON.stringify({
    negocio: input.displayName,
    contacto: input.contactName || null,
    categoria: input.category,
    ciudad: input.city,
    calificacion: input.rating ?? null,
    resenas: input.reviewCount ?? null,
    sitio_web: input.websiteUrl || null,
    fuente: input.discoverySource || null,
    notas: input.notes || null,
  });
  const prompt = `Escribe un correo comercial B2B personalizado para un proveedor de eventos en Colombia.
Objetivo de campaña: ${input.objective.trim()}
Datos verificados del proveedor: ${context}

Reglas estrictas:
- Escribe el mensaje completo. No uses placeholders, variables ni etiquetas como {{nombre}}, [[contact.first_name]] o [link].
- Personaliza de verdad usando el negocio, categoría, ciudad y solo hechos disponibles.
- No inventes servicios, clientes, premios, cifras, alianzas ni necesidades.
- No afirmes que revisaste información que no aparece en los datos.
- Tono humano, breve y respetuoso; 80 a 140 palabras.
- Si falta nombre de persona, saluda al equipo o al negocio sin inventar nombre.
- Incluye una llamada a la acción clara${input.registrationUrl ? ` con este enlace exacto: ${input.registrationUrl}` : ' sin inventar enlace'}.
- Devuelve JSON exacto con subject, body_text, confidence entre 0 y 1 y facts_used.
- No incluyas HTML ni explicaciones fuera del JSON.`;

  const response = await fetch(GEMINI_INTERACTIONS_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      model,
      input: prompt,
      response_format: { type: 'text', mime_type: 'application/json', schema: responseSchema },
    }),
  });
  const body = await response.json() as Record<string, unknown>;
  if (!response.ok) {
    console.error('Gemini outreach request failed', response.status, typeof body.error === 'object' ? body.error : 'unknown error');
    throw new Error('GEMINI_OUTREACH_FAILED');
  }
  const outputText = extractOutputText(body);
  if (!outputText) throw new Error('GEMINI_OUTREACH_EMPTY');

  let parsed: { subject?: string; body_text?: string; confidence?: number; facts_used?: string[] };
  try { parsed = JSON.parse(outputText) as typeof parsed; } catch { throw new Error('GEMINI_OUTREACH_INVALID_JSON'); }
  if (!parsed.subject?.trim() || !parsed.body_text?.trim() || !Array.isArray(parsed.facts_used)) throw new Error('GEMINI_OUTREACH_INVALID_RESULT');

  return {
    subject: parsed.subject.trim().slice(0, 180),
    bodyText: parsed.body_text.trim().slice(0, 5000),
    confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)),
    factsUsed: parsed.facts_used.map(String).slice(0, 20),
    model,
  };
}
