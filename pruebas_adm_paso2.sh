#!/usr/bin/env bash
# =============================================================================
# pruebas_adm_paso2.sh — Pruebas del paso 2 (contrato y datos de facturación)
# contra el backend corriendo en QA.
#
# QUÉ HACE: lanza peticiones con curl y compara el código HTTP que devuelve el
# backend con el esperado. Imprime PASA / FALLA por cada una.
#
# ADVERTENCIA: estas pruebas ESCRIBEN datos reales en las tablas RETSC_ADM_* de QA
# (contratos, datos de facturación y filas de bitácora). No hacen rollback.
# Úsalas SOLO contra QA y con una empresa de prueba.
#
# REQUISITOS: curl. El backend debe estar corriendo apuntando a la base de QA.
#
# USO (variables de entorno, sin guardarlas en ningún archivo):
#   BASE=http://localhost:3000 \
#   DTC_TOKEN='<token de un usuario ADMIN_DTC>' \
#   CLIENT_TOKEN='<token de un ADMIN o GERENCIA de la empresa de prueba>' \
#   ENT_ID=<Enterprise_id de la empresa de prueba> \
#   OTHER_ENT_ID=<Enterprise_id de OTRA empresa> \
#   ./pruebas_adm_paso2.sh
#
# IMPORTANTE: CLIENT_TOKEN debe pertenecer a un usuario de la empresa ENT_ID.
# Los tokens se obtienen haciendo login (POST /api/auth/login) en QA.
# =============================================================================

# Falla si falta alguna variable obligatoria (la sintaxis ${VAR:?msg} aborta con el mensaje)
: "${BASE:?Falta BASE (ej. http://localhost:3000)}"
: "${DTC_TOKEN:?Falta DTC_TOKEN}"
: "${CLIENT_TOKEN:?Falta CLIENT_TOKEN}"
: "${ENT_ID:?Falta ENT_ID}"
: "${OTHER_ENT_ID:?Falta OTHER_ENT_ID}"

PASAN=0
FALLAN=0
TMP="$(mktemp)"          # archivo temporal donde se guarda el cuerpo de cada respuesta
trap 'rm -f "$TMP"' EXIT # lo borra al terminar, pase lo que pase

# probar <nombre> <código(s) esperado(s), ej. 200 o 200|201> <método> <ruta> <token o "-"> [cuerpo JSON]
probar() {
  local nombre="$1" esperado="$2" metodo="$3" ruta="$4" token="$5" cuerpo="${6:-}"
  # Argumentos de curl: -s silencioso, -o guarda el cuerpo, -w imprime el código HTTP
  local args=(-s -o "$TMP" -w '%{http_code}' -X "$metodo" "$BASE$ruta")
  # Solo se manda el header de autorización si hay token ("-" significa "sin token")
  if [ "$token" != "-" ]; then args+=(-H "Authorization: Bearer $token"); fi
  # Solo se manda cuerpo si se indicó uno
  if [ -n "$cuerpo" ]; then args+=(-H 'Content-Type: application/json' -d "$cuerpo"); fi

  local codigo
  codigo="$(curl "${args[@]}")"

  # "esperado" puede traer varios códigos separados por | (ej. 200|201). Se rodea con | a ambos
  # lados para comparar códigos completos y no pedazos (así 20 no coincide con 200).
  if [[ "|$esperado|" == *"|$codigo|"* ]]; then
    echo "PASA   [$codigo] $nombre"; PASAN=$((PASAN + 1))
  else
    echo "FALLA  [$codigo, esperaba $esperado] $nombre"; FALLAN=$((FALLAN + 1))
  fi
  echo "       $(head -c 300 "$TMP")"   # primeros 300 caracteres de la respuesta
  echo
}

# Cuerpo de un contrato válido que se reutiliza en varias pruebas.
CONTRATO="{\"enterpriseId\":$ENT_ID,\"planCode\":\"PRUEBA-PASO2\",\"status\":\"ACTIVO\",\"startDate\":\"2026-12-01\",\"billingFrequency\":\"MENSUAL\",\"amountPerPeriod\":4500,\"currency\":\"USD\",\"paymentMethod\":\"OC_FACTURA\",\"creditDays\":30,\"requiresPo\":true}"
PERFIL='{"legalName":"EMPRESA DE PRUEBA S.A.","taxId":"3-101-000000","billingEmail":"prueba@ejemplo.com"}'

