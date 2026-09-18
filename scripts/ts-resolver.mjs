// Resolutor para ejecutar las pruebas con node sobre el código fuente de Astro.
// Astro/Vite aceptan imports sin extensión ("./curation"); node no. Este hook añade ".ts".
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

const hook = `
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && !/\\.[a-z]+$/i.test(specifier)) {
    try {
      return await nextResolve(specifier + '.ts', context);
    } catch {
      return nextResolve(specifier, context);
    }
  }
  return nextResolve(specifier, context);
}
`;

register(`data:text/javascript,${encodeURIComponent(hook)}`, pathToFileURL('./'));
