-- Agrega campos de métricas a RETSC_AI_DETECTION_MODELS.
-- Soporta el flujo automático de la spec v1.4 (fotos aprobadas → sync → umbral → training →
-- publicación): las métricas se guardan SOLO para monitoreo, nunca condicionan la publicación.
--
-- AJUSTADO 2026-08-03 (decisión de jefatura, ver docs/DIAGNOSTICO-spec-v1.4-vs-codigo.md):
-- la versión original de este script (Issue 8.5) también agregaba approved_by/approved_at
-- para un flujo de aprobación humana manual de versiones con métricas peores. Ese flujo fue
-- eliminado por completo del código (modelVersioningService.approveVersion/rejectVersion,
-- aiModelRepo.setApproval, endpoints POST /api/models/:modelId/approve|reject) — la spec v1.4
-- exige publicación 100% automática, sin gate de métricas ni aprobación humana. Se quitan esas
-- dos columnas de este script en consecuencia. Esta migración TODAVÍA NO se aplicó contra la
-- BD real (verificado con INFORMATION_SCHEMA, última vez 2026-07-25) — este ajuste solo
-- corrige el script antes de correrlo; aplicarlo se coordina aparte porque toca prod.
--
-- Columnas nuevas (todas NULL → no rompen filas/versiones existentes):
--   precision_score  — precision del modelo (0..1), solo monitoreo
--   recall_score     — recall del modelo (0..1), solo monitoreo
--   mean_ap          — mean Average Precision (mAP), solo monitoreo — NO es gate de publicación
--   metrics_json     — payload crudo de métricas de la iteración de Custom Vision (auditoría)
--
-- NOTA: se usan nombres *_score porque PRECISION es palabra reservada en T-SQL.
--
-- Correr desde SSMS (o cliente SQL) como operación manual — NO ejecutar desde Node.
-- Validar con:
--   SELECT detection_model_id, category_id, model_version, status, is_active,
--          precision_score, recall_score, mean_ap
--   FROM RETSC_AI_DETECTION_MODELS ORDER BY category_id, model_version;

USE [sqldb-rscope-prod];
GO

ALTER TABLE dbo.RETSC_AI_DETECTION_MODELS
  ADD precision_score FLOAT          NULL,
      recall_score    FLOAT          NULL,
      mean_ap         FLOAT          NULL,
      metrics_json    NVARCHAR(MAX)  NULL;
GO

-- Índice de apoyo para listar versiones de una categoría ordenadas por versión.
CREATE INDEX IX_RETSC_AI_DETECTION_MODELS_category_version
  ON dbo.RETSC_AI_DETECTION_MODELS (category_id, model_version DESC);
GO
