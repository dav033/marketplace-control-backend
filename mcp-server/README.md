# Marketplace Control MCP Server

Mini-servidor MCP en TypeScript/Node con transporte `stdio` para consultar el
pipeline de proveedores y, de forma explícita, importar lotes curados desde
Claude. El servidor no expone un puerto HTTP y no tiene herramientas para
enviar correo.

## Herramientas

- `search_providers`: texto, categoría, ciudad, estado y límite. Solo lectura.
- `get_provider`: proveedor por UUID y fuentes públicas asociadas. Solo lectura.
- `pipeline_stats`: conteos por estado; sin datos personales. Solo lectura.
- `list_registration_submissions`: registros del formulario, con correo y teléfono enmascarados por defecto. Solo lectura.
- `import_curated_providers`: dry-run por defecto; con `confirm=true` valida e importa un lote de hasta 50 filas curadas.

La escritura solo toca `marketplace.providers`, `marketplace.provider_sources`,
`marketplace.contacts` y un registro resumido en `marketplace.audit_log`. Los
proveedores quedan en estado `candidate`. Los contactos nuevos quedan con
`consent_status = 'unknown'`; el consentimiento existente nunca se cambia.
No existe ninguna operación MCP de envío, programación o cancelación de
campañas.

## Importación curada

`import_curated_providers` recibe JSON estructurado, no SQL ni TSV libre. Cada
fila contiene las 18 columnas de la salida de curaduría, más estos metadatos
obligatorios para poder auditar el filtro:

- `provider_type`: `type_1_local` exige al menos 50 reseñas; `type_2_by_order` exige al menos 15.
- `event_evidence`: evidencia publicada de que presta servicios para eventos.
- `activity_evidence`: evidencia de actividad dentro de los últimos 12 meses.

La herramienta además exige rating entre 4.5 y 5, nivel de curaduría coherente,
URL directa de la ficha (rechaza búsquedas), ID con categoría consistente,
fecha real, teléfono normalizado, correo válido o `Sin dato`, y que todas las
filas del lote compartan ciudad y categoría. Los duplicados dentro del lote
se rechazan antes de abrir una transacción.

Primero se debe llamar sin confirmación:

```json
{
  "batch_id": "mde-musica-2026-09-17-01",
  "rows": [{
    "id": "MDE-03-001",
    "display_name": "Proveedor de ejemplo",
    "category": "Música",
    "segment": "Sin clasificar",
    "city": "Medellín",
    "zone": "Área Metropolitana",
    "scale": "Sin dato",
    "formality": "No verificado",
    "rating": 4.8,
    "review_count": 86,
    "reputation_platform": "Google",
    "curation_level": "A",
    "curation_reason": "4.8 con 86 reseñas en Google; portafolio publicado de música para bodas.",
    "phone": "Sin dato",
    "instagram": "Sin Redes",
    "email": "Sin dato",
    "source_url": "https://example.com/ficha-directa",
    "verification_date": "2026-09-17",
    "provider_type": "type_2_by_order",
    "event_evidence": "El sitio publica servicios de música para bodas y eventos corporativos.",
    "activity_evidence": "El perfil muestra publicaciones recientes dentro de los últimos 12 meses."
  }]
}
```

El dry-run no toca la base. Solo después de revisar la respuesta se repite el
mismo lote con `"confirm": true`. La operación es idempotente por proveedor
(`nombre + ciudad + categoría`) y por fuente (`plataforma + URL + ID`), y toda
la transacción se revierte si una fila falla.

## Desarrollo local

Requiere Node 20+ y una única variable de conexión:

```powershell
$env:DATABASE_URL = "postgresql://USUARIO:CONTRASENA@HOST:5432/marketplace"
npm ci
npm run build
npm run smoke
npm run check
```

`DATABASE_URL` se usa exclusivamente para PostgreSQL. No pongas credenciales
en Git, README, logs ni configuración pública. Para la conexión desde Claude
por SSH no se configura `DATABASE_URL` en el cliente: el puente remoto la lee
desde `/etc/marketplace-control/marketplace-control.env`.

## Transporte stdio y SSH

El cliente Claude ejecuta `ssh` como proceso local. SSH transporta stdin/stdout
hacia `/usr/local/bin/marketplace-control-mcp` en EC2; el wrapper remoto carga
el entorno privado y arranca `node .../mcp-server/dist/index.js`. stdout queda
reservado para JSON-RPC MCP y los diagnósticos van a stderr.

Usa la plantilla sin secretos en
`deploy/mcp-client-config.example.json`. La guía paso a paso para Claude
Desktop y Claude Code está en [docs/claude-mcp.md](../docs/claude-mcp.md).

## Verificación

Desde esta carpeta:

```powershell
npm run build
npm run smoke
npm run check
```

El smoke test valida el handshake y las herramientas existentes sin conectarse
a una base real. El dry-run de `import_curated_providers` tampoco requiere
`DATABASE_URL`; la escritura confirmada sí requiere la base desplegada y el
esquema `marketplace` existente.
