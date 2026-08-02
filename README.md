# shared

개인용 웹앱들이 함께 쓰는 공용 코드 저장소입니다. GitHub Pages로 배포되어
`https://jennie-verse.github.io/shared/v1/...` 주소로 각 앱이 직접 불러다 씁니다.

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
```

## 쓰는 법

**ES module 앱** (`<script type="module">` 을 쓰는 앱 — 예: bloom, petal)

```html
<link rel="stylesheet" href="../shared/v1/theme.css">
<script type="module">
  import { readFile, writeFile } from 'https://jennie-verse.github.io/shared/v1/sync.js';
</script>
```

**classic script 앱** (`<script src="./app.js"></script>` 처럼 module이 아닌 앱 — 예: clip)

```html
<link rel="stylesheet" href="../shared/v1/theme.css">
<script src="https://jennie-verse.github.io/shared/v1/sync-global.js"></script>
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
