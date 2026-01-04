const API_BASE = 'https://sake-import-checker.sake-checker-taeju.workers.dev';
let authToken = '';

// 업로드 제어 변수
let isUploadCancelled = false;
let currentRetryAttempt = 0;
let maxRetryAttempts = 5;

async function login() {
  const password = document.getElementById('password-input').value;
  if (!password) { alert('비밀번호를 입력하세요'); return; }

  const loginBtn = document.querySelector('#auth-screen button');
  loginBtn.disabled = true;
  loginBtn.textContent = '확인 중...';

  try {
    const response = await fetch(`${API_BASE}/admin/stats`, {
      headers: { 'Authorization': `Bearer ${password}` },
    });
    if (response.ok) {
      authToken = password;
      document.getElementById('auth-screen').classList.add('hidden');
      document.getElementById('main-screen').classList.remove('hidden');
      loadStats();
    } else {
      alert('비밀번호가 틀렸습니다.');
    }
  } catch (error) {
    alert('서버 연결 실패');
  } finally {
    loginBtn.disabled = false;
    loginBtn.textContent = '로그인';
  }
}

async function loadStats() {
  try {
    const response = await fetch(`${API_BASE}/admin/stats`, {
      headers: { 'Authorization': `Bearer ${authToken}` },
    });
    if (!response.ok) return;
    const data = await response.json();
    if (data && data.length > 0) {
      document.getElementById('total-records').textContent = data[0].total_products?.toLocaleString() || '0';
      document.getElementById('last-update').textContent = data[0].last_updated
        ? new Date(data[0].last_updated).toLocaleString('ko-KR') : '-';
    }
  } catch (error) { console.error('Stats error:', error); }
}

function getUploadMode() {
  const selected = document.querySelector('input[name="upload-mode"]:checked');
  return selected ? selected.value : 'smart';
}

function handleFileSelect(event) {
  const file = event.target.files[0];
  if (file && file.name.endsWith('.xlsx')) processExcelFile(file);
  else alert('xlsx 파일만 업로드 가능합니다');
}

