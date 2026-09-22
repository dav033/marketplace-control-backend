// Deducción de categorías a partir del nombre y del tipo de Google. Sin red.
import assert from 'node:assert/strict';
import { inferAdditionalCategories, inferCategories } from '../src/lib/category-inference.ts';

// El caso que destapó el agujero: entró solo como "Comida y Bebida".
assert.deepEqual(
  inferAdditionalCategories({ name: 'Casa de Eventos Barcelona Plaza (Alquiler de mobiliario y menaje para eventos)' }, 'Comida y Bebida'),
  ['Lugar', 'Menaje y mantelería', 'Carpas y mobiliario'],
);

assert.deepEqual(
  inferAdditionalCategories({ name: 'Atalú, pastelería sin azúcar', type: 'Pastelería' }, 'Comida y Bebida'),
  [], 'una pastelería normal no gana categorías de más',
);
assert.deepEqual(
  inferAdditionalCategories({ name: 'Hotel Dann Carlton', type: 'Hotel' }, 'Lugar'),
  [], 'la principal nunca se repite en las adicionales',
);
assert.deepEqual(
  inferCategories('DJ y sonido para bodas, con hora loca y decoración con globos'),
  ['Música', 'Entretenimiento', 'Decoración temática'],
);
assert.deepEqual(inferCategories('Fotografía y video con dron'), ['Fotografía y Video']);

// Palabra completa: ni la ciudad ni un apellido pueden colar una categoría.
assert.deepEqual(inferCategories('Eventos Barranquilla Bartolomé'), [], '"bar" no está dentro de "Barranquilla"');
assert.deepEqual(inferCategories('Organización de eventos en Cartagena'), ['Servicios Especializados']);

// Tope: la ficha admite 5 categorías contando la principal.
const muchas = inferAdditionalCategories(
  { name: 'Carpas, menaje, decoración con flores, DJ, fotografía y show infantil' },
  'Comida y Bebida',
);
assert.equal(muchas.length, 4);

console.log('category inference tests passed');
