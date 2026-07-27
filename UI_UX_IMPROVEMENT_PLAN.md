# Tab Manager UI·사용성 개선 실행 계획

> - 실행 대상 모델: `gpt-5.6-terra`, reasoning effort `low`
> - 문서 상태: 구현 지시서
> - 범위: 기존 UI와 사용성 개선만 수행
> - 금지: 새 기능, 새 명령, 새 설정, 새 데이터 모델, 새 의존성 추가

---

## 0. 이 문서를 실행하는 모델에게

이 문서는 아이디어 목록이 아니라 순서가 고정된 구현 지시서다. 아래 규칙을 그대로 따른다.

1. 이 문서에 적힌 단계와 문자열을 임의로 바꾸지 않는다.
2. “더 좋아 보인다”는 이유로 색, 아이콘, 메뉴, 명령, 설정, 저장 데이터, 동작을 추가하지 않는다.
3. 기존 VS Code Tree View와 Codicon, 파일 테마 아이콘, VS Code 기본 색·글꼴·포커스·선택 동작을 그대로 사용한다.
4. Webview, HTML, CSS, React, 사용자 정의 폰트, 사용자 정의 색상, 외부 아이콘 패키지를 도입하지 않는다.
5. 각 단계가 끝날 때 해당 단계의 검사 명령과 수동 확인을 수행한다.
6. 검사 실패를 다음 단계로 넘기지 않는다. 실패 원인을 현재 단계의 변경 범위 안에서 고친 뒤 다시 검사한다.
7. 작업 전부터 존재하던 사용자 변경은 수정하거나 되돌리지 않는다.
8. 이 계획과 직접 관계없는 리팩터링, 파일 이동, 이름 변경, 포맷 전체 변경을 하지 않는다.
9. 코드 수정에는 `apply_patch`를 사용한다.
10. 버전 번호를 올리지 않고 VSIX를 만들거나 배포하지 않는다.
11. 스크린샷에 실제 사용자의 파일명·경로가 보이면 저장소에 커밋하지 않는다.
12. 구현 중 아래 “중단 조건”에 해당할 때만 작업을 멈추고 상위 모델 또는 사용자에게 보고한다. 그 외에는 이 문서의 고정값으로 진행한다.

### 0.1 중단 조건

다음 중 하나가 실제로 발생할 때만 작업을 멈춘다.

- `package.json`의 `engines.vscode`가 구현 도중 `^1.85.0`이 아닌 값으로 바뀌어 이 계획의 VS Code API 전제가 깨졌다.
- 이 계획에서 수정할 파일에 작업 시작 후 다른 변경이 생겨 동일한 줄을 안전하게 병합할 수 없다.
- 기존 명령 ID를 제거하지 않고는 요구된 메뉴 구성을 만들 수 없다는 것이 테스트로 확인됐다.
- VS Code 1.85 타입 정의에 이 계획이 지정한 API가 존재하지 않는다.
- 테스트가 외부 서비스 자격 증명이나 사용자 계정 입력 없이는 진행될 수 없다.

중단 보고에는 다음 세 항목만 포함한다.

1. 실패한 정확한 단계 번호
2. 실행한 명령과 오류 원문
3. 이미 완료되어 되돌릴 필요가 없는 단계

---

## 1. 작업 목표

Tab Manager가 제공하는 세 Tree View를 VS Code의 기본 탐색기처럼 조용하고 빠르게 읽히는 도구로 다듬는다.

- `tabManagerView`: 열린 탭을 빠르게 스캔하고 현재 레이아웃·필터·정렬 상태를 즉시 이해할 수 있게 한다.
- `tabManagerExplorer`: 기본 Explorer와 혼동되지 않는 정체성을 갖고, 흔한 작업만 헤더에 남기며, 빈 상태·오류·로딩을 명확하게 보여준다.
- `tabManagerProjects`: 긴 절대 경로의 시각적 소음을 줄이되 같은 이름의 프로젝트를 구분할 정보는 유지한다.

목표는 기능 수가 아니라 다음 다섯 결과로 판단한다.

1. 헤더 액션이 붐비지 않는다.
2. 현재 상태가 색이나 아이콘만이 아니라 텍스트로도 읽힌다.
3. 좁은 사이드바에서 중요한 상태가 경로보다 먼저 보인다.
4. 빈 결과와 읽기 실패를 사용자가 구분할 수 있다.
5. 키보드·스크린 리더·고대비 테마에서도 기존 작업을 수행할 수 있다.

---

## 2. 범위 경계

### 2.1 허용되는 변경

아래는 기존 기능의 표현과 사용성만 바꾸므로 허용한다.

- View 이름, 설명, 빈 상태 문구 변경
- 기존 명령의 View 헤더/overflow 배치와 순서 변경
- 기존 TreeItem의 label, description, tooltip, accessibility label 개선
- 기존 필터·정렬·레이아웃 상태를 View description에 표시
- 기존 비동기 새로고침에 VS Code 기본 진행 표시 추가
- 기존 파일 생성 실패 시 InputBox를 닫지 않고 오류를 표시
- 디렉터리 읽기 실패를 비대화형 TreeItem으로 표시
- 전역 hover delay 기본값 강제 설정 제거
- 과거 렌더러 tooltip 갱신 안내 알림 제거
- 위 변경을 검증하는 테스트 추가·수정
- README와 CHANGELOG의 UI 설명 갱신

### 2.2 금지되는 변경

아래는 새 기능 또는 별도 제품 결정이므로 수행하지 않는다.

- 새 command ID 추가
- 기존 command ID 제거
- 필터 종류 추가
- 정렬 방식 추가
- 프로젝트 검색·정렬·핀·그룹 기능 추가
- 탭 자동 포커스·자동 reveal 동작 추가
- 파일 작업 방식, 클립보드 동작, drag-and-drop 동작 변경
- 새 키보드 단축키 추가 또는 기존 단축키 변경
- 사용자 설정 추가
- 전역 상태, workspace 상태, 저장 형식 변경
- 새 notification 또는 routine success toast 추가
- 삭제 확인 정책 변경
- 새 Activity Bar 아이콘 또는 마켓플레이스 아이콘 제작
- Webview, CSS, 애니메이션, 차트, 이미지 자산 추가
- 모바일·웹용 별도 레이아웃 제작
- dependency 또는 devDependency 추가
- VS Code 엔진 범위 변경
- 버전 변경, 패키징 산출물 커밋, 배포

### 2.3 작업 완료 후 유지해야 하는 불변식

- 등록 command 수: 현재와 동일한 `68`
- Tree View 수: 현재와 동일한 `3`
- View ID:
  - `tabManagerView`
  - `tabManagerExplorer`
  - `tabManagerProjects`
- 기존 명령 ID 전부 유지
- 기존 저장 키와 저장 데이터 구조 유지
- 기존 필터 모드와 정렬 상태 값 유지
- 기존 context value 유지
  - 새로 허용되는 내부 context key는 `tabManager.hasActiveFilter` 하나다.
  - 새로 허용되는 비대화형 TreeItem context value는 `explorerError` 하나다.
- 새 npm dependency 없음
- 사용자 코드와 실제 workspace 파일을 변경하지 않음

---

## 3. 조사 근거와 현재 상태

### 3.1 기술 구조

- 제품 형태: VS Code extension
- UI 형태: VS Code native `TreeView`
- 구현 언어: TypeScript
- React/Next.js/Webview: 없음
- 스타일시트: 없음
- 외부 런타임 dependency: 없음
- VS Code 엔진: `^1.85.0`
- 빌드: TypeScript typecheck + esbuild
- 테스트: VS Code Extension Host E2E

### 3.2 기존 시각 언어 중 보존할 것

- `ThemeIcon`과 파일 테마 아이콘
- VS Code 기본 Tree 행 높이와 들여쓰기
- VS Code 기본 focus, selected, hover, disabled 표현
- VS Code 기본 context menu
- VS Code 기본 QuickPick, InputBox, modal dialog, progress UI
- 한 행에 하나뿐인 inline “Close” 액션
- 다중 선택
- 기존 view/item command 구조
- Light, Dark, High Contrast 테마 상속

### 3.3 실제 렌더링에서 확인한 문제

실제 설치된 extension을 VS Code에서 확인한 결과다.

1. Open Tabs 헤더에 확장 기능 액션이 최대 6개 가까이 노출되어 VS Code 기본 Collapse/overflow와 경쟁한다.
2. Extended Explorer 헤더에는 확장 기능 액션이 최대 9개 가까이 노출된다.
3. 필터 아이콘이 헤더 공간을 차지하지만 어떤 필터인지 좁은 너비에서 알기 어렵다.
4. `tabManagerExplorer` 제목이 현재 workspace 이름으로 바뀌어 기본 Explorer의 workspace 섹션과 동일한 제목이 두 번 보인다.
5. Tab 행 description에 파일명을 포함한 전체 상대 경로가 먼저 나오므로 `active`, `unsaved`, `read-only`, `missing` 상태가 오른쪽에서 잘린다.
6. 활성 탭 행 자체는 명시적인 텍스트 상태가 없어 컬럼의 `active`만 보고 추론해야 한다.
7. Projects 행에 전체 절대 경로가 항상 노출되어 밀도가 높고 반복 정보가 많다.
8. 디렉터리 읽기 실패가 빈 디렉터리와 똑같이 보인다.
9. 필터가 0건을 만들었을 때 “원래 데이터가 없음”과 “필터 결과 없음”을 구분할 수 없다.
10. extension이 전역 `workbench.hover.delay`를 `0`으로 강제한다.
11. 과거 tooltip 변경을 알리는 1회성 reload notification이 신규 사용자에게 현재 기능과 관계없는 방해를 준다.

### 3.4 코드 감사에서 확인한 관련 파일

