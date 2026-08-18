# Interfaz Joel → Daniel — Flujo de fotos de visita (guía v1.9)

> Documento de traspaso. Generado 2026-08-09, **actualizado 2026-08-10** leyendo el código y la
> base de datos real (`sqldb-rscope-prod`) de `retsc-backend` (rama `developo-Joe`, commit
> `21220a3`). Cada contrato descrito abajo fue re-verificado contra el código o la BD real en
> esta actualización — donde algo no existe todavía, se marca explícitamente como
> **PENDIENTE/PROPUESTO**, nunca como si ya funcionara.
>
> **Qué cambió desde la versión del 2026-08-09** (leer si ya conocías la versión anterior de
> este documento): ya existe un modelo `PUBLISHED` real (sección 1 y 5) — pero con métricas de
> calidad prácticamente nulas (⚠ leer la advertencia de la sección 1 antes que nada); el
> diagnóstico anterior de "hacen falta 30+ fotos por tag" resultó estar mal — la causa real era
> un tag vacío en el proyecto de Custom Vision, ya corregido, y 15 fotos sí entrenan (sección 5,
> punto C3); y `image_hash`/`cv_image_id` dejaron de viajar concatenados en `photo_notes` — ahora
> son columnas propias (sección 6).

---

## 1. Resumen de un vistazo

Del flujo completo de la guía v1.9 (foto de visita → detectar cajitas → OCR → identificar
producto → guardar en dashboard), Joel entrega **dos piezas**, y **una de las dos todavía no
existe como código**:

```
 [Daniel] foto de visita
     │
     ▼
 ① Detección de cajitas (Paso 3)         ⚠ NO EXISTE TODAVÍA — ver sección 2
    "esta foto + category_id → ¿qué cajitas hay y dónde?"
     │
     ▼
 [Daniel] OCR de cada cajita recortada (Daniel ya lo hace con Azure Vision / lo que use mobile)
     │
     ▼
 ② buscarSkuPorTexto(textos[])            ✅ EXISTE — ver sección 3
    "estos textos OCR → ¿qué sku_id es cada uno?"
     │
     ▼
 [Daniel] guarda sku_id + score en el dashboard / KPI de la visita
```

| Pieza | Paso guía v1.9 | Estado | Cómo se llama |
|---|---|---|---|
| **① Detección de cajitas** | Paso 3 | ❌ **No existe** | Propuesto abajo — no hay ruta, no hay función |
| **② `buscarSkuPorTexto`** | Paso 5 / sección 7.2 | ✅ Existe y probado | Función interna (`require`), **no** HTTP |

**Lo más importante que Daniel necesita saber ahora mismo (actualizado 2026-08-10)**: ya hay **1
modelo `PUBLISHED`/`is_active=1`** en producción (`category_id=2`, canal OMT, `model_version=2`).
Pero: ⚠ **sus métricas reales son `precision=0`, `recall=0`, `mAP≈23.7%`** (verificado en vivo
contra `sqldb-rscope-prod`, 2026-08-10) — se entrenó con solo 15 fotos, el mínimo técnico, no un
volumen real. **Si Daniel llega a construir/probar el Paso 3 contra este modelo y ve que "casi
no detecta cajitas" o detecta con confianza muy baja, es el comportamiento esperado del modelo
actual, no un bug de su integración.** No tratar este modelo como un detector confiable todavía
— sirve para validar que el pipeline de punta a punta funciona, no la calidad de detección. Ver
sección 5 para el detalle completo y sección 2 para cómo esto cambia (parcialmente) el estado
del Paso 3.

---

## 2. Pieza 1 — Detección de cajitas (Paso 3) — ❌ PENDIENTE DE CONSTRUIR

**No existe ningún endpoint ni función en este repo que reciba una imagen y devuelva cajitas
detectadas.** Re-verificado exhaustivamente el 2026-08-10, sin cambios respecto al 2026-08-09:

- `src/services/customVisionService.js` (el único módulo que habla con Custom Vision) solo
  expone funciones de **entrenamiento** (`createProject`, `createImageFromData`,
  `createImageRegions`, `trainProject`, `publishIteration`, etc. — API `customvision/v3.3/training`).
  No hay ninguna función que llame a la **API de predicción** (`customvision/v3.0/Prediction/...`).
