# Marketplace Control — Frontend

Panel interno para revisar proveedores candidatos, campañas de contacto y formularios recibidos.
No tiene acceso a PostgreSQL ni a ninguna credencial de servicio externa: todo lo pide por HTTP al
backend, que vive en un repositorio aparte ([`marketplace-control`](https://github.com/dav033/proovedores)).

## Arranque local

Necesitas el backend corriendo en otra terminal (o apuntar `BACKEND_URL` a uno ya desplegado):

```bash
npm install
copy .env.example .env   # define BACKEND_URL y BACKEND_SERVICE_TOKEN
npm run dev               # http://127.0.0.1:4322
```

Sin `BACKEND_URL` configurado, el proxy (`src/pages/api/[...path].ts`) responde 503 en vez de
fallar en silencio. Las páginas que leen datos (`fetchDashboard`, `fetchProvider`, …) degradan a
datos de demostración cuando el backend no responde, así que la interfaz se puede revisar aunque no
haya backend a mano — solo que sin datos reales.

## Por qué hay un proxy

Los scripts de las páginas llaman a rutas del mismo origen (`/api/ai/curation`, `/api/campaigns`…).
Con el panel desplegado en Vercel esas rutas no existen ahí, así que `src/pages/api/[...path].ts`
reenvía cualquier `/api/*` al backend **añadiendo el token de servicio del lado del servidor**. El
navegador nunca ve `BACKEND_SERVICE_TOKEN`.

## El contrato con el backend

`src/lib/contract.ts`, `src/lib/types.ts` y `src/lib/demo.ts` son una copia deliberada de los
mismos archivos en el repositorio del backend, no un paquete compartido: es más barato mantener dos
copias de unos tipos y dos constantes que un paquete npm privado. El riesgo de que se separen con el
tiempo lo cubre `contract.test.ts` (pendiente de escribir — ver `MIGRACION-REPOS.md` en el backend),
que llama al backend real y valida que la respuesta de cada `/api/v1/*` tiene la forma que este
frontend espera.

## Variables de entorno

| Variable | Uso |
|---|---|
| `BACKEND_URL` | Origen del backend (`https://...`). Vacío = mismo origen. |
| `BACKEND_SERVICE_TOKEN` | Token con el que el proxy se autentica ante `/api/v1/*` del backend. |

Ninguna otra credencial (PostgreSQL, Omnisend, Gemini, Google Places, WhatsApp) pertenece a este
repositorio.

## Despliegue

Vercel, apuntando a este repositorio con *Root Directory* en la raíz. Variables de entorno:
`BACKEND_URL` y `BACKEND_SERVICE_TOKEN`.

## Pruebas

```bash
npm test
```

`scripts/ui-identity.test.ts` comprueba que ninguna plantilla `.astro` nombre al proveedor de IA que
hace la investigación en el backend (Gemini, Codex, Claude Code): es una decisión de operación que el
operador del panel no debería ver.
