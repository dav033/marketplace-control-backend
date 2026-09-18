# Marketplace Control
# proovedores

Panel interno para revisar proveedores candidatos, campañas de contacto y formularios recibidos.

## Arranque local

```bash
npm install
copy .env.example .env
npm run dev
```

Sin `DATABASE_URL`, la interfaz usa datos de demostración y sigue permitiendo revisar el flujo visual.

En esta sesión el panel está corriendo en `http://127.0.0.1:4321/` conectado al PostgreSQL remoto. La contraseña del usuario técnico no se guardó en el proyecto; para reiniciar el panel hay que inyectar `DATABASE_URL` desde un gestor de secretos o una variable de entorno segura.

## PostgreSQL

`sql/schema.sql` crea el esquema `marketplace` de forma idempotente. El esquema ya fue aplicado en la instancia EC2 de marketplace y sus tablas fueron verificadas.

Para conectar la aplicación, define `DATABASE_URL` con la credencial guardada en el servidor. No la subas al repositorio ni la uses con prefijo `PUBLIC_`.

## Datos cargados

Primer lote importado desde `C:\Users\davidt\Downloads\omnisend-playground\leads_barranquilla.csv`: 25 proveedores de Barranquilla, 25 fuentes y 9 contactos. Los contactos quedaron con `consent_status = unknown`; no son elegibles para campañas hasta obtener consentimiento.

## AWS actual

- SES sigue en sandbox.
- Se creó la identidad de dominio `sempertex.com`; verificación DKIM pendiente.
- No existe zona Route 53 para el dominio. Publicar los 3 CNAME de SES en el proveedor DNS real.
- La primera solicitud de producción quedó `DENIED` (caso AWS `178967643700934`); reintentar después de verificar DKIM y revisar el motivo en SES.

## Flujos MVP

- `/proveedores`: candidatos, búsqueda, estados e importación estricta del TSV de 18 columnas de curaduría.
- `/proveedores/:id`: evidencia y siguiente acción.
- `/t/:token`: registra clic con token opaco y envía al formulario.
- `/registro/:token`: formulario público con consentimiento separado.
- `/formularios`: bandeja de respuestas para revisión humana.
- `/campanas`: composición y envío SES con confirmación explícita; solo se muestran contactos con consentimiento de marketing concedido y sin supresión.
- Gemini: el panel permite escoger ciudad y categoría, genera una vista previa de curaduría, separa empresas para correo corporativo de empresas para WhatsApp, valida el TSV localmente y solo importa proveedores como `candidate` después de una confirmación explícita.

La primera versión no convierte un correo público en permiso de marketing: los contactos descubiertos por curaduría quedan en `unknown`. Solo el formulario público con la casilla de marketing marcada los vuelve elegibles para una campaña.

## Seguridad pendiente antes de producción

- Configurar `ADMIN_ACCESS_KEY` y terminar autenticación por roles/sesiones.
- Cambiar el fallback `sslip.io` por `marketplace.sempertex.com` cuando el DNS real apunte a una Elastic IP estable.
- Conectar SES solo desde el servidor; nunca desde el navegador.
- Configurar rebotes, quejas, bajas y lista de supresión.
- Eliminar la regla antigua del Security Group cuando ya no sea necesaria; durante esta sesión se añadió `204.199.82.34/32` a 22 y 5432 para acceso temporal.