echo "=== Seguridad básica ==="
probar "Sin token -> 401"                                   401 GET  "/api/adm/contract" "-"
probar "DTC sin ?enterpriseId= -> 422"                      422 GET  "/api/adm/contract" "$DTC_TOKEN"

echo "=== CRITERIO DE ACEPTACIÓN: contrato activo único ==="
probar "DTC crea contrato ACTIVO (empresa de prueba) -> 201" 201 POST "/api/adm/contracts" "$DTC_TOKEN" "$CONTRATO"
probar "DTC crea SEGUNDO contrato ACTIVO -> rechazado 422"   422 POST "/api/adm/contracts" "$DTC_TOKEN" "$CONTRATO"

echo "=== Lectura ==="
probar "DTC ve el contrato activo -> 200"                   200 GET  "/api/adm/contract?enterpriseId=$ENT_ID" "$DTC_TOKEN"
probar "DTC lista contratos de la empresa -> 200"           200 GET  "/api/adm/contracts?enterpriseId=$ENT_ID" "$DTC_TOKEN"
probar "Cliente ve SU contrato -> 200"                      200 GET  "/api/adm/contract" "$CLIENT_TOKEN"
probar "Cliente pide OTRA empresa -> 404 (no 403)"          404 GET  "/api/adm/contract?enterpriseId=$OTHER_ENT_ID" "$CLIENT_TOKEN"

echo "=== El cliente NO puede escribir ==="
probar "Cliente intenta crear contrato -> 403"              403 POST "/api/adm/contracts" "$CLIENT_TOKEN" "$CONTRATO"
probar "Cliente intenta listar contratos -> 403"            403 GET  "/api/adm/contracts?enterpriseId=$ENT_ID" "$CLIENT_TOKEN"

echo "=== Validaciones (422 con campo y motivo) ==="
probar "Moneda inválida -> 422" 422 POST "/api/adm/contracts" "$DTC_TOKEN" \
  "{\"enterpriseId\":$ENT_ID,\"planCode\":\"X\",\"startDate\":\"2026-12-01\",\"billingFrequency\":\"MENSUAL\",\"amountPerPeriod\":1,\"currency\":\"EUR\",\"paymentMethod\":\"OC_FACTURA\",\"creditDays\":30,\"requiresPo\":true}"
probar "PASARELA con 30 días de crédito -> 422" 422 POST "/api/adm/contracts" "$DTC_TOKEN" \
  "{\"enterpriseId\":$ENT_ID,\"planCode\":\"X\",\"startDate\":\"2026-12-01\",\"billingFrequency\":\"MENSUAL\",\"amountPerPeriod\":1,\"currency\":\"USD\",\"paymentMethod\":\"PASARELA\",\"creditDays\":30,\"requiresPo\":false}"
probar "Fecha inexistente (31 de febrero) -> 422" 422 POST "/api/adm/contracts" "$DTC_TOKEN" \
  "{\"enterpriseId\":$ENT_ID,\"planCode\":\"X\",\"startDate\":\"2026-02-31\",\"billingFrequency\":\"MENSUAL\",\"amountPerPeriod\":1,\"currency\":\"USD\",\"paymentMethod\":\"OC_FACTURA\",\"creditDays\":30,\"requiresPo\":true}"

echo "=== Datos de facturación ==="
probar "DTC guarda datos de facturación -> 201 (alta) o 200"  "200|201" PUT  "/api/adm/billing-profile?enterpriseId=$ENT_ID" "$DTC_TOKEN" "$PERFIL"
probar "Cliente ve SUS datos de facturación -> 200"         200 GET  "/api/adm/billing-profile" "$CLIENT_TOKEN"
probar "Cliente intenta editar los datos -> 403"            403 PUT  "/api/adm/billing-profile?enterpriseId=$ENT_ID" "$CLIENT_TOKEN" "$PERFIL"
probar "Correo de facturación inválido -> 422"              422 PUT  "/api/adm/billing-profile?enterpriseId=$ENT_ID" "$DTC_TOKEN" \
  '{"legalName":"X","taxId":"1","billingEmail":"no-es-un-correo"}'

echo "============================================================"
echo "Resumen: $PASAN pasan, $FALLAN fallan"
echo "============================================================"
[ "$FALLAN" -eq 0 ]   # el script termina con éxito solo si no hubo fallos
