# iPhone/iPad Safari 배포 안내

## 1. GitHub에 프로젝트 올리기

VS Code에서 이 프로젝트 폴더를 열고 터미널에서 실행합니다.

```powershell
git init
git add .
git commit -m "TalkTalk English v2.1"
git branch -M main
git remote remove origin
git remote add origin https://github.com/guyeong/talktalkenglish.git
git push -u origin main --force
```

기존 GitHub 파일을 보존해야 한다면 마지막 명령에서 `--force`를 사용하지 마세요.

## 2. Netlify 연결

1. Netlify 로그인
2. **Add new site → Import an existing project**
3. GitHub 선택
4. `guyeong/talktalkenglish` 선택
5. 빌드 설정은 `netlify.toml`에서 자동으로 읽습니다.

- Build command: `npm run build`
- Publish directory: `dist`
- Functions directory: `netlify/functions`

## 3. Gemini 키 설정

Netlify 사이트에서 다음으로 이동합니다.

**Site configuration → Environment variables → Add a variable**

- Key: `GEMINI_API_KEY`
- Value: 새 Gemini API 키

저장한 뒤 **Deploys → Trigger deploy → Deploy site**를 실행합니다.

## 4. iPhone/iPad에서 사용

1. Netlify가 만든 `https://...netlify.app` 주소를 Safari에서 엽니다.
2. Safari 공유 버튼을 누릅니다.
3. **홈 화면에 추가**를 누릅니다.
4. 생성된 `TalkTalk English` 아이콘으로 실행합니다.

카카오톡/네이버 내부 브라우저가 아니라 Safari에서 여는 것이 중요합니다.

## 5. 업데이트

코드를 GitHub에 다시 push하면 Netlify가 자동으로 새 버전을 배포합니다.


## v2.3 업데이트를 GitHub와 Netlify에 반영하기

1. 이 ZIP을 새 폴더에 압축 해제합니다.
2. 기존 GitHub 로컬 폴더 `talktalkenglish` 안의 `.git` 폴더는 그대로 둡니다.
3. 새 폴더의 파일을 기존 `talktalkenglish` 폴더에 모두 복사하여 덮어씁니다.
4. `.env`, `node_modules`, `.netlify`, `dist`는 복사하거나 GitHub에 올리지 않습니다.
5. VS Code로 기존 `talktalkenglish` 폴더를 엽니다.
6. 터미널에서 다음을 실행합니다.

```powershell
git status
git add .
git commit -m "Add pronunciation evaluation v2.3"
git push origin main
```

7. GitHub의 `guyeong/talktalkenglish`에서 최신 커밋을 확인합니다.
8. Netlify의 Deploys 메뉴에서 자동 배포가 `Published`가 될 때까지 기다립니다.
9. 실패하면 Deploy log를 확인하고, 필요하면 `Trigger deploy` → `Clear cache and deploy site`를 실행합니다.
10. 아이폰 Safari에서 배포 주소를 다시 열고 새로고침합니다. 홈 화면 앱이 이전 버전이면 앱을 완전히 종료했다가 다시 열거나 Safari 사이트 데이터를 지운 뒤 홈 화면에 다시 추가합니다.

## 마이크 권한

- 로컬: `http://localhost:8888`에서 사용 가능합니다.
- 아이폰/아이패드: 반드시 Netlify의 HTTPS 주소로 접속해야 합니다.
- 최초 따라 읽기 평가 시 Safari가 마이크 권한을 물으면 `허용`을 누릅니다.
- 거부한 경우 Safari 주소창의 페이지 설정 → 마이크 → 허용으로 변경합니다.


## v2.5 마이크 권한 중요 확인

`netlify.toml`의 Permissions-Policy가 `microphone=(self)`로 설정되어 있어야 합니다.
이전 버전의 `microphone=()`는 모든 브라우저에서 마이크를 강제로 차단합니다.

배포 후 기존에 마이크를 거부한 경우:
- iPhone/iPad Safari: 주소창 왼쪽의 페이지 메뉴 → 웹사이트 설정 → 마이크 → 허용
- Chrome/Edge: 주소창 자물쇠 아이콘 → 사이트 설정 → 마이크 → 허용
그 뒤 페이지를 완전히 새로고침하세요.

## v3.1 배포 후 확인
1. Netlify에서 `Deploy project without cache`를 실행합니다.
2. PC에서 `Ctrl + Shift + R`로 새로고침합니다.
3. 읽기 도구가 책 사진 위에 모두 보이는지 확인합니다.
4. iPhone에서 HEIC 또는 HEIF 사진을 선택하면 `사진 준비 중`이 표시된 뒤 미리보기가 나타나는지 확인합니다.
5. 홈 화면 앱이 이전 화면을 보이면 기존 아이콘을 삭제하고 Safari에서 다시 홈 화면에 추가합니다.
