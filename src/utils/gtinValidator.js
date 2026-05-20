function detectGTINType(code) {
  if (code.length === 8)  return 'EAN8';
  if (code.length === 12) return 'UPC12';
  if (code.length === 13) return 'EAN13';
  return null;
}

function validateGTIN(code) {
  const str = String(code ?? '').trim();

  if (!str || !/^\d+$/.test(str)) {
    return { valid: false, type: null, reason: 'Código no numérico' };
  }

  const type = detectGTINType(str);
  if (!type) {
    return { valid: false, type: null, reason: 'Longitud inválida' };
  }

  const digits = str.split('').map(Number);
  const checkDigit = digits[digits.length - 1];
  const data = digits.slice(0, -1);

  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    const posFromRight = data.length - i; // 1-indexed from right
    sum += data[i] * (posFromRight % 2 === 1 ? 3 : 1);
  }

  const expected = (10 - (sum % 10)) % 10;
  if (checkDigit !== expected) {
    return { valid: false, type, reason: 'Dígito verificador inválido' };
  }

  return { valid: true, type };
}

module.exports = { validateGTIN, detectGTINType };

// ── auto-test ─────────────────────────────────────────────────────────────────
if (require.main === module) {
  const cases = [
    { code: '7501031311309', expectValid: true,  expectType: 'EAN13' },
    { code: '7501031311300', expectValid: false, expectType: 'EAN13' },
    { code: '036000291452',  expectValid: true,  expectType: 'UPC12' },
    { code: '96385074',      expectValid: true,  expectType: 'EAN8'  },
    { code: 'abc123',        expectValid: false, expectType: null    },
    { code: '123',           expectValid: false, expectType: null    },
  ];

  let passed = 0;
  for (const { code, expectValid, expectType } of cases) {
    const result = validateGTIN(code);
    const ok = result.valid === expectValid && result.type === expectType;
    console.log(`${ok ? '✓' : '✗'} ${code} → valid=${result.valid}, type=${result.type}${result.reason ? ', reason=' + result.reason : ''}`);
    if (ok) passed++;
  }
  console.log(`\n${passed}/${cases.length} tests pasaron`);
}
