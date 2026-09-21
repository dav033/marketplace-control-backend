import { OFFICIAL_CATEGORIES, parseList, parseVolume } from './registration-fields';
import { findProhibited } from './prohibited-items';

/**
 * El formulario de registro, hecho conversación.
 *
 * Recoge exactamente los mismos campos que `/registro/:token` y con las mismas reglas: si el
 * formulario web exige entre 1 y 5 categorías oficiales, aquí también, y la comprobación es
 * literalmente la misma función (`parseList`, `parseVolume`). Dos validaciones paralelas acabarían
 * separándose, y entonces el bot aceptaría fichas que el formulario rechaza.
 *
 * REPARTO DE RESPONSABILIDADES, que es lo que hace esto fiable:
 * - El CÓDIGO decide qué se pregunta, en qué orden, y qué es válido.
 * - El MODELO solo traduce lenguaje suelto a un valor ("pues unas 50 o 60 personas" → 50 y 60).
 *
 * Si el modelo se equivoca, el código lo rechaza y vuelve a preguntar. Y como el orden no depende
 * del modelo, la conversación se puede probar entera sin llamar a ninguna API.
 */

export const MAX_PRODUCTS = 10;
export const MAX_SERVICES = 5;
export const CATEGORY_LIST = [...OFFICIAL_CATEGORIES];

/** Lo que se sabe de un candidato antes de escribirle: sale de la ficha que dejó la curaduría. */
export type SeedProvider = {
  providerId: string;
  displayName: string;
  city: string | null;
  category: string | null;
  additionalCategories?: string[];
  phone?: string | null;
  email?: string | null;
};

export type RegistrationDraft = {
  /**
   * Marca que la conversación salió de un candidato ya conocido, no de alguien que escribió solo.
   * Es explícita a propósito: deducirlo de "ya hay nombre de empresa" hacía que, en el flujo normal,
   * el bot preguntara "¿hablo con alguien de X?" justo después de que el proveedor dijera X.
   */
  from_candidate?: boolean;
  /** Solo cuando la conversación arranca desde un candidato: ¿confirmó que es quien creemos? */
  identity_confirmed?: boolean;
  company_name?: string;
  full_name?: string;
  email?: string;
  phone?: string | null;
  services?: string[];
  products?: string[];
  volume_min?: number;
  volume_max?: number;
  description?: string | null;
  privacy_consent?: boolean;
  marketing_consent?: boolean;
};

export type StepKey = keyof RegistrationDraft | 'confirm' | 'done';

export type ChatStep = {
  key: StepKey;
  /** Lo que el bot pregunta. Lo escribe el código, no el modelo. */
  question: (draft: RegistrationDraft) => string;
  /** Interpreta la respuesta. `undefined` = no se entendió y hay que repreguntar. */
  parse: (input: string) => Partial<RegistrationDraft> | undefined;
  /**
   * Qué decir cuando no se entiende. Recibe lo que escribió la persona: repetir la misma frase
   * cuando alguien dice "no tengo correo" es lo que hace que un bot parezca tonto.
   */
  retry: (input: string) => string;
  /** Un paso opcional se puede saltar diciendo que no. */
  optional?: boolean;
  /**
   * Texto abierto: no hay formato que comprobar, así que cualquier cadena "cabe".
   *
   * Es justo donde se colaba la basura. Un correo, un rango de asistentes o un sí/no se validan
   * solos —o casan o no casan—, pero el nombre de una empresa admite cualquier cosa, y por eso
   * "hola", "adios" o una pregunta acababan guardados como razón social. En estos pasos decide el
   * agente si lo que llegó es una respuesta; el código sigue decidiendo si es válida.
   */
  openText?: boolean;
};

// El corte va con `(?!\p{L})` y no con `\b`: en JavaScript `\b` se calcula sobre ASCII, así que tras
// una vocal acentuada no hay frontera de palabra y /^s[ií]\b/ NO casa con "sí". Con `\b`, el bot
// ignoraba la afirmación más común en español y repreguntaba en bucle.
const NEGATIVE = /^(?:no|ninguno|ninguna|nada|omitir|saltar|paso|n\/a|na|luego|despu[eé]s)(?!\p{L})/iu;
const AFFIRMATIVE = /^(?:s[ií]|sii+|claro|dale|acepto|de acuerdo|correcto|ok|okay|vale|afirmativo|listo|confirmo|por supuesto)(?!\p{L})/iu;

export function isNegative(input: string) { return NEGATIVE.test(input.trim()); }