| 파일 | 현재 책임 | 이 계획의 변경 |
|---|---|---|
| `package.json` | View, command, menu, welcome, 기본 설정 기여 | 이름·메뉴 계층·welcome·전역 설정 제거 |
| `src/extension.ts` | View 생성, context 동기화, description, 명령 등록, 알림 | 상태 description, filter context, 제목/알림 정리 |
| `src/tabProvider.ts` | Open Tabs TreeItem | 상태 우선 description, tooltip, 접근성 |
| `src/explorerProvider.ts` | Extended Explorer TreeItem와 데이터 읽기 | 오류 노드, 파일 접근성 |
| `src/explorerCommands.ts` | Explorer 명령, 생성 InputBox, refresh | 진행 표시와 오류 복구 |
| `src/projectProvider.ts` | Projects 저장·TreeItem·명령 | 압축된 위치 설명, tooltip/접근성 |
| `src/test/suite/tabManager.e2e.test.ts` | 통합·UI 계약 테스트 | 모든 변경의 회귀 테스트 |
| `README.md` | 사용자 문서 | UI 명칭과 상태 표현 갱신 |
| `CHANGELOG.md` | 변경 기록 | Unreleased UI 개선 기록 |

---

## 4. 고정 디자인 방향

### 4.1 제품 모드

`Operate` 모드로 구현한다.

- 반복 사용에 최적화한다.
- 한 번에 많은 항목을 읽는 밀도를 유지한다.
- 장식보다 상태와 계층을 우선한다.
- VS Code가 이미 제공하는 interaction model을 바꾸지 않는다.
- 일반 작업은 조용하게 완료하고, 실패 시에만 복구 가능한 정보를 제공한다.

### 4.2 시각 원칙

1. **Host-native**
   - 새 색·글꼴·그림자·모서리·애니메이션을 만들지 않는다.
   - VS Code가 렌더링하는 `label`, `description`, `tooltip`, `ThemeIcon`만 쓴다.

2. **Scan-first**
   - 행 description의 첫 토큰은 중요한 상태다.
   - 긴 경로는 마지막에 둔다.
   - label에 이미 있는 파일명은 description에서 반복하지 않는다.

3. **Progressive disclosure**
   - 자주 쓰는 작업만 View 헤더의 `navigation` 그룹에 둔다.
   - 필터, 정렬, 표시 옵션, 보조 새로고침은 overflow에 둔다.
   - Tree item inline action은 현재의 Close 하나보다 늘리지 않는다.

4. **Text-backed state**
   - 활성 필터, 레이아웃, 비기본 정렬은 View description에 텍스트로 표시한다.
   - 활성 탭, unsaved, read-only, missing도 행 description과 accessibility label에 표시한다.
   - 색이나 아이콘만으로 상태를 전달하지 않는다.

5. **Quiet feedback**
   - 성공 toast를 추가하지 않는다.
   - 새로고침에는 View 범위 진행 표시를 쓴다.
   - 입력 오류는 입력 위치에서 보여주고 입력값을 보존한다.
   - 읽기 실패는 해당 Tree 위치에 표시한다.

### 4.3 밀도 계약

| 영역 | 허용되는 기본 헤더 액션 |
|---|---|
| Open Tabs | Create Group, Close Selected, Layout 전환 |
| Extended Explorer | New File, New Folder, Reveal Active File, Refresh |
| Projects | Add Current Workspace, Add Project Folder |

조건부 액션은 보이는 순간에만 위 수에 포함한다.

- Open Tabs의 Layout 명령 두 개는 상호 배타적이므로 동시에 하나만 보인다.
- Close Selected는 실제 TabNode 선택이 있을 때만 보인다.
- 필터는 기본 헤더 액션으로 계산하지 않는다. 모두 overflow에 있어야 한다.
- PR Comments Refresh와 Expand All도 overflow에 있어야 한다.

### 4.4 상태 계약

각 상태를 다음 방식으로 표현한다.

| 상태 | 표현 위치 | 표현 방법 |
|---|---|---|
| 기본 레이아웃 | Open Tabs description | `By Column` |
| 병합 레이아웃 | Open Tabs description | `All Columns` |
| 활성 필터 | 두 관련 View description | `Filter: <label>` |
| 활성 정렬 | 관련 View description | `Sort: <labels>` |
| workspace 이름 | Extended Explorer description | workspace name |
| active tab | Tab 행 description | `active` |
| dirty tab | Tab 행 description | `unsaved` |
| read-only tab | Tab 행 description | `read-only` |
| missing tab | Tab 행 description | `missing` |
| preview tab | Tab 행 description | `preview` |
| 읽기 실패 | Explorer child row | `Unable to read folder` |
| 필터 결과 0 | viewsWelcome | Clear Filter 링크 포함 |
| 비동기 refresh | View progress | `Refreshing files…` |
| 입력 실패 | 열린 InputBox | `validationMessage` |

### 4.5 접근성 계약

- 기존 `role: 'treeitem'`은 이번 작업에서 유지한다.
- label에 보이는 상태는 accessibility label에도 포함한다.
- 경로를 줄여 보이는 경우 tooltip 또는 accessibility label에는 전체 위치를 남긴다.
- `active`, `unsaved`, `read-only`, `missing`, `preview`, `deleted`를 색만으로 전달하지 않는다.
- 모든 기존 command는 키보드로 계속 실행 가능해야 한다.
- focus ring과 selection 색은 VS Code 테마가 담당하게 둔다.
- 고대비 테마에서 별도 색상 의존이 없어야 한다.

---

## 5. 우선순위와 합격 기준

| 우선순위 | 문제 | 합격 기준 |
|---|---|---|
| P0 | 기본 Explorer와 View 제목 중복 | `Extended Explorer`가 고정 제목이고 workspace 이름은 description에만 보임 |
| P0 | 헤더 액션 과밀 | Open Tabs 최대 3개 계열, Explorer 최대 4개 계열, Projects 2개 |
| P0 | 빈 결과와 오류 상태 불명확 | empty/filter-empty/read-error가 서로 다른 문구로 보임 |
| P0 | 중요한 Tab 상태가 경로 뒤에서 잘림 | 상태 토큰이 description 앞에 오고 파일명이 description에서 중복되지 않음 |
| P1 | 현재 필터·정렬 상태 발견성 부족 | View description만 읽고 현재 상태를 알 수 있음 |
| P1 | Projects 절대 경로 소음 | 행에는 부모 위치만, tooltip에는 전체 경로 |
| P1 | 입력 실패 시 복구 불편 | InputBox가 열린 채 입력값과 오류가 유지됨 |
| P1 | refresh 진행 상태 없음 | View 헤더에 `Refreshing files…` 진행 표시 |
| P1 | 접근성 label 정보 부족 | 표시 상태와 구분 위치가 스크린 리더 label에 포함 |
| P2 | 전역 hover 동작 침범 | `configurationDefaults.workbench.hover.delay`가 없음 |
| P2 | 과거 reload 안내 소음 | 관련 상수·상태·알림·테스트가 전부 없음 |

---

## 6. 구현 전 기준선

### 6.1 시작 명령

저장소 루트 `/Users/lky/project/tab-manager`에서 순서대로 실행한다.

```bash
git status --short
npm run check-types
npm test
```

### 6.2 시작 판정

- `git status --short`가 비어 있으면 계속한다.
- 이 계획 파일만 새 파일로 보이면 계속한다.
- 이 계획 파일 외에 변경이 있으면 변경 파일 목록을 기록하고 그 파일의 사용자 변경을 보존한다.
- `npm run check-types`가 실패하면 구현을 시작하지 않는다.
- `npm test`가 외부 환경 문제 없이 코드 오류로 실패하면 구현을 시작하지 않는다.
- 기준선 결과를 최종 보고에 포함한다.

### 6.3 구현 중 공통 규칙

- 각 파일을 수정하기 직전에 현재 내용을 다시 읽는다.
- `package.json`은 전체 자동 정렬하지 않는다.
- TypeScript 파일은 관련 symbol 주변만 수정한다.
- 테스트에서 timeout을 늘려 실패를 숨기지 않는다.
- 기존 오류를 UI 범위 밖 리팩터링으로 고치지 않는다.

---

## 7. 고정 문자열과 표시 순서

이 절의 문자열은 대소문자, en dash, ellipsis까지 그대로 쓴다.

### 7.1 필터 label

| 내부 값 | 표시 label |
|---|---|
| `modified` | `Modified` |
| `untracked` | `Untracked` |
| `deleted` | `Deleted` |
| `errors` | `Errors` |
| `tabsOnly` | `Open Tabs` |
| `unsaved` | `Unsaved` |
| `readOnly` | `Read-only` |
| `prComments` | `PR Comments` |
| `prFiles` | `PR Files` |
| `comparison` | `Comparison` |

`none`은 표시하지 않는다.

### 7.2 정렬 label

| 상태 | 표시 label |
|---|---|
| `name === 'asc'` | `Name A–Z` |
| `name === 'desc'` | `Name Z–A` |
| `type === true` | `Type` |
| `readOnly === true` | `Read-only first` |

정렬 토큰 순서는 항상 Name → Type → Read-only first다.

### 7.3 View description 순서

Open Tabs:

1. 레이아웃
2. 필터
3. 정렬

Extended Explorer:

1. workspace 이름
2. 필터
3. 정렬

토큰 구분자는 정확히 ` · `다.

예:

```text
By Column
All Columns · Filter: Modified · Sort: Name A–Z, Type
my-workspace
my-workspace · Filter: Errors · Sort: Name Z–A
```

Open Tabs의 정렬에는 `Read-only first`를 포함한다. Extended Explorer의 정렬에는 `Read-only first`를 포함하지 않는다.

### 7.4 Tab 행 description 순서

토큰을 다음 순서로 추가한다.

