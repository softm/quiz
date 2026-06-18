# OCR 로직 정리

이 문서는 현재 풀이 화면과 위치맵 생성에서 문제지 PDF를 읽어 `문제 앵커`, `문항 앵커`, `문항 영역`을 만드는 흐름을 정리한다.

## 기본 원칙

- 위치맵이 없어도 OCR 가능한 기본 문제지는 런타임에서 현재 PDF를 읽어 동작해야 한다.
- 여기서 OCR은 기본적으로 브라우저의 PDF.js `getTextContent()`로 얻는 PDF 텍스트 레이어 분석을 말한다.
- Tesseract 이미지 OCR은 런타임의 보조 fallback이다. 매번 기본으로 돌리는 방식이 아니라, PDF.js 텍스트 분석으로 문제 시작점을 충분히 찾지 못할 때 제한적으로 사용한다.
- 저장된 위치맵은 성능과 보정값 유지용이다. 런타임 분석을 완전히 대체하는 필수 조건이 아니다.
- 수동 보정값은 자동 계산보다 우선한다. 사용자가 삭제한 문항 영역은 hidden marker로 취급해 자동 영역이 다시 보이지 않게 한다.

## 기준 문서 구분

- `2022`: `농산물품질관리사 / 2022년 제19회 농산물품질관리사 1차`를 뜻한다. 이 문서는 위치맵 없이 PDF.js 텍스트 레이어를 런타임 분석해서 문제 앵커, 문항 앵커, 문항 영역이 동작해야 하는 기준 문서다.
- `2023`: `농산물품질관리사 / 2023년 제20회 농산물품질관리사 1차`를 뜻한다. 이 문서는 위치맵 생성 결과를 기준으로 1단 문항 영역 품질을 검증하는 기준 문서다.
- `2014`: `방통대 / 모바일앱프로그래밍 / [기출문제] [2014.1학기 기말시험] 모바일앱프로그래밍`을 뜻한다. 이 문서는 위치맵 생성 결과를 기준으로 2단, 연속 문항, 이미지/코드 포함 문항을 검증하는 기준 문서다.

## 앵커

### 문제 앵커

문제 앵커는 문제 번호 위치를 뜻한다. 화면 crop, 전체보기 스크롤 활성화, 문항 앵커 탐색 범위의 기준이 된다.

### 런타임 문제 앵커 분석

런타임에서는 `quiz.html`에서 PDF.js로 문제 PDF를 열고 각 페이지의 텍스트 레이어를 읽는다.

주요 흐름:

1. `ensurePdfDocument()`가 PDF.js로 문제 PDF를 로드한다.
2. `getQuestionPageTextLayer(pageNo)`가 `page.getTextContent()` 결과를 캐시한다.
3. 텍스트 item을 줄 단위로 정렬하고, 줄 시작의 `1.`, `36.` 같은 문제 번호 패턴을 찾는다.
4. 머리말/꼬리말 영역은 제외한다.
5. 인쇄 문제 번호를 내부 문항 번호로 변환한다.
6. 페이지별 문제 시작 y ratio를 `questionTopRatioMap`처럼 사용한다.
7. 찾은 문제 시작점과 다음 문제 시작점 사이를 현재 문제의 기본 범위로 본다.

문제 번호 탐색의 기본 원칙은 `문제 q 시작점 ~ 문제 q+1 시작점`이다. 2단 문서에서는 같은 페이지라도 왼쪽 단과 오른쪽 단을 별도 흐름으로 보고, `questionSegments`와 `questionColumnBoundsMap`으로 단 범위를 제한한다.

### Tesseract fallback

PDF.js 텍스트 레이어로 충분한 문제 번호를 찾지 못할 때 `getOcrQuestionStartRatiosForPage()`가 Tesseract를 사용한다.

동작:

- PDF 페이지를 캔버스로 렌더링한다.
- `kor+eng`로 이미지 OCR을 수행한다.
- OCR word bbox를 줄로 묶는다.
- 줄 시작 문제 번호를 찾아 y ratio를 보강한다.

이 경로는 느리기 때문에 기본 경로가 아니라 보조 경로다.

### 위치맵 생성 문제 앵커

`scripts/anchor-ocr.mjs`는 Node에서 실행되는 위치맵 생성기다.

주요 흐름:

1. PDF 페이지를 이미지로 렌더링한다.
2. OCR/텍스트 후보에서 문제 번호 후보를 만든다.
3. 문제 번호 후보를 페이지, 단, y 위치 순서로 정렬한다.
4. 누락된 문제 번호는 인접 문제 흐름으로 보정한다.
5. `questionPageMap`, `questionTopRatioMap`, `questionLabelMap`을 만든다.
6. `questionColumnBoundsMap`으로 1단/2단의 좌우 범위를 저장한다.
7. `questionSegments`로 각 문제의 실제 유효 영역을 저장한다.