/**
 * Un "si" o un "no" pelado, sin nada mas detras.
 *
 * `isNegative` casa con cualquier mensaje que EMPIECE por "no", y eso incluye "no quiero
 * decirtelo", que no es una respuesta si/no sino una negativa que merece explicacion. Tratarlas
 * igual hacia que el bot soltara el mismo mensaje fijo una y otra vez.
 */
/**
 * Peticion explicita de no volver a escribir.
 *
 * No es lo mismo que decir "no" a una pregunta: esto va a la lista de supresion y cierra la puerta
 * para siempre. Insistir a quien lo pide es lo que hace que Meta baje la calidad de la cuenta.
 */
const OPT_OUT_PHRASES = [
  'no me escriban', 'no me escribas', 'no vuelvan a escribir', 'no vuelvas a escribir',
  'dejen de escribir', 'deja de escribirme', 'no me contacten', 'no me contactes',
  'quiero que me dejen', 'dejenme en paz', 'dejame en paz', 'borrenme', 'borrame',
  'eliminen mi numero', 'no me interesa nada', 'stop', 'baja', 'darme de baja',
];

export function isOptOut(input: string): boolean {
  const normalizado = fold(input.trim());
  return OPT_OUT_PHRASES.some((frase) => normalizado === frase || normalizado.includes(frase));
}

export function isPlainYesNo(input: string): boolean {
  const value = input.trim().replace(/[\s,.;:!¡¿?]+$/, '');
  if (!isNegative(value) && !isAffirmative(value)) return false;
  return value.split(/\s+/).filter(Boolean).length <= 2;
}

/**
 * Lo que queda de un mensaje despues de quitarle el "si"/"no" del principio.
 *
 * La gente contesta y adelanta en la misma frase: "si, me llamo Julian". Si solo se lee el "si", el
 * bot pregunta justo lo que le acaban de decir, que es lo que mas cara de tonto le pone. Esto
 * devuelve "me llamo Julian" para poder seguir leyendo el mismo mensaje.
 */
export function stripLeadingYesNo(input: string): string {
  const value = input.trim();
  const match = /^(?:si|sí|sii+|no|claro|dale|ok|okay|vale|listo|correcto|por supuesto|acepto)(?![\p{L}])/iu.exec(value);
  if (!match) return '';
  return value.slice(match[0].length).replace(/^[\s,.;:!¡¿?-]+/, '').trim();
}
export function isAffirmative(input: string) { return AFFIRMATIVE.test(input.trim()); }

const EMAIL_PATTERN = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const NO_EMAIL = /no\s+(?:tengo|tenemos|manejo|manejamos|uso|usamos)|sin\s+correo|no\s+hay\s+correo/i;

/**
 * Casi nadie abre soltando el nombre de su empresa: abre con "hola" o con "quiero registrarme".
 * Sin esto, ese primer saludo se guardaba COMO nombre de la empresa y toda la ficha quedaba
 * desplazada un campo — el nombre de la empresa en el del contacto, y así hasta el final.
 */
const OPENING_ONLY = /^(?:hola|buenas|buen[oa]s?\s+(?:d[ií]as?|tardes?|noches?)|saludos|qu[eé]\s+tal|c[oó]mo\s+est[aá]s?|hey|buenas\s+tardes)?[\s,.!¡¿?]*(?:quiero|quisiera|me\s+gustar[ií]a|necesito|deseo|busco)?\s*(?:registrar(?:me|nos|\s+mi\s+negocio|\s+mi\s+empresa)?|inscribir(?:me|nos)?|informaci[oó]n|info|ser\s+proveedor|unirme)?[\s,.!¡¿?]*$/iu;

/**
 * ¿Esto es una pregunta y no una respuesta?
 *
 * Los pasos de texto libre aceptaban cualquier cadena, así que "¿y esto cuánto me cuesta?" se
 * guardaba como el nombre de la persona de contacto. Detectarlo es lo que permite desviar el turno
 * al agente, que contesta la duda y vuelve a preguntar.
 */
const QUESTION_MARK = /[?¿]/;