1. `active`
2. `unsaved`
3. `read-only`
4. `missing`
5. `preview`
6. merged layout일 때 column label
7. 파일이면 파일명을 제외한 상대 부모 경로
8. 파일이 아니면 tab type category

토큰 구분자는 ` · `다.

예:

```text
active · unsaved · Column 2 · src/components
read-only · missing · src
preview · notebook
```

workspace root 바로 아래 파일은 부모 경로 토큰을 추가하지 않는다.

### 7.5 개수 문구

Tab 개수는 다음 helper 하나로 만든다.

```ts
function formatTabCount(count: number): string {
  return `${count} ${count === 1 ? 'tab' : 'tabs'}`;
}
```

예:

```text
0 tabs
1 tab
41 tabs
active · 41 tabs
```

---

## 8. 1단계 — View 정체성과 메뉴 계층 정리

수정 파일: `package.json`

### 8.1 Explorer View 이름 고정

`contributes.views.explorer`의 `tabManagerExplorer` 항목을 다음 의미로 바꾼다.

```json
{
  "id": "tabManagerExplorer",
  "name": "Extended Explorer"
}
```

- 기존 `id`는 바꾸지 않는다.
- 별도 icon 항목을 추가하지 않는다.
- `contextualTitle`을 추가하지 않는다.
- Projects View 이름은 바꾸지 않는다.
- Open Tabs View 이름은 바꾸지 않는다.

### 8.2 전역 hover 기본값 제거

다음 기여를 완전히 제거한다.

```json
"configurationDefaults": {
  "workbench.hover.delay": 0
}
```

`contributes.configurationDefaults`에 다른 항목이 없다면 `configurationDefaults` 객체 자체를 제거한다.

### 8.3 Open Tabs navigation 그룹

`contributes.menus["view/title"]`에서 `view == tabManagerView`에 적용되는 `navigation` 그룹은 아래만 남긴다.

| 순서 | command | group | 기존 when 조건 |
|---|---|---|---|
| 1 | `tabManager.createGroup` | `navigation@1` | 유지 |
| 2 | `tabManager.closeSelected` | `navigation@2` | `tabManager.hasSelectedTabs` 조건 유지 |
| 3 | `tabManager.layout.merged` | `navigation@3` | 현재 by-column일 때 보이는 기존 조건 유지 |
| 3 | `tabManager.layout.byColumn` | `navigation@3` | 현재 merged일 때 보이는 기존 조건 유지 |

다음 필터 명령의 show/clear 쌍은 `navigation`에서 제거하고 8.5의 overflow 그룹에만 둔다.

- Modified
- Errors
- Comparison

레이아웃의 사람이 읽을 수 있는 overflow 항목이 기존에 별도로 있으면 유지한다. 단, 그 그룹은 `navigation`이 아니어야 한다.

### 8.4 Extended Explorer navigation 그룹

`view == tabManagerExplorer`에 적용되는 `navigation` 그룹은 아래만 남긴다.

| 순서 | command | group | when |
|---|---|---|---|
| 1 | `tabManager.explorer.newFile` | `navigation@1` | 기존 workspace 조건 유지 |
| 2 | `tabManager.explorer.newFolder` | `navigation@2` | 기존 workspace 조건 유지 |
| 3 | `tabManager.explorer.revealActive` | `navigation@3` | 기존 workspace 조건 유지 |
| 4 | `tabManager.explorer.refresh` | `navigation@4` | 기존 조건 유지 |

다음 두 명령은 header icon에서 overflow로 이동한다.

| command | 새 group |
|---|---|
| `tabManager.explorer.refreshPullRequestComments` | `4_refresh@1` |
| `tabManager.explorer.expandAll` | `5_tree@1` |

각 명령의 기존 `when` 조건은 유지한다.

### 8.5 필터 overflow 그룹 통일

두 관련 View에 적용되는 모든 필터 show/clear 명령을 `3_filter` 그룹에 둔다.

| 순서 | show command | clear command | group |
|---|---|---|---|
| 1 | `tabManager.filter.modified` | `tabManager.filter.clearModified` | `3_filter@1` |
| 2 | `tabManager.filter.untracked` | `tabManager.filter.clearUntracked` | `3_filter@2` |
| 3 | `tabManager.filter.deleted` | `tabManager.filter.clearDeleted` | `3_filter@3` |
| 4 | `tabManager.filter.errors` | `tabManager.filter.clearErrors` | `3_filter@4` |
| 5 | `tabManager.filter.tabsOnly` | `tabManager.filter.clearTabsOnly` | `3_filter@5` |
| 6 | `tabManager.filter.unsaved` | `tabManager.filter.clearUnsaved` | `3_filter@6` |
| 7 | `tabManager.filter.readOnly` | `tabManager.filter.clearReadOnly` | `3_filter@7` |
| 8 | `tabManager.filter.prComments` | `tabManager.filter.clearPrComments` | `3_filter@8` |
| 9 | `tabManager.filter.prFiles` | `tabManager.filter.clearPrFiles` | `3_filter@9` |
| 10 | `tabManager.filter.comparison` | `tabManager.filter.clearComparison` | `3_filter@10` |

세부 규칙:

- show와 clear는 같은 순서 값을 쓴다. `when` 조건이 상호 배타적이므로 동시에 보이지 않는다.
- 기존 `tabManager.filterMode` 조건을 그대로 유지한다.
- Comparison show 항목의 `tabManager.hasActiveComparison` 조건을 유지한다.
- 현재 `view/title`에 두 번 들어 있는 Comparison show/clear 쌍은 각각 한 번만 남긴다.
- `tabManager.filter.clear`는 command 기여와 command 등록을 유지한다.
- 일반 `tabManager.filter.clear` 항목만 `view/title` 메뉴에서 제거한다.
- 필터별 clear 명령은 `view/title`에 유지한다.
- command palette 숨김 기여는 변경하지 않는다.

### 8.6 Projects 헤더

Projects의 기존 navigation 두 개를 그대로 유지한다.

- `tabManager.projects.addCurrentWorkspace`
- `tabManager.projects.addFolder`

순서와 조건도 변경하지 않는다.

### 8.7 viewsWelcome 교체

기존 세 welcome 항목을 아래 일곱 항목으로 교체한다.

#### Open Tabs — 활성 필터 없음

```json
{
  "view": "tabManagerView",
  "contents": "No tabs are open.",
  "when": "!tabManager.hasActiveFilter"
}
```

#### Open Tabs — 활성 필터 있음

```json
{
  "view": "tabManagerView",
  "contents": "No open tabs match the active filter.\n[Clear Filter](command:tabManager.filter.clear)",
  "when": "tabManager.hasActiveFilter"
}
```

#### Extended Explorer — workspace 없음

```json
{
  "view": "tabManagerExplorer",
  "contents": "Open a folder or workspace to browse files.\n[Open Folder](command:vscode.openFolder)",
  "when": "workbenchState == empty"
}
```

#### Extended Explorer — 활성 필터가 만든 빈 결과

```json
{
  "view": "tabManagerExplorer",
  "contents": "No files match the active filter.\n[Clear Filter](command:tabManager.filter.clear)",
  "when": "workbenchState != empty && tabManager.hasActiveFilter"
}
```

#### Extended Explorer — workspace는 있지만 파일이 없음

```json
{
  "view": "tabManagerExplorer",
  "contents": "No files or folders are in this workspace.",
  "when": "workbenchState != empty && !tabManager.hasActiveFilter"
}
```

#### Projects — workspace 없음

```json
{
  "view": "tabManagerProjects",
  "contents": "No saved projects.\n[Add Project Folder](command:tabManager.projects.addFolder)",
  "when": "workbenchState == empty"
}
```

#### Projects — workspace 있음

```json
{
  "view": "tabManagerProjects",
  "contents": "No saved projects.\n[Add Current Workspace](command:tabManager.projects.addCurrentWorkspace)\nOr [add another folder](command:tabManager.projects.addFolder).",
  "when": "workbenchState != empty"
}
```

welcome 규칙:

- 링크는 기존 command만 가리킨다.
- 한 상태에서 버튼으로 렌더링될 첫 링크는 하나만 둔다.
- 이미지, 아이콘, 긴 설명을 추가하지 않는다.
- Explorer의 read error는 provider가 ErrorNode를 반환하므로 viewsWelcome로 표현하지 않는다.

### 8.8 1단계 테스트 수정

`src/test/suite/tabManager.e2e.test.ts`의 manifest 테스트를 다음 계약으로 바꾼다.

1. `packageJson.contributes.configurationDefaults?.['workbench.hover.delay']`가 `undefined`인지 검사한다.
2. `tabManagerExplorer`의 name이 정확히 `Extended Explorer`인지 검사한다.
3. Open Tabs navigation의 command 집합이 8.3의 네 command ID뿐인지 검사한다.
4. Explorer navigation의 command 집합이 8.4의 네 command ID뿐인지 검사한다.
5. Projects navigation command 두 개가 유지되는지 검사한다.
6. 어떤 `tabManager.filter.*` command도 `navigation` 그룹에 없는지 검사한다.
7. 필터 show/clear 각 쌍의 group이 8.5와 정확히 일치하는지 검사한다.
8. Comparison show/clear 항목이 각 View 조건을 포괄하는 항목 하나씩만 있는지 검사한다.
9. `tabManager.filter.clear`가 command 목록에는 있고 `view/title`에는 없는지 검사한다.
10. `refreshPullRequestComments`의 group이 `4_refresh@1`인지 검사한다.
11. `expandAll`의 group이 `5_tree@1`인지 검사한다.
12. 일곱 viewsWelcome의 `view`, `contents`, `when` 문자열을 정확히 검사한다.
13. 기존 지원 menu field 검사와 command 존재 검사는 유지한다.

### 8.9 1단계 검사

```bash
npm run check-types
npm test
git diff --check
```

합격 조건:

- JSON parse 오류 없음
- command 수 `68`
- View 수 `3`
- 필터 command가 navigation에 없음
- 테스트 전부 통과

