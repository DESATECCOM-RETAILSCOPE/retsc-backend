-- Agrega campos de métricas y aprobación a RETSC_AI_DETECTION_MODELS.
-- Soporta el Issue 8.5: versioning y re-entrenamiento de modelos.
--
-- Reglas que habilita:
--   - "Nueva versión con métricas peores requiere aprobación manual": se necesita
--     persistir las métricas de cada versión para poder comparar la nueva vs la activa.
--   - Auditoría de quién aprobó una versión peor.
--
-- Columnas nuevas (todas NULL → no rompen filas/versiones existentes):
--   precision_score  — precision del modelo (0..1)
--   recall_score     — recall del modelo (0..1)
--   mean_ap          — mean Average Precision (mAP); métrica primaria de comparación
--   metrics_json     — payload crudo de métricas de la iteración de Custom Vision (auditoría)
--   approved_by      — user_id que aprobó manualmente una versión con métricas peores
--   approved_at      — fecha de esa aprobación
--
-- NOTA: se usan nombres *_score porque PRECISION es palabra reservada en T-SQL.
-- NOTA: el ciclo de vida agrega valores de status nuevos ('AWAITING_APPROVAL', 'REJECTED')
--   sobre la columna status existente (varchar(20)); no requiere cambios de esquema.
--
-- Correr desde SSMS (o cliente SQL) como operación manual — NO ejecutar desde Node.
-- Validar con:
--   SELECT detection_model_id, category_id, model_version, status, is_active,
--          precision_score, recall_score, mean_ap, approved_by, approved_at
--   FROM RETSC_AI_DETECTION_MODELS ORDER BY category_id, model_version;

USE [sqldb-rscope-prod];
GO

ALTER TABLE dbo.RETSC_AI_DETECTION_MODELS
  ADD precision_score FLOAT          NULL,
      recall_score    FLOAT          NULL,
      mean_ap         FLOAT          NULL,
      metrics_json    NVARCHAR(MAX)  NULL,
      approved_by     INT            NULL,
      approved_at     DATETIME       NULL;
GO

-- Índice de apoyo para listar versiones de una categoría ordenadas por versión.
CREATE INDEX IX_RETSC_AI_DETECTION_MODELS_category_version
  ON dbo.RETSC_AI_DETECTION_MODELS (category_id, model_version DESC);
GO
