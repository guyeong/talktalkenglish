# TalkTalk English v2.5

- Netlify `Permissions-Policy`에서 마이크를 차단하던 설정을 `microphone=(self)`로 수정했습니다.
- Safari, Chrome, Edge에서 따라 읽기 버튼을 누르면 마이크 권한 요청이 정상적으로 표시됩니다.
- 이미 거부한 사이트는 브라우저 사이트 설정에서 마이크를 다시 허용해야 합니다.
- Gemini 오디오와 브라우저 음성의 일시정지/계속 읽기 로직을 보강했습니다.
- Safari가 `resume()`을 무시하거나 오디오 상태를 잃으면 현재 읽던 문장/내용을 자동 재시작합니다.
