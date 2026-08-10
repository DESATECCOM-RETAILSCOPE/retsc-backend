// Prueba EN VIVO (E2E) del flujo real de carga de fotos de góndola, de punta a punta:
// servidor levantado + BD real + Azure Blob Storage real. Reproduce específicamente el
// bug corregido el 2026-08-05 (la rama de "reutilización" de blob cuando el hash ya
// existía en otro canal) subiendo la MISMA imagen a dos canales distintos (OMT y DTT) y
// verificando que ambos blobs quedan realmente en el contenedor, cada uno bajo su propia
// carpeta de canal.
//
// Requisitos antes de correr: backend levantado (`npm run dev`) y `.env` apuntando a la
// BD y al Storage reales (BLOB_STORAGE_MODE=azure).
//
// Correr desde la raíz del repo:
//   node scripts/e2e-shelf-upload.mjs
//   BASE_URL=http://localhost:3000 node scripts/e2e-shelf-upload.mjs   (base distinta)
//
// NOTA: crea 2 filas reales (RETSC_AI_TRAINING_PHOTOS, canal OMT y DTT) y 2 blobs reales
// en Azure. No borra nada solo — imprime los photo_id/blob_path al final para borrarlos a
// mano si se quiere dejar el dataset limpio, así nunca toca producción sin que alguien lo
// decida explícitamente.

import { createRequire } from 'node:module';
import path from 'node:path';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
require('dotenv').config();
const jwt   = require('jsonwebtoken');
const sharp = require('sharp');
const fs    = require('fs').promises;
const { getPool } = require(path.join(process.cwd(), 'src', 'config', 'db'));
const { downloadFromContainer } = require(path.join(process.cwd(), 'src', 'services', 'blobStorageService'));
const trainingPhotoRepo = require(path.join(process.cwd(), 'src', 'repositories', 'trainingPhotoRepo'));

const BASE_URL  = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
const CONTAINER = process.env.AZURE_GLOBAL_SHELF_CONTAINER || 'global-shelf-training';
const IMG_PATH  = path.join(process.cwd(), 'test-data', 'quality-test', 'buena_1000x1000.png');

async function pickCategoryAndUser() {
  const pool = await getPool();
  const cat = (await pool.request().query(
    `SELECT TOP 1 Category_id, Category_dsc FROM RETSC_OP_CATEGORIES WHERE is_smart_dtc = 1 ORDER BY Category_id`
  )).recordset[0];
  assert.ok(cat, 'No hay ninguna categoría con is_smart_dtc=1 en la BD');

  const usr = (await pool.request().query(`
    SELECT TOP 1 ux.User_id, ux.Enterprise_id, r.Role_id, r.Role_name, u.Email, u.User_name
    FROM RETSC_OP_USRSXENTERP ux
    JOIN RETSC_OP_USERS u ON u.User_id = ux.User_id
    JOIN RETSC_OP_ROLES r ON r.Role_id = ux.Role_id
    WHERE ux.Status = 1
      AND (ux.Fecha_inactivacion IS NULL OR ux.Fecha_inactivacion > GETDATE())
      AND UPPER(LTRIM(RTRIM(r.Role_name))) IN ('ADMIN','ADMIN_DTC')
    ORDER BY ux.Fecha_activacion ASC
  `)).recordset[0];
  assert.ok(usr, 'No hay usuario ADMIN/ADMIN_DTC activo en la BD');
  return { cat, usr };
}

function mintToken(usr) {
  return jwt.sign(
    { userId: usr.User_id, email: usr.Email, username: usr.User_name,
      enterpriseId: usr.Enterprise_id, roleId: usr.Role_id, roleName: usr.Role_name },
    process.env.JWT_SECRET, { expiresIn: '30m' }
  );
}

async function uniqueJpeg() {
  const base   = await fs.readFile(IMG_PATH);
  const jitter = 1 + (Math.random() * 0.004 - 0.002); // ±0.2% brillo → hash único, calidad OK
  // buena_1000x1000.png (1000x1000) alcanza el mínimo de imageValidationService (800x800,
  // fotos de SKU) pero NO el del gate de fotos de góndola (QUALITY_MIN_WIDTH/HEIGHT,
  // default 1280x720) — sin este resize, el upload rebota con 422 LOW_RESOLUTION antes de
  // llegar a la Etapa 5 que este E2E prueba.
  return sharp(base)
    .resize(1280, 960, { fit: 'cover' })
    .modulate({ brightness: jitter })
    .jpeg({ quality: 92 })
    .toBuffer();
}

