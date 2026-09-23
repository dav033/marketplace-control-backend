// Deducción de categorías a partir del nombre y del tipo de Google. Sin red.
import assert from 'node:assert/strict';
import { inferAdditionalCategories, inferCategories } from '../src/lib/category-inference.ts';

// El caso que destapó el agujero: entró solo como "Comida y Bebida".
assert.deepEqual(
  inferAdditionalCategories({ name: 'Casa de Eventos Barcelona Plaza (Alquiler de mobiliario y menaje para eventos)' }, 'Comida y Bebida'),
  ['Lugar', 'Menaje y mantelería', 'Carpas y mobiliario'],
);

assert.deepEqual(
  inferAdditionalCategories({ name: 'Atalú, pastelería sin azúcar', type: 'Pastelería' }, 'Repostería y pastelería'),
  [], 'una pastelería normal no gana categorías de más',
);

// Repostería es su propia categoría, no Comida y Bebida.
assert.deepEqual(inferCategories('Tortas y cupcakes para bodas'), ['Repostería y pastelería']);
assert.deepEqual(inferCategories('Panadería y Pastelería La Espiga'), ['Repostería y pastelería']);
assert.deepEqual(inferCategories('Catering y banquetes con mesa de postres'), ['Comida y Bebida', 'Repostería y pastelería']);
assert.deepEqual(inferCategories('Restaurante y parrilla'), ['Comida y Bebida'], 'un restaurante no es repostería');

// Falsos positivos vistos en nombres reales.
assert.deepEqual(inferCategories('Catering Andrea Flores'), ['Comida y Bebida'], '"Flores" es un apellido');
assert.deepEqual(inferCategories('Tortas Marina Coro'), ['Repostería y pastelería'], '"Coro" es un apellido');
assert.deepEqual(inferCategories('Banquetes La Quinta'), ['Comida y Bebida']);
assert.deepEqual(inferCategories('Restaurante Bar La Terraza'), ['Comida y Bebida']);
assert.deepEqual(inferCategories('Takuma Cocina Show'), [], 'un teppanyaki no es entretenimiento');
assert.deepEqual(inferCategories('Alquiler de luces y sonido para eventos'), ['Servicios Especializados']);
assert.deepEqual(inferCategories('Quinta de eventos El Paraíso'), ['Lugar']);
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
