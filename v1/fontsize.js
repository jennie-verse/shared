/* ==========================================================================
   shared/v1/fontsize.js
   글자 크기 6단계 조절 공통 코드 (ES module)
   WebApp_House_Style.md 3장 기준: 6 / 8 / 10 / 12 / 14 / 17px, 기본은 4단계(12px)

   ⚠️ v1/ 은 한 번 올린 뒤 절대 수정하지 않습니다. README.md 를 확인하세요.

   이 모듈은 값만 계산하고 저장합니다. 실제로 글자 크기를 반영하려면
   앱의 CSS에서 아래처럼 CSS 변수를 사용하세요:

     body { font-size: var(--app-font-size, 12px); }

   입력창은 표준 문서에 따라 이 변수를 쓰지 않고 16px 고정을 유지해야 합니다.
   ========================================================================== */

export const FONT_SIZE_STEPS = [6, 8, 10, 12, 14, 17];
export const DEFAULT_STEP_INDEX = 3; // 12px

function storageKey(namespace) {
  return `${namespace}.fontStep`;
}

function clampStep(index) {
  return Math.min(FONT_SIZE_STEPS.length - 1, Math.max(0, Math.trunc(index)));
}

function applyStep(index, cssVar) {
  document.documentElement.style.setProperty(cssVar, `${FONT_SIZE_STEPS[index]}px`);
}

/** 현재 저장된 단계 인덱스(0~5)를 반환합니다. 저장된 값이 없으면 기본값. */
export function getFontStep(namespace) {
  const raw = localStorage.getItem(storageKey(namespace));
  if (raw === null) return DEFAULT_STEP_INDEX;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? clampStep(n) : DEFAULT_STEP_INDEX;
}

/** 단계를 지정하고 저장 + 화면에 반영합니다. */
export function setFontStep(namespace, index, { cssVar = '--app-font-size' } = {}) {
  const step = clampStep(index);
  localStorage.setItem(storageKey(namespace), String(step));
  applyStep(step, cssVar);
  return step;
}

/** 앱 시작 시 1회 호출: 저장된 단계를 읽어 CSS 변수에 반영합니다. */
export function initFontSize(namespace, { cssVar = '--app-font-size' } = {}) {
  const step = getFontStep(namespace);
  applyStep(step, cssVar);
  return step;
}

export function increaseFontSize(namespace, opts) {
  return setFontStep(namespace, getFontStep(namespace) + 1, opts);
}

export function decreaseFontSize(namespace, opts) {
  return setFontStep(namespace, getFontStep(namespace) - 1, opts);
}

/** 기본값(4단계, 12px)으로 되돌립니다. */
export function resetFontSize(namespace, opts) {
  return setFontStep(namespace, DEFAULT_STEP_INDEX, opts);
}

/** 주어진 단계 인덱스의 실제 px 값을 반환합니다. */
export function getFontSizePx(index) {
  return FONT_SIZE_STEPS[clampStep(index)];
}