---

## 9. 2단계 — View description과 상태 발견성

수정 파일:

- `src/extension.ts`
- `src/test/suite/tabManager.e2e.test.ts`

### 9.1 Explorer runtime title 덮어쓰기 제거

`src/extension.ts`에서 다음을 제거한다.

- `syncExplorerTitle` 함수 전체
- activate 초기화 중 `syncExplorerTitle()` 호출
- `onDidChangeWorkspaceFolders` 안의 `syncExplorerTitle()` 호출

workspace folder 변경 listener 자체는 유지한다. 그 listener가 provider refresh 등 다른 일을 한다면 그 동작은 남긴다.

결과:

- View title은 manifest의 `Extended Explorer`를 유지한다.
- workspace 이름은 9.3의 description으로만 표시한다.

### 9.2 상태 문자열 helper

`src/extension.ts`의 기존 `capitalize` 기반 표현을 다음 helper 구조로 교체한다.

```ts
const FILTER_LABELS: Record<Exclude<FilterMode, 'none'>, string> = {
  modified: 'Modified',
  untracked: 'Untracked',
  deleted: 'Deleted',
  errors: 'Errors',
  tabsOnly: 'Open Tabs',
  unsaved: 'Unsaved',
  readOnly: 'Read-only',
  prComments: 'PR Comments',
  prFiles: 'PR Files',
  comparison: 'Comparison',
};
```

다음 helper를 같은 파일에 둔다.

```ts
function filterDescription(mode: FilterMode): string | undefined
function sortDescription(sort: SortState, includeReadOnly: boolean): string | undefined
function joinDescription(parts: Array<string | undefined>): string | undefined
```

구현 계약:

- `filterDescription('none')`은 `undefined`
- 다른 필터는 `Filter: ${FILTER_LABELS[mode]}`
- `sortDescription`은 7.2 순서로 활성 토큰을 만든다.
- 토큰이 없으면 `undefined`
- 토큰이 있으면 `Sort: ${tokens.join(', ')}`
- `includeReadOnly === false`이면 `sort.readOnly`가 true여도 무시한다.
- `joinDescription`은 falsy part를 제거한 뒤 ` · `로 join한다.
- 결과가 빈 문자열이면 `undefined`
- 기존 `capitalize`가 다른 곳에서 사용되지 않으면 제거한다.

### 9.3 `updateViewDescriptions` 정확한 구현

`updateViewDescriptions`는 store에서 filter, layout, sort를 한 번씩 읽고 다음과 같이 설정한다.

```ts
const mode = store.getFilterMode();
const layout = store.getTabLayoutMode();
const sort = store.getSortState();

view.description = joinDescription([
  layout === 'byColumn' ? 'By Column' : 'All Columns',
  filterDescription(mode),
  sortDescription(sort, true),
]);

filesView.description = joinDescription([
  vscode.workspace.name,
  filterDescription(mode),
  sortDescription(sort, false),
]);
```

규칙:

- Open Tabs는 기본 상태에서도 반드시 `By Column`을 보여준다.
- merged는 반드시 `All Columns`를 보여준다.
- workspace가 없고 필터·정렬도 없으면 Explorer description은 `undefined`다.
- workspace folder가 바뀌면 `updateViewDescriptions()`를 호출한다.

### 9.4 sort 변경 시 description 갱신

현재 `syncSortContext`는 context key만 동기화한다. 다음 규칙을 추가한다.

- sort state가 바뀐 경우 context key 세 개를 갱신한 다음 `updateViewDescriptions()`를 호출한다.
- sort state가 이전과 같아 early return하더라도 다른 sync 함수가 description을 갱신하므로 중복 호출은 허용한다.
- debounce나 timer를 새로 추가하지 않는다.

### 9.5 활성 필터 boolean context

`syncFilterState`에 boolean context를 추가한다.

```ts
void vscode.commands.executeCommand(
  'setContext',
  'tabManager.hasActiveFilter',
  mode !== 'none',
);
```

구현 규칙:

- `lastHasActiveFilter` 변수를 추가해 값이 바뀔 때만 `setContext`를 호출한다.
- 초기 activate에서도 반드시 호출되어 `false`가 설정된다.
- 기존 `tabManager.filterMode` context는 유지한다.
- 필터를 clear하면 `false`가 된다.
- 새 저장 상태를 만들지 않는다.

### 9.6 과거 renderer tooltip reload 안내 제거

`src/extension.ts`에서 다음을 전부 제거한다.

- `RENDERER_TOOLTIP_SCHEMA_KEY`
- `RENDERER_TOOLTIP_SCHEMA_VERSION`
- `RENDERER_TOOLTIP_NOTICE_MESSAGE`
- `RELOAD_WINDOW_ACTION`
- `rendererTooltipNoticeContexts`
- renderer tooltip notice를 예약하는 호출
- notice를 표시하고 globalState를 갱신하는 helper 전체

`src/test/suite/tabManager.e2e.test.ts`에서 다음을 전부 제거한다.

- 위 export import
- notification dismiss/accept 테스트
- `rendererTooltipContext()` helper
- renderer tooltip schema 전용 mock setup

다른 notification 테스트는 제거하지 않는다.

### 9.7 Test API 확장

`TAB_MANAGER_E2E` 조건에서 반환하는 기존 Test API에 이미 생성한 세 TreeView 참조를 포함한다.

```ts
tabView: view,
explorerView: filesView,
projectsView,
```

이미 같은 참조가 포함돼 있으면 이름을 바꾸지 않고 재사용한다.

테스트 타입에도 같은 필드를 추가한다.

### 9.8 View description E2E

새 테스트 한 개에서 상태를 순서대로 바꾸며 정확한 문자열을 검사한다.

테스트 시작과 종료에서 다음 명령을 이 순서로 실행해 상태를 기본값으로 되돌린다.

1. `tabManager.filter.clear`
2. `tabManager.sort.nameNone`
3. `tabManager.sort.stopType`
4. `tabManager.sort.stopReadOnly`
5. `tabManager.layout.byColumn`

테스트 순서:

1. 기본 상태
   - `tabView.description === 'By Column'`
   - workspace가 있으면 `explorerView.description === vscode.workspace.name`

2. merged
   - `tabManager.layout.merged` 실행
   - `tabView.description === 'All Columns'`

3. Modified 필터
   - `tabManager.filter.modified` 실행
   - Open Tabs 끝에 `Filter: Modified`
   - Explorer 끝에 `Filter: Modified`

4. Name ascending + Type + Read-only first
   - `tabManager.sort.nameAsc`
   - `tabManager.sort.toggleType`
   - `tabManager.sort.toggleReadOnly`
   - Open Tabs: `Sort: Name A–Z, Type, Read-only first`
   - Explorer: `Sort: Name A–Z, Type`

5. Name descending
   - `tabManager.sort.nameDesc` 실행
   - `Name Z–A`로 바뀌는지 검사

6. 필터를 `tabsOnly`로 변경
   - 현재 Modified 상태에서 `tabManager.filter.tabsOnly` 실행
   - label이 내부 camelCase가 아니라 `Open Tabs`인지 검사

7. 기본 상태 복원
   - 1번 문자열로 돌아왔는지 검사

각 command 뒤에는 기존 store/event propagation 방식에 맞춰 짧은 polling helper를 사용한다. 고정 sleep을 새로 만들지 않는다.

### 9.9 2단계 검사

```bash
npm run check-types
npm test
git diff --check
```

합격 조건:

- View title을 runtime에서 바꾸는 코드가 없음
- `capitalize(mode)` 기반 필터 표시가 없음
- `tabManager.hasActiveFilter`가 초기 false, 활성 true, clear 후 false
- reload 안내 문자열이 source와 test 어디에도 없음
- description E2E 전부 통과

---

## 10. 3단계 — Open Tabs 행의 정보 계층 개선

수정 파일:

- `src/tabProvider.ts`
- `src/test/suite/tabManager.e2e.test.ts`

### 10.1 공통 helper

`src/tabProvider.ts`에 다음 두 helper를 추가한다.

```ts
function formatTabCount(count: number): string {
  return `${count} ${count === 1 ? 'tab' : 'tabs'}`;
}

function relativeParentPath(uri: vscode.Uri): string | undefined {
  const relative = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
  const slash = relative.lastIndexOf('/');
  return slash > 0 ? relative.slice(0, slash) : undefined;
}
```

규칙:

- Windows separator를 `/`로 정규화한다.
- 파일명은 반환하지 않는다.
- workspace root 파일은 `undefined`
- multi-root workspace가 relative path 앞에 folder 이름을 포함하면 그 부모 경로를 그대로 유지한다.

### 10.2 ColumnNode

현재 숫자-only description을 다음으로 바꾼다.

```ts
this.description = active
  ? `active · ${formatTabCount(tabCount)}`
  : formatTabCount(tabCount);
```

추가:

- tooltip: `${label}\n${active ? 'Active column\n' : ''}${formatTabCount(tabCount)}`
- accessibility label: label, active 여부, tab count를 쉼표로 연결
- 기존 id, contextValue, icon, collapse state 유지

tooltip에 빈 줄이 생기지 않도록 배열 join 방식을 사용한다.

### 10.3 GroupNode

변경:

- description: `formatTabCount(tabCount)`
- tooltip: `${group.name}\n${formatTabCount(tabCount)}`
- accessibility label: `${group.name}, ${formatTabCount(tabCount)}`
- 기존 id, contextValue, folder icon, collapse state 유지

### 10.4 UngroupedHeaderNode

변경:

- description: `formatTabCount(tabCount)`
- tooltip: `Ungrouped\n${formatTabCount(tabCount)}`
- accessibility label: `Ungrouped, ${formatTabCount(tabCount)}`
- 기존 id, contextValue, icon, collapse state 유지

