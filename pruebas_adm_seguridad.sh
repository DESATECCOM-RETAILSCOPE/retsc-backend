#!/usr/bin/env bash
# =============================================================================
# pruebas_adm_seguridad.sh — Pruebas de SEGURIDAD de /api/adm contra el backend en QA
# (sección 9 de la especificación: rol en el servidor, aislamiento por empresa, bitácora completa
# y datos personales).
#
# QUÉ HACE:
#   1. Matriz de acceso: sin token -> 401; CLIENT_TOKEN (y GERENCIA_TOKEN si se da) en cada ruta
#      solo DTC -> 403; rutas que ve el cliente con ?enterpriseId=OTHER_ENT_ID -> 404.
#   2. Bitácora real: hace UNA escritura de cada tipo y comprueba en GET /audit que cada una dejó
#      su fila (entidad, acción y usuario correctos). Luego provoca una escritura rechazada (422)
#      y comprueba que NO se agregó ninguna fila.
#   3. Datos personales: los datos de facturación guardados no aparecen en GET /audit (se ve "***").
#   4. Un cliente no puede registrar nada: 403 y la bitácora no cambia.
#
# ADVERTENCIA: estas pruebas ESCRIBEN datos reales en QA: SOBRESCRIBEN los datos de facturación de
# ENT_ID con valores PRUEBA-SEG-..., registran una factura y un pago (que luego se anula) y dejan
# filas de bitácora. No hacen rollback. Úsalas SOLO contra QA y con una empresa de prueba.
#
# REQUISITOS: curl y node (para leer JSON y decodificar el token; no se necesita jq). El backend
# debe estar corriendo apuntando a la base de QA.
#
# USO (variables de entorno, sin guardarlas en ningún archivo):
#   BASE=http://localhost:3000 \
#   DTC_TOKEN='<token de un usuario ADMIN_DTC>' \
#   CLIENT_TOKEN='<token de un ADMIN de la empresa de prueba>' \
#   GERENCIA_TOKEN='<opcional: token de un GERENCIA de la empresa de prueba>' \
#   ENT_ID=<Enterprise_id de la empresa de prueba> \
#   OTHER_ENT_ID=<Enterprise_id de OTRA empresa> \
#   CONTRACT_ID=<Contract_id del contrato de prueba> \
#   ./pruebas_adm_seguridad.sh
#
# IMPORTANTE:
#   - CLIENT_TOKEN y GERENCIA_TOKEN deben pertenecer a usuarios de la empresa ENT_ID.
#   - CONTRACT_ID debe ser un contrato ACTIVO de ENT_ID, en USD, OC_FACTURA, 30 días y SIN exigir
#     OC (el mismo de pruebas_adm_paso5.sh).
#   - Las comprobaciones de "la bitácora no cambió" asumen que NADIE más escribe en el módulo
#     mientras corre el script. Si otra persona trabaja en QA al mismo tiempo, pueden fallar sin
#     que haya un problema real.
# =============================================================================

# Falla si falta alguna variable obligatoria (la sintaxis ${VAR:?msg} aborta con el mensaje)
: "${BASE:?Falta BASE (ej. http://localhost:3000)}"
: "${DTC_TOKEN:?Falta DTC_TOKEN}"
: "${CLIENT_TOKEN:?Falta CLIENT_TOKEN}"
: "${ENT_ID:?Falta ENT_ID}"
: "${OTHER_ENT_ID:?Falta OTHER_ENT_ID}"
: "${CONTRACT_ID:?Falta CONTRACT_ID}"
GERENCIA_TOKEN="${GERENCIA_TOKEN:-}"   # opcional

PASAN=0
FALLAN=0
TMP="$(mktemp)"          # archivo temporal donde se guarda el cuerpo de cada respuesta
trap 'rm -f "$TMP"' EXIT # lo borra al terminar, pase lo que pase

# probar <nombre> <código(s) esperado(s), ej. 200 o 200|201> <método> <ruta> <token o "-"> [cuerpo JSON]
# (misma función que pruebas_adm_paso5.sh)
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