- `CUSTOM_VISION_PREDICTION_KEY` existe en `.env.example`, pero **ningún archivo de `src/` lo
  lee** — sigue reservado, sin código detrás. `CUSTOM_VISION_PREDICTION_RESOURCE_ID` sí se lee
  hoy (`aiInfrastructureService.js`), pero solo para **publicar** iteraciones de entrenamiento
  (`prediction_resource_id` en `RETSC_AI_DETECTION_MODELS`), no para llamar a la API de
  predicción — sigue sin existir ese consumo.
- No hay ninguna ruta en `src/routes/` con forma de "detectar"/"predecir"/"inferir".

**Lo que sí cambió desde el 2026-08-09**: antes no tenía sentido construir esto porque no había
ningún modelo publicado contra el cual probarlo end-to-end. Hoy **sí hay un modelo publicado**
(`category_id=2`, ver sección 5) — el bloqueante de "no hay nada real contra qué probar" ya no
aplica. Lo que persiste como advertencia real es la calidad: ese modelo tiene métricas de
`precision=0`/`recall=0` (sección 1), así que aunque el endpoint se construya y funcione
perfecto, las detecciones que devuelva hoy no van a ser útiles todavía — eso es una limitación
de datos de entrenamiento, no del contrato propuesto abajo.

### Contrato PROPUESTO (no implementado — para discutir antes de construir)

Basado en cómo ya funciona el resto del pipeline de este repo (multipart para imágenes, JSON
para todo lo demás) y en la forma real que devuelve la API de Predicción de Custom Vision:

```
POST /api/detections/predict          (propuesto — no existe)
Auth: Bearer (mismo esquema que el resto de la API)
Content-Type: multipart/form-data

campos del form:
  image        (file, jpg/png)
  categoryId   (int) — igual que dtcCategoryId en /api/shelf-photos/upload
```

Respuesta propuesta (200):

```json
{
  "success": true,
  "categoryId": 2,
  "modelVersion": 1,
  "detections": [
    {
      "tagName": "OMT",
      "probability": 0.87,
      "boundingBox": { "left": 0.12, "top": 0.34, "width": 0.20, "height": 0.15 }
    }
  ]
}
```

- `boundingBox` normalizado `[0,1]` (mismo formato que ya usa `RETSC_AI_TRAINING_ANNOTATIONS.bbox_*`
  en este repo — ver sección 6), **no píxeles**. Es el formato nativo que devuelve la API de
  Predicción de Custom Vision, así que no habría que transformar nada del lado de Joel.
- Caso "no hay modelo publicado para esa categoría" (sigue siendo el caso real para cualquier
  categoría que no sea `category_id=2` — ver sección 5) → propuesto `409` con
  `{ success:false, code:'NO_PUBLISHED_MODEL', categoryId }`, para que Daniel lo distinga de un
  error real y pueda mostrar "detección no disponible aún" sin romper el flujo de la visita.
- Quién resuelve qué modelo/iteración llamar: el backend, vía la consulta de la sección 5 —
  Daniel nunca ve `customvision_project_id` ni ninguna credencial de Custom Vision.

**Antes de construir esto**, confirmar con el equipo: (a) si Daniel necesita esto ya — ahora sí
se puede probar end-to-end contra `category_id=2` (aunque con detecciones de mala calidad, ver
sección 1), lo que antes no era posible; (b) si conviene esperar a que el modelo mejore antes de
integrarlo en un flujo real de visita, para no acostumbrar al equipo de campo a resultados que
todavía no son representativos; y (c) si el contrato propuesto de arriba es el que realmente
necesita el flujo mobile (tamaño máximo de imagen, si Daniel prefiere mandar la imagen ya como
blob URL en vez de multipart, etc.).

---

## 3. Pieza 2 — `buscarSkuPorTexto` (Paso 5) — ✅ EXISTE

**Ubicación**: [`src/services/skuSearchService.js`](../src/services/skuSearchService.js)

**Es una función interna de Node, NO un endpoint HTTP.** Confirmado en el propio archivo
(comentario final, línea 144): "Daniel/mobile todavía no llama directo al backend para este
paso — la guía lo describe como función interna que el propio backend invocará al procesar una
foto de visita". Si el backend de mobile de Daniel corre en un proceso Node separado que puede
importar este repo, se llama directo. **Si Daniel necesita esto por HTTP** (proceso separado,
sin acceso al código de este repo), hace falta agregar una ruta delgada que solo valide el body
y delegue a esta función — no existe todavía, hay que pedirlo explícitamente.

