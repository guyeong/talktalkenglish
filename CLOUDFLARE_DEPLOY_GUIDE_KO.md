# Cloudflare Pages 무료 배포 안내

이 프로젝트는 Netlify 대신 Cloudflare Pages와 Pages Functions에서 실행할 수 있습니다.

## 1. ElevenLabs 무료 API 키 만들기

1. ElevenLabs 계정을 만듭니다.
2. 왼쪽 메뉴에서 `Developers`를 엽니다.
3. `API Keys`를 선택합니다.
4. 새 API 키를 만듭니다.
5. Text to Speech 권한을 허용합니다.
6. 생성 직후 표시되는 전체 API 키를 안전한 곳에 복사합니다.

API 키는 GitHub 코드, `.env.example`, 브라우저 개발자 도구에 직접 넣지 않습니다.

## 2. ElevenLabs 음성 ID 확인

1. ElevenLabs의 Voices 또는 Voice Library에서 사용할 영어 음성을 선택합니다.
2. 해당 음성의 Voice ID를 복사합니다.
3. 한 개의 음성만 사용할 때는 Cloudflare의 `ELEVENLABS_VOICE_ID`에 넣습니다.

기본 예시 ID가 코드에 있지만, 본인 계정에서 실제로 사용할 수 있는 Voice ID를 설정하는 것을 권장합니다.

## 3. GitHub에 v3.7 적용

기존 GitHub 연결 프로젝트 폴더에 v3.7 파일을 덮어쓴 뒤 실행합니다.

```powershell
npm.cmd run build
git add .
git commit -m "Add ElevenLabs premium narration and Cloudflare deployment"
git push origin main
```

## 4. Cloudflare Pages 프로젝트 만들기

1. Cloudflare 대시보드에 로그인합니다.
2. `Workers & Pages`를 엽니다.
3. `Create` 또는 `Create application`을 누릅니다.
4. `Pages`를 선택합니다.
5. `Connect to Git`을 선택합니다.
6. GitHub 권한을 허용합니다.
7. `guyeong/talktalkenglish` 저장소를 선택합니다.
8. Production branch는 `main`을 선택합니다.

빌드 설정:

- Framework preset: `Vite` 또는 `None`
- Build command: `npm run build`
- Build output directory: `dist`
- Root directory: 비워 둠

이 프로젝트에는 `.nvmrc`가 포함되어 있어 Node.js 22를 사용합니다.

## 5. Cloudflare 환경변수 설정

Cloudflare Pages 프로젝트의 Settings에서 Production과 Preview 환경에 아래 변수를 추가합니다.

```text
GEMINI_API_KEY=기존 Gemini API 키
ELEVENLABS_API_KEY=ElevenLabs API 키
ELEVENLABS_VOICE_ID=선택한 ElevenLabs Voice ID
```

선택 사항:

```text
ELEVENLABS_VOICE_US_FEMALE=...
ELEVENLABS_VOICE_US_MALE=...
ELEVENLABS_VOICE_UK_MALE=...
ELEVENLABS_VOICE_AU_FEMALE=...
```

한 개의 ElevenLabs 음성만 사용할 때는 선택 변수 네 개를 만들 필요가 없습니다.

## 6. 다시 배포

환경변수를 저장한 뒤 Deployments에서 `Retry deployment` 또는 새 배포를 실행합니다.

배포가 성공하면 다음 형식의 주소가 생성됩니다.

```text
https://프로젝트이름.pages.dev
```

앞으로 GitHub `main` 브랜치에 push하면 Cloudflare가 자동으로 다시 배포합니다.

## 7. 기능 확인

1. 새 Cloudflare Pages 주소를 엽니다.
2. 기존 책 또는 테스트 책을 엽니다.
3. 낭독 메뉴에서 `ElevenLabs 프리미엄 연극`을 선택합니다.
4. `전체 읽기`를 누릅니다.
5. 첫 재생은 ElevenLabs에서 MP3를 생성하므로 시간이 조금 걸릴 수 있습니다.
6. 같은 페이지를 두 번째 재생하면 저장된 음성을 사용합니다.

## 8. 무료 사용량을 아끼는 방법

- 같은 페이지는 캐시되므로 반복 생성하지 않습니다.
- 페이지 텍스트를 수정하면 새로운 음성이 생성됩니다.
- ElevenLabs 무료 크레딧이 부족하면 기존 Gemini 또는 기기 음성 모드를 사용합니다.
- Cloudflare Pages 정적 파일 요청은 Functions를 호출하지 않도록 `/api/*`만 Functions 경로로 설정되어 있습니다.

## 9. Netlify 처리

새 Cloudflare 주소에서 OCR, Gemini 음성, ElevenLabs 음성, 발음 평가가 모두 정상 작동하는 것을 확인한 뒤 Netlify 자동 배포를 중지합니다.

기존 Netlify 사이트는 바로 삭제하지 않아도 됩니다. 브라우저 저장 데이터는 도메인별로 분리되므로 기존 책을 옮길 때까지 남겨 두는 편이 안전합니다.