// Lista comparada sobre el texto ya normalizado (sin tildes, en minusculas) en vez de una
// alternancia con clases de caracteres acentuados: la version con regex casaba en pruebas sueltas
// pero no al cargarse desde este modulo. Sin tildes en el patron, el problema no puede repetirse.
// Interrogativos que solo valen al principio de la frase. 'que' o 'como' sueltos aparecen dentro de
// respuestas legitimas ('tortas que hacemos por encargo'), asi que aqui solo cuentan si abren.
const QUESTION_STARTERS = [
  'que', 'cual', 'cuales', 'cuanto', 'cuanta', 'cuantos', 'cuantas', 'cuando', 'como',
  'quien', 'quienes', 'donde', 'por que', 'para que', 'puedo', 'puedes', 'pueden',
  'podria', 'podrian', 'hay que', 'es gratis', 'y si', 'me explicas', 'explicame',
];

// Giros que son inequivocamente una pregunta aparezcan donde aparezcan. Nacen de un caso real:
// "antes de que trata todo esto" se guardo como si fuera un producto, porque el interrogativo no
// iba al principio.
const QUESTION_PHRASES = [
  'de que trata', 'que trata', 'de que se trata', 'que es esto', 'que es', 'en que consiste',
  'no entiendo', 'como funciona', 'quienes son', 'para que sirve', 'para que es',
  'cuanto cuesta', 'tiene costo', 'tienen costo', 'que gano', 'que hacen ustedes',
];

export function looksLikeQuestion(input: string): boolean {
  const value = input.trim();
  if (QUESTION_MARK.test(value)) return true;
  const normalizado = fold(value);
  if (QUESTION_STARTERS.some((word) => normalizado === word || normalizado.startsWith(`${word} `))) return true;
  return QUESTION_PHRASES.some((phrase) => normalizado.includes(phrase));
}

/**
 * Una frase corrida, no un dato.
 *
 * Un nombre son dos o tres palabras y una lista de productos lleva comas. Cuando llega una oracion
 * larga sin comas, casi siempre es alguien hablando, no respondiendo: sin esto, "antes de euq trata
 * todo esto" acabo guardado como el unico producto del proveedor.
 */
export function looksLikeSentence(input: string, maxWords: number): boolean {
  const value = input.trim();
  if (value.includes(',') || value.includes(';')) return false;
  return value.split(/\s+/).filter(Boolean).length > maxWords;
}

export function looksLikeOpening(input: string): boolean {
  const value = input.trim();
  if (!value) return true;
  return OPENING_ONLY.test(value);
}

