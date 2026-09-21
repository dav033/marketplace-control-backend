-- Amplía el CHECK de providers.status para admitir 'unconfirmed': el proveedor que rellenó él mismo
-- el formulario de registro y espera aprobación de un operador. Ver seguimiento.md, sección 31.6.
ALTER TABLE marketplace.providers DROP CONSTRAINT IF EXISTS providers_status_check;
ALTER TABLE marketplace.providers
  ADD CONSTRAINT providers_status_check
  CHECK (status IN ('candidate','unconfirmed','under_review','approved','rejected','archived'));

GRANT SELECT, INSERT, UPDATE ON marketplace.providers TO marketplace_control;
GRANT SELECT, INSERT ON marketplace.audit_log TO marketplace_control;
