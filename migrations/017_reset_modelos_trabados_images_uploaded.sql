-- Ciclo 5 · A3 — Destrabar modelos que quedaron en IMAGES_UPLOADED.
--
-- Causa: hasta el ciclo 5, la Etapa 8 de shelfPhotoUploadService marcaba el modelo como
-- IMAGES_UPLOADED al SUBIR una foto (al llegar a 15 aprobadas EN UN CANAL) sin disparar ningún
-- entrenamiento. Como la evaluación de entrenamiento salta los modelos en ese estado, quedaban
-- trabados para siempre. El código nuevo ya no lo hace, y evaluarEntrenamiento() nunca deja un
-- modelo ahí si algo falla; este script solo limpia lo que quedó de antes.
--
-- NOTA (Fase 4): al arrancar, el backend del ciclo 5 ya pasa estos modelos a TRAINING_FAILED
-- (recuperarEntrenamientosAlArrancar). Si el paso 1 devuelve 0 filas, este script no hace falta.
--
-- Correr DESPUÉS de desplegar el código del ciclo 5 y SIN entrenamientos en curso (un modelo
-- puede estar en IMAGES_UPLOADED legítimamente durante los ~2 s que tarda trainProject).
-- Correr desde SSMS paso a paso: primero el SELECT, revisar, después la transacción.

-- 1) Vista previa: qué modelos están trabados y a qué estado volverían
SELECT detection_model_id, category_id, status, customvision_project_id, trained_at,
       last_publish_name, last_training_error,
       CASE
         WHEN customvision_project_id IS NULL THEN 'PENDING'
         WHEN trained_at IS NULL              THEN 'PROJECT_CREATED'
         WHEN last_publish_name IS NULL       THEN 'TRAINED'
         ELSE 'PUBLISHED'
       END AS status_nuevo
FROM dbo.RETSC_AI_DETECTION_MODELS
WHERE status = 'IMAGES_UPLOADED';
GO

-- 2) Aplicar (revisar el SELECT de arriba antes; cambiar ROLLBACK por COMMIT para confirmar)
BEGIN TRANSACTION;

UPDATE dbo.RETSC_AI_DETECTION_MODELS
SET status = CASE
               WHEN customvision_project_id IS NULL THEN 'PENDING'
               WHEN trained_at IS NULL              THEN 'PROJECT_CREATED'
               WHEN last_publish_name IS NULL       THEN 'TRAINED'
               ELSE 'PUBLISHED'
             END
WHERE status = 'IMAGES_UPLOADED';

SELECT @@ROWCOUNT AS modelos_destrabados;

ROLLBACK TRANSACTION;   -- ← cambiar a COMMIT TRANSACTION cuando el resultado sea el esperado
GO

-- 3) Después del COMMIT: la próxima foto aprobada de cada categoría vuelve a evaluar el umbral.
