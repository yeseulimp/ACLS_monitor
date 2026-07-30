# ACLS 시뮬레이터

폰(Operator)으로 리듬·활력징후를 조작하면, 아이패드(Monitor)에 환자 모니터 화면이 실시간으로 반영되는 ACLS 교육용 시뮬레이터입니다.

기기 간 연결은 [PeerJS](https://peerjs.com)(WebRTC)를 사용합니다. 별도 서버를 직접 운영할 필요 없이, PeerJS의 무료 공용 시그널링 서버로 최초 연결만 잡고 그 다음부터는 두 기기가 직접 통신합니다.

---

## 1. 처음 한 번만 하는 준비 (컴퓨터에서)

1. [Node.js](https://nodejs.org) 설치 (LTS 버전이면 충분합니다)
2. 이 폴더를 통째로 컴퓨터에 다운로드
3. 터미널에서 이 폴더로 이동한 뒤:
   ```bash
   npm install
   ```

## 2. 로컬에서 미리 확인해보기 (선택)

```bash
npm run dev
```
터미널에 뜨는 주소(`http://localhost:5173`)를 같은 와이파이의 폰/아이패드 브라우저로 열면 테스트할 수 있어요. (`npm run dev -- --host` 로 실행하면 같은 와이파이의 다른 기기에서도 접속 가능한 주소가 뜹니다.)

## 3. GitHub Pages로 배포하기

### 3-1. GitHub 저장소 만들기
1. GitHub에서 새 저장소 생성 (예: `acls-monitor`)
2. `vite.config.js` 파일을 열어서 `base: "/acls-monitor/"` 부분을 **본인 저장소 이름**으로 맞춰주세요.
   - 저장소 이름이 `my-sim` 이면 → `base: "/my-sim/"`

### 3-2. 코드 올리기
```bash
git init
git add .
git commit -m "first commit"
git branch -M main
git remote add origin https://github.com/내계정/저장소이름.git
git push -u origin main
```

### 3-3. 자동 배포 켜기
1. GitHub 저장소 → **Settings** → **Pages**
2. "Build and deployment" → Source를 **GitHub Actions**로 선택
3. 코드를 `main` 브랜치에 push할 때마다 `.github/workflows/deploy.yml`이 자동으로 빌드 후 배포합니다.
4. 몇 분 뒤 `https://내계정.github.io/저장소이름/` 주소로 접속하면 됩니다.

(원한다면 `npm run deploy` 로 `gh-pages` 패키지를 이용해 수동 배포도 가능합니다.)

---

## 4. 사용 방법

1. 아이패드에서 사이트를 열고 **🖥️ Monitor** 선택 → 화면에 4자리 코드가 표시됩니다.
2. 폰에서 같은 사이트를 열고 **📱 Operator** 선택 → 아이패드에 뜬 코드를 입력하고 "연결"
3. 연결되면 폰 화면 전체가 조작 패널이 되고, 아이패드에는 환자 모니터만 표시됩니다.
4. 제세동기 충전/샷, NIBP 측정, EtCO₂ 연결, Ambu Bagging 버튼은 **아이패드(Monitor) 쪽**에 있습니다 — 실제로도 학생이 환자 옆 장비를 조작하는 것과 같은 구조예요.
5. 혼자 테스트할 땐 **🧪 한 기기에서 모두** 선택.

## 5. 참고 / 문제 해결

- 두 기기가 서로 다른 네트워크(와이파이 vs 데이터)에 있어도 대부분 연결됩니다. 방화벽이 아주 엄격한 기관 와이파이라면 연결이 안 될 수 있어요 — 그럴 땐 두 기기를 같은 와이파이에 두거나 핫스팟을 사용해보세요.
- 연결 상태는 화면 상단 초록/빨강 문구로 계속 표시됩니다.
- 코드는 Monitor 화면을 새로고침할 때마다 새로 발급됩니다. 새로고침했다면 폰에서도 새 코드로 다시 연결해주세요.
- 알람 소리는 브라우저 정책상 화면을 한 번 탭해야 재생이 시작돼요 (Monitor 화면의 "🔕 알람 꺼짐" 버튼).

## 6. 다음에 더 고칠 것 (메모)

- 알람 임계값(고혈압/저혈압 기준 등)을 화면에서 직접 조절할 수 있게 하기
- 시나리오 저장/불러오기 (교육 세트 준비)
- Auto NIBP 주기 반복 측정