// ============================================
// 자동 재시도 함수 (지수 백오프)
// ============================================
async function fetchWithRetry(url, options, onRetry = null) {
  for (let attempt = 0; attempt < maxRetryAttempts; attempt++) {
    // 취소 확인
    if (isUploadCancelled) {
      throw new Error('업로드가 취소되었습니다');
    }

    try {
      const response = await fetch(url, options);

      if (response.ok) {
        currentRetryAttempt = 0; // 성공 시 초기화
        return response;
      }

      // 서버 에러 (5xx) 시 재시도
      if (response.status >= 500) {
        const errorText = await response.text();
        throw new Error(`Server error ${response.status}: ${errorText}`);
      }

      // 클라이언트 에러 (4xx) 시 즉시 반환 (재시도 안 함)
      return response;

    } catch (error) {
      currentRetryAttempt = attempt + 1;

      // 취소된 경우 즉시 종료
      if (isUploadCancelled) {
        throw new Error('업로드가 취소되었습니다');
      }

      // 마지막 시도면 에러 throw
      if (attempt >= maxRetryAttempts - 1) {
        currentRetryAttempt = 0;
        throw error;
      }

      // 지수 백오프: 2초, 4초, 8초, 16초, 32초
      const delay = 2000 * Math.pow(2, attempt);
      console.log(`[RETRY] Attempt ${attempt + 1}/${maxRetryAttempts} failed, retrying in ${delay/1000}s...`);
      console.log(`[RETRY] Error:`, error.message);

      // 재시도 상태 UI 업데이트
      if (onRetry) {
        onRetry(attempt + 1, maxRetryAttempts, delay);
      }

      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// 전역 변수로 진행 상태 저장
let lastProcessedIndex = 0;
let lastTotalUpdated = 0;
let lastTotalInserted = 0;
let currentFile = null;

function resetUploadUI() {
  document.getElementById('progress-container').classList.add('hidden');
  document.getElementById('retry-container').classList.add('hidden');
  document.getElementById('stop-container').classList.add('hidden');
  document.getElementById('progress-bar').style.width = '0%';
  document.getElementById('progress-text').textContent = '0/0 (0%)';
  document.getElementById('file-input').value = '';
  // 진행 상태 초기화
  lastProcessedIndex = 0;
  lastTotalUpdated = 0;
  lastTotalInserted = 0;
  isUploadCancelled = false;
  currentRetryAttempt = 0;
  currentFile = null;
}

function stopUpload() {
  isUploadCancelled = true;
  updateProgress(lastProcessedIndex, 0, 'stopped');
}

async function processExcelFile(file, isRetry = false) {
  // 재시도 시 UI 초기화
  document.getElementById('retry-container').classList.add('hidden');
  isUploadCancelled = false;
  currentFile = file;

  const mode = getUploadMode();

  // 첫 시도(isRetry=false)인데 Reset 모드면 확인 창 띄우기
  if (!isRetry && mode === 'reset') {
    const confirmed = confirm(
      '⚠️ 전체 초기화 모드입니다.\n\n' +
      '• 기존 데이터가 모두 삭제됩니다.\n' +
      '• API 할당량을 초과하면 중간에 멈출 수 있습니다.\n\n' +
      '정말 계속하시겠습니까?'
    );
    if (!confirmed) {
      document.getElementById('file-input').value = '';
      return;
    }
  }

  const progressContainer = document.getElementById('progress-container');
  progressContainer.classList.remove('hidden');

  // 중지 버튼 표시
  showStopButton();

  // 재시도면 저장된 값에서 시작, 아니면 0부터 시작
  let processed = isRetry ? lastProcessedIndex : 0;
  let totalUpdated = isRetry ? lastTotalUpdated : 0;
  let totalInserted = isRetry ? lastTotalInserted : 0;

  try {
    const arrayBuffer = await file.arrayBuffer();
    const workbook = XLSX.read(arrayBuffer, { type: 'array' });
    const sheetName = workbook.SheetNames.includes('제품별_합산') ? '제품별_합산' : workbook.SheetNames[0];
    const data = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);

    if (!data.length) { alert('빈 파일입니다'); resetUploadUI(); return; }

    const firstRow = data[0];
    if (!('Product Name (KR)' in firstRow)) {
      alert('필수 컬럼이 없습니다: Product Name (KR)');
      resetUploadUI();
      return;
    }

    updateProgress(processed, data.length, isRetry ? 'processing' : 'init');

    // 첫 시작이고 Reset 모드면 초기화 API 호출
    if (!isRetry && mode === 'reset') {
      updateProgress(0, data.length, 'deleting');
      const initRes = await fetchWithRetry(
        `${API_BASE}/admin/upload-init`,
        {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${authToken}` }
        },
        (attempt, max, delay) => updateProgress(0, data.length, 'retrying', attempt, max)
      );
      if (!initRes.ok) throw new Error('초기화 실패');
    }

    // 속도 최적화: 자동 재시도로 실패 복구 가능하므로 더 공격적인 설정
    const BATCH_SIZE = 50;          // 더 큰 배치
    const MAX_CONCURRENT = 3;       // 병렬 처리

    // i를 processed부터 시작 (이어하기)
    for (let i = processed; i < data.length; i += BATCH_SIZE * MAX_CONCURRENT) {
      // 취소 확인
      if (isUploadCancelled) {
        throw new Error('업로드가 취소되었습니다');
      }

      // Create batch of batches (up to MAX_CONCURRENT)
      const batchPromises = [];
      const batchStarts = [];

      for (let j = 0; j < MAX_CONCURRENT && i + j * BATCH_SIZE < data.length; j++) {
        const start = i + j * BATCH_SIZE;
        const chunk = data.slice(start, start + BATCH_SIZE);
        batchStarts.push(start);

        batchPromises.push(
          fetchWithRetry(
            `${API_BASE}/admin/upload-chunk`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authToken}`
              },
              body: JSON.stringify({ data: chunk })
            },
            (attempt, max, delay) => {
              updateProgress(processed, data.length, 'retrying', attempt, max);
            }
          ).then(async res => {
            if (!res.ok) {
              const err = await res.json();
              throw new Error(err.error || 'Chunk upload failed');
            }
            return res.json();
          })
        );
      }

      // Wait for all parallel batches to complete
      const results = await Promise.allSettled(batchPromises);

      // Process results
      let allSucceeded = true;
      for (let j = 0; j < results.length; j++) {
        if (results[j].status === 'fulfilled') {
          const result = results[j].value;
          totalUpdated += result.updated || 0;
          totalInserted += result.inserted || 0;
          processed += Math.min(BATCH_SIZE, data.length - batchStarts[j]);

          lastProcessedIndex = processed;
          lastTotalUpdated = totalUpdated;
          lastTotalInserted = totalInserted;
        } else {
          // One batch failed after all retries
          allSucceeded = false;
          console.error(`Batch at index ${batchStarts[j]} failed:`, results[j].reason);
          throw results[j].reason;
        }
      }

      updateProgress(processed, data.length, 'processing');
      updateProgressDetail(totalUpdated, totalInserted);

      // Small delay between waves
      if (i + BATCH_SIZE * MAX_CONCURRENT < data.length) {
        await new Promise(r => setTimeout(r, 300));
      }
    }

    // 중지 버튼 숨기기
    document.getElementById('stop-container').classList.add('hidden');

    updateProgress(data.length, data.length, 'complete');
    updateProgressDetail(totalUpdated, totalInserted);
    loadStats();

    setTimeout(() => {
      alert(`업로드 완료!\n\n• 업데이트: ${totalUpdated}개\n• 신규 추가: ${totalInserted}개`);
      resetUploadUI();
    }, 500);

  } catch (error) {
    console.error(error);

    // 중지 버튼 숨기기
    document.getElementById('stop-container').classList.add('hidden');

    if (isUploadCancelled) {
      updateProgress(processed, 0, 'stopped');
      // 이어하기 버튼 표시
      showRetryButton(file);
    } else {
      alert(`오류 발생 (${processed}개 처리 후 중단): ` + error.message);
      updateProgress(processed, 0, 'error');
      // 이어하기 버튼 표시
      showRetryButton(file);
    }
  }
}

