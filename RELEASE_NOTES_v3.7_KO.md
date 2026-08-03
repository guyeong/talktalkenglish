# TalkTalk English v3.7

## 변경 범위

기존 Gemini OCR, Gemini 감정 낭독, 기기 음성, 따라 읽기, 발음 평가, 퀴즈, 백업 기능은 그대로 유지했습니다.

이번 버전에서 추가된 기능은 다음 두 가지입니다.

1. ElevenLabs Eleven v3 기반 `ElevenLabs 프리미엄 연극` 낭독 모드
2. Netlify 대신 사용할 수 있는 Cloudflare Pages + Pages Functions 배포 구조

## ElevenLabs 프리미엄 연극 낭독

낭독 선택 메뉴에 다음 항목이 추가됩니다.

- ElevenLabs 프리미엄 연극

특징:

- Eleven v3 모델 사용
- 속삭임, 놀람, 긴장, 기쁨, 외침 등을 오디오 태그로 강화
- 한 페이지 전체를 한 번 생성하고 IndexedDB에 저장
- 같은 페이지를 다시 읽으면 ElevenLabs API를 다시 호출하지 않음
- 속도 변경은 저장된 MP3의 재생 속도만 변경
- 무료 크레딧이나 요청 제한에 도달하면 기기 음성으로 자동 전환

## Cloudflare Pages 배포

루트 `functions/api` 폴더에 다음 Pages Functions가 추가되었습니다.

- `/api/analyze`: Gemini OCR
- `/api/evaluate`: Gemini 발음 평가
- `/api/tts`: Gemini 감정 TTS
- `/api/elevenlabs-tts`: ElevenLabs Eleven v3 프리미엄 연극 낭독

정적 파일은 Functions 요청으로 계산되지 않도록 `public/_routes.json`에서 `/api/*` 경로만 Functions가 실행되도록 제한했습니다.

## 필요한 Cloudflare 환경변수

필수:

- `GEMINI_API_KEY`
- `ELEVENLABS_API_KEY`
- `ELEVENLABS_VOICE_ID`

선택:

- `ELEVENLABS_VOICE_US_FEMALE`
- `ELEVENLABS_VOICE_US_MALE`
- `ELEVENLABS_VOICE_UK_MALE`
- `ELEVENLABS_VOICE_AU_FEMALE`

선택 음성 ID가 없으면 `ELEVENLABS_VOICE_ID` 하나를 모든 프리미엄 낭독에 사용합니다.