### 10.5 TabNode description

현재 URI가 있을 때 전체 상대 경로를 먼저 넣는 로직을 제거한다.

다음 순서로 구현한다.

```ts
const statusParts: string[] = [];
if (tab.isActive) statusParts.push('active');
if (tab.isDirty) statusParts.push('unsaved');
if (isReadOnly) statusParts.push('read-only');
if (isMissing) statusParts.push('missing');
if (tab.isPreview) statusParts.push('preview');
if (showColumn) statusParts.push(tabColumnLabel(tab));

if (uri) {
  const parentPath = relativeParentPath(uri);
  if (parentPath) statusParts.push(parentPath);
} else {
  statusParts.push(category);
}

this.description = statusParts.join(' · ');
```

규칙:

- `active`는 실제 `tab.isActive`를 사용한다.
- `preview`보다 unsaved/read-only/missing이 앞에 온다.
- description이 빈 문자열인 것은 허용한다.
- label은 계속 `tab.label`
- 파일 아이콘과 non-file category 아이콘 로직 유지
- contextValue 로직 유지
- open command 로직 유지

### 10.6 TabNode tooltip

tooltip을 한 줄 문자열 조합으로 만들지 말고 배열로 만든다.

파일 tab:

1. `uri.fsPath`
2. 활성 상태 토큰이 있으면 `Status: ${statusLabels.join(', ')}`
3. `Open Tab`

non-file tab:

1. `tab.label`
2. 활성 상태 토큰이 있으면 같은 Status 줄
3. `Open Tab`

tooltip의 status label 순서:

1. `active`
2. `unsaved`
3. `read-only`
4. `missing`
5. `preview`
6. column label

부모 경로와 category는 Status 줄에 넣지 않는다.

### 10.7 TabNode accessibility label

접근성 토큰을 다음 순서로 만든다.

1. `tab.label`
2. 파일이면 전체 `uri.fsPath`
3. merged layout이면 column label
4. `active tab`
5. `unsaved`
6. `read-only`
7. `file missing`
8. `preview`
9. non-file이면 category
10. `Open Tab`

쉼표와 공백으로 join한다.

```ts
this.accessibilityInformation = {
  label: accessibilityParts.join(', '),
  role: 'treeitem',
};
```

전체 경로를 넣는 이유는 같은 파일명의 tab을 스크린 리더에서 구분하기 위함이다.

### 10.8 Open Tabs 테스트

기존 Node 단위/E2E 기대값을 새 계약에 맞춘다.

필수 assertion:

1. `formatTabCount`
   - 0 → `0 tabs`
   - 1 → `1 tab`
   - 2 → `2 tabs`

2. Column
   - active가 description 첫 토큰
   - count pluralization
   - tooltip과 accessibility label에 active/count

3. Group/Ungrouped
   - `1 tab`과 `2 tabs`
   - tooltip과 accessibility label

4. 파일 Tab
   - label에 파일명
   - description에는 같은 파일명이 없음
   - description 끝에는 부모 경로
   - root file은 부모 경로 없음

5. 상태 순서
   - active + dirty + read-only + missing + preview + column을 모두 가진 fixture에서 정확한 순서 검사

6. non-file Tab
   - category가 마지막 토큰

7. accessibility
   - 전체 경로
   - column
   - active tab
   - unsaved/read-only/file missing/preview
   - Open Tab

8. 기존 동작
   - command ID와 arguments 유지
   - contextValue 유지
   - resourceUri 유지
   - icon 유지

### 10.9 3단계 검사

```bash
npm run check-types
npm test
git diff --check
```

합격 조건:

- 파일명 중복 description 없음
- 상태 순서가 7.4와 일치
- 기존 open/close/group/filter/sort 테스트 통과
- 새 접근성 assertion 통과

---

## 11. 4단계 — Explorer 오류·로딩·입력 복구

수정 파일:

- `src/explorerProvider.ts`
- `src/explorerCommands.ts`
- `src/test/suite/tabManager.e2e.test.ts`

### 11.1 ExplorerErrorNode 추가

`src/explorerProvider.ts`에서 Tree node union에 `ExplorerErrorNode`를 추가한다.

Node 계약:

```ts
export class ExplorerErrorNode extends vscode.TreeItem {
  constructor(
    public readonly folderUri: vscode.Uri,
    errorMessage: string,
  )
}
```

생성자에서 정확히 설정:

- label: `Unable to read folder`
- description: `path.posix.basename(folderUri.path) || folderUri.authority || folderUri.scheme`
- collapsibleState: `vscode.TreeItemCollapsibleState.None`
- id: `error:${folderUri.toString()}`
- contextValue: `explorerError`
- iconPath: `new vscode.ThemeIcon('error')`
- tooltip:
  - 1행 전체 위치
  - 2행 정규화된 error message
- accessibility label:
  - `Unable to read folder ${description}. ${errorMessage}`
  - role `treeitem`
- command: 설정하지 않음
- resourceUri: 설정하지 않음

전체 위치:

- file URI: `folderUri.fsPath`
- 그 외: `folderUri.toString()`

### 11.2 multi-root의 filtered-empty 처리

`getChildren(undefined)`의 multi-root 분기를 다음 계약으로 바꾼다.

```ts
if (!element) {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) return [];
  if (folders.length === 1) return this.readDirectory(folders[0].uri, mode);
  if (mode === 'none') {
    return folders.map((folder) => this.workspaceFolderNode(folder));
  }

  this.ensureCache(mode);
  return folders
    .filter((folder) => this.cache!.ancestors.has(folder.uri.toString()))
    .map((folder) => this.workspaceFolderNode(folder));
}
```

규칙:

- 필터가 없으면 기존처럼 모든 workspace root를 표시한다.
- 필터가 있으면 매칭 파일의 ancestor인 workspace root만 표시한다.
- 모든 root에서 매칭이 0이면 `[]`를 반환해 filtered-empty welcome이 보이게 한다.
- 필터 결과 계산 방식이나 filter source를 바꾸지 않는다.
- single-root 동작은 기존 `readDirectory` 결과를 그대로 사용한다.
- deleted ghost의 URI도 기존 `ancestors`에 포함되므로 같은 규칙을 쓴다.

### 11.3 readDirectory 실패 처리

현재 catch에서 `entries = []`로 바꾸고 빈 결과를 cache하는 로직을 제거한다.

새 동작:

1. 정상 read 성공 시 기존 정렬·필터·cache 동작을 그대로 수행
2. 실패 시 오류를 빈 배열로 cache하지 않음
3. 실패 시 `[new ExplorerErrorNode(folderUri, formatOpenError(error))]` 반환
4. 다음 refresh 때 실제 read를 다시 시도
5. error notification을 추가하지 않음

Tree provider 분기:

- `getTreeItem`은 union이므로 기존처럼 element를 반환
- `getChildren(ExplorerErrorNode)`는 `[]`
- `nodeUri(ExplorerErrorNode)`는 `undefined`
- drag 대상 URI에 ErrorNode가 들어가지 않음
- `getParent(ExplorerErrorNode)`는 `undefined`
- `resolveDropDestination(ExplorerErrorNode)`는 `undefined`
- single-root workspace에서도 ErrorNode 위 drop을 workspace root drop으로 대체하지 않음
- context menu는 `explorerError`에 매칭되는 기여가 없으므로 비어 있음

### 11.4 FileNode accessibility 보강

`FileNode`가 화면 description에 보여주는 metadata를 accessibility label에도 추가한다.

순서:

1. file label
2. 전체 경로
3. description에 표시된 file size
4. description에 표시된 line count
5. deleted이면 `deleted`
6. 기존 action label

규칙:

- 화면에 숨긴 metadata는 accessibility label에도 넣지 않는다.
- deleted 파일의 실제 이름은 combining strike 문자가 없는 원본 이름을 읽는다.
- tooltip의 전체 경로와 기존 action hint는 유지한다.
- Directory와 WorkspaceFolder의 resourceUri, icon, collapse 동작은 바꾸지 않는다.

### 11.5 Explorer refresh 진행 표시

`src/explorerCommands.ts`의 `tabManager.explorer.refresh` handler를 다음 형태로 감싼다.

```ts
await vscode.window.withProgress(
  {
    location: { viewId: 'tabManagerExplorer' },
    title: 'Refreshing files…',
  },
  async () => {
    // 기존 refresh handler 본문
  },
);
```

규칙:

- `cancellable`을 추가하지 않는다.
- 기존 refresh 작업 순서와 최종 provider refresh를 바꾸지 않는다.
- 새 notification을 추가하지 않는다.
- 명령은 Promise를 반환하도록 `async`를 유지한다.

### 11.6 파일·폴더 생성 InputBox 실패 복구

현재 생성 작업 전에 `input.hide()`를 호출하는 부분을 옮긴다.

`startInlineCreate`의 InputBox 생성 직후 다음 상태를 추가한다.

```ts
let submitting = false;
let hidden = false;
```

accept handler 시작 규칙:

1. `submitting === true`이면 즉시 return
2. 기존 name trim, empty, validation, duplicate 검사를 먼저 수행
3. 실제 파일 시스템 호출 직전에 `submitting = true`
4. 실제 파일 시스템 호출 직전에 `input.busy = true`
5. 실제 파일 시스템 호출 직전에 `input.enabled = false`
6. 실제 파일 시스템 호출 직전에 `input.validationMessage = undefined`

성공 경로:

1. 실제 `createDirectory` 또는 `writeFile`
2. file이면 기존 `openExplorerResource(provider, target)` 호출
3. 성공 여부 flag를 `true`로 설정
4. `input.hide()`
5. 기존 `onDidHide`가 pending row를 제거하고 provider를 refresh하고 disposable을 정리

실패 경로:

1. InputBox를 닫지 않음
2. 사용자가 입력한 `input.value` 유지
3. `input.validationMessage`에 아래 정확한 값을 설정

   ```ts
   `Failed to create ${kind}: ${formatOpenError(error)}`
   ```

4. 별도 `showErrorMessage`를 띄우지 않음
5. pending row와 pending name을 유지
6. `input.busy = false`
7. `input.enabled = true`
8. `submitting = false`
9. 사용자가 값을 수정하고 다시 submit할 수 있음

finally 규칙:

- 성공해서 InputBox가 hide된 경우 disposed InputBox 속성을 다시 쓰지 않는다.
- 실패한 경우에만 busy/enabled/submitting을 복구한다.
- 성공 flag를 사용해 두 경로를 명시적으로 분기한다.
- `onDidHide` 첫 줄에서 `hidden = true`로 설정한다.
- 사용자가 작업 도중 InputBox를 닫아 `hidden === true`가 되면 catch/finally에서 InputBox 속성을 쓰지 않는다.

accept handler는 아래 구조와 동일하게 구현한다. 기존 helper 이름만 현재 코드에 맞게 그대로 사용한다.

```ts
input.onDidAccept(async () => {
  if (submitting) return;

  const name = input.value.trim();
  if (!name) {
    input.hide();
    return;
  }

  const validation = validateName(name);
  if (validation) {
    input.validationMessage = validation;
    return;
  }

  const target = vscode.Uri.joinPath(dir, name);
  if (await exists(target)) {
    input.validationMessage = `"${name}" already exists.`;
    return;
  }

  submitting = true;
  input.busy = true;
  input.enabled = false;
  input.validationMessage = undefined;
  let succeeded = false;

  try {
    if (kind === 'file') {
      await vscode.workspace.fs.writeFile(target, new Uint8Array());
      await openExplorerResource(provider, target);
    } else {
      await vscode.workspace.fs.createDirectory(target);
    }
    succeeded = true;
    input.hide();
  } catch (error) {
    if (!hidden) {
      input.validationMessage =
        `Failed to create ${kind}: ${formatOpenError(error)}`;
    }
  } finally {
    if (!succeeded && !hidden) {
      submitting = false;
      input.busy = false;
      input.enabled = true;
    }
  }
});
```

기존 `onDidHide` handler는 첫 줄만 추가하고 나머지 cleanup을 유지한다.

```ts
input.onDidHide(() => {
  hidden = true;
  provider.clearPending();
  for (const disposable of disposables) disposable.dispose();
  input.dispose();
});
```

취소 경로:

- 기존 hide/cancel cleanup 유지
- 파일을 만들지 않음
- pending row가 남지 않음

중복 submit 방지:

- `submitting` guard로 두 번째 accept를 무시한다.
- 파일 시스템 호출 중에는 busy indicator가 보인다.
- 파일 시스템 호출 중에는 입력을 수정할 수 없다.
- 실패하면 같은 InputBox가 다시 활성화된다.

### 11.7 오류 문구 정규화

`src/explorerCommands.ts`에서 사용자에게 보이는 파일 작업 실패 문자열 중 `String(error)`를 직접 쓰는 곳을 `formatOpenError(error)`로 통일한다.

적용 대상:

- create
- delete
- paste/copy-move
- 이 파일 안에서 이미 같은 유틸을 쓰지 않는 기타 파일 작업 오류

규칙:

- 기존 작업명과 대상 label은 유지한다.
- 정상 성공 toast를 추가하지 않는다.
- 테스트가 문자열을 검사하면 새 정규화 문자열로 갱신한다.

### 11.8 Explorer 오류/진행/입력 테스트

필수 테스트:

1. readDirectory failure
   - fs mock이 error throw
   - child 하나
   - `ExplorerErrorNode`
   - 정확한 label/context/icon/id
   - command 없음
   - tooltip에 전체 경로와 정규화 오류
   - accessibility label에 folder와 오류

2. refresh recovery
   - 첫 read 실패
   - cache에 빈 결과가 고정되지 않음
   - 다음 refresh/read 성공
   - 실제 child가 나타남

3. multi-root filtered-empty
   - 두 root 모두 filter match가 없으면 root children `[]`
   - 한 root에만 match가 있으면 그 WorkspaceFolderNode 하나
   - filter clear 후 두 root 모두 복원

4. drag exclusion
   - ErrorNode가 drag URI 목록에 들어가지 않음
   - ErrorNode를 drop target으로 넘기면 destination이 `undefined`
   - single-root fallback이 실행되지 않음

5. withProgress
   - `vscode.window.withProgress` stub으로 options 캡처
   - `location.viewId === 'tabManagerExplorer'`
   - `title === 'Refreshing files…'`
   - 기존 refresh 호출이 callback 안에서 실행

6. create failure
   - fs create/write가 error throw
   - InputBox visible 상태 유지
   - value 유지
   - validationMessage가 정규화 오류
   - showErrorMessage 호출 없음
   - pending row와 pending name 유지
   - busy false, enabled true
   - 중복 accept 동안 fs 호출 1회

7. create retry
   - 첫 submit 실패
   - 같은 InputBox에서 값 수정
   - 두 번째 submit 성공
   - InputBox hide
   - pending row 제거
   - 생성/open 기존 동작 수행

8. create cancel
   - hide 후 pending row 없음
   - fs mutation 없음

9. FileNode accessibility
   - metadata off/on
   - deleted
   - 전체 경로
   - action label

### 11.9 4단계 검사

```bash
npm run check-types
npm test
git diff --check
```

합격 조건:

- read failure와 empty folder가 서로 다른 Tree 결과
- refresh 실패 후 재시도 가능
- create 실패 후 입력값 보존
- 진행 표시가 View 범위
- 새 command와 dependency 없음

---

## 12. 5단계 — Projects 행 소음 감소

수정 파일:

- `src/projectProvider.ts`
- `src/test/suite/tabManager.e2e.test.ts`

### 12.1 위치 helper 분리

현재 전체 경로를 반환하는 `projectDescription` 역할을 둘로 나눈다.

```ts
function projectFullLocation(uri: vscode.Uri): string {
  return uri.scheme === 'file' ? uri.fsPath : uri.toString();
}

function projectCompactLocation(uri: vscode.Uri): string {
  if (uri.scheme === 'file') {
    const parent = path.dirname(uri.fsPath);
    return path.basename(parent) || parent;
  }
  return uri.authority || uri.scheme;
}
```

규칙:

- 화면 description은 `projectCompactLocation`
- tooltip과 경고 메시지는 `projectFullLocation`
- `.code-workspace` label 처리 로직은 유지
- project 저장 URI는 변경하지 않음
- 정렬을 추가하지 않음

### 12.2 ProjectNode 표시

ProjectNode:

- label: 기존 `projectLabel(uri)`
- description: `projectCompactLocation(uri)`
- tooltip:
  1. project label
  2. full location
  3. `Open Project in New Window`
- accessibility label:
  1. project label
  2. full location
  3. `Open Project in New Window`
- 기존 icon, contextValue, command, id 유지

동일 label을 가진 두 프로젝트가 있어도 description과 tooltip/accessibility의 위치로 구분할 수 있어야 한다.

### 12.3 유효하지 않은 프로젝트 경고

`addExistingProjects`의 invalid project 경고는 압축 위치가 아니라 전체 위치를 쓴다.

정확한 형태:

```text
"<full location>" is not a folder or VS Code workspace file.
```

### 12.4 Projects 테스트

필수 assertion:

1. file URI
   - label은 마지막 path segment
   - description은 부모 directory basename
   - description은 전체 절대 경로가 아님
   - tooltip/accessibility는 전체 절대 경로 포함

2. `.code-workspace`
   - label에서 suffix 제거하는 기존 동작 유지
   - description은 부모 directory basename

3. remote URI
   - authority가 있으면 description은 authority
   - authority가 없으면 scheme
   - tooltip은 전체 URI

4. 동일 label, 다른 부모
   - 두 description이 다름
   - 두 accessibility label이 전체 위치로 구분됨

5. 저장 순서와 remove/open 동작
   - 기존 테스트 그대로 통과

### 12.5 5단계 검사

```bash
npm run check-types
npm test
git diff --check
```

합격 조건:

- 행에 전체 절대 경로가 상시 표시되지 않음
- tooltip과 접근성에서 전체 위치 유지
- 저장·open·remove 동작 변화 없음

---

## 13. 6단계 — 문서 갱신

수정 파일:

- `README.md`
- `CHANGELOG.md`

### 13.1 README

기존 기능 목록을 유지하면서 다음 표현만 갱신한다.

1. Extended Explorer의 제목은 workspace 이름이 아니라 `Extended Explorer`라고 설명한다.
2. workspace 이름은 View description에 표시된다고 설명한다.
3. 활성 layout/filter/non-default sort가 View description에 표시된다고 설명한다.
4. filter가 빈 결과를 만들면 Clear Filter가 제공된다고 설명한다.
5. 파일 생성 실패 시 입력을 보존하고 오류를 입력 상자에 표시한다고 설명한다.
6. 새 기능처럼 보이는 제목을 만들지 않는다.
7. command 목록, keyboard shortcut, 기존 기능 설명을 삭제하지 않는다.

문구는 구현 결과를 현재형으로 설명한다. “new”, “brand-new”, “feature” 같은 표현은 쓰지 않는다.

### 13.2 CHANGELOG

파일 맨 위의 기존 형식을 확인한 뒤 `Unreleased` 섹션을 추가한다. 이미 있으면 그 섹션을 사용한다.

항목은 다음 네 줄의 의미만 포함한다.

- Simplified Open Tabs and Extended Explorer header actions.
- Clarified view, filter, sort, empty, loading, and read-error states.
- Improved tab and project row scanning without removing full-path tooltips.
- Improved keyboard and screen-reader state descriptions and inline input error recovery.

새 기능 추가를 암시하지 않는다.