# campo <expresión> — lee un valor del JSON de la ÚLTIMA respuesta (guardada en $TMP).
# La expresión se aplica sobre el objeto "r". Si no se puede leer, imprime vacío.
campo() {
  node -pe "try { const r = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')); String(($1) ?? '') } catch { '' }" -- "$TMP"
}

# verificar <nombre> <esperado> <obtenido> — compara dos textos y cuenta PASA / FALLA.
verificar() {
  if [ "$2" == "$3" ]; then
    echo "PASA   $1 (= $3)"; PASAN=$((PASAN + 1))
  else
    echo "FALLA  $1 (esperaba '$2', se obtuvo '$3')"; FALLAN=$((FALLAN + 1))
  fi
  echo
}

# fecha <días> — "hoy" en hora de Costa Rica (UTC-6) más N días, AAAA-MM-DD.
fecha() {
  node -pe "new Date(Date.now() - 6 * 3600e3 + Number(process.argv[1]) * 864e5).toISOString().slice(0, 10)" -- "$1"
}

# max_audit — el mayor auditId actual de la bitácora (0 si está vacía). Se lee con el token DTC.
# Usa su propio archivo temporal para no pisar la última respuesta guardada en $TMP.
max_audit() {
  local tmp2; tmp2="$(mktemp)"
  curl -s -o "$tmp2" -H "Authorization: Bearer $DTC_TOKEN" "$BASE/api/adm/audit?limit=1"
  node -pe "try { const r = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')); String(r.entries?.[0]?.auditId ?? 0) } catch { 'ERROR' }" -- "$tmp2"
  rm -f "$tmp2"
}

# audit_tiene <entidad> <id> <acción> <desde_auditId> — "true" si GET /audit trae una fila de esa
# entidad e id, con esa acción, hecha por el usuario DTC y con auditId mayor que <desde_auditId>.
audit_tiene() {
  local tmp2; tmp2="$(mktemp)"
  curl -s -o "$tmp2" -H "Authorization: Bearer $DTC_TOKEN" "$BASE/api/adm/audit?entityType=$1&entityId=$2&limit=20"
  node -pe "try { const r = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
    String(r.entries.some((e) => e.entityType === '$1' && e.entityId === $2 && e.action === '$3'
      && e.userId === $DTC_USER_ID && e.auditId > $4)) } catch { 'false' }" -- "$tmp2"
  rm -f "$tmp2"
}

# Id del usuario DTC: se lee del propio token (la parte del medio de un JWT es JSON en base64url).
# Solo se decodifica, no se valida la firma (eso lo hace el backend).
DTC_USER_ID="$(node -pe "JSON.parse(Buffer.from(process.argv[1].split('.')[1], 'base64url').toString()).userId" -- "$DTC_TOKEN")"
SELLO="$(date +%Y%m%d%H%M%S)"
HOY="$(fecha 0)"

# Cuerpos mínimos válidos para las rutas con cuerpo (la respuesta esperada es 403 antes de validarlos).
CUERPO_CONTRATO="{\"enterpriseId\":$ENT_ID,\"planCode\":\"PRUEBA-SEG\",\"status\":\"BORRADOR\",\"startDate\":\"$HOY\",\"billingFrequency\":\"MENSUAL\",\"amountPerPeriod\":1,\"currency\":\"USD\",\"paymentMethod\":\"OC_FACTURA\",\"creditDays\":30,\"requiresPo\":false}"
CUERPO_PERFIL='{"legalName":"PRUEBA-SEG S.A.","taxId":"3-101-000000","billingEmail":"prueba-seg@ejemplo.com"}'
CUERPO_FACTURA() { printf '{"contractId":%s,"invoiceNumber":"%s","issueDate":"%s","subtotal":1000,"taxAmount":130,"totalAmount":1130,"currency":"USD"}' "$CONTRACT_ID" "$1" "$HOY"; }
CUERPO_PAGO() { printf '{"paymentDate":"%s","amount":%s,"currency":"USD","method":"TRANSFERENCIA","reference":"PRUEBA-SEG-%s"}' "$HOY" "$1" "$SELLO"; }
CUERPO_NOTA='{"note":"PRUEBA-SEG no debe guardarse"}'

