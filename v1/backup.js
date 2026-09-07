/* ==========================================================================
   shared/v1/backup.js
   JSON 백업 내보내기 / 가져오기 공통 코드 (ES module)

   ⚠️ v1/ 은 한 번 올린 뒤 절대 수정하지 않습니다. README.md 를 확인하세요.

   classic <script> 에서 쓰려면 sync-global.js 처럼 로더를 추가하거나,
   <script type="module"> 로 개별적으로 import 하세요.
   ========================================================================== */

function slugify(str) {
  return String(str)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'app';
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * 표준 백업 파일 이름을 만듭니다: app-name-backup-2026-08-01.json
 * @param {string} appName
 * @param {Date} [date]
 */
export function buildBackupFilename(appName, date = new Date()) {
  const y = date.getFullYear();
  const m = pad2(date.getMonth() + 1);
  const d = pad2(date.getDate());
  return `${slugify(appName)}-backup-${y}-${m}-${d}.json`;
}

/**
 * 데이터 객체를 JSON 파일로 다운로드합니다 (Share Sheet/Files 앱으로 저장 가능).
 * @param {string} filename
 * @param {object} dataObj
 */
export function downloadJSON(filename, dataObj) {
  const json = JSON.stringify(dataObj, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Safari가 다운로드를 시작할 시간을 준 뒤 해제합니다.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * File 객체를 JSON으로 파싱합니다. 형식이 잘못되면 에러를 던집니다.
 * @param {File} file
 * @returns {Promise<object>}
 */
export async function readJSONFile(file) {
  if (!file) throw new Error('파일이 없습니다.');
  const text = await file.text();
  try {
    return JSON.parse(text);
  } catch (cause) {
    const err = new Error('JSON 형식이 아닙니다. 올바른 백업 파일인지 확인하세요.');
    err.cause = cause;
    throw err;
  }
}

/**
 * 가져온 데이터가 최소한의 형태를 갖췄는지 확인합니다.
 * @param {object} obj
 * @param {string[]} requiredKeys - obj에 반드시 있어야 하는 최상위 키 목록
 * @returns {{valid:boolean, missing:string[]}}
 */
export function validateBackupShape(obj, requiredKeys = []) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { valid: false, missing: requiredKeys.slice() };
  }
  const missing = requiredKeys.filter((key) => !(key in obj));
  return { valid: missing.length === 0, missing };
}

/**
 * 숨겨진 <input type="file"> 를 만들어 클릭하고, 선택된 파일을 Promise로 돌려줍니다.
 * @param {string} [accept]
 * @returns {Promise<File|null>} 취소하면 null
 */
export function pickFile(accept = 'application/json,.json') {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.position = 'fixed';
    input.style.top = '-1000px';
    input.addEventListener(
      'change',
      () => {
        resolve(input.files && input.files[0] ? input.files[0] : null);
        input.remove();
      },
      { once: true }
    );
    // 일부 iOS Safari 버전은 change 없이 취소되면 이벤트가 없어 그대로 방치됩니다.
    // 사용하는 쪽에서 타임아웃을 둘 필요는 없고, DOM에서만 정리되도록 둡니다.
    document.body.appendChild(input);
    input.click();
  });
}