### 13.3 6단계 검사

```bash
rg -n "Workspace|Extended Explorer|Filter|Sort|Clear Filter" README.md CHANGELOG.md
git diff --check
```

합격 조건:

- 문서가 실제 구현과 일치
- workspace 이름이 View title이라고 잘못 설명한 문구 없음
- 새 command나 설정을 문서화하지 않음

---

## 14. 자동 테스트 전체 계약

### 14.1 반드시 유지할 기존 기능 테스트

다음 영역의 기존 테스트는 삭제하거나 약화하지 않는다.

- activation과 command 등록
- 탭 open/close
- 다중 tab close
- 그룹 create/rename/remove
- by-column/merged layout
- 모든 기존 filter
- 모든 기존 sort
- explorer file/folder create
- rename/delete
- copy/cut/paste
- drag-and-drop
- multi-root workspace
- reveal active file
- expand all
- file metadata
- deleted ghost
- comparison
- PR comments
- project add/open/remove
- unsaved/read-only/missing 상태

### 14.2 새 UI 계약 테스트 목록

최종적으로 아래 테스트가 모두 존재해야 한다.

- manifest View 이름
- header navigation 허용 command set
- filter overflow order
- duplicate comparison 제거
- generic clear의 title menu 제거
- viewsWelcome 일곱 상태
- hover delay override 제거
- renderer tooltip notice 제거
- exact View descriptions
- active filter boolean context
- Tab count pluralization
- Tab 상태 우선순위
- 파일명 description 중복 제거
- Tab tooltip/accessibility
- Explorer ErrorNode
- read error recovery
- Explorer refresh View progress
- create InputBox failure/retry/cancel
- FileNode metadata accessibility
- Project compact/full location

### 14.3 assertion 원칙

- 문자열 계약은 exact equality를 쓴다.
- menu group은 exact equality를 쓴다.
- command 집합은 정렬 후 deep equality로 검사한다.
- async UI 상태는 기존 polling helper를 사용한다.
- 단순 통과를 위해 assertion을 `includes`로 약화하지 않는다.
- private API 또는 DOM selector를 새로 사용하지 않는다.
- 실제 VS Code TreeView 공개 API와 기존 Test API를 사용한다.

---

## 15. 기능 QA

기능 QA와 시각 QA는 별도다. 이 절은 기능만 검사한다.

### 15.1 Open Tabs

- 탭 클릭 시 기존 editor open
- 다중 선택 후 close
- inline close
- group 생성·이름 변경·제거
- by-column ↔ merged
- 각 filter 적용·해제
- name asc/desc/clear
- type on/off
- read-only first on/off
- 상태 변경 후 description 즉시 갱신
- 탭 open/close/dirty 변화 후 Tree 갱신
- 긴 파일명과 같은 이름의 파일 구분

### 15.2 Extended Explorer

- workspace 없음
- single-root
- multi-root
- file/folder open
- create 성공
- create 실패 후 retry
- rename
- delete
- copy/cut/paste
- drag-and-drop
- reveal active
- refresh
- expand all
- metadata toggles
- filter apply/clear
- filter empty welcome
- unreadable folder ErrorNode
- refresh 후 recovery

### 15.3 Projects

- empty workspace에서 folder add
- 열린 workspace에서 current workspace add
- folder/workspace file add
- invalid target warning
- open new window
- remove
- 같은 이름, 다른 부모 구분

### 15.4 기능 QA 합격

- 기존 명령의 결과가 변경되지 않음
- 새 command ID 없음
- 새 설정 없음
- 입력 실패를 제외한 기존 modal/toast 정책 변화 없음
- 모든 E2E 통과

---

## 16. 실제 VS Code 시각 QA

빌드 성공은 시각 검증이 아니다. 반드시 Extension Development Host의 실제 Tree View를 눈으로 확인한다.

### 16.1 실행 준비

1. `npm run compile`
2. `.vscode/launch.json`의 기존 Extension launch configuration으로 Development Host 실행
3. 실제 사용자 workspace가 아니라 검사용 임시 workspace 사용
4. 검사용 workspace에 아래 fixture를 만든다.

```text
ui-qa-workspace/
  README.md
  src/
    index.ts
    components/
      VeryLongComponentNameThatMustTruncate.tsx
    한글-파일.ts
  readonly/
    locked.txt
  empty/
  nested/
    level-1/
      level-2/
        duplicate.ts
```

fixture는 저장소 밖 임시 directory에 만든다. 저장소에 커밋하지 않는다.

### 16.2 대표 창 크기와 사이드바 너비

모바일 viewport를 흉내 내지 않는다. native desktop extension이므로 다음 desktop matrix를 쓴다.

| 창 크기 | 사이드바 너비 | 목적 |
|---|---:|---|
| 1280×800 | 240px | 좁은 실제 작업 환경 |
| 1440×900 | 320px | 기본 환경 |
| 1920×1080 | 480px | 넓은 환경 |

각 크기에서 다음을 확인한다.

- View title 중복 없음
- header action wrap 없음
- action이 title을 침범하지 않음
- 행에 불필요한 horizontal scrollbar 없음
- label truncation 정상
- tooltip로 전체 경로 확인 가능
- 중요한 상태 토큰이 좁은 너비에서도 먼저 보임

### 16.3 테마 matrix

다음 세 테마를 모두 확인한다.

- Dark+
- Light+
- Dark High Contrast

확인 항목:

- native file icon 가독성
- error icon 가독성
- selected/focused 행 구분
- hover와 focus ring
- active/unsaved/read-only/missing가 텍스트로도 구분
- 별도 hard-coded color가 없음을 소스 검색으로 재확인

### 16.4 확대와 접근성

다음을 확인한다.

- Zoom 100%
- Zoom 200%
- macOS VoiceOver 또는 VS Code Accessibility Help로 TreeItem label 확인

스크린 리더에서 다음 정보가 읽혀야 한다.

- active column과 tab count
- group과 tab count
- tab full path
- active/unsaved/read-only/missing/preview
- file metadata가 화면에 켜졌을 때 metadata
- project full location
- Explorer read error와 오류 메시지

### 16.5 Open Tabs 상태 matrix

각 행을 실제로 만든 뒤 확인한다.

| 상태 | 데이터 | 확인 |
|---|---|---|
| 완전 empty | 열린 editor 0 | `No tabs are open.` |
| 단일 tab | root file 1 | 파일명 중복 description 없음 |
| dense | tab 50개, column 3개 | 스크롤·밀도·count |
| active | active tab 1 | `active`가 첫 토큰 |
| preview | preview tab | `preview` 표시 |
| unsaved | dirty untitled/file | `unsaved` 표시 |
| read-only | readonly fixture | `read-only` 표시 |
| missing | 열린 뒤 파일 제거 | `missing` 표시 |
| combined | 가능한 상태 조합 | 고정 순서 |
| groups | 0/1/N tab group | pluralization |
| long group | 긴 한글·영문 group명 | truncation + tooltip |
| merged | All Columns | column label 표시 |
| filter match | Modified 등 | View description |
| filter zero | 결과 0 | Clear Filter welcome |
| sort | asc/desc/type/readonly | View description 순서 |

### 16.6 Extended Explorer 상태 matrix

| 상태 | 확인 |
|---|---|
| workspace 없음 | Open Folder welcome |
| normal tree | 파일/폴더 아이콘과 hierarchy |
| dense folder | 스크롤과 header 안정성 |
| long path | label truncation, full tooltip |
| 한글 이름 | 깨짐 없음 |
| RTL 문자가 포함된 이름 | 행 구조가 무너지지 않음 |
| metadata off | 접근성에도 metadata 미포함 |
| metadata on | description과 접근성에 동일 metadata |
| deleted ghost | 시각 표시와 원본 accessibility name |
| filter zero | Clear Filter welcome |
| unreadable folder | ErrorNode, empty와 구분 |
| refresh | View progress 표시 |
| create success | InputBox 정상 종료 |
| create validation | 기존 validation 유지 |
| create FS failure | InputBox/value 유지, inline error |
| create retry | 같은 InputBox에서 성공 |
| create cancel | pending row 없음 |

### 16.7 Projects 상태 matrix

| 상태 | 확인 |
|---|---|
| 0 projects, workspace 없음 | Add Project Folder |
| 0 projects, workspace 있음 | Add Current Workspace + 보조 링크 |
| 1 project | compact parent description |
| 20 projects | 절대 경로 반복 소음 없음 |
| 같은 이름 2개 | 부모 description으로 구분 |
| 긴 경로 | 행은 compact, tooltip은 full |
| `.code-workspace` | suffix 없는 label 유지 |
| remote URI fixture | authority/scheme description |

### 16.8 헤더 action matrix

Open Tabs:

- 선택 없음: Create Group + Layout만
- Tab 선택: Create Group + Close Selected + Layout
- 필터 활성: 필터 icon이 navigation에 추가되지 않음
- Comparison 데이터 있음: comparison은 overflow에만 있음

Extended Explorer:

- workspace 없음: 허용된 `when`에 따라 Refresh만 또는 기존 조건의 최소 set
- workspace 있음: New File + New Folder + Reveal Active + Refresh
- PR data 있음: PR Refresh가 overflow
- collapsed tree 있음: Expand All이 overflow
- 필터 활성: 필터 icon이 navigation에 추가되지 않음

Projects:

- 두 add action만 유지

### 16.9 키보드 matrix

마우스 없이 확인한다.

- View focus
- Up/Down으로 행 이동
- Left/Right로 collapse/expand
- Enter로 open
- Shift+F10으로 context menu
- Cmd/Ctrl 다중 선택
- Shift 범위 선택
- Escape로 QuickPick/InputBox/modal 취소
- 기존 Explorer keybinding
  - new file
  - new folder
  - rename
  - delete
  - copy/cut/paste