function showStopButton() {
  let container = document.getElementById('stop-container');

  // 컨테이너가 없으면 생성
  if (!container) {
    container = document.createElement('div');
    container.id = 'stop-container';
    container.className = 'mt-4 text-center';
    container.innerHTML = `
      <button id="stop-btn" class="px-4 py-2 bg-red-500 text-white rounded hover:bg-red-600">
        ⏹️ 업로드 중지
      </button>
    `;
    document.getElementById('progress-container').appendChild(container);
  }

  container.classList.remove('hidden');

  const stopBtn = document.getElementById('stop-btn');
  const newStopBtn = stopBtn.cloneNode(true);
  stopBtn.parentNode.replaceChild(newStopBtn, stopBtn);

  newStopBtn.addEventListener('click', () => {
    stopUpload();
  });
}

function showRetryButton(file) {
  const container = document.getElementById('retry-container');
  container.classList.remove('hidden');

  const oldBtn = document.getElementById('retry-btn');
  const newBtn = oldBtn.cloneNode(true);

  // 버튼 텍스트 변경: "이어하기" vs "다시 시도"
  newBtn.textContent = lastProcessedIndex > 0 ? `🔄 이어하기 (${lastProcessedIndex}번부터)` : '🔄 다시 시도';

  oldBtn.parentNode.replaceChild(newBtn, oldBtn);

  newBtn.addEventListener('click', () => {
    processExcelFile(file, true);
  });

  const cancelBtn = document.getElementById('cancel-retry-btn');
  const newCancelBtn = cancelBtn.cloneNode(true);
  cancelBtn.parentNode.replaceChild(newCancelBtn, cancelBtn);

  newCancelBtn.addEventListener('click', () => {
    resetUploadUI();
  });
}

function updateProgress(current, total, status, retryAttempt = 0, maxRetry = 0) {
  const percent = total > 0 ? Math.round((current / total) * 100) : 0;
  const bar = document.getElementById('progress-bar');
  const text = document.getElementById('progress-text');
  const statusEl = document.getElementById('progress-status');

  if (bar) bar.style.width = percent + '%';
  if (text) text.textContent = current + '/' + total + ' (' + percent + '%)';
  if (statusEl) {
    if (status === 'init') {
      statusEl.textContent = '파일 분석 중...';
      statusEl.className = 'text-sm text-blue-600';
    }
    else if (status === 'deleting') {
      statusEl.textContent = '기존 데이터 삭제 중...';
      statusEl.className = 'text-sm text-orange-600';
    }
    else if (status === 'processing') {
      statusEl.textContent = '데이터 동기화 중...';
      statusEl.className = 'text-sm text-blue-600';
    }
    else if (status === 'retrying') {
      statusEl.textContent = `재시도 중... (${retryAttempt}/${maxRetry})`;
      statusEl.className = 'text-sm text-yellow-600';
    }
    else if (status === 'complete') {
      statusEl.textContent = '완료!';
      statusEl.className = 'text-sm text-green-600';
    }
    else if (status === 'error') {
      statusEl.textContent = '오류 발생';
      statusEl.className = 'text-sm text-red-600';
    }
    else if (status === 'stopped') {
      statusEl.textContent = '업로드 중지됨';
      statusEl.className = 'text-sm text-orange-600';
    }
  }
}

function updateProgressDetail(updated, inserted) {
  const detailEl = document.getElementById('progress-detail');
  if (detailEl) {
    detailEl.textContent = `업데이트: ${updated}개 | 신규 추가: ${inserted}개`;
  }
}

const dropzone = document.getElementById('dropzone');
if (dropzone) {
  dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('border-blue-500', 'bg-blue-50'); });
  dropzone.addEventListener('dragleave', (e) => { e.preventDefault(); dropzone.classList.remove('border-blue-500', 'bg-blue-50'); });
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('border-blue-500', 'bg-blue-50');
    const file = e.dataTransfer.files[0];
    if (file && file.name.endsWith('.xlsx')) processExcelFile(file);
    else alert('xlsx 파일만 업로드 가능합니다');
  });
}