### Cómo llamarla (función directa)

```js
const { buscarSkuPorTexto } = require('./src/services/skuSearchService');

const resultados = await buscarSkuPorTexto([
  'NIVEA MEN INVISIBLE FOR BLACK & WHITE 48H',
  'COCA COLA 600ML',
]);
```

### Firma exacta

```
buscarSkuPorTexto(textos: string[]) → Promise<{
  texto_original: string,
  sku_id: number | null,
  similarity_score: number | null,
  matched: boolean
}[]>
```

- **Acepta un arreglo — llamar UNA VEZ con todas las cajitas de la visita**, no una vez por
  cajita. El arreglo de salida siempre tiene la misma longitud que el de entrada, en el mismo
  orden (índice `i` de salida corresponde al texto `i` de entrada).
- Si `textos` es `[]` o no es un arreglo, devuelve `[]` inmediatamente (no lanza).

### Ejemplo real de request/response

Request (el "request" es simplemente el argumento de la función):

```json
["NIVEA MEN INVISIBLE FOR BLACK & WHITE 48h", "TEXTO OCR QUE NO MATCHEA NADA"]
```

Response (ejemplo verificado en pruebas reales contra Azure AI Search, documentado en `CLAUDE.md`):

```json
[
  {
    "texto_original": "NIVEA MEN INVISIBLE FOR BLACK & WHITE 48h",
    "sku_id": 1,
    "similarity_score": 0.916,
    "matched": true
  },
  {
    "texto_original": "TEXTO OCR QUE NO MATCHEA NADA",
    "sku_id": null,
    "similarity_score": 0.41,
    "matched": false
  }
]
```

### Qué significa cada campo

| Campo | Significado |
|---|---|
| `texto_original` | El mismo string que se mandó, tal cual (útil para volver a mapear al índice del arreglo de entrada si Daniel reordena algo) |
| `sku_id` | El SKU identificado — **`null` si `matched=false`**, aunque haya habido algún resultado de búsqueda con score bajo |
| `similarity_score` | Score de similitud coseno del mejor resultado (`0`-`1`), o `null` si el índice no devolvió ningún resultado o si falló la resolución de ese texto puntual |
| `matched` | `true` solo si `similarity_score > umbral configurado` (ver abajo) |

### El umbral

- Vive en la tabla `RETSC_CONFIG`, fila `clave='SKU_MATCH_THRESHOLD'` (columna `valor`, tipo
  `data_type='float'`) — **hoy en producción vale `0.85`** (verificado contra la BD real,
  2026-08-09).
- Fallback en código si la fila no existe o no parsea: `0.85` (mismo valor, coincidencia
  intencional con lo que ya hay en prod).
- **Se puede ajustar sin deploy** — es una fila de BD, no una env var. Si Daniel ve muchos
  `matched:false` con scores que a simple vista parecen razonables (ej. 0.80-0.85), avisar al
  equipo — puede ser cuestión de ajustar esta fila, no un bug.

### ⚠ Limitación conocida — por qué los scores pueden salir más bajos de lo esperado

El índice `retsc-sku-vectors` se pobló embebiendo **texto enriquecido**
(`"EAN: ... | Producto: ... | Categoría: ... | <OCR>"`, generado por la Azure Function
`ProcessSkuImageQueue`, repo hermano). `buscarSkuPorTexto` solo tiene el **OCR crudo** de la
cajita de la visita (no hay EAN/Producto/Categoría todavía — es justo lo que se está buscando).
Se embebe el OCR tal cual, sin inventar placeholders para imitar el formato enriquecido.

**Consecuencia práctica para Daniel**: los scores de coseno pueden salir sistemáticamente más
bajos que comparando enriquecido-contra-enriquecido, aunque el ranking relativo (cuál SKU es
el más parecido) debería mantenerse razonablemente estable. Un match real confirmado en
pruebas dio **0.916** — como referencia de "esto sí es un match real, no un caso límite".
El umbral de 0.85 es la palanca para absorber esta asimetría; no es una corrección de código
pendiente, es una decisión de negocio que se ajusta con datos reales de uso.

### Manejo de errores