/** Normaliza para comparar categorías sin depender de tildes ni mayúsculas. */
function fold(value: string) {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

export function matchCategories(input: string): string[] {
  const found: string[] = [];
  const folded = fold(input);
  for (const category of CATEGORY_LIST) {
    if (folded.includes(fold(category)) && !found.includes(category)) found.push(category);
  }
  return found;
}

/** "de 50 a 200", "entre 50 y 200", "50-200", "unas 80 personas" (un solo número = min y max). */
export function matchVolume(input: string): { min: number; max: number } | undefined {
  const numbers = [...input.matchAll(/\d[\d.,]*/g)]
    .map((match) => Number(match[0].replace(/[.,]/g, '')))
    .filter((value) => Number.isInteger(value) && value > 0);
  if (!numbers.length) return undefined;
  const min = numbers[0];
  const max = numbers.length > 1 ? numbers[1] : numbers[0];
  // La validación real es la del formulario, no esta.
  return parseVolume(String(min), String(max));
}

/** Separa una enumeración hablada: comas, "y", saltos de línea, guiones de lista. */
export function splitItems(input: string): string[] {
  return input
    .split(/\n|,|;|\s+y\s+|\s*\/\s*|^\s*[-*•]\s*/gim)
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter((part) => part.length > 0 && part.length <= 60);
}

export const STEPS: ChatStep[] = [
  {
    // Solo aplica cuando la conversación arranca desde un candidato; `nextStep` lo salta si no.
    key: 'identity_confirmed',
    question: (draft) => `¿Hablo con alguien de ${draft.company_name}? Si te interesa, te hago unas preguntas rápidas.`,
    retry: () => 'Dime "sí" para seguir, o "no" si prefieres que no te escriba.',
    parse: (input) => {
      if (isAffirmative(input)) return { identity_confirmed: true };
      if (isNegative(input)) return { identity_confirmed: false };
      return undefined;
    },
  },
  {
    key: 'company_name',
    openText: true,
    question: () => '¡Hola! Te ayudo a registrar tu negocio en el marketplace. ¿Cómo se llama tu empresa?',
    retry: () => 'No alcancé a captar el nombre. ¿Cómo se llama tu empresa?',
    parse: (input) => {
      const value = input.replace(/\s+/g, ' ').trim();
      // Un "sí" o un "no" suelto no es un nombre: antes quedaban guardados como razón social.
      if (isNegative(value) || isAffirmative(value) || looksLikeQuestion(value)) return undefined;
      return value.length >= 2 && value.length <= 200 ? { company_name: value } : undefined;
    },
  },
  {
    key: 'full_name',
    openText: true,
    question: (draft) => `Gracias. ¿Y cuál es tu nombre completo, la persona de contacto de ${draft.company_name}?`,
    retry: () => 'Necesito tu nombre completo para la ficha. ¿Cómo te llamas?',
    parse: (input) => {
      const value = input.replace(/\s+/g, ' ').trim();
      if (isNegative(value) || isAffirmative(value) || looksLikeQuestion(value)) return undefined;
      // Nadie se llama con siete palabras: eso es una frase, no un nombre.
      if (looksLikeSentence(value, 5)) return undefined;
      return value.length >= 2 && value.length <= 160 ? { full_name: value } : undefined;
    },
  },
  {
    key: 'email',
    question: () => '¿A qué correo te escribimos? Es el que queda en la ficha.',
    // El correo es obligatorio en la ficha (la columna es NOT NULL), así que no se puede omitir.
    // Cuando alguien dice que no tiene, repetir "ese correo no me cuadra" es absurdo: hay que
    // explicar para qué se pide y bajar el listón a un correo personal.
    retry: (input) => (
      NO_EMAIL.test(input) || isNegative(input)
        ? 'Ese sí lo necesito: es donde llega la confirmación del registro y por donde te escribe el equipo. Puede ser uno personal, no hace falta que sea corporativo.'
        : 'Ese correo no me cuadra. ¿Me lo escribes completo? Por ejemplo: contacto@tuempresa.com'
    ),
    parse: (input) => {
      const match = EMAIL_PATTERN.exec(input.trim());
      if (!match) return undefined;
      const email = match[0].toLowerCase();
      return email.length <= 320 ? { email } : undefined;
    },
  },
  {
    key: 'phone',
    question: () => '¿Quieres dejar un teléfono de contacto? Si prefieres que usemos este mismo de WhatsApp, dime "no".',
    retry: () => 'No entendí el número. Puedes escribirlo o decir "no" para omitirlo.',
    optional: true,
    parse: (input) => {
      if (isNegative(input)) return { phone: null };
      const digits = input.replace(/[^\d+]/g, '');
      return digits.length >= 7 && digits.length <= 20 ? { phone: digits } : undefined;
    },
  },
  {
    key: 'services',
    question: () => `¿En cuál de estas categorías trabajas? Puedes decirme hasta ${MAX_SERVICES}:\n\n${CATEGORY_LIST.map((category) => `• ${category}`).join('\n')}`,
    retry: () => `No reconocí ninguna de la lista. Escríbela tal como aparece, por ejemplo "Comida y Bebida".`,
    parse: (input) => {
      const matched = matchCategories(input);
      if (!matched.length) return undefined;
      // Se valida contra la lista oficial igual que el formulario web.
      const clean = parseList(JSON.stringify(matched), MAX_SERVICES, OFFICIAL_CATEGORIES);
      return clean?.length ? { services: clean } : undefined;
    },
  },
  {
    key: 'products',
    openText: true,
    question: () => `Cuéntame qué ofreces en concreto, hasta ${MAX_PRODUCTS} cosas separadas por comas. Por ejemplo: "menú de boda, estación de postres, coctelería".`,
    retry: (input) => {
      const vetados = findProhibited(splitItems(input));
      if (vetados.length) {
        return `No puedo registrar ${vetados.join(' ni ')} en el catálogo: solo listamos productos y servicios para eventos. `
          + 'Si el resto de lo que ofreces sí encaja, escríbemelo de nuevo sin eso.';
      }
      return isNegative(input)
        // Los productos son obligatorios (el formulario exige entre 1 y 10): un "no" no vale.
        ? 'Esta sí la necesito: sin saber qué ofreces no puedo mostrarte en el catálogo. Basta con dos o tres cosas, por ejemplo "tortas de boda, postres personalizados".'
        : `No pude separar la lista. Escríbelos separados por comas, máximo ${MAX_PRODUCTS}.`;
    },
    parse: (input) => {
      // Mas de 5 palabras sin una sola coma se trata como frase, no como lista. Un producto real
      // largo ("alquiler de carpas para eventos grandes") tambien cae aqui, y es el intercambio
      // aceptado: repreguntar pidiendo comas cuesta un turno; guardar la frase de alguien como si
      // fuera su catalogo ensucia la ficha que despues revisa una persona.
      if (isNegative(input) || looksLikeQuestion(input) || looksLikeSentence(input, 5)) return undefined;
      const items = splitItems(input);
      if (!items.length) return undefined;
      // Lo que no entra al catalogo no entra por aqui tampoco: se rechaza el lote entero y se le
      // dice cual es el problema, en vez de guardarlo y que lo descubra quien revise la ficha.
      if (findProhibited(items).length) return undefined;
      const clean = parseList(JSON.stringify(items), MAX_PRODUCTS);
      return clean?.length ? { products: clean } : undefined;
    },
  },
  {
    key: 'volume_min',
    question: () => '¿Para cuántos asistentes sueles trabajar? Dame un rango, por ejemplo "de 50 a 300".',
    retry: () => 'Necesito un rango de asistentes, por ejemplo "de 50 a 300".',
    parse: (input) => {
      const volume = matchVolume(input);
      return volume ? { volume_min: volume.min, volume_max: volume.max } : undefined;
    },
  },
  {
    key: 'description',
    openText: true,
    question: () => '¿Quieres añadir algo más sobre tu negocio? Si no, dime "no" y seguimos.',
    retry: () => 'Puedes contarme algo breve o decir "no".',
    optional: true,
    parse: (input) => {
      if (isNegative(input)) return { description: null };
      if (looksLikeQuestion(input)) return undefined;
      const value = input.trim().slice(0, 4000);
      return value ? { description: value } : undefined;
    },
  },
  {
    key: 'privacy_consent',
    question: () => 'Para guardar tu ficha necesito tu autorización para tratar estos datos con el fin de evaluarte como proveedor. ¿Me la das? Responde "sí" o "no".',
    retry: () => 'Necesito un "sí" o un "no" claro para poder continuar.',
    parse: (input) => {
      if (isAffirmative(input)) return { privacy_consent: true };
      if (isNegative(input)) return { privacy_consent: false };
      return undefined;
    },
  },
  {
    key: 'marketing_consent',
    question: () => 'Última: ¿quieres que te enviemos novedades y oportunidades comerciales? Es opcional y puedes decir "no" sin afectar tu registro.',
    retry: () => 'Responde "sí" o "no", como prefieras.',
    parse: (input) => {
      if (isAffirmative(input)) return { marketing_consent: true };
      if (isNegative(input)) return { marketing_consent: false };
      return undefined;
    },
  },
  {
    key: 'confirm',
    question: (draft) => `Esto es lo que voy a registrar:\n\n${summarize(draft)}\n\n¿Lo confirmo? Responde "sí" para enviarlo o dime qué corrijo.`,
    retry: () => 'Dime "sí" para enviarlo, o qué dato quieres corregir.',
    parse: (input) => (isAffirmative(input) ? {} : undefined),
  },
];

/**
 * Convierte un candidato en un borrador a medio llenar.
 *
 * Se precarga solo lo que la curaduría verificó contra fuentes públicas: el nombre, el canal de
 * contacto y la categoría. NO se precargan el nombre de la persona ni el correo aunque existan en
 * la ficha: eso lo tiene que decir el proveedor, porque es justo lo que el registro viene a
 * confirmar. Y las categorías se filtran contra la lista oficial, porque una etiqueta libre no
 * pasaría la validación del formulario.
 */
export function seedDraft(seed: SeedProvider): RegistrationDraft {
  const categorias = [seed.category, ...(seed.additionalCategories ?? [])]
    .filter((value): value is string => Boolean(value))
    .flatMap((value) => matchCategories(value));
  const services = parseList(JSON.stringify([...new Set(categorias)]), MAX_SERVICES, OFFICIAL_CATEGORIES);

  return {
    from_candidate: true,
    company_name: seed.displayName,
    ...(services?.length ? { services } : {}),
    ...(seed.phone ? { phone: seed.phone } : {}),
  };
}

export function summarize(draft: RegistrationDraft): string {
  const lines = [
    `Empresa: ${draft.company_name ?? '—'}`,
    `Contacto: ${draft.full_name ?? '—'}`,
    `Correo: ${draft.email ?? '—'}`,
    `Teléfono: ${draft.phone ?? 'el de este WhatsApp'}`,
    `Categorías: ${draft.services?.join(', ') ?? '—'}`,
    `Ofrece: ${draft.products?.join(', ') ?? '—'}`,
    `Asistentes: de ${draft.volume_min ?? '—'} a ${draft.volume_max ?? '—'}`,
  ];
  if (draft.description) lines.push(`Nota: ${draft.description}`);
  lines.push(`Novedades comerciales: ${draft.marketing_consent ? 'sí' : 'no'}`);
  return lines.join('\n');
}

/**
 * El primer paso sin responder. Los pasos opcionales cuentan como respondidos en cuanto se fija su
 * valor, incluido `null`, que es la forma de decir "lo omitió a propósito".
 */
export function nextStep(draft: RegistrationDraft): ChatStep | undefined {
  for (const step of STEPS) {
    if (step.key === 'identity_confirmed') {
      // Solo se confirma identidad cuando nosotros escribimos primero a un candidato.
      if (!draft.from_candidate) continue;
      if (draft.identity_confirmed === undefined) return step;
      continue;
    }
    if (step.key === 'confirm') return step;
    if (step.key === 'volume_min') {
      if (draft.volume_min === undefined || draft.volume_max === undefined) return step;
      continue;
    }
    if (draft[step.key as keyof RegistrationDraft] === undefined) return step;
  }
  return undefined;
}

/** Qué se espera recoger en cada paso; se le pasa al agente para que extraiga lo correcto. */
export const FIELD_HINTS: Partial<Record<StepKey, string>> = {
  company_name: 'el nombre comercial de la empresa del proveedor',
  full_name: 'el nombre completo de la persona de contacto',
  products: 'los productos o servicios concretos que ofrece, separados por comas',
  description: 'una nota libre sobre el negocio, o nada si no quiere anadir',
};

export type ChatOutcome =
  | { type: 'question'; message: string; draft: RegistrationDraft }
  | { type: 'retry'; message: string; draft: RegistrationDraft }
  | { type: 'declined'; message: string; draft: RegistrationDraft }
  | { type: 'submit'; message: string; draft: RegistrationDraft };

/** Primer mensaje, cuando el proveedor todavía no ha dicho nada útil. */
export function openingMessage(): string {
  // Se pregunta a `nextStep` en vez de asumir `STEPS[0]`: el primer paso de la lista es el de
  // confirmar identidad, que solo aplica cuando escribimos nosotros. Con `STEPS[0]` fijo, el saludo
  // del flujo normal salía como "¿Hablo con alguien de undefined?".
  return (nextStep({}) ?? STEPS[1]).question({});
}

/**
 * Avanza la conversación un turno.
 *
 * Devuelve el borrador actualizado y qué decir. No escribe en la base ni llama al modelo: eso lo
 * hace quien la usa, y por eso esta función se puede probar entera sin red.
 */
export function advance(draft: RegistrationDraft, input: string): ChatOutcome {
  const step = nextStep(draft);
  if (!step) return { type: 'submit', message: '', draft };

  // Un saludo de apertura no es la respuesta a la primera pregunta: se contesta con la pregunta,
  // no consumiéndolo como nombre de la empresa.
  if (step.key === 'company_name' && looksLikeOpening(input)) {
    return { type: 'question', message: step.question(draft), draft };
  }

  const parsed = step.parse(input);
  if (!parsed) return { type: 'retry', message: step.retry(input), draft };

  const updated = { ...draft, ...parsed };

  // Un "no" aquí puede ser "no me interesa" o "te equivocaste de número", y como escribimos primero
  // no sabemos cuál es. El cierre sirve para los dos y no insiste: insistir a quien no contesta o
  // dice que no es lo que hace que Meta baje la calidad de la cuenta y acabe limitándola.
  if (step.key === 'identity_confirmed' && updated.identity_confirmed === false) {
    return {
      type: 'declined',
      message: 'Entendido, no te escribo más por aquí. Si más adelante te interesa, escríbeme y lo retomamos.',
      draft: updated,
    };
  }

  // Sin consentimiento de privacidad no hay ficha: es la única respuesta que corta el flujo.
  if (step.key === 'privacy_consent' && updated.privacy_consent === false) {
    return {
      type: 'declined',
      message: 'Entendido, no guardo nada. Si cambias de idea escríbeme y lo retomamos desde donde estábamos.',
      draft: updated,
    };
  }

  if (step.key === 'confirm') {
    return { type: 'submit', message: '¡Listo! Ya envié tu registro. Una persona del equipo lo revisa y te contacta.', draft: updated };
  }

  const following = nextStep(updated);
  if (!following) return { type: 'submit', message: '', draft: updated };
  return { type: 'question', message: following.question(updated), draft: updated };
}