# Rutas SOLO DTC: "MÉTODO|ruta|cuerpo". Mantener alineada con src/routes/admRoutes.js (la prueba
# node src/routes/__tests__/admSecurity.test.mjs sí recorre el router automáticamente).
# El id 1 en las rutas con :id da igual: el 403 llega antes de buscar el recurso.
RUTAS_DTC=(
  "GET|/api/adm/contracts?enterpriseId=$ENT_ID|"
  "POST|/api/adm/contracts|$CUERPO_CONTRATO"
  "PUT|/api/adm/contracts/$CONTRACT_ID|{\"planCode\":\"PRUEBA-SEG\"}"
  "PUT|/api/adm/billing-profile?enterpriseId=$ENT_ID|$CUERPO_PERFIL"
  "POST|/api/adm/invoices|$(CUERPO_FACTURA "PRUEBA-SEG-$SELLO-X")"
  "POST|/api/adm/invoices/1/status|{\"status\":\"ENVIADA\"}"
  "GET|/api/adm/invoices/1/payments|"
  "POST|/api/adm/invoices/1/payments|$(CUERPO_PAGO 1)"
  "POST|/api/adm/payments/1/void|{\"reason\":\"PRUEBA-SEG\"}"
  "GET|/api/adm/aging|"
  "GET|/api/adm/receivables|"
  "GET|/api/adm/invoices/1/notes|"
  "POST|/api/adm/invoices/1/notes|$CUERPO_NOTA"
  "GET|/api/adm/audit|"
)
# Rutas que ve el cliente (solo lectura de su propia empresa).
RUTAS_CLIENTE=("/api/adm/contract" "/api/adm/billing-profile" "/api/adm/invoices")

echo "=== 1. Matriz de acceso ==="
for ruta in "${RUTAS_CLIENTE[@]}"; do
  probar "Sin token: GET $ruta -> 401" 401 GET "$ruta" "-"
done
for entrada in "${RUTAS_DTC[@]}"; do
  IFS='|' read -r metodo ruta cuerpo <<< "$entrada"
  probar "Sin token: $metodo $ruta -> 401" 401 "$metodo" "$ruta" "-" "$cuerpo"
done

MAX_ANTES_MATRIZ="$(max_audit)"
for entrada in "${RUTAS_DTC[@]}"; do
  IFS='|' read -r metodo ruta cuerpo <<< "$entrada"
  probar "ADMIN cliente: $metodo $ruta -> 403" 403 "$metodo" "$ruta" "$CLIENT_TOKEN" "$cuerpo"
  if [ -n "$GERENCIA_TOKEN" ]; then
    probar "GERENCIA: $metodo $ruta -> 403" 403 "$metodo" "$ruta" "$GERENCIA_TOKEN" "$cuerpo"
  fi
done
verificar "La matriz de 403 no dejó filas en la bitácora" "$MAX_ANTES_MATRIZ" "$(max_audit)"

for ruta in "${RUTAS_CLIENTE[@]}"; do
  probar "ADMIN cliente pide OTRA empresa: GET $ruta -> 404 (no 403)" 404 GET "$ruta?enterpriseId=$OTHER_ENT_ID" "$CLIENT_TOKEN"
  if [ -n "$GERENCIA_TOKEN" ]; then
    probar "GERENCIA pide OTRA empresa: GET $ruta -> 404" 404 GET "$ruta?enterpriseId=$OTHER_ENT_ID" "$GERENCIA_TOKEN"
  fi
done

echo "=== 2. Bitácora real: cada escritura deja su fila ==="
MAX0="$(max_audit)"
echo "       auditId mayor al empezar: $MAX0"

# Datos de facturación con textos ÚNICOS, para buscarlos después en la bitácora.
RAZON_UNICA="PRUEBA-SEG-$SELLO S.A."
CORREO_UNICO="prueba-seg-$SELLO@ejemplo.com"
probar "DTC guarda datos de facturación de ENT_ID -> 200|201" "200|201" PUT "/api/adm/billing-profile?enterpriseId=$ENT_ID" "$DTC_TOKEN" \
  "{\"legalName\":\"$RAZON_UNICA\",\"taxId\":\"3-101-$SELLO\",\"billingEmail\":\"$CORREO_UNICO\"}"