Cada texto se resuelve en su propia función aislada — **un fallo individual (Azure OpenAI o
Azure Search caídos para ese texto puntual) nunca rompe el resto del arreglo**: sale como
`matched:false, sku_id:null, similarity_score:null`, con el error logueado del lado del
backend. Daniel no necesita try/catch por elemento — la función completa solo lanza si
`AZURE_SEARCH_ENDPOINT`/`AZURE_SEARCH_KEY` no están configurados en absoluto (error de
configuración del servidor, no de datos).

---

## 4. Cómo encadenar las dos piezas en el flujo de Daniel

Pseudocódigo del flujo completo, con la Pieza ① marcada como pendiente:

```js
// 1. Detección de cajitas — PENDIENTE, ver sección 2
const detecciones = await detectarCajitas(fotoBuffer, categoryId); // endpoint propuesto

// 2. Por cada cajita detectada, Daniel recorta y hace OCR (esto ya lo hace Daniel,
//    fuera del alcance de este documento — mismo motor/versión que usa el pipeline de
//    entrenamiento, Azure AI Vision Image Analysis 4.0 features=read, para que los
//    textos sean comparables a los que se usaron para calibrar el umbral).
const textosOcr = await Promise.all(
  detecciones.map(d => hacerOcr(recortar(fotoBuffer, d.boundingBox)))
);

// 3. UNA SOLA llamada con el arreglo completo — no una por cajita
const resultados = await buscarSkuPorTexto(textosOcr);

// 4. Mapear cada resultado de vuelta a su cajita por índice (mismo orden, misma longitud)
const cajitasConSku = detecciones.map((d, i) => ({
  ...d,
  sku_id: resultados[i].sku_id,
  matched: resultados[i].matched,
  score: resultados[i].similarity_score,
}));

// 5. Guardar en el dashboard / KPI de la visita (fuera del alcance de este documento)
```

**Punto crítico a no perder**: el paso 3 es UNA llamada con `textosOcr` (arreglo), nunca un
loop llamando a `buscarSkuPorTexto` una vez por texto — la función ya resuelve internamente
con concurrencia acotada (8 en paralelo) y aislamiento de fallos por ítem; llamarla en loop
solo pierde ese paralelismo sin ganar nada.

---

## 5. Dependencias y estado actual — qué puede probar Daniel HOY

| Pieza | ¿Lista para integrar? | Detalle |
|---|---|---|
| `buscarSkuPorTexto` | ✅ **Sí, hoy mismo** | Función probada contra Azure OpenAI/Azure AI Search reales (2026-08-04). Si Daniel puede importar este repo, ya puede llamarla. Sin cambios desde el 2026-08-09. |
| Endpoint de detección (Paso 3) | ❌ **No existe** | Ver sección 2 — el código no cambió, pero ya hay un modelo real contra el cual construirlo y probarlo (fila siguiente). |
| Modelos `PUBLISHED` en prod | ✅ **1 modelo** (antes 0) | Verificado en vivo contra `sqldb-rscope-prod` el 2026-08-10: `RETSC_AI_DETECTION_MODELS` tiene **1 sola fila**, `category_id=2`, `status='PUBLISHED'`, `is_active=1`, `model_version=2`, `last_publish_name='Iteration2'`. ⚠ Pero `precision_score=0`, `recall_score=0`, `mean_ap=0.2373` — ver la advertencia de la sección 1, es la misma fila. Ninguna otra categoría tiene modelo `TRAINED` ni `PUBLISHED` todavía. |
| Publicación automática (spec v1.4) | ✅ Código funcionando end-to-end | El mecanismo que entrena y publica automáticamente ya corrió una vez de punta a punta para `category_id=2` (con 15 fotos `APROBADA`/`SYNCED` reales en canal OMT, confirmado por consulta directa a la BD). El diagnóstico anterior de que "15 no alcanzan, Microsoft pide 30+" **era incorrecto** — la causa real del primer rechazo de Custom Vision era un tag vacío/residual dentro del proyecto CV de esa categoría (`imageCount=1` en un tag `DTT` que en realidad era la misma imagen de otro tag, residuo de pruebas), no un problema de volumen. Una vez limpiado ese tag, 15 fotos sí entrenaron y publicaron sin pedir más volumen. Ver `CLAUDE.md`, sección "de `TRAINED` a `PUBLISHED` (2026-08-10)" para el detalle completo, incluidos dos gaps de reconciliación manual que aparecieron en el camino (no bloquean a Daniel, son operativos). |

