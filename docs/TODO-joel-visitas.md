# Pendientes de Joel — flujo "Fotos de Visita" v1.9

Origen: guía `RetailScope_FotosVisita_Guia_Daniel_v1.9.docx` (María Royo, Directora de
Retail Scope, julio 2026), sección 9 ("Lo que Joel te debe entregar — no son preguntas, son
entregables"). Este documento registra el estado de esos entregables desde el lado del
backend (este repo) después de implementar los Pasos 0-4 y 6 de la guía.

## Entregables pendientes de Joel

1. **Endpoint/función para mandar la foto a Custom Vision y recibir las cajitas detectadas**
   (regiones + confidence), sin que Daniel maneje credenciales de Custom Vision.
   - Contrato esperado en este repo: `src/services/visionDetectionService.js`, función
     `detectRegions(buffer, categoryId)`. Hoy es un stub — configurar `DETECTION_ENDPOINT_URL`
     (y `DETECTION_ENDPOINT_KEY` si aplica) en `.env` cuando Joel confirme la URL real.
   - Formato de respuesta esperado (ya simplificado, según la guía §5.2):
     `{ predictions: [{ probability, tagName, boundingBox: { left, top, width, height } }] }`.
     Si el formato real difiere, ajustar el mapeo en `detectRegions()` — no hace falta tocar
     nada más del pipeline.

2. **La función `buscarSkuPorTexto` ya construida, y dónde vive en el repo.**
   - Contrato exacto (guía §7.2): `buscarSkuPorTexto(textos: string[]) → resultados[]`, cada
     resultado `{ texto_original, sku_id, similarity_score, matched }`.
   - Placeholder hoy: `src/services/skuIdentificationService.js` — devuelve `matched:false`
     para todo, sin llamar a ningún servicio externo. Cuando Joel confirme la ubicación real,
     reemplazar la implementación de ese archivo (o redirigir el `require()` en
     `productIdentificationService.js` si Joel la pone en otra ruta del repo).
   - Debe vivir en un módulo propio, separado del flujo de carga del catálogo, y aceptar
     arreglos completos de texto (no una llamada por cajita) — ver guía §7.2.

3. **Confirmación de que acepta arreglos de textos (no uno por uno).**
   - Ya asumido en `productIdentificationService.identifyDetections()` — junta el OCR de
     TODAS las cajitas de una foto y hace una sola llamada a `buscarSkuPorTexto()`.

4. **Confirmación de los modelos `PUBLISHED` que ya existen en `RETSC_AI_DETECTION_MODELS`.**
   - Ver discrepancia de nombres abajo — mientras no se reconcilie, `aiModelRepo.findPublishedByCategoryId()` acepta tanto `'PUBLISHED'` como `'READY'`.

## Discrepancias encontradas al implementar (no resueltas unilateralmente)

- **`status='PUBLISHED'` vs `'READY'`**: la guía usa `'PUBLISHED'` textualmente (§5.1). El
  ciclo de vida real de `RETSC_AI_DETECTION_MODELS` (documentado en `CLAUDE.md`, Issue 8.4)
  nunca usó ese literal — el estado "activo/publicado" se llama `'READY'`. Confirmar con el
  equipo cuál nombre es el correcto de aquí en adelante.

- **`RETSC_OP_RETAILER` — existencia sin confirmar**: la guía da por hecho que ya existe con
  una columna `Canal` (§2.2, §3.2). El `CLAUDE.md` de este repo (auditoría 2026-07-25) dice
  lo contrario: no hay tabla de retailers, `Retailer_id` es una columna suelta. No se creó
  esa tabla en la migración 008 — `src/repositories/retailerRepo.js` la consulta de forma
  defensiva (si no existe, devuelve `canal: null` en vez de romper el flujo). Confirmar con
  María/equipo si la tabla existe de verdad en la base real.

## Ya implementado del lado de Daniel (este repo)

- Paso 0 — abrir/cerrar visita: `POST /api/visits`, `PATCH /api/visits/:id/close`.
- Pasos 1-2 — guardar foto de visita: `POST /api/shelf-photos/visit`.
- Paso 3 — resolver modelo publicado por categoría: `aiModelRepo.findPublishedByCategoryId()`.
- Paso 4 — guardar detecciones: `RETSC_EX_SHELFPHOTO_DETECTION` (migración 008).
- Paso 5 — recorte + OCR + llamada a `buscarSkuPorTexto` (placeholder) + UPDATE de
  identificación: `productIdentificationService.js`.
- Paso 6 — resultados para el mobile: `GET /api/sessions/:id/results`.
- Sección 8.4 — no identificados para el dashboard web: `GET /api/shelf-photos/unidentified`.
