# PROMPT CLAUDE CODE — BACKEND (retsc-backend)

> **RESUELTO** (2026-07-17). Implementado en su totalidad — ver commit
> `fix(sku-upload): ...` en `developo-Joe`. Probado end-to-end contra
> `sqldb-rscope-prod` con datos reales (carga → recarga con datos distintos →
> confirma resync de brand/categoría → limpieza de datos de prueba). Se deja
> este documento como registro de diagnóstico y decisiones tomadas.

> Rama: `developo-Joe`. Trabajar y commitear directamente sobre esta rama.
> Contexto: fix de seguimiento a los issues B1/B5 de QA (ver commits `197401b`,
> `d2f0fc8`) — ya se corrigió que los productos no aparecieran; este prompt
> corrige que aparezcan con datos incompletos/incorrectos.

## CONTEXTO

Al cargar `test-data/desodorantes.xlsx` (headers: `EAN, DESCRIPTION, CATEGORY,
SUBCATEGORY, MANUFACTURER, BRAND, VOLUME, RELEVANT, CHECKLIST`), en la pantalla
de Productos del frontend se ve:

1. **Columna "Marca" siempre vacía**, aunque el Excel tiene `BRAND` poblado en
   todas las filas (NIVEA, REXONA, DOVE, etc.).
2. **Columna "Categoría" inconsistente** — el mismo archivo, donde `CATEGORY`
   dice "DESODORANTES CORPORALES" en todas las filas, muestra algunos productos
   como "SHAMPOO" en la UI.

## DIAGNÓSTICO (ya confirmado — no re-investigar desde cero)

Archivo: `src/services/skuService.js`, función `processSkuExcel`.

- `parseSkuExcel` (línea ~132) ya extrae `row.brand`, `row.manufacturer`,
  `row.category`, `row.subcategory` correctamente desde el Excel — el parseo
  no tiene bug.
- En el loop principal (línea ~192), **esos cuatro campos se leen y se
  descartan**. Solo `row.gtin`/`row.description` se usan. `insertSku`/
  `updateSku` (contra `RETSC_OP_SKUS`) no reciben brand/category del Excel —
  usan `entCat.selected_category_id`/`entCat.resolved_category_id`, que vienen
  del `enterpriseCategoryId` elegido UNA VEZ en el formulario de carga, igual
  para todas las filas del batch.
- `skuRepo.insertEnterpriseSku` (línea ~92 de `skuRepo.js`) solo inserta
  `enterprise_id, sku_id, status, created_at` — nunca escribe a las columnas
  `Brand`, `Supplier`, `client_category`, `client_subcategory`, `volume`,
  `Relevant_feature` que YA EXISTEN en `RETSC_OP_ENTERPRISE_PRODUCT_SEG`
  (verificado con INFORMATION_SCHEMA — no hace falta migración, las columnas
  ya están ahí y encajan 1:1 con las columnas del Excel).
- Cuando un SKU ya existe (`isNew = false`, línea ~234), solo se actualiza
  `Product_dsc` si cambió — la categoría nunca se re-sincroniza en cargas
  posteriores, por lo que un SKU cargado una vez con la categoría equivocada
  queda "pegado" así para siempre.

## DECISIÓN DE DISEÑO YA TOMADA (no volver a preguntar)

La "Categoría" que se muestra en `GET /api/products` debe pasar a ser
`client_category` (el texto del Excel, por-SKU-por-empresa) en vez de
`categoryName` (la categoría única del árbol `RETSC_OP_CATEGORIES` elegida
una vez por batch). Son conceptos distintos y ambos son válidos:
- `selected_category_id`/`detection_category_id` (en `RETSC_OP_SKUS`) siguen
  existiendo — son la clasificación oficial de la plataforma (usada para IA/DTC).
- `client_category`/`client_subcategory` (en `RETSC_OP_ENTERPRISE_PRODUCT_SEG`)
  son la clasificación propia del cliente, tal como viene en su Excel, y es lo
  que el listado de productos debe mostrar como "Categoría" porque es lo que
  el cliente espera ver reflejado.

## TAREA

### 1. `src/utils/skuFilenameParser` no aplica — es en `skuService.js`

Agregar `volume` y `relevant` a `COLUMN_ALIASES` (línea ~22) con sus alias:
```js
volume:   ['volume', 'volumen'],
relevant: ['relevant', 'relevante', 'relevant_feature', 'checklist'],
```
Nota: `CHECKLIST` en el Excel es `Y`/`N` — decidir si mapea a `relevant`
(boolean-ish) o se ignora; dado que `Relevant_feature` en la tabla es
`varchar(100)`, guardar el valor crudo (`"Y"`/`"N"`) es aceptable, no hace
falta parsear a boolean.