- focus가 보이지 않는 상태가 없어야 함
- 키보드로 Clear Filter welcome action에 도달 가능해야 함

### 16.10 시각 QA 결함 수정 규칙

발견한 결함은 다음 범위 안에서만 고친다.

- 문자열 길이
- description 토큰 순서
- tooltip 내용
- accessibility label 내용
- menu group 또는 order
- welcome 조건
- native ThemeIcon 선택

새 UI surface, 설정, 명령, 색, CSS가 필요해 보이면 구현하지 않고 범위 밖으로 기록한다.

### 16.11 시각 QA 증거

최종 보고에 다음을 기록한다.

- 실제 사용한 VS Code 버전
- 확인한 창 크기 3개
- 확인한 테마 3개
- Zoom 100%/200%
- 수행한 keyboard 항목
- 발견하고 수정한 시각 결함
- 미검증 항목이 있으면 정확한 이유

실제 수행하지 않은 viewport, 테마, screen reader 검사를 수행했다고 쓰지 않는다.

---

## 17. 최종 회귀 검사

모든 구현과 시각 수정이 끝난 뒤 저장소 루트에서 순서대로 실행한다.

```bash
npm run check-types
npm test
npm run package
git diff --check
git status --short
git diff --stat
git diff -- package.json src/extension.ts src/tabProvider.ts src/explorerProvider.ts src/explorerCommands.ts src/projectProvider.ts src/test/suite/tabManager.e2e.test.ts README.md CHANGELOG.md
```

프로젝트에 lint script가 없으므로 `npm run lint`를 실행하거나 새 lint dependency를 추가하지 않는다.

### 17.1 최종 정적 검색

```bash
rg -n "Header action tooltips were updated|rendererTooltipSchemaVersion|workbench\.hover\.delay" package.json src README.md
rg -n "filesView\.title|syncExplorerTitle" src
rg -n "\"group\": \"navigation" package.json
rg -n "tabManager\.filter\." package.json
```

기대:

- 첫 검색 결과 0
- 둘째 검색 결과 0
- navigation 검색 결과는 8.3, 8.4, Projects 계약과 일치
- 필터 검색은 command 등록과 overflow/menu 조건에만 있으며 navigation에는 없음

### 17.2 manifest 불변식 검사

기존 테스트 외에 간단한 Node read-only 검사로 확인한다.

- commands length `68`
- views total `3`
- dependency 변화 없음
- engine 변화 없음

검사만 하고 별도 script 파일을 저장소에 추가하지 않는다.

### 17.3 diff 감사

diff를 파일별로 읽고 다음을 확인한다.

- 계획 대상 9개 구현/문서 파일과 이 계획 파일 외 변경 없음
- 무관한 whitespace churn 없음
- generated `dist/extension.js`를 커밋 대상으로 수정하지 않음
- lockfile 변화 없음
- version 변화 없음
- 새 command ID 없음
- 기존 command ID 제거 없음
- 미완성 표식 또는 임시 log 없음
- private path 또는 QA fixture가 문서·테스트 snapshot에 없음

---

## 18. 완료 정의

아래 모든 checkbox가 충족되어야 완료다.

### 범위

- [ ] 새 기능이 추가되지 않았다.
- [ ] command 수가 `68`이다.
- [ ] View 수가 `3`이다.
- [ ] dependency와 engine이 바뀌지 않았다.
- [ ] 저장 데이터 구조가 바뀌지 않았다.

### 정보 구조

- [ ] Extended Explorer 제목이 고정되어 기본 Explorer와 중복되지 않는다.
- [ ] workspace 이름은 Explorer description에 보인다.
- [ ] 필터·정렬·레이아웃이 정해진 문자열로 보인다.
- [ ] Open Tabs header에는 허용된 액션만 보인다.
- [ ] Explorer header에는 허용된 액션만 보인다.
- [ ] 필터는 overflow에 순서대로 보인다.
- [ ] Comparison 메뉴 중복이 없다.

### 행 가독성

- [ ] Tab description에 파일명이 중복되지 않는다.
- [ ] active/unsaved/read-only/missing/preview 순서가 정확하다.
- [ ] count가 `tab/tabs`로 읽힌다.
- [ ] Project 행에는 compact 위치만 보인다.
- [ ] 전체 경로는 tooltip과 접근성에 남아 있다.

### 상태와 복구

- [ ] unfiltered empty와 filtered empty가 구분된다.
- [ ] Explorer empty와 read error가 구분된다.
- [ ] refresh 진행 상태가 보인다.
- [ ] create 실패 후 InputBox와 입력값이 유지된다.
- [ ] create retry와 cancel이 정상이다.
- [ ] routine success toast가 추가되지 않았다.
- [ ] reload 안내 notification이 제거됐다.
- [ ] 전역 hover delay override가 제거됐다.

### 접근성

- [ ] 상태가 색에만 의존하지 않는다.
- [ ] tab 상태와 full path가 accessibility label에 있다.
- [ ] file metadata가 표시 상태와 동일하게 읽힌다.
- [ ] project full location이 읽힌다.
- [ ] error row가 오류를 읽는다.
- [ ] keyboard 작업이 유지된다.
- [ ] High Contrast에서 의미 손실이 없다.

### 검증

- [ ] `npm run check-types` 통과
- [ ] `npm test` 통과
- [ ] `npm run package` 통과
- [ ] `git diff --check` 통과
- [ ] 3개 창 크기 시각 QA 완료
- [ ] 3개 테마 시각 QA 완료
- [ ] Zoom 100%/200% 확인
- [ ] keyboard matrix 확인
- [ ] 수행하지 않은 검사를 사실대로 기록

---

## 19. 커밋 단위

사용자가 커밋을 요청한 경우에만 다음 단위로 커밋한다. 요청이 없으면 커밋하지 않는다.

1. `refactor(ui): simplify view headers and state descriptions`
   - `package.json`
   - `src/extension.ts`
   - 관련 manifest/description 테스트

2. `refactor(ui): improve tree row readability and accessibility`
   - `src/tabProvider.ts`
   - `src/projectProvider.ts`
   - 관련 테스트

3. `fix(ui): clarify explorer progress and recoverable errors`
   - `src/explorerProvider.ts`
   - `src/explorerCommands.ts`
   - 관련 테스트

4. `docs: update tab manager ui guidance`
   - `README.md`
   - `CHANGELOG.md`

커밋을 나누더라도 각 커밋 시점에 typecheck와 관련 테스트가 통과해야 한다.

---

## 20. 최종 보고 형식

구현을 끝낸 모델은 다음 형식을 사용한다.

```markdown
UI와 사용성 개선을 완료했습니다.

- View 정체성/헤더:
- 행 가독성/접근성:
- empty/loading/error/input recovery:
- 새 기능이 추가되지 않았음을 확인한 근거:

검증:
- npm run check-types:
- npm test:
- npm run package:
- git diff --check:
- 실제 VS Code 시각 QA:

남은 제한:
- 없음
```

미검증 항목이 있으면 `남은 제한`에 이름과 이유를 적는다. `없음`은 자동·기능·시각 검증을 모두 실제로 끝냈을 때만 쓴다.

---

## 21. 공식 기준

구현과 QA는 다음 VS Code 공식 문서의 native View 원칙을 따른다.

- [Views UX Guidelines](https://code.visualstudio.com/api/ux-guidelines/views)
  - View 이름은 짧고 설명적이어야 한다.
  - View action을 과도하게 늘리지 않는다.
  - Tree item은 설명적이어야 한다.
  - empty Tree에는 Welcome View를 쓴다.
  - 기존 아이콘과 파일 아이콘을 우선한다.

- [Contribution Points](https://code.visualstudio.com/api/references/contribution-points)
  - `navigation` menu group은 View toolbar에 노출된다.
  - `viewsWelcome`은 Tree가 비었을 때 적용된다.
  - welcome content의 command link를 action으로 사용할 수 있다.

- [When Clause Contexts](https://code.visualstudio.com/api/references/when-clause-contexts)
  - `workbenchState`, `view`, `viewItem`, `focusedView`를 사용한다.
  - extension의 `setContext`로 `tabManager.hasActiveFilter`를 동기화한다.

- [Tree View API Guide](https://code.visualstudio.com/api/extension-guides/tree-view)
  - 기존 `TreeDataProvider`, `TreeItem`, `TreeView` interaction model을 유지한다.

---

## 22. 이 계획에 반영된 전문 검토

### UI Design Workflow

- 기존 제품 UI 감사와 실제 렌더링 검증을 먼저 수행했다.
- 디자인 방향을 `Operate`, host-native, scan-first로 고정했다.
- 기능 QA와 시각 QA를 분리했다.
- empty, filtered-empty, loading, read-error, disabled/input-error, focus, selected, dense, overflow 상태를 계획에 포함했다.

### UI UX Pro Max

- keyboard navigation과 visible focus를 P0/P1 기준에 포함했다.
- active 상태를 색에만 의존하지 않도록 텍스트 계약을 추가했다.
- empty state에 다음 행동을 한 개의 primary action으로 제공했다.
- 성공/오류 피드백과 복구 경로를 분리했다.
- 외부 icon 추천 대신 제품의 기존 Codicon 체계를 유지했다.

### Impeccable

- 정보 밀도와 인지 부하를 줄이는 방향을 적용했다.
- toolbar action을 progressive disclosure로 재배치했다.
- label 중복을 제거하고 status-first description 계층을 고정했다.
- 제품의 native visual language를 깨는 별도 디자인 시스템을 금지했다.

### 적용하지 않은 전문 스킬

- `web-design-guidelines`: 이 제품은 Web UI가 아니라 VS Code native TreeView이므로 적용하지 않았다.
- `vercel-react-best-practices`: React/Next.js 코드가 없으므로 적용하지 않았다.
- `imagegen`: bitmap asset이 필요한 변경이 아니므로 적용하지 않았다.