verificar "Bitácora: BILLING_PROFILE CREATE o UPDATE de ENT_ID" "true" \
  "$( [ "$(audit_tiene BILLING_PROFILE "$ENT_ID" UPDATE "$MAX0")" == true ] || [ "$(audit_tiene BILLING_PROFILE "$ENT_ID" CREATE "$MAX0")" == true ] && echo true || echo false)"

probar "DTC registra una factura -> 201" 201 POST "/api/adm/invoices" "$DTC_TOKEN" "$(CUERPO_FACTURA "PRUEBA-SEG-$SELLO")"
FACTURA_ID="$(campo 'r.invoice.invoiceId')"
verificar "Bitácora: INVOICE CREATE de la factura" "true" "$(audit_tiene INVOICE "$FACTURA_ID" CREATE "$MAX0")"

probar "DTC registra un pago de 100 -> 201" 201 POST "/api/adm/invoices/$FACTURA_ID/payments" "$DTC_TOKEN" "$(CUERPO_PAGO 100)"
PAGO_ID="$(campo 'r.payment.paymentId')"
verificar "Bitácora: PAYMENT CREATE del pago" "true" "$(audit_tiene PAYMENT "$PAGO_ID" CREATE "$MAX0")"

probar "DTC anula ese pago -> 200" 200 POST "/api/adm/payments/$PAGO_ID/void" "$DTC_TOKEN" '{"reason":"PRUEBA-SEG anulación"}'
verificar "Bitácora: PAYMENT VOID del pago" "true" "$(audit_tiene PAYMENT "$PAGO_ID" VOID "$MAX0")"

probar "DTC cambia la factura a ENVIADA -> 200" 200 POST "/api/adm/invoices/$FACTURA_ID/status" "$DTC_TOKEN" '{"status":"ENVIADA"}'
verificar "Bitácora: INVOICE STATUS_CHANGE de la factura" "true" "$(audit_tiene INVOICE "$FACTURA_ID" STATUS_CHANGE "$MAX0")"

echo "=== Una escritura RECHAZADA no deja fila ==="
MAX1="$(max_audit)"
probar "Pago mayor al saldo (1130) -> 422" 422 POST "/api/adm/invoices/$FACTURA_ID/payments" "$DTC_TOKEN" "$(CUERPO_PAGO 999999)"
verificar "El mayor auditId no cambió tras el 422" "$MAX1" "$(max_audit)"

echo "=== 3. Datos personales en la bitácora ==="
probar "DTC lee la bitácora de BILLING_PROFILE -> 200" 200 GET "/api/adm/audit?entityType=BILLING_PROFILE&entityId=$ENT_ID&limit=5" "$DTC_TOKEN"
verificar "La razón social NO aparece en la bitácora" "0" "$(grep -c -F "$RAZON_UNICA" "$TMP")"
verificar "El correo de facturación NO aparece en la bitácora" "0" "$(grep -c -F "$CORREO_UNICO" "$TMP")"
verificar "La identificación fiscal NO aparece en la bitácora" "0" "$(grep -c -F "3-101-$SELLO" "$TMP")"
verificar "La bitácora muestra los datos enmascarados (***)" "true" "$(grep -q -F '"***"' "$TMP" && echo true || echo false)"

echo "=== 4. Un cliente no puede registrar nada ==="
MAX2="$(max_audit)"
probar "Cliente registra factura -> 403" 403 POST "/api/adm/invoices" "$CLIENT_TOKEN" "$(CUERPO_FACTURA "PRUEBA-SEG-$SELLO-C")"
probar "Cliente registra pago -> 403"    403 POST "/api/adm/invoices/$FACTURA_ID/payments" "$CLIENT_TOKEN" "$(CUERPO_PAGO 1)"
probar "Cliente registra nota -> 403"    403 POST "/api/adm/invoices/$FACTURA_ID/notes" "$CLIENT_TOKEN" "$CUERPO_NOTA"
verificar "Los intentos del cliente no dejaron filas en la bitácora" "$MAX2" "$(max_audit)"

echo "============================================================"
echo "Resumen: $PASAN pasan, $FALLAN fallan"
echo "============================================================"
[ "$FALLAN" -eq 0 ]   # el script termina con éxito solo si no hubo fallos