`questionSegments`는 문제 시작선부터 다음 문제 시작선 전까지가 기본이다. 2단에서 문항이 단이나 페이지를 넘어 이어지는 경우 continuation segment가 붙을 수 있다.

### 문항 앵커

문항 앵커는 선택지 `①`, `②`, `③`, `④`, `⑤`의 원 또는 숫자 위치를 뜻한다.

런타임 문항 앵커 탐색 흐름:

1. 현재 문제의 페이지와 segment 범위를 구한다.
2. 같은 문제 범위 안에서 PDF.js 텍스트 item을 읽는다.
3. `①②③④⑤`, `1)`, `(1)` 같은 선택지 토큰을 찾는다.
4. 찾은 토큰을 `choice`별로 하나씩 고른다.
5. 일부 선택지가 누락되면 약한 숫자 토큰을 위치 제약으로 보강한다.
6. 그래도 부족하면 저장된 수동/image 앵커를 보완값으로 병합한다.
7. 그래도 부족하면 `questionSegments` 기반 fallback 앵커를 만든다.

문항 앵커 탐색도 기본적으로 `현재 문제 segment 내부`에서만 한다. 다음 문제 segment 안의 토큰은 현재 문항 앵커로 보지 않는다.

### 문항 앵커 source 의미

- `manual-*`: 사용자가 직접 찍은 앵커. 편집/저장 대상이며 최우선이다.
- `text-choice-anchor`: PDF.js 텍스트 레이어에서 찾은 선택지 앵커.
- `text-choice-anchor-weak`: 단독 숫자 등 약한 후보에서 보강한 앵커.
- `anchor-ocr-token`: 위치맵 생성에서 OCR 토큰으로 찾은 앵커.
- `anchor-image-*`: 위치맵 생성에서 이미지/원형 후보로 찾은 앵커.
- `segment-choice-anchor*`: 선택지 토큰을 못 찾았을 때 문제 segment 구조로 추정한 fallback 앵커.

`segment-*`, `pdf-*`, `ocr-*`, `inferred:true` 앵커는 편집 가능한 저장 앵커로 취급하지 않는다. 표시와 클릭 계산의 보조 기준으로만 사용한다.

## 문항 영역

### 문항 영역의 의미

문항 영역은 선택지 텍스트를 클릭할 수 있는 사각 영역이다. `choiceClickAreaMap`에 저장되는 값은 클릭 판정용 geometry이며, 문항 활성화 표시 geometry와는 목적이 다르다.

문항 영역은 선택지 원 자체가 아니라 `문항 앵커 원 오른쪽 바깥`에서 시작해 선택지 텍스트 끝까지 잡는 것이 목표다.

### 우선순위

화면에서 문항 영역을 구할 때 우선순위는 다음과 같다.

1. hidden marker: 사용자가 삭제한 영역. 이 choice는 영역 없음으로 처리한다.
2. `manual-click-area`: 사용자가 직접 만든/수정한 수동 영역.
3. 런타임 자동 계산 영역: 현재 PDF와 문항 앵커를 기반으로 즉시 계산한다.
4. `generated-click-area-anchor-text`: 위치맵 생성에서 저장한 자동 기준 영역.

수동 영역과 hidden marker만 자동 계산을 막는다. generated 영역은 기준값이지만, 런타임 자동 계산이 가능하면 런타임 계산을 우선한다.

### 런타임 문항 영역 계산

런타임에서는 `getChoiceClickAreaCanvasRects()`가 현재 문항의 표시 영역을 결정한다.

주요 흐름:

1. 현재 문항의 문항 앵커 points를 만든다.
2. 문항 앵커 source가 신뢰 가능한지 확인한다.
3. 각 문항 앵커를 행으로 묶는다.
4. 행 배치가 가로형, 세로형, 2x2 grid인지 추정한다.
5. 각 선택지별로 사각 영역을 만든다.
6. 텍스트 픽셀 탐색이 가능한 경우 `buildChoiceClickAreaRectFromAnchorText()`로 텍스트 끝까지 영역을 맞춘다.
7. 텍스트 픽셀 탐색이 실패하면 행/다음 앵커/segment 경계 기반 fallback 영역을 만든다.

### 문항 앵커 기준 초기 영역

문항 영역의 기본 계산 기준은 다음과 같다.