**Conclusión honesta (actualizada 2026-08-10)**: Daniel puede seguir integrando y probando
`buscarSkuPorTexto` de forma aislada, sin cambios respecto al 2026-08-09. Sobre el Paso 3: ya
**no** es cierto que "aunque el endpoint existiera, no habría modelo contra el cual probar" —
ese bloqueante se resolvió, hay un modelo publicado real. Lo que sigue bloqueado es (a) el
endpoint en sí, que no existe, y lo que es nuevo como advertencia es (b) que el único modelo
disponible hoy tiene métricas de calidad prácticamente nulas — así que "ya se puede probar
end-to-end" no es lo mismo que "ya se puede confiar en el resultado". Si se construye el
endpoint ahora, tratarlo como una prueba de plomería (¿la llamada llega, la respuesta tiene el
formato correcto?), no como una validación de que la detección funciona bien.

---

## 6. Datos de referencia

### Tablas/columnas relevantes

**`RETSC_AI_DETECTION_MODELS`** (un modelo de detección por categoría DTC):

| Columna | Tipo | Nota |
|---|---|---|
| `detection_model_id` | INT PK | |
| `category_id` | INT | FK lógica a `RETSC_OP_CATEGORIES` |
| `customvision_project_id` | VARCHAR(100) | Proyecto de Custom Vision — Daniel nunca necesita este valor directamente |
| `status` | VARCHAR(20) | Ciclo real: `PENDING → PROJECT_CREATED → IMAGES_UPLOADED → TRAINING → TRAINED\|TRAINING_FAILED → PUBLISHED` |
| `is_active` | BIT | Junto con `status='PUBLISHED'`, define "el modelo vigente de esta categoría" |
| `model_version` | INT | Se incrementa en cada publicación exitosa |
| `last_publish_name` | VARCHAR(100) | Nombre de la iteración publicada en Custom Vision |

Consulta que Daniel (o el endpoint propuesto de la sección 2) usaría para saber si hay modelo
publicado para una categoría:

```sql
SELECT * FROM RETSC_AI_DETECTION_MODELS
WHERE category_id = @categoryId AND status = 'PUBLISHED' AND is_active = 1
```

⚠ **Bug conocido sin resolver** (`docs/BUG-is_active-no-unico.md`): nada en la BD impide más
de una fila con `is_active=1` para la misma categoría. Si esa consulta llegara a devolver más
de una fila algún día, no hay garantía de cuál es "la correcta" — tomar la primera no es
seguro. **Esto ya deja de ser una advertencia teórica**: hoy hay 1 modelo publicado/activo real
(`category_id=2`, verificado — la consulta de arriba devuelve exactamente 1 fila para esa
categoría hoy), así que el bug estructural ya tiene un caso real donde importaría si alguna vez
se disparara. No se resolvió en esta pasada — vale que Daniel lo tenga presente si construye
sobre esta consulta.

**`RETSC_CONFIG`** (config editable sin deploy): `clave` (varchar), `valor` (varchar — todo se
guarda como texto), `data_type`. La fila que le importa a Daniel: `SKU_MATCH_THRESHOLD`.

**`RETSC_AI_TRAINING_ANNOTATIONS`** (de referencia, para entender el formato de coordenadas
que ya usa este repo — no es una tabla que Daniel consulte directo): `bbox_left`, `bbox_top`,
`bbox_width`, `bbox_height`, todos `FLOAT` normalizados a `[0,1]` respecto al ancho/alto real
de la imagen. **Mismo formato que se propone para el `boundingBox` de la sección 2** — no hay
conversión a píxeles en ningún punto de este repo.

### Formato de coordenadas — resumen

Todo lo que este repo maneja como "cajita" (anotaciones de entrenamiento, y el contrato
propuesto de predicción) usa **coordenadas normalizadas `[0,1]`**, nunca píxeles:
`left`/`top` = esquina superior izquierda como fracción del ancho/alto de la imagen;
`width`/`height` = tamaño de la cajita como fracción del ancho/alto de la imagen.

---

## 7. Contacto / notas de traspaso

Joel se va del proyecto — esto es lo que Daniel necesita saber para no depender de preguntarle:

