# shared

개인용 웹앱들이 함께 쓰는 공용 코드 저장소입니다. GitHub Pages로 배포되어
`https://<account>.github.io/shared/v1/...` 주소로 각 앱이 직접 불러다 씁니다.
여기서 `<account>`는 이 저장소를 배포한 GitHub 계정 이름입니다.

---

## ⚠️ 가장 중요한 규칙

> **`v1/` 안의 파일은 한 번 올린 뒤 절대 수정하지 않습니다.**
> **고칠 일이 생기면 `v2/` 를 새로 만들고, 앱을 하나씩 옮깁니다.**
> **이걸 어기면 이 모듈을 쓰는 모든 앱이 동시에 깨집니다.**

`v1/` 파일 내용을 고치고 싶어지면:

1. `v2/` 폴더를 새로 만들고 그 안에 수정된 버전을 올립니다.
2. 앱을 하나씩, 준비된 순서대로 `v1/` → `v2/` 참조로 바꿉니다.
3. 모든 앱이 옮겨간 뒤에도 `v1/` 은 삭제하지 않고 그대로 둡니다
   (혹시 남아있는 참조가 깨지지 않도록).

버그 수정이라도 예외는 없습니다. `v1/`을 쓰는 앱이 여러 개이므로,
한 앱을 고치려고 파일을 바꾸면 다른 앱들이 예고 없이 함께 깨집니다.

> **2026-08-01: 소비자 0개 상태에서 한 번 보정했고 이후로는 고정입니다.**
> `v1/`을 실제로 쓰는 앱이 아직 하나도 없는 시점(clip 연결 시작 전)에
> `sync.js`의 outbox 재시도 로직·컨텍스트 ID 파일명 처리·1MB 판정을 보정했습니다.
> 이 시점 이후로 `v1/`을 쓰기 시작하는 앱이 생기면, 위 규칙이 그대로 적용되어
> 더 이상 `v1/` 파일을 고치지 않습니다.
>
> 2026-08-01 두 번째 보정(listDir 추가). 이 시점부터 v1 은 완전히 고정입니다.

---

## 구조

```
shared/
├─ .nojekyll
├─ README.md
└─ v1/
    ├─ sync.js          GitHub Contents API 읽기/쓰기 + outbox 재전송 큐 (ES module)
    ├─ sync-global.js   sync.js를 classic <script> 에서 쓰기 위한 로더 (window.SharedSync)
    ├─ backup.js        JSON 백업 내보내기/가져오기 공통 코드 (ES module)
    ├─ fontsize.js       글자 크기 6단계(6/8/10/12/14/17px) 공통 코드 (ES module)
    └─ theme.css        webapp-standard.md 기준 색상·글꼴 CSS 변수
└─ v2/
    └─ journal.js      Daybook 날짜별 projection 계약·writer·reader (ES module)
```

## Journal V2

`v2/journal.js`는 기존 앱 데이터 동기화를 대체하지 않습니다. 사용자가 별도로
`Include in journal`을 켠 source 앱이 `journal/` 아래에 날짜별 projection을 쓸 때만
사용합니다. `shared` 자체는 활동 source가 아니며 `v1/` 파일은 변경하지 않습니다.

Source 앱은 원래 저장을 먼저 완료한 뒤 동적 import로 journal 모듈을 불러야 합니다.
모듈 로드나 원격 쓰기가 실패해도 원래 저장·sync·events 동작은 계속되어야 합니다.

```js
const { createJournalClient } = await import(
  'https://<account>.github.io/shared/v2/journal.js'
);

const journal = createJournalClient({
  app: 'focus',
  context: existingSyncContextId,
  isEnabled: () => journalSetting === true,
  resolveConfig: async () => ({ owner, repo, branch: 'main', token }),
});

await journal.enqueue(record, { date: '2026-08-17' });
```

계약 경로:

- activity: `journal/activity/<app>/<YYYY-MM>/<date>.<context>.p01.json`
- source status: `journal/status/<app>/<context>.json`
- Daily note: `journal/notes/<YYYY-MM>/<date>.<context>.json`

공용 writer는 900,000-byte part rollover, NFC 텍스트 정규화, tombstone과
`updatedAt` 병합, 409/422 충돌 재읽기(최대 3회), token을 포함하지 않는 IndexedDB
pending queue를 담당합니다. 테스트는 `node --test tests/journal.test.mjs`로 실행합니다.

Folio는 파일 활동 외에 `excerpt-exported`, `highlight-created`,
`highlight-updated`, `note-created`, `note-updated` projection을 쓸 수 있습니다.
Source 앱은 표시할 인용문·메모·사람이 읽을 수 있는 위치만 투영해야 하며 원본 파일,
PDF 좌표, DOM locator, 파일 hash와 credential은 Journal record에 넣지 않습니다.

Tide의 `item-activity`와 Loom의 `block-activity`는 객체가 속한 날짜와 사용자가 실제로
작업한 날짜를 분리하는 additive kind입니다. 공통 `data`에는 필요에 따라
`activityDate`, `sourceDate`, `previousSourceDate`, `actions`, `firstAt`, `lastAt`,
`contentIncluded`, `importedHistory`, `historyAccuracy`(`exact`, `inferred`,
`future-only`), 원래 offset timestamp 또는 `originTimezone`을 넣을 수 있습니다.
알 수 없는 `data` 필드는 운반되지만 app/kind/id/timestamp/title/data 검증은 유지됩니다.

Source status는 `reportedAt`, `lastSuccessfulWriteAt`, `pendingCount`, `lastErrorCode`,
`contentIncluded`, `backfill`, `redaction`의 안전한 필드만 허용합니다. 원문 포함을 끌 때는
`transformPending()`으로 아직 전송되지 않은 projection도 같은 allowlist로 정제할 수 있습니다.

## 쓰는 법

**ES module 앱** (`<script type="module">` 을 쓰는 앱 — 예: bloom, petal)

```html
<link rel="stylesheet" href="../shared/v1/theme.css">
<script type="module">
  import { readFile, writeFile } from '../shared/v1/sync.js';
</script>
```

**classic script 앱** (`<script src="./app.js"></script>` 처럼 module이 아닌 앱 — 예: clip)

```html
<link rel="stylesheet" href="../shared/v1/theme.css">
<script src="../shared/v1/sync-global.js"></script>
<script src="./app.js"></script>
```

`app.js` 안에서는 `window.SharedSync.readFile(...)` 처럼 그대로 씁니다.
`sync-global.js` 는 내부적으로 동적 `import()`로 `sync.js`를 한 번만 불러와 캐시하므로,
`app.js` 자체를 module로 바꿀 필요가 없습니다.

로컬 개발 중이거나 같은 저장소 상대 경로로 쓰고 싶다면 절대 URL 대신
`../shared/v1/sync.js` 처럼 상대 경로를 써도 됩니다 (GitHub Pages 배포 후 기준).

## 이 저장소가 지키는 것

- 외부 CDN, 웹폰트 서버, 분석 도구, 로그인, 유료 서버 없음
- 빌드 도구 없이 그대로 배포되는 정적 파일
- 토큰이나 비밀값을 코드에 포함하지 않음 (`sync.js`는 토큰을 인자로만 받고 저장하지 않음)
- `webapp-data`(개인 데이터 저장소)는 이 저장소와 분리되어 있으며 항상 private
