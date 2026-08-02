/* ==========================================================================
   shared/v1/sync-global.js
   sync.js(ES module)를 classic <script> 환경에서 쓰기 위한 얇은 로더.

   ⚠️ v1/ 은 한 번 올린 뒤 절대 수정하지 않습니다. README.md 를 확인하세요.

   이 파일 자체는 classic script 입니다 (import/export 없음).
   <script type="module"> 없이 그냥 아래처럼 넣으면 됩니다:

     <script src="../shared/v1/sync-global.js"></script>
     <script src="./app.js"></script>

   app.js 를 module로 바꾸지 않아도 window.SharedSync 로 sync.js 의
   모든 함수를 그대로 쓸 수 있습니다. 내부적으로 첫 호출 시점에
   동적 import()로 sync.js 모듈을 한 번만 불러와 캐시합니다.
   ========================================================================== */

(function (global) {
  'use strict';

  // classic script라 import.meta 를 쓸 수 없어 document.currentScript 로
  // 이 파일 자신의 위치를 알아내 sync.js 의 상대 경로를 계산합니다.
  const SELF_URL = (document.currentScript && document.currentScript.src) || document.baseURI;
  const MODULE_URL = new URL('./sync.js', SELF_URL).href;
  let modPromise = null;

  function loadModule() {
    if (!modPromise) modPromise = import(MODULE_URL);
    return modPromise;
  }

  const FN_NAMES = [
    'readFile',
    'writeFile',
    'deleteFile',
    'listDir',
    'utf8ToBase64',
    'base64ToUtf8',
    'outboxEnqueue',
    'outboxEnqueueReplace',
    'outboxList',
    'outboxRemove',
    'outboxFlush',
    'outboxWatch',
    'getContextId',
    'getContextLabel',
    'ensureContextId',
    'setContextLabel',
    'contextFilePath',
  ];

  const SharedSync = {};

  FN_NAMES.forEach((name) => {
    SharedSync[name] = async function (...args) {
      const mod = await loadModule();
      return mod[name](...args);
    };
  });

  // outboxWatch 는 등록 해제 함수를 동기적으로 돌려주는 API라
  // Promise 로 감싸면 쓰기 불편합니다. 별도로 Promise<unsubscribe> 형태로 제공합니다.
  SharedSync.outboxWatch = async function (namespace, resolveConfig, callbacks) {
    const mod = await loadModule();
    return mod.outboxWatch(namespace, resolveConfig, callbacks);
  };

  // SyncError.type 비교가 필요한 코드를 위해 클래스도 노출합니다.
  SharedSync.getSyncErrorClass = async function () {
    const mod = await loadModule();
    return mod.SyncError;
  };

  SharedSync.ready = loadModule();

  global.SharedSync = SharedSync;
})(window);
