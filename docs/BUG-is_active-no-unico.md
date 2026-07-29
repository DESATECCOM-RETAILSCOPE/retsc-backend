# Bug: `is_active` no es único por categoría en `RETSC_AI_DETECTION_MODELS`

**Encontrado en**: Issue 8.2 (sincronización de anotaciones a Custom Vision), 2026-07-12.
**Estado**: sin corregir — requiere decisión de equipo porque la solución toca estructura de BD.

## El problema

`aiModelRepo.findByCategoryId(categoryId)` resuelve el modelo activo de una categoría así:

```sql
SELECT * FROM RETSC_AI_DETECTION_MODELS
WHERE category_id = @categoryId AND is_active = 1
```

Nada en la base de datos impide que haya **más de una fila con `is_active = 1` para la misma
`category_id`**. No hay constraint, índice único filtrado, ni validación a nivel de aplicación
que lo prevenga. Si eso llega a pasar, la query de arriba devuelve más de una fila y el código
se queda con `recordset[0]` — es decir, con la que el motor de SQL decida devolver primero, no
necesariamente la fila "correcta".

Esto afecta a **todo el código que depende de `findByCategoryId`**, incluyendo:

- `annotationSyncService.js` (Issue 8.2) — `syncApprovedPhoto`, `removeRejectedPhoto` y
  `checkAndUpdateThreshold` resuelven el `projectId` y el `detection_model_id` a actualizar
  a través de esta función.
- `modelVersioningService.js` (Issue 8.5) — el ciclo de vida de reentrenamiento también
  depende de que exista una única fila activa por categoría (`setActiveVersion` desactiva
  "las demás" antes de activar la nueva, lo cual asume que solo hay una).
- `shelfPhotoUploadService.js` (Issue 7.2) — resuelve `projectId`/`tagId` de la misma forma
  en la Etapa 6.

## Cómo se descubrió

Al correr pruebas aisladas del Issue 8.2 contra una categoría real de producción
(`category_id=36`), insertar una segunda fila `is_active=1` para probar el umbral hizo que
`checkAndUpdateThreshold` actualizara el modelo real preexistente (`detection_model_id=19`)
en vez del modelo de prueba — porque ambas filas competían por el mismo `SELECT ... WHERE
is_active=1`. Se revirtió el cambio accidental sobre la fila real; ver commit de este mismo
issue.

## Por qué no se corrige acá

`modelVersioningService.setActiveVersion(categoryId, detectionModelId)` hace dos UPDATEs
secuenciales (desactivar todas → activar una) sin transacción explícita — es la única fuente
"legítima" de múltiples activaciones simultáneas hoy, y ya tiene una nota reconociendo el
riesgo de concurrencia. Corregir la causa raíz implica:

1. Decidir si la garantía se impone a nivel de BD (índice único filtrado
   `CREATE UNIQUE INDEX ... ON RETSC_AI_DETECTION_MODELS (category_id) WHERE is_active = 1`)
   o a nivel de aplicación (transacción explícita en cada UPDATE de `is_active`).
2. Si se elige el índice único, decidir qué hacer con las filas que YA violan la regla hoy
   (hay que auditar la tabla completa antes de poder crear el índice).
3. Envolver `setActiveVersion` en una transacción `pool.transaction()` de cualquier forma,
   independientemente del índice, para que el desactivar+activar sea atómico.

Ninguno de esos tres puntos es responsabilidad del Issue 8.2 — se deja documentado para que
el equipo decida cuándo abordarlo.

## Mitigación aplicada mientras tanto

Ninguna en el código de producción. `annotationSyncService.js` tiene un comentario en su
header señalando este riesgo explícitamente para que quien lo lea no asuma que
`findByCategoryId` es seguro.
