-- Ciclo 5 · A4 — Fecha del último error de entrenamiento/publicación.
--
-- El plan proponía columnas nuevas (last_error NVARCHAR(MAX) + last_error_at). Ya existe
-- last_training_error VARCHAR(500) (migración 009), cableada en todo el flujo (rechazo de
-- trainProject, Failed de Custom Vision, timeout, publicación fallida, recuperación tras
-- reinicio) y se limpia al publicar con éxito. Propuesta: REUTILIZARLA y agregar solo la fecha.
--
-- El código ya escribe esta columna en modo best-effort: funciona igual si esta migración no se
-- corrió (solo falta la fecha). ⚠ Correr con el OK de María. Desde SSMS. Idempotente.

-- 0) Verificar que la 006 (métricas) y la 009 (last_training_error) estén aplicadas
SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_NAME = 'RETSC_AI_DETECTION_MODELS'
  AND COLUMN_NAME IN ('precision_score', 'recall_score', 'mean_ap', 'metrics_json',
                      'last_training_error', 'last_training_error_at', 'model_version', 'last_publish_name')
ORDER BY COLUMN_NAME;
-- Esperado: las 8 columnas. Si faltan las 4 de métricas → correr migrations/006 (sin su línea
-- USE). Si falta last_training_error → correr migrations/009 (sin su línea USE).
GO

-- 1) Agregar la fecha del error (UTC)
IF COL_LENGTH('dbo.RETSC_AI_DETECTION_MODELS', 'last_training_error_at') IS NULL
  ALTER TABLE dbo.RETSC_AI_DETECTION_MODELS ADD last_training_error_at DATETIME2 NULL;
GO

-- 2) Validar
SELECT detection_model_id, category_id, status, last_training_error, last_training_error_at
FROM dbo.RETSC_AI_DETECTION_MODELS
ORDER BY category_id;
GO