- X 시작점: 문항 앵커 원 오른쪽 바깥에서 시작한다.
- Y 시작점: `앵커 중심 y - 반지름 * 0.9`
- Y 끝점: `앵커 중심 y + 반지름 * 0.9`
- X 끝점: 선택지 텍스트의 실제 dark pixel 오른쪽 끝에 margin을 더한 위치
- X 제한: 다음 선택지 앵커, 같은 문제 segment 오른쪽, 같은 단 column 오른쪽을 넘지 않는다.
- Y 제한: 다음 선택지 row 직전, 같은 문제 segment bottom을 넘지 않는다.

즉, 기본 높이는 앵커 원의 상위 5% 안쪽부터 하위 5% 안쪽까지다. 단일 행/짧은 선택지는 이 기본 높이를 유지한다.

### 여러 줄 선택지 보완

세로형 선택지나 긴 선택지에서 텍스트가 두 줄 이상이면 높이를 확장한다.

확장 조건:

- 실제 텍스트 픽셀 bounding box가 여러 줄로 판단될 때
- 다음 선택지 row 전까지 공간이 있을 때
- 현재 문제 segment bottom을 넘지 않을 때

확장 방식:

- scan 영역을 다음 보기 직전까지 넓힌다.
- 긴 가로선/세로선은 텍스트 픽셀로 보지 않도록 제외한다.
- 텍스트 픽셀의 하단까지 포함하되, 다음 문제나 다른 단으로 넘어가지 않는다.

### 위치맵 생성 문항 영역

Node 위치맵 생성에서는 `scripts/anchor-ocr.mjs`의 `buildPreciseChoiceClickAreaMapFromRenderedPages()`가 문항 영역을 만든다.

주요 흐름:

1. 이미 만든 `choiceAnchorMap`, `questionSegments`, `questionColumnBoundsMap`을 입력으로 받는다.
2. 렌더된 페이지 PNG를 Pillow로 읽는다.
3. 문항 앵커 원 오른쪽에서 선택지 텍스트 dark pixel을 탐색한다.
4. 텍스트 끝까지의 영역을 `generated-click-area-anchor-text`로 저장한다.
5. 텍스트 픽셀 탐색 실패 시 낮은 품질 영역은 억지로 만들지 않는다.
6. 일부 choice만 실패하면 형제 choice의 폭/높이 median으로 제한적으로 보완한다.

예전 `buildChoiceClickAreaMap()`에는 `generated-click-area` 방식이 남아 있지만, 현재 위치맵 생성 메인 흐름은 렌더 PNG 기반 `generated-click-area-anchor-text`를 사용한다.

### 문항 영역 source 의미

- `manual-click-area`: 사용자가 직접 만든 영역.
- `manual-click-area-hidden`: 사용자가 삭제한 영역. 자동 영역 재생성을 막는다.
- `auto-click-area`: 런타임에서 현재 화면 기준으로 계산한 영역.
- `auto-click-area-text-fit`: 문항 앵커 옆 텍스트 픽셀 끝 기준으로 맞춘 런타임 영역.
- `auto-click-area-anchor-fallback`: 텍스트 픽셀 탐색 실패 시 앵커/행 경계 기준 fallback 영역.
- `generated-click-area-anchor-text`: 위치맵 생성 시 렌더 PNG 픽셀 탐색으로 만든 기준 영역.

### 2단/연속 문항 처리

2단 문서에서는 문제와 선택지의 유효 범위를 column 기준으로 제한한다.

- 왼쪽 단 문제는 왼쪽 단 segment 안에서 문항 앵커와 문항 영역을 찾는다.
- 오른쪽 단 문제는 오른쪽 단 segment 안에서 찾는다.
- 왼쪽 단에서 시작해 오른쪽 단으로 이어지는 문항, 또는 오른쪽 단에서 다음 페이지 왼쪽 단으로 이어지는 문항은 continuation segment를 통해 같은 문항으로 취급한다.
- 스크롤 활성화와 문항 영역 편집은 continuation segment를 같은 문항의 유효 범위로 본다.

### 현재 주의점

- PDF.js 텍스트 레이어가 있는 문서는 위치맵 없이도 동작해야 한다.
- 이미지 OCR(Tesseract)은 느리므로 상시 실행 기준으로 삼지 않는다.
- 문항 영역 품질은 문항 앵커 품질에 크게 의존한다.
- 문항 앵커가 segment fallback으로만 생성된 경우 실제 선택지 텍스트 위치와 어긋날 수 있으므로, 텍스트 픽셀 탐색과 행/단 경계 제한이 같이 필요하다.
- 저장된 generated 영역이 화면 품질을 낮추는 경우 런타임 자동 계산이 우선되어야 한다.