Extraer estos dos campos en el `return rawRows.map(...)` de `parseSkuExcel`
(línea ~132), mismo patrón que `brand`/`manufacturer`.

### 2. `skuRepo.insertEnterpriseSku` — aceptar y escribir los campos nuevos

Extender la función (línea ~92) para aceptar `{ enterpriseId, skuId, brand,
supplier, clientCategory, clientSubcategory, volume, relevantFeature }` y
escribirlos en el INSERT contra `RETSC_OP_ENTERPRISE_PRODUCT_SEG` (columnas
reales: `Brand`, `Supplier`, `client_category`, `client_subcategory`,
`volume`, `Relevant_feature` — ver comentario de cabecera del archivo para
los tipos SQL exactos).

### 3. Nueva función `skuRepo.updateEnterpriseSku(segId, partial)`

Mismo patrón que `roleRepo.update`/`aiModelRepo.updateStatus` — UPDATE parcial
por `seg_id`, para poder resincronizar brand/categoría en cargas posteriores
del mismo SKU (hoy `processSkuExcel` NUNCA actualiza esta tabla una vez creada
la fila — solo hace find-then-insert, nunca find-then-update).

### 4. `skuService.processSkuExcel` — usar los campos y resincronizar siempre

- Pasar `row.brand`, `row.manufacturer` (→ supplier), `row.category` (→
  clientCategory), `row.subcategory` (→ clientSubcategory), `row.volume`,
  `row.relevant` a `insertEnterpriseSku` cuando la fila enterprise-sku no
  existe (bloque de la línea ~252).
- Cuando SÍ existe (`existingEntSku` truthy), llamar a
  `skuRepo.updateEnterpriseSku(existingEntSku.seg_id, {...})` con los mismos
  campos — así una re-carga corrige datos viejos en vez de dejarlos pegados.
  Este es el fix concreto para "categoría Shampoo en productos que son
  desodorantes": la próxima carga del mismo Excel con `client_category`
  correcto va a corregir la fila existente.

### 5. `productRepo.js` / `productService.js` — exponer y priorizar `client_category`

- En el SELECT de `listByEnterprise` (línea ~64) y `listCategoriesWithProducts`
  (línea ~91), traer `seg.client_category`, `seg.client_subcategory`,
  `seg.Supplier`, `seg.volume`, `seg.Relevant_feature` además de lo que ya se
  trae.
- En `toProductDTO` (`productService.js`), agregar `clientCategory`,
  `clientSubcategory`, `supplier`, `volume`, `relevantFeature`. Cambiar
  `categoryName` para que sea `row.client_category ?? row.commercial_category_dsc`
  — prioriza el dato del cliente, cae al de la plataforma si no hay.
- `listCategoriesWithProducts` (usado por el dropdown de filtro) debe agrupar
  por `client_category` en vez de `Category_dsc` de `RETSC_OP_CATEGORIES`, ya
  que ahora la fuente de verdad de "categoría visible" cambió.

### 6. Backfill de datos existentes cargados antes de este fix (opcional, avisar antes de correr)

Los SKUs ya cargados con este bug (los del Excel de la captura) van a tener
`client_category`/`Brand` en NULL hasta que se vuelvan a cargar. Ofrecer
volver a subir el mismo Excel una vez desplegado el fix como forma de
backfill (el UPDATE de arriba lo corrige), en vez de escribir un script de
backfill aparte — es la misma acción que ya haría el usuario para probarlo.

## VERIFICACIÓN

1. `npm run dev`, subir el Excel de la captura (o uno de prueba con las mismas
   columnas) dos veces: la primera para simular "ya existe con datos viejos",
   la segunda para confirmar que el UPDATE corrige `client_category`/`Brand`.
2. `GET /api/products` — confirmar que TODOS los productos del archivo
   muestran `clientCategory: "DESODORANTES CORPORALES"` y el `brand` correcto
   por fila (NIVEA, REXONA, DOVE — no todos iguales).
3. Confirmar que `GET /api/products/categories` devuelve categorías reales
   del cliente, no solo las del árbol `RETSC_OP_CATEGORIES`.
4. No romper el flujo de IA/DTC — `selected_category_id`/`detection_category_id`
   en `RETSC_OP_SKUS` NO se tocan en este prompt, siguen viniendo de
   `entCat.selected_category_id`/`resolved_category_id` como hoy.

## REGLAS

- No tocar nada de `RETSC_AI_*`, `annotationService`, `modelTrainingService`,
  `pipelineOrchestrator` (dominio de Joel).
- Commit separado de este fix, formato `fix(sku-upload): ...`.
- Correr el server y probar el flujo real antes de dar por terminado — no
  alcanza con que compile.
