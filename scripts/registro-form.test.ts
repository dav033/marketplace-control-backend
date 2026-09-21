import { parseList, parseVolume, OFFICIAL_CATEGORIES } from '../src/lib/registration-fields.ts';

let failed = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) { failed += 1; console.log(`  FALLA ${label}: ${a}, esperado ${e}`); }
}

// Productos: lista abierta con tope de 10.
check('vacío', parseList('', 10), []);
check('uno', parseList('["Cobertura de boda"]', 10), ['Cobertura de boda']);
check('espacios normalizados', parseList('["  Foto   de  boda "]', 10), ['Foto de boda']);
check('duplicados colapsan', parseList('["Foto","Foto"]', 10), ['Foto']);
check('diez caben', parseList(JSON.stringify(['1','2','3','4','5','6','7','8','9','10']), 10)?.length, 10);
check('once se rechaza', parseList(JSON.stringify(['1','2','3','4','5','6','7','8','9','10','11']), 10), undefined);
check('no es array', parseList('{"a":1}', 10), undefined);
check('JSON roto', parseList('[no-json', 10), undefined);
check('elemento no textual', parseList('["ok",5]', 10), undefined);
check('elemento vacío', parseList('["ok","   "]', 10), undefined);
check('elemento larguísimo', parseList(JSON.stringify(['x'.repeat(61)]), 10), undefined);

// Servicios: solo las 10 categorías oficiales, tope de 5.
check('categoría oficial', parseList('["Lugar"]', 5, OFFICIAL_CATEGORIES), ['Lugar']);
check('con tilde', parseList('["Fotografía y Video"]', 5, OFFICIAL_CATEGORIES), ['Fotografía y Video']);
check('inventada se rechaza', parseList('["Categoria Inventada"]', 5, OFFICIAL_CATEGORIES), undefined);
check('mayúsculas no cuelan', parseList('["LUGAR"]', 5, OFFICIAL_CATEGORIES), undefined);
check('cinco caben', parseList('["Lugar","Música","Entretenimiento","Decoración temática","Fotografía y Video"]', 5, OFFICIAL_CATEGORIES)?.length, 5);
check('seis se rechaza', parseList('["Lugar","Música","Entretenimiento","Decoración temática","Fotografía y Video","Invitación digital"]', 5, OFFICIAL_CATEGORIES), undefined);
check('son diez oficiales', OFFICIAL_CATEGORIES.size, 10);

// Volumen: rango de asistentes.
check('rango válido', parseVolume('20', '180'), { min: 20, max: 180 });
check('mismo valor', parseVolume('50', '50'), { min: 50, max: 50 });
check('invertido', parseVolume('100', '10'), undefined);
check('cero', parseVolume('0', '10'), undefined);
check('negativo', parseVolume('-5', '10'), undefined);
check('decimal', parseVolume('10.5', '20'), undefined);
check('vacío', parseVolume('', ''), undefined);
check('texto', parseVolume('mucho', '20'), undefined);
check('por encima del tope', parseVolume('1', '100001'), undefined);

if (failed) { console.log(`registro form tests: ${failed} fallos`); process.exit(1); }
console.log('registro form tests passed');
