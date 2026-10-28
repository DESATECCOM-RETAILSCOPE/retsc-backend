-- Ciclo 5 · A3 — Umbrales del entrenamiento automático en RETSC_CONFIG.
--
-- Motivación: el umbral del PRIMER entrenamiento salía de la variable de entorno
-- SHELF_TRAINING_THRESHOLD y el de reentrenamiento de RETSC_CONFIG — configuración y código
-- desconectados (pendiente desde agosto). Ahora annotationSyncService.evaluarEntrenamiento()
-- lee AMBOS de RETSC_CONFIG (cache de 60 s; si la fila falta usa 15 / 5):
--
--   FIRST_TRAIN_MIN_PHOTOS = 15  → primer entrenamiento: fotos APROBADAS + SYNCED de la
--                                  categoría (todos los canales). 15 es también el mínimo
--                                  técnico de Custom Vision (15 imágenes por tag); el código
--                                  ignora valores menores a 15.
--   RETRAIN_BATCH_SIZE     = 5   → reentrenamiento: fotos aprobadas después de trained_at
--                                  (decisión del 11-ago).
--
-- Idempotente: se puede correr más de una vez. Correr desde SSMS sobre la base del ambiente
-- (seleccionar la base en el combo de SSMS antes de ejecutar). NO ejecutar desde Node.
--
-- ⚠ Antes de correr: verificar con la consulta de abajo si config_id es IDENTITY. Si NO lo es,
--   avisar — habría que pasar el config_id a mano en los INSERT.
--   SELECT COLUMNPROPERTY(OBJECT_ID('dbo.RETSC_CONFIG'), 'config_id', 'IsIdentity') AS es_identity;

-- 1) Estado actual (para la evidencia "antes")
SELECT config_id, clave, valor, data_type, description, updated_at
FROM dbo.RETSC_CONFIG
WHERE clave IN ('FIRST_TRAIN_MIN_PHOTOS', 'RETRAIN_BATCH_SIZE');
GO

-- 2) FIRST_TRAIN_MIN_PHOTOS (nueva)
IF NOT EXISTS (SELECT 1 FROM dbo.RETSC_CONFIG WHERE clave = 'FIRST_TRAIN_MIN_PHOTOS')
  INSERT INTO dbo.RETSC_CONFIG (clave, valor, data_type, description, updated_at)
  VALUES ('FIRST_TRAIN_MIN_PHOTOS', '15', 'int',
          'Fotos aprobadas+sincronizadas de una categoría (todos los canales) para el PRIMER entrenamiento automático. Mínimo técnico de Custom Vision: 15.',
          GETDATE());
GO

-- 3) RETRAIN_BATCH_SIZE (existente según el plan; se fija en 5 o se crea si falta)
IF EXISTS (SELECT 1 FROM dbo.RETSC_CONFIG WHERE clave = 'RETRAIN_BATCH_SIZE')
  UPDATE dbo.RETSC_CONFIG
  SET valor = '5', updated_at = GETDATE()
  WHERE clave = 'RETRAIN_BATCH_SIZE' AND valor <> '5';
ELSE
  INSERT INTO dbo.RETSC_CONFIG (clave, valor, data_type, description, updated_at)
  VALUES ('RETRAIN_BATCH_SIZE', '5', 'int',
          'Fotos nuevas aprobadas desde el último entrenamiento para reentrenar automáticamente.',
          GETDATE());
GO

-- 4) Validar (evidencia "después")
SELECT config_id, clave, valor, data_type, description, updated_at
FROM dbo.RETSC_CONFIG
WHERE clave IN ('FIRST_TRAIN_MIN_PHOTOS', 'RETRAIN_BATCH_SIZE');
GO