async function uploadOnce({ token, categoryId, canal, buffer }) {
  const form = new FormData();
  form.append('dtcCategoryId', String(categoryId));
  form.append('canal', canal);
  form.append('photo', new Blob([buffer], { type: 'image/jpeg' }), 'e2e.jpg');
  const res  = await fetch(`${BASE_URL}/api/shelf-photos/upload`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form,
  });
  const body = await res.json();
  return { status: res.status, body };
}

async function assertBlobExists(blobPath) {
  const buf = await downloadFromContainer({ containerName: CONTAINER, blobPath }); // tira si no existe
  assert.ok(buf && buf.length > 0, `El blob ${blobPath} existe pero vino vacío`);
}

(async () => {
  const created = [];
  try {
    const { cat, usr } = await pickCategoryAndUser();
    const token = mintToken(usr);
    console.log(`[e2e] categoría=${cat.Category_id} (${cat.Category_dsc}) · usuario=${usr.User_id} (${usr.Role_name}) · base=${BASE_URL} · container=${CONTAINER}`);

    // MISMA imagen para OMT y DTT (mismo hash) → prueba el caso cross-canal del bug.
    const buffer = await uniqueJpeg();

    // 1) OMT
    const omt = await uploadOnce({ token, categoryId: cat.Category_id, canal: 'OMT', buffer });
    assert.equal(omt.status, 201, `OMT esperaba 201, vino ${omt.status}: ${JSON.stringify(omt.body)}`);
    assert.equal(omt.body.blobMode, 'azure', `OMT blobMode debía ser 'azure', vino '${omt.body.blobMode}' (revisar Railway/env)`);
    assert.match(omt.body.blobPath, /\/omt\//, `OMT blob_path debe caer bajo /omt/, vino ${omt.body.blobPath}`);
    await assertBlobExists(omt.body.blobPath);
    const omtRow = await trainingPhotoRepo.findById(omt.body.photoId);
    assert.ok(omtRow && omtRow.canal === 'OMT' && /\/omt\//.test(omtRow.blob_path), 'La fila OMT en BD no coincide canal/carpeta');
    created.push({ canal: 'OMT', photoId: omt.body.photoId, blobPath: omt.body.blobPath });
    console.log(`[e2e] OK OMT → photo_id=${omt.body.photoId} · blob=${omt.body.blobPath} · blob existe en Azure ✔`);

    // 2) DTT con la MISMA imagen → antes: 0 upload + path /omt/ (bug). Ahora: sube su propio blob /dtt/.
    const dtt = await uploadOnce({ token, categoryId: cat.Category_id, canal: 'DTT', buffer });
    assert.equal(dtt.status, 201, `DTT esperaba 201, vino ${dtt.status}: ${JSON.stringify(dtt.body)}`);
    assert.match(dtt.body.blobPath, /\/dtt\//, `DTT blob_path debe caer bajo /dtt/, vino ${dtt.body.blobPath}`);
    await assertBlobExists(dtt.body.blobPath);
    const dttRow = await trainingPhotoRepo.findById(dtt.body.photoId);
    assert.ok(dttRow && dttRow.canal === 'DTT' && /\/dtt\//.test(dttRow.blob_path), 'La fila DTT en BD no coincide canal/carpeta (BUG cross-canal)');
    assert.notEqual(dtt.body.photoId, omt.body.photoId, 'OMT y DTT deben ser filas distintas');
    created.push({ canal: 'DTT', photoId: dtt.body.photoId, blobPath: dtt.body.blobPath });
    console.log(`[e2e] OK DTT → photo_id=${dtt.body.photoId} · blob=${dtt.body.blobPath} · blob existe en Azure ✔`);

    console.log('\n[e2e] ✅ TODO EN VERDE. Filas de prueba creadas (borralas cuando quieras):');
    console.table(created);
    process.exit(0);
  } catch (err) {
    console.error('\n[e2e] ❌ FALLÓ:', err.message);
    if (created.length) { console.error('[e2e] Filas de prueba ya creadas antes del fallo:'); console.table(created); }
    process.exit(1);
  }
})();