- **Toda la lógica de negocio y decisiones de arquitectura de este backend están documentadas
  en [`CLAUDE.md`](../CLAUDE.md)** (raíz del repo) — es el documento vivo que describe cada
  flujo, cada tabla, cada decisión no obvia, y la lista de TODOs pendientes con su contexto.
  Este documento (`INTERFAZ-para-Daniel.md`) es un recorte enfocado solo en lo que Daniel
  consume; `CLAUDE.md` tiene el resto (autenticación, roles, pipeline de SKUs, etc.).
- **`docs/DIAGNOSTICO-spec-v1.4-vs-codigo.md`** tiene el diagnóstico completo de qué le faltaba
  al flujo automático de entrenamiento/publicación antes de cablearse (2026-08-03). El modelo de
  `category_id=2` ya no está atascado (entrenó y publicó, ver secciones 1 y 5) — este documento
  sirve más como contexto histórico de por qué costó tanto llegar ahí, incluidos dos gaps de
  reconciliación manual documentados en `CLAUDE.md` (2026-08-10) que Daniel no necesita resolver,
  pero que explican por qué "el equipo subió las fotos" no siempre se traduce en "el modelo se
  publicó solo, sin intervención manual" todavía.
- **`docs/DB-SCHEMA.md`** (si existe en la rama que Daniel use) es un dump automático y
  actualizable (`node scripts/dump-schema.js`) de todo el schema real de la BD — más confiable
  que cualquier prosa si hay dudas sobre columnas/tipos.
- **Si se construye el endpoint de detección de la sección 2**: seguir el patrón de
  `src/routes/shelfPhotoRoutes.js` + `shelfPhotoController.js` para el manejo de multipart
  (`multer`), y `customVisionService.js` para el patrón de llamadas HTTP directas a Custom
  Vision vía `fetch` (sin SDK — ver el comentario de cabecera de ese archivo para el porqué).
- Cualquier pregunta sobre el estado de `RETSC_AI_DETECTION_MODELS`/`RETSC_CONFIG` en
  producción se puede volver a verificar en vivo con una consulta de solo lectura — no hace
  falta esperar a nadie, las credenciales de `.env` ya apuntan a `sqldb-rscope-prod`.

---

## Inconsistencias encontradas entre la guía v1.9 y el código real (para reconciliar antes de pasarle esto a Daniel)

1. **La guía asume que el Paso 3 (detección) es una pieza lista para consumir — sigue sin
   serlo.** No hay ni endpoint ni función (re-verificado 2026-08-10, sin cambios de código en
   esta parte). Lo que sí cambió es que ya no falta un modelo publicado para probarlo — hay que
   decidir con el equipo si conviene construirlo ya (con un modelo de calidad todavía baja, ver
   punto 2) o esperar a que haya más volumen real de fotos.
2. **La guía asume que con "15 fotos por canal" alcanza para tener un modelo entrenado — esto
   resultó ser cierto, pero no fue obvio en el camino.** Un diagnóstico anterior de este mismo
   proyecto (2026-08-08) concluyó erróneamente que Custom Vision necesitaba 30+ imágenes por
   tag; la causa real del rechazo era un tag vacío/residual en el proyecto de Custom Vision
   (no un problema de volumen) — una vez limpiado, `category_id=2` entrenó y publicó con
   exactamente 15 fotos reales del canal OMT (verificado en la BD, 2026-08-10: `mean_ap=0.237`).
   **Advertencia que sí sigue vigente**: "hay un modelo entrenado y publicado" no es lo mismo
   que "hay un modelo útil" — con solo 15 fotos, `precision` y `recall` salieron en `0` (ver
   secciones 1 y 5). Si el equipo sube más fotos y el modelo se re-entrena, esas métricas
   deberían mejorar; hoy no lo hacen.
3. **La sección 7.2 de la guía describe `buscarSkuPorTexto` como parte de un flujo con datos
   enriquecidos (EAN/Producto/Categoría ya conocidos)** — en la práctica, en el punto del flujo
   donde Daniel la llama, esos datos todavía no existen (es lo que se está buscando). Esto no
   es un defecto de implementación, es una asimetría inherente al orden del flujo — documentada
   en la sección 3 de este documento y en el propio código (`skuSearchService.js`, cabecera).
   Sin cambios desde el 2026-08-09.
