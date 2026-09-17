# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Astro SSR + TypeScript + PostgreSQL remoto. SMTP/SES solo en servidor. Desplegar destino aún no decidido.

## Users

Operador interno de marketplace, no técnico. Revisa proveedores candidatos, prepara contactos y consulta respuestas de proveedores.

## Product Purpose

Panel operativo para llevar proveedores desde extracción inicial hasta contacto, clic en correo, formulario recibido y revisión interna. Éxito: cada proveedor tiene estado, evidencia y siguiente acción visibles sin usar SQL.

## Positioning

Conserva trazabilidad entre dato público extraído, contacto enviado y respuesta del proveedor; el flujo no confunde interés medido con proveedor aprobado.

## Operating Context

Los candidatos llegan desde el prompt de curaduría v2.8 en lotes por ciudad y categoría. El operador revisa, selecciona contactos, envía campañas mediante SES y consulta formularios recibidos.

## Capabilities and Constraints

- MVP: dashboard, lista y detalle de proveedores, estados, campañas, clics y formularios.
- Debe aceptar importación futura de TSV/JSON del extractor.
- PostgreSQL corre en EC2 existente; el navegador nunca conecta directamente a la base.
- SMTP/SES, DATABASE_URL y claves permanecen en variables de entorno privadas.
- Tracking usa tokens opacos; no incluye correo ni teléfono en URLs.
- Consentimiento, bajas, rebotes y quejas deben quedar registrados.
- La app no aprueba automáticamente un proveedor por hacer clic o enviar formulario.
- Autenticación administrativa y despliegue quedan abiertos para siguiente fase.

## Evidence on Hand

- Prompt vigente: `C:\Users\davidt\Downloads\prompt-curaduria\PEGAR-EN-PROJECT.txt`.
- Infraestructura y handoff: `C:\Users\davidt\Downloads\CONTINUIDAD.md`.
- PostgreSQL 16.15 en base `marketplace` de EC2.

## Product Principles

1. Evidencia antes que volumen.
2. Estado visible y acción siguiente clara.
3. Interés no equivale a aprobación.
4. Datos sensibles solo en servidor.
5. Operable por una persona no técnica.

## Accessibility & Inclusion

Contraste AA, navegación por teclado, foco visible, tablas con alternativa móvil, etiquetas explícitas y mensajes de error accionables.
