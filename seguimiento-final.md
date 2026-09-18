# Seguimiento final — Marketplace Control

Fecha de cierre: 2026-09-18  
Repositorio: `https://github.com/dav033/proovedores`  
Rama final: `main`  
Commit funcional final: `2471b44`

## 1. Setup y despliegue

- Se clonó y configuró el repositorio `dav033/proovedores`.
- Se preparó la aplicación Astro/Node, PostgreSQL local de la EC2 y Caddy.
- Se desplegó en la EC2 de Marketplace mediante GitHub Actions.
- URL activa: `https://54-167-34-107.sslip.io`.
- El endpoint `/api/health` responde HTTP 200.
- Las credenciales, `DATABASE_URL`, `ADMIN_ACCESS_KEY` y claves SSH permanecen
  fuera del repositorio.

## 2. Integración Gemini

- Se integró Gemini directamente dentro de `/proveedores`.
- La llave se recuperó de forma controlada del contenedor activo
  `demo-decoracion-ai-api` en `n8n-maros`.
- Se instaló en EC2 como `/etc/marketplace-control/gemini.env`, con permisos
  `0600`; nunca se imprimió ni se subió a Git.
- Gemini usa búsqueda web y contexto de URLs para devolver el TSV de curaduría.
- La respuesta siempre pasa por el validador local antes de permitir una vista
  previa o una importación.
- La importación requiere confirmación explícita y deja los proveedores como
  `candidate`.
- No se enviaron correos ni se activaron campañas.

## 3. Búsqueda por ciudad y categoría

La interfaz permite escoger obligatoriamente:

- Ciudad: Bogotá, Medellín, Cali, Barranquilla, Cartagena, Bucaramanga,
  Pereira, Manizales, Santa Marta, Armenia y Villavicencio.
- Las 10 categorías oficiales del proyecto.

El botón `Lanzar búsqueda con Gemini` envía la ciudad y categoría seleccionadas
al endpoint `/api/ai/curation`.

## 4. División por canal de contacto

Se agregó `marketplace.providers.contact_channel` con valores `email` o
`whatsapp`, incluyendo migración idempotente para bases existentes.

- `email`: empresa mediana/masiva con correo válido, o empresa con correo de
  dominio corporativo propio.
- `whatsapp`: empresa pequeña o con correo gratuito, únicamente si tiene un
  móvil colombiano verificable.
- Sin correo corporativo ni móvil válido: la fila se rechaza.
- Los correos públicos se guardan en `contacts` con consentimiento `unknown`.
- El consentimiento desconocido no habilita campañas de marketing.
- La vista previa muestra conteos y nombres de ambos grupos.
- La tabla de proveedores permite filtrar por correo corporativo o WhatsApp.
- La ficha individual muestra el canal asignado.

## 5. Retiro del MCP

Como la operación pasó a Gemini, el MCP de Marketplace fue eliminado:

- Se eliminaron `mcp-server/`, su documentación y sus plantillas de conexión.
- Se quitó el registro `marketplace-control` de Claude local.
- Se eliminó el wrapper SSH efímero local.
- En EC2 se detuvo y eliminó la unidad systemd, wrapper y regla sudoers MCP.
- Se eliminaron copias MCP de releases históricas.
- Caddy dejó de publicar `/mcp`, OAuth y metadatos MCP.
- `/mcp` y los endpoints OAuth devuelven 404.
- El MCP no toca la aplicación Gemini ni la base de datos.

Commits relacionados: `5e96b89` y `0a3a539`.

## 6. Pruebas y benchmarks

- `npm run build`: ✅ 0 errores, 0 warnings y 0 hints.
- `node --experimental-strip-types scripts/curation.test.ts`: ✅.
- Se probaron filas válidas, umbrales, URL inválida, evidencia débil,
  normalización, correo corporativo, Gmail con WhatsApp y ausencia de canal.
- Benchmark del parser/validador, 30 iteraciones por lote:
  - 1 fila: 0.153 ms promedio.
  - 10 filas: 0.570 ms.
  - 50 filas: 2.515 ms.
  - 100 filas: 4.968 ms.
  - 500 filas: 23.450 ms, aproximadamente 21,322 filas/s.
- Health: 10/10 respuestas HTTP 200; promedio 262.73 ms, mediana 240.03 ms.
- Gemini e2e: una corrida 502 en 56.565 s y un reintento HTTP 200 en 66.231 s,
  con 0 aceptados y 7 rechazados por el validador. No hubo escritura.
- La página autenticada publicada confirmó los selectores de ciudad/categoría,
  el botón de búsqueda, los filtros de canal y la columna PostgreSQL.

## 7. Despliegue final

- Commit final en `main`: `2471b44 feat: classify provider contact channels`.
- Workflow exitoso: [GitHub Actions run #21](https://github.com/dav033/proovedores/actions/runs/35337336585).
- El repositorio quedó limpio después del push.

## 8. Pendientes no bloqueantes

- Configurar el DNS corporativo definitivo en lugar de `sslip.io`.
- Confirmar certificados HTTPS para el dominio corporativo.
- Completar identidad/DKIM y salida de sandbox de SES antes de campañas reales.
- Definir backups programados de PostgreSQL.
- No borrar datos de proveedores ni la base sin una confirmación separada y un
  backup previo.
