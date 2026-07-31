-- Crea RETSC_LOG_DASHBOARD_SNAPSHOTS: un snapshot diario de los números del
-- dashboard (Issue B7 follow-up — tendencias/históricos). Sin esta tabla no hay
-- con qué comparar para calcular "+12% vs. hace 30 días" — GET /api/dashboard
-- solo tenía el conteo en tiempo real, sin historial.
--
-- No hay cron/job en background en este repo — el llenado es responsabilidad de
-- la app (dashboardRepo.upsertSnapshotToday), que hace upsert de la fila de HOY
-- en cada request a GET /api/dashboard. El historial se va completando solo con
-- el uso normal del dashboard, sin scheduler nuevo.
--
-- scope_enterprise_id NULL representa el scope GLOBAL de ADMIN_DTC (no una empresa
-- sin asignar) — un valor numérico representa el scope de ADMIN/GERENCIA para esa
-- empresa puntual.
--
-- avg_model_precision_pct queda NULL en la práctica hasta que se aplique la
-- migración 006 (precision_score en RETSC_AI_DETECTION_MODELS) — ver ese archivo
-- y el comentario en dashboardRepo.js. No es un error, es el estado esperado.
--
-- El UNIQUE index es un índice NORMAL (no filtrado), a propósito: en SQL Server dos
-- NULL SÍ cuentan como iguales dentro de un índice único (confirmado empíricamente
-- en el fix del Issue B4, ver CLAUDE.md) — acá eso es exactamente lo que se quiere:
-- como mucho UN snapshot global (scope_enterprise_id NULL) por día, igual que como
-- mucho un snapshot por (día, empresa) para el resto de los casos.
--
-- Correr desde SSMS (o cliente SQL) como operación manual — NO ejecutar desde Node,
-- mismo criterio que las migraciones 005/006/007 de este mismo repo. Mientras esta
-- tabla no exista, dashboardRepo.upsertSnapshotToday()/getSnapshotSeries()/
-- getReferenceSnapshot() atrapan el error "Invalid object name" y el endpoint sigue
-- respondiendo con trends.*.deltaPct=null y series=[valorDeHoy] — no rompe nada.
--
-- Validar con:
--   SELECT TOP 20 * FROM RETSC_LOG_DASHBOARD_SNAPSHOTS ORDER BY snapshot_date DESC;

USE [sqldb-rscope-prod];
GO

CREATE TABLE dbo.RETSC_LOG_DASHBOARD_SNAPSHOTS (
  snapshot_id              INT IDENTITY(1,1) PRIMARY KEY,
  snapshot_date            DATE          NOT NULL,
  scope_enterprise_id      INT           NULL,
  product_cards            INT           NOT NULL,
  product_photos           INT           NOT NULL,
  active_assortments       INT           NOT NULL,
  analyses_done            INT           NOT NULL,
  avg_model_precision_pct  DECIMAL(5,2)  NULL,
  created_at               DATETIME      NOT NULL DEFAULT GETDATE(),
  updated_at               DATETIME      NOT NULL DEFAULT GETDATE()
);
GO

CREATE UNIQUE INDEX UX_DASHBOARD_SNAPSHOTS_DATE_SCOPE
  ON dbo.RETSC_LOG_DASHBOARD_SNAPSHOTS (snapshot_date, scope_enterprise_id);
GO
