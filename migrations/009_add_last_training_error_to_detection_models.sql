-- Agrega last_training_error a RETSC_AI_DETECTION_MODELS.
--
-- Motivación (2026-08-08, investigación del fallo silencioso del disparo automático de
-- training para category_id=2): checkAndUpdateThreshold() dispara
-- modelTrainingService.startTraining() de forma fire-and-forget — si Custom Vision rechaza
-- trainProject() (ej. BadRequestDetectionTrainingValidationFailed "Not enough images per tag
-- for training", confirmado contra CV real), el modelo queda colgado en IMAGES_UPLOADED con
-- trained_at=NULL para siempre, sin ningún rastro en BD del motivo — solo un console.error que
-- se pierde en los logs del proceso. Ver docs/DIAGNOSTICO-spec-v1.4-vs-codigo.md y el hilo de
-- diagnóstico de category_id=2 para el detalle completo.
--
-- Columna nueva (NULL → no rompe filas existentes):
--   last_training_error — mensaje crudo del último rechazo/fallo de Custom Vision al intentar
--     entrenar (trainProject) o publicar (publishIteration). Se limpia (se deja NULL) en el
--     próximo intento exitoso — no es un historial, es "el motivo del último fallo conocido".
--
-- Correr desde SSMS (o cliente SQL) como operación manual — NO ejecutar desde Node.
-- Validar con:
--   SELECT detection_model_id, category_id, status, trained_at, last_training_error
--   FROM RETSC_AI_DETECTION_MODELS ORDER BY category_id, model_version;

USE [sqldb-rscope-prod];
GO

ALTER TABLE dbo.RETSC_AI_DETECTION_MODELS
  ADD last_training_error VARCHAR(500) NULL;
GO
