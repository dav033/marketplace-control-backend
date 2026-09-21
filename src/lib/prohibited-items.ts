/**
 * Productos que no entran al catálogo, se pidan por donde se pidan.
 *
 * Nace de una prueba real: un proveedor escribió "comida, bebidas, servicios de catering, drogas
 * alucinogenas, armas, globos" y el sistema lo guardó entero sin pestañear. Ni el bot ni el
 * formulario web miraban qué se estaba registrando.
 *
 * Vive aparte y lo usan los dos caminos —la conversación y `/api/public/form-submit`— porque una
 * regla de negocio aplicada en un solo sitio es una regla que se puede rodear cambiando de puerta.
 *
 * NO es un filtro de contenido exhaustivo ni pretende serlo: es la primera barrera contra lo obvio.
 * La ficha la revisa igual una persona, y ahí está el juicio de verdad.
 */

/** Términos que por sí solos descartan un producto. Sin tildes: se comparan sobre texto normalizado. */
const PROHIBITED_TERMS = [
  // Estupefacientes
  'droga', 'drogas', 'estupefaciente', 'estupefacientes', 'alucinogeno', 'alucinogenos',
  'alucinogena', 'alucinogenas', 'cocaina', 'heroina', 'metanfetamina', 'lsd', 'extasis',
  // Armas y explosivos
  'arma', 'armas', 'municion', 'municiones', 'explosivo', 'explosivos', 'granada', 'granadas',
  'dinamita', 'pistola', 'pistolas', 'fusil', 'fusiles', 'revolver',
  // Servicios sexuales
  'prostitucion', 'prostitutas', 'escorts', 'servicios sexuales', 'trata de personas',
  // Falsificacion
  'documentos falsos', 'documentos falsificados', 'titulos falsos', 'dinero falso',
  // Contenido sexual
  'sexo', 'sexual', 'sexuales', 'pornografia', 'pornografico', 'strippers', 'putas',
  'coito', 'orgia', 'orgias', 'burdel', 'prostibulo',
  // Violencia y dano
  'asesinar', 'asesinato', 'matar', 'sicariato', 'secuestro', 'tortura', 'maltrato animal',
];

function fold(value: string) {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/**
 * Compara por palabra completa y no por subcadena: "armado de carpas" contiene "arma" y es un
 * servicio perfectamente legítimo de montaje. Bloquearlo por coincidencia parcial sería peor que no
 * filtrar, porque rechazaría a proveedores reales sin que nadie entienda por qué.
 */
export function isProhibited(item: string): boolean {
  const normalizado = fold(item);
  const palabras = normalizado.split(/[^a-z0-9]+/).filter(Boolean);
  return PROHIBITED_TERMS.some((term) => (
    term.includes(' ')
      ? normalizado.includes(term)
      : palabras.includes(term)
  ));
}

/** Los que no se pueden aceptar, tal como los escribió el proveedor, para poder nombrárselos. */
export function findProhibited(items: string[]): string[] {
  return items.filter((item) => isProhibited(item));
}
