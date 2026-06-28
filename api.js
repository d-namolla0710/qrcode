// qr-code-styling.js를 <script> 태그로 불러오면 전역 변수 QRCodeStyling으로 노출됨
// (ES 모듈 import 아님 — 브라우저 전역 스크립트 방식)

let currentQrCode = null;

const QR_TYPES = [
  "text",
  "wifi",
  "url",
  "email",
  "tel",
  "sms",
  "vcard",
  "event",
  "geo",
];

const QR_TYPE_LABELS = {
  text: "텍스트",
  wifi: "와이파이",
  url: "URL",
  email: "이메일",
  tel: "전화번호(전화)",
  sms: "전화번호(문자)",
  vcard: "연락처",
  event: "일정",
  geo: "위치",
};

// 각 QR 종류별로 어떤 입력칸을 히스토리에 어떤 라벨로 기록할지 정의.
// sensitive: true인 항목은 사용자가 설정에서 직접 켜지 않으면 기록되지 않음.
const TYPE_FIELD_DEFS = {
  text: [{ id: "text-content", label: "텍스트" }],
  wifi: [
    { id: "wifi-ssid", label: "SSID" },
    { id: "wifi-password", label: "비밀번호", sensitive: true },
    { id: "wifi-encryption", label: "암호화 방식" },
    { id: "wifi-hidden", label: "숨겨진 네트워크", isCheckbox: true },
  ],
  url: [{ id: "url-input", label: "URL" }],
  email: [
    { id: "email-address", label: "이메일", sensitive: true },
    { id: "email-subject", label: "제목" },
    { id: "email-body", label: "내용" },
  ],
  tel: [{ id: "tel-number", label: "전화번호", sensitive: true }],
  sms: [
    { id: "sms-number", label: "전화번호", sensitive: true },
    { id: "sms-message", label: "문자 내용" },
  ],
  vcard: [
    { id: "vcard-name", label: "이름", sensitive: true },
    { id: "vcard-phone", label: "전화번호", sensitive: true },
    { id: "vcard-email", label: "이메일", sensitive: true },
    { id: "vcard-org", label: "회사/소속" },
  ],
  event: [
    { id: "event-title", label: "제목" },
    { id: "event-start", label: "시작 일시" },
    { id: "event-end", label: "종료 일시" },
    { id: "event-location", label: "장소" },
    { id: "event-description", label: "설명" },
  ],
  geo: [
    { id: "geo-lat", label: "위도" },
    { id: "geo-lng", label: "경도" },
  ],
};

/**
 * 한글 등 멀티바이트 문자가 QR 스캔 시 깨지는 문제 방지용 변환.
 * qrcode-generator(qr-code-styling 내부 의존 라이브러리)는 입력 문자열을
 * "1글자 = 1바이트"로 가정하고 Byte 모드로 인코딩하기 때문에,
 * 한글처럼 UTF-8에서 여러 바이트를 쓰는 문자를 그대로 넘기면 깨진다.
 * 그래서 미리 UTF-8 바이트로 변환한 뒤, 바이트 하나당 문자 하나로 매핑한
 * "바이너리 문자열"로 바꿔서 넘겨준다.
 */
function toUtf8BinaryString(str) {
  const bytes = new TextEncoder().encode(str);
  let result = "";
  for (let i = 0; i < bytes.length; i++) {
    result += String.fromCharCode(bytes[i]);
  }
  return result;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

// WIFI QR 스펙: \ ; , : " 는 백슬래시로 escape
function escapeWifiValue(value) {
  return value.replace(/([\\;,:"])/g, "\\$1");
}

// vCard 3.0 스펙: \ ; , 는 백슬래시로 escape
function escapeVcardValue(value) {
  return value.replace(/([\\;,])/g, "\\$1");
}

// iCalendar(RFC5545) 스펙: \ ; , 줄바꿈 escape
function escapeICalValue(value) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

// datetime-local input 값("YYYY-MM-DDTHH:MM")을 iCalendar 날짜 형식으로 변환
function formatICalDate(datetimeLocalValue) {
  const [datePart, timePart] = datetimeLocalValue.split("T");
  const [year, month, day] = datePart.split("-");
  const [hour, minute] = timePart.split(":");
  return `${year}${month}${day}T${hour}${minute}00`;
}

/**
 * 선택된 QR 종류와 화면 입력값을 바탕으로 QR에 실제로 인코딩할 데이터 문자열을 생성.
 * 필수값이 비어있으면 alert를 띄우고 null을 반환한다.
 */
function buildDataString(type) {
  switch (type) {
    case "text": {
      const text = document.getElementById("text-content").value.trim();
      if (!text) {
        alert("텍스트를 입력해주세요.");
        return null;
      }
      return text;
    }

    case "wifi": {
      const ssid = document.getElementById("wifi-ssid").value.trim();
      const password = document.getElementById("wifi-password").value;
      const encryption = document.getElementById("wifi-encryption").value;
      const hidden = document.getElementById("wifi-hidden").checked;

      if (!ssid) {
        alert("네트워크 이름(SSID)을 입력해주세요.");
        return null;
      }

      const parts = [`T:${encryption}`, `S:${escapeWifiValue(ssid)}`];

      if (encryption !== "nopass") {
        parts.push(`P:${escapeWifiValue(password)}`);
      }

      parts.push(`H:${hidden ? "true" : "false"}`);

      return `WIFI:${parts.join(";")};;`;
    }

    case "url": {
      let url = document.getElementById("url-input").value.trim();
      if (!url) {
        alert("URL을 입력해주세요.");
        return null;
      }
      if (!/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(url)) {
        url = `https://${url}`;
      }
      return url;
    }

    case "email": {
      const address = document.getElementById("email-address").value.trim();
      const subject = document.getElementById("email-subject").value.trim();
      const body = document.getElementById("email-body").value.trim();

      if (!address) {
        alert("받는 사람 이메일을 입력해주세요.");
        return null;
      }

      const params = [];
      if (subject) params.push(`subject=${encodeURIComponent(subject)}`);
      if (body) params.push(`body=${encodeURIComponent(body)}`);

      return `mailto:${address}${params.length ? `?${params.join("&")}` : ""}`;
    }

    case "tel": {
      const number = document.getElementById("tel-number").value.trim();
      if (!number) {
        alert("전화번호를 입력해주세요.");
        return null;
      }
      return `tel:${number.replace(/[\s-]/g, "")}`;
    }

    case "sms": {
      const number = document.getElementById("sms-number").value.trim();
      const message = document.getElementById("sms-message").value.trim();

      if (!number) {
        alert("전화번호를 입력해주세요.");
        return null;
      }

      const cleanNumber = number.replace(/[\s-]/g, "");
      return message
        ? `sms:${cleanNumber}?body=${encodeURIComponent(message)}`
        : `sms:${cleanNumber}`;
    }

    case "vcard": {
      const name = document.getElementById("vcard-name").value.trim();
      const phone = document.getElementById("vcard-phone").value.trim();
      const email = document.getElementById("vcard-email").value.trim();
      const org = document.getElementById("vcard-org").value.trim();

      if (!name) {
        alert("이름을 입력해주세요.");
        return null;
      }

      const lines = [
        "BEGIN:VCARD",
        "VERSION:3.0",
        `N:;${escapeVcardValue(name)};;;`,
        `FN:${escapeVcardValue(name)}`,
      ];

      if (org) lines.push(`ORG:${escapeVcardValue(org)}`);
      if (phone) lines.push(`TEL;TYPE=CELL:${phone.replace(/[\s-]/g, "")}`);
      if (email) lines.push(`EMAIL:${email}`);

      lines.push("END:VCARD");

      return lines.join("\r\n");
    }

    case "event": {
      const title = document.getElementById("event-title").value.trim();
      const start = document.getElementById("event-start").value;
      const end = document.getElementById("event-end").value;
      const location = document.getElementById("event-location").value.trim();
      const description = document
        .getElementById("event-description")
        .value.trim();

      if (!title || !start) {
        alert("제목과 시작 일시를 입력해주세요.");
        return null;
      }

      const dtStart = formatICalDate(start);
      const dtEnd = end ? formatICalDate(end) : dtStart;

      const lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "BEGIN:VEVENT",
        `SUMMARY:${escapeICalValue(title)}`,
        `DTSTART:${dtStart}`,
        `DTEND:${dtEnd}`,
      ];

      if (location) lines.push(`LOCATION:${escapeICalValue(location)}`);
      if (description)
        lines.push(`DESCRIPTION:${escapeICalValue(description)}`);

      lines.push("END:VEVENT", "END:VCALENDAR");

      return lines.join("\r\n");
    }

    case "geo": {
      const lat = document.getElementById("geo-lat").value.trim();
      const lng = document.getElementById("geo-lng").value.trim();

      if (!lat || !lng) {
        alert("위도와 경도를 입력해주세요.");
        return null;
      }

      return `geo:${lat},${lng}`;
    }

    default:
      return null;
  }
}

/**
 * QR 코드를 생성하는 함수
 *
 * @param {string} data - QR 코드에 인코딩할 데이터 (이미 형식이 맞춰진 최종 문자열)
 * @param {object} settings - 사용자 커스터마이징 옵션
 * @returns {QRCodeStyling} 생성된 QRCodeStyling 인스턴스
 */
function generate(data, settings = {}) {
  const {
    errorCorrLvl = "Q",
    image,
    margin = 0,
    shape = "square",
    imageOptions = {},
    dotsOptions = {},
    backgroundOptions = {},
    cornersSquareOptions = {},
    cornersDotOptions = {},
    width = 300,
    height = 300,
  } = settings;

  const qrCode = new QRCodeStyling({
    width,
    height,
    type: "svg",
    shape,
    data: toUtf8BinaryString(data),
    image,
    margin,

    qrOptions: {
      typeNumber: 0,
      errorCorrectionLevel: errorCorrLvl,
    },

    imageOptions: {
      hideBackgroundDots: true,
      imageSize: imageOptions.imageSize ?? 0.4,
      margin: imageOptions.margin ?? 0,
      crossOrigin: "anonymous",
    },

    dotsOptions: {
      color: dotsOptions.color ?? "#000",
      gradient: dotsOptions.gradient,
      type: dotsOptions.type ?? "square",
    },

    backgroundOptions: {
      color: backgroundOptions.color ?? "#fff",
      gradient: backgroundOptions.gradient,
    },

    cornersSquareOptions: {
      color: cornersSquareOptions.color,
      gradient: cornersSquareOptions.gradient,
      type: cornersSquareOptions.type,
    },

    cornersDotOptions: {
      color: cornersDotOptions.color,
      gradient: cornersDotOptions.gradient,
      type: cornersDotOptions.type,
    },
  });

  return qrCode;
}

/**
 * qr-code-styling이 만드는 svg에는 width/height 속성만 있고 viewBox가 없어서,
 * CSS로 크기를 줄이면 "축소"가 아니라 "잘림"이 발생한다.
 * viewBox를 직접 채워주고 고정 width/height 속성은 지워서,
 * CSS(%, dvw 등)로 비율 유지 반응형 스케일링이 되도록 만든다.
 */
function makeQrSvgResponsive(container) {
  const svgEl = container.querySelector("svg");
  if (!svgEl) return;

  const width = svgEl.getAttribute("width");
  const height = svgEl.getAttribute("height");

  if (width && height) {
    svgEl.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svgEl.removeAttribute("width");
    svgEl.removeAttribute("height");
  }
}

/**
 * 체크박스로 그라데이션 사용 여부를 토글했을 때, 해당 영역 input들을 읽어서
 * gradient 객체를 만들어주는 헬퍼. 체크 안 했으면 undefined 반환 (-> color 단독 사용)
 *
 * @param {string} prefix - "dots" | "bg" | "corners-square" | "corners-dot"
 */
function readGradient(prefix) {
  const toggle = document.getElementById(`${prefix}-gradient-toggle`);
  if (!toggle || !toggle.checked) {
    return undefined;
  }

  const type = document.getElementById(`${prefix}-gradient-type-select`).value;
  const rotationDeg = Number(
    document.getElementById(`${prefix}-gradient-rotation-input`).value,
  );
  const color1 = document.getElementById(
    `${prefix}-gradient-color1-input`,
  ).value;
  const color2 = document.getElementById(
    `${prefix}-gradient-color2-input`,
  ).value;

  return {
    type,
    rotation: (rotationDeg * Math.PI) / 180,
    colorStops: [
      { offset: 0, color: color1 },
      { offset: 1, color: color2 },
    ],
  };
}

/**
 * 그라데이션 객체를 다시 화면 입력칸에 채워주는 헬퍼 (readGradient의 반대)
 */
function applyGradientToForm(prefix, gradient) {
  const toggle = document.getElementById(`${prefix}-gradient-toggle`);
  const fields = document.getElementById(`${prefix}-gradient-fields`);

  if (gradient) {
    toggle.checked = true;
    document.getElementById(`${prefix}-gradient-type-select`).value =
      gradient.type ?? "linear";
    document.getElementById(`${prefix}-gradient-rotation-input`).value =
      Math.round(((gradient.rotation ?? 0) * 180) / Math.PI);
    document.getElementById(`${prefix}-gradient-color1-input`).value =
      gradient.colorStops?.[0]?.color ?? "#000000";
    document.getElementById(`${prefix}-gradient-color2-input`).value =
      gradient.colorStops?.[1]?.color ?? "#ffffff";
  } else {
    toggle.checked = false;
  }

  fields.style.display = toggle.checked ? "" : "none";
}

/**
 * 디자인 설정 영역의 모든 입력값을 읽어서 generate()에 넘길 settings 객체로 변환
 */
function collectSettingsFromForm() {
  const cornersSquareType = document.getElementById(
    "corners-square-type-select",
  ).value;
  const cornersDotType = document.getElementById(
    "corners-dot-type-select",
  ).value;

  return {
    errorCorrLvl: document.getElementById("error-corr-select").value,
    image: document.getElementById("logo-url-input").value || undefined,
    margin: Number(document.getElementById("margin-input").value),
    shape: document.getElementById("shape-select").value,
    width: Number(document.getElementById("width-input").value),
    height: Number(document.getElementById("height-input").value),

    imageOptions: {
      imageSize: Number(document.getElementById("image-size-input").value),
      margin: Number(document.getElementById("image-margin-input").value),
    },

    dotsOptions: {
      color: document.getElementById("dots-color-input").value,
      type: document.getElementById("dots-type-select").value,
      gradient: readGradient("dots"),
    },

    backgroundOptions: {
      color: document.getElementById("bg-color-input").value,
      gradient: readGradient("bg"),
    },

    cornersSquareOptions: {
      color: document.getElementById("corners-square-color-input").value,
      type: cornersSquareType || undefined,
      gradient: readGradient("corners-square"),
    },

    cornersDotOptions: {
      color: document.getElementById("corners-dot-color-input").value,
      type: cornersDotType || undefined,
      gradient: readGradient("corners-dot"),
    },
  };
}

/**
 * settings 객체를 화면 입력칸에 다시 채워주는 헬퍼 (collectSettingsFromForm의 반대).
 * 스타일 불러오기 / 히스토리 불러오기에서 공통으로 사용.
 */
function applySettingsToForm(settings) {
  document.getElementById("error-corr-select").value =
    settings.errorCorrLvl ?? "Q";
  document.getElementById("logo-url-input").value = settings.image ?? "";
  document.getElementById("margin-input").value = settings.margin ?? 0;
  document.getElementById("shape-select").value = settings.shape ?? "square";
  document.getElementById("width-input").value = settings.width ?? 300;
  document.getElementById("height-input").value = settings.height ?? 300;

  document.getElementById("image-size-input").value =
    settings.imageOptions?.imageSize ?? 0.4;
  document.getElementById("image-margin-input").value =
    settings.imageOptions?.margin ?? 0;

  document.getElementById("dots-color-input").value =
    settings.dotsOptions?.color ?? "#000000";
  document.getElementById("dots-type-select").value =
    settings.dotsOptions?.type ?? "square";
  applyGradientToForm("dots", settings.dotsOptions?.gradient);

  document.getElementById("bg-color-input").value =
    settings.backgroundOptions?.color ?? "#ffffff";
  applyGradientToForm("bg", settings.backgroundOptions?.gradient);

  document.getElementById("corners-square-color-input").value =
    settings.cornersSquareOptions?.color ?? "#000000";
  document.getElementById("corners-square-type-select").value =
    settings.cornersSquareOptions?.type ?? "";
  applyGradientToForm(
    "corners-square",
    settings.cornersSquareOptions?.gradient,
  );

  document.getElementById("corners-dot-color-input").value =
    settings.cornersDotOptions?.color ?? "#000000";
  document.getElementById("corners-dot-type-select").value =
    settings.cornersDotOptions?.type ?? "";
  applyGradientToForm("corners-dot", settings.cornersDotOptions?.gradient);
}

/**
 * 선택된 QR 종류에 해당하는 입력 영역만 보여주고 나머지는 숨김
 */
function syncTypeFields() {
  const selectedType = document.getElementById("qr-type-select").value;
  QR_TYPES.forEach((type) => {
    const section = document.getElementById(`type-fields-${type}`);
    section.style.display = type === selectedType ? "" : "none";
  });
}

/**
 * "생성" 버튼 클릭 시: 입력값으로 QR 생성 후 미리보기 영역에 렌더링
 */
function renderQrPreview() {
  const type = document.getElementById("qr-type-select").value;
  const data = buildDataString(type);

  if (!data) {
    return; // buildDataString에서 이미 alert 처리함
  }

  const settings = collectSettingsFromForm();
  currentQrCode = generate(data, settings);

  const previewContainer = document.getElementById("qr-preview");
  previewContainer.innerHTML = ""; // 이전 QR 코드 제거
  currentQrCode.append(previewContainer);
  makeQrSvgResponsive(previewContainer);

  recordHistoryEntry(type, data, settings);
}

/**
 * "내보내기" 버튼 클릭 시: 아직 생성된 QR이 없으면 먼저 생성하고, 다운로드 모달을 띔
 */
function openExportModal() {
  if (!currentQrCode) {
    renderQrPreview();
    if (!currentQrCode) {
      return; // 필수 입력값이 비어있어서 생성 실패한 경우
    }
  }
  document.getElementById("export-modal").style.display = "flex";
}

function closeExportModal() {
  document.getElementById("export-modal").style.display = "none";
}

/**
 * 모달의 "다운로드" 버튼 클릭 시: 선택한 확장자로 현재 QR 코드 다운로드
 */
function downloadQrCode() {
  if (!currentQrCode) {
    alert("먼저 QR 코드를 생성해주세요.");
    return;
  }

  const extension = document.getElementById("download-ext-select").value;
  currentQrCode.download({ name: "qrcode", extension });
}

/* ==================== 스타일 저장/불러오기 (localStorage) ==================== */

const STYLE_PRESETS_KEY = "qrgen-style-presets";

function getStylePresets() {
  try {
    return JSON.parse(localStorage.getItem(STYLE_PRESETS_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveStylePresets(presets) {
  localStorage.setItem(STYLE_PRESETS_KEY, JSON.stringify(presets));
}

function refreshPresetSelect() {
  const presets = getStylePresets();
  const select = document.getElementById("preset-select");
  const names = Object.keys(presets);

  select.innerHTML = "";

  if (names.length === 0) {
    select.innerHTML = '<option value="">저장된 스타일 없음</option>';
    return;
  }

  names.forEach((name) => {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name;
    select.appendChild(option);
  });
}

function saveCurrentStylePreset() {
  const nameInput = document.getElementById("preset-name-input");
  const name = nameInput.value.trim();

  if (!name) {
    alert("저장할 스타일 이름을 입력해주세요.");
    return;
  }

  const presets = getStylePresets();
  presets[name] = collectSettingsFromForm();
  saveStylePresets(presets);
  refreshPresetSelect();
  document.getElementById("preset-select").value = name;
  nameInput.value = "";
  alert(`"${name}" 스타일을 저장했습니다.`);
}

function loadSelectedStylePreset() {
  const name = document.getElementById("preset-select").value;

  if (!name) {
    alert("불러올 스타일을 선택해주세요.");
    return;
  }

  const presets = getStylePresets();
  const preset = presets[name];
  if (!preset) return;

  applySettingsToForm(preset);
}

function deleteSelectedStylePreset() {
  const name = document.getElementById("preset-select").value;

  if (!name) {
    alert("삭제할 스타일을 선택해주세요.");
    return;
  }

  if (!confirm(`"${name}" 스타일을 삭제할까요?`)) return;

  const presets = getStylePresets();
  delete presets[name];
  saveStylePresets(presets);
  refreshPresetSelect();
}

/* ==================== 히스토리 (localStorage) ==================== */

const HISTORY_KEY = "qrgen-history";
const HISTORY_ENABLED_KEY = "qrgen-history-enabled";
const HISTORY_PRIVACY_KEY = "qrgen-history-privacy";
const HISTORY_MAX_ITEMS = 50;

function getHistoryEnabled() {
  const v = localStorage.getItem(HISTORY_ENABLED_KEY);
  return v === null ? true : v === "true"; // 기본값: 사용
}

function setHistoryEnabled(value) {
  localStorage.setItem(HISTORY_ENABLED_KEY, String(value));
}

function getPrivacySettings() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_PRIVACY_KEY) || "{}");
  } catch {
    return {};
  }
}

function setPrivacySettings(settings) {
  localStorage.setItem(HISTORY_PRIVACY_KEY, JSON.stringify(settings));
}

function getHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveHistory(list) {
  localStorage.setItem(
    HISTORY_KEY,
    JSON.stringify(list.slice(-HISTORY_MAX_ITEMS)),
  );
}

/**
 * 해당 종류의 입력값 중, 설정에서 기록이 허용되지 않은 민감 정보가 하나라도
 * 있으면 true. true인 경우 QR 데이터 자체(및 썸네일)는 히스토리에 저장하지 않는다.
 * (QR 이미지를 저장하면 스캔으로 민감정보가 그대로 노출되기 때문)
 */
function typeHasDisallowedSensitiveField(type) {
  const defs = TYPE_FIELD_DEFS[type] || [];
  const privacy = getPrivacySettings();
  return defs.some((def) => def.sensitive && !privacy[def.id]);
}

function buildHistoryFieldsSnapshot(type) {
  const defs = TYPE_FIELD_DEFS[type] || [];
  const privacy = getPrivacySettings();

  return defs.map((def) => {
    const el = document.getElementById(def.id);
    if (!el) return { label: def.label, value: null, redacted: true };

    if (def.sensitive && !privacy[def.id]) {
      return { label: def.label, value: null, redacted: true };
    }

    const value = def.isCheckbox ? (el.checked ? "예" : "아니오") : el.value;
    return { label: def.label, value, redacted: false };
  });
}

function recordHistoryEntry(type, data, settings) {
  if (!getHistoryEnabled()) return;

  const disallowed = typeHasDisallowedSensitiveField(type);

  const entry = {
    id: Date.now(),
    type,
    createdAt: new Date().toISOString(),
    fields: buildHistoryFieldsSnapshot(type),
    data: disallowed ? null : data,
    settings,
  };

  const history = getHistory();
  history.push(entry);
  saveHistory(history);
  renderHistoryList();
}

function formatHistoryDate(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}.${pad2(d.getMonth() + 1)}.${pad2(d.getDate())} ${pad2(
    d.getHours(),
  )}:${pad2(d.getMinutes())}`;
}

function deleteHistoryEntry(id) {
  const history = getHistory().filter((entry) => entry.id !== id);
  saveHistory(history);
  renderHistoryList();
}

function clearHistory() {
  if (!confirm("모든 히스토리를 삭제할까요?")) return;
  saveHistory([]);
  renderHistoryList();
}

/**
 * 히스토리 항목을 입력 폼에 다시 채워줌 (비공개로 기록된 항목은 비워둠 -> 직접 재입력 필요).
 * 자동으로 QR을 생성하지는 않음 (중복 히스토리 방지 + 사용자가 내용 확인 후 직접 생성하도록).
 */
function loadHistoryEntry(id) {
  const history = getHistory();
  const entry = history.find((item) => item.id === id);
  if (!entry) return;

  document.getElementById("qr-type-select").value = entry.type;
  syncTypeFields();

  const defs = TYPE_FIELD_DEFS[entry.type] || [];
  defs.forEach((def, index) => {
    const snapshot = entry.fields[index];
    const el = document.getElementById(def.id);
    if (!el || !snapshot || snapshot.redacted) return;

    if (def.isCheckbox) {
      el.checked = snapshot.value === "예";
    } else {
      el.value = snapshot.value ?? "";
    }
  });

  applySettingsToForm(entry.settings);

  const hasRedacted = entry.fields.some((field) => field.redacted);
  if (hasRedacted) {
    alert(
      "개인정보 보호 설정으로 기록되지 않은 항목이 있어 직접 다시 입력해야 합니다.",
    );
  }
}

function renderHistoryList() {
  const container = document.getElementById("history-list");
  const history = getHistory().slice().reverse(); // 최신순

  container.innerHTML = "";

  if (history.length === 0) {
    container.innerHTML =
      '<p class="history-empty">아직 생성 기록이 없습니다.</p>';
    return;
  }

  history.forEach((entry) => {
    const item = document.createElement("div");
    item.className = "history-item";

    const thumb = document.createElement("div");
    thumb.className = "history-thumb";

    if (entry.data) {
      try {
        const thumbQr = generate(entry.data, {
          ...entry.settings,
          width: 90,
          height: 90,
        });
        thumbQr.append(thumb);
        makeQrSvgResponsive(thumb);
      } catch {
        thumb.classList.add("history-thumb-locked");
        thumb.textContent = "?";
      }
    } else {
      thumb.classList.add("history-thumb-locked");
      thumb.textContent = "🔒";
    }

    const info = document.createElement("div");
    info.className = "history-info";

    const title = document.createElement("strong");
    title.textContent = QR_TYPE_LABELS[entry.type] || entry.type;

    const date = document.createElement("span");
    date.className = "history-date";
    date.textContent = formatHistoryDate(entry.createdAt);

    const fieldList = document.createElement("ul");
    entry.fields.forEach((field) => {
      const li = document.createElement("li");
      li.textContent = `${field.label}: ${field.redacted ? "비공개" : field.value || "-"}`;
      fieldList.appendChild(li);
    });

    const actions = document.createElement("div");
    actions.className = "history-actions";

    const loadBtn = document.createElement("button");
    loadBtn.type = "button";
    loadBtn.textContent = "불러오기";
    loadBtn.addEventListener("click", () => loadHistoryEntry(entry.id));

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.textContent = "삭제";
    deleteBtn.addEventListener("click", () => deleteHistoryEntry(entry.id));

    actions.appendChild(loadBtn);
    actions.appendChild(deleteBtn);

    info.appendChild(title);
    info.appendChild(date);
    info.appendChild(fieldList);
    info.appendChild(actions);

    item.appendChild(thumb);
    item.appendChild(info);
    container.appendChild(item);
  });
}

/* ==================== 아코디언 (접기/펼치기) ==================== */

/**
 * .accordion-header 클릭 시 형제 .accordion-body를 부드럽게 펼치거나 접음.
 * height: 0 <-> height: scrollHeight px로 전환한 뒤, 펼친 상태에서는
 * height를 "auto"로 되돌려 내부 콘텐츠(중첩 아코디언 등)가 늘어나도
 * 잘리지 않도록 한다.
 */
function toggleAccordion(header) {
  const accordion = header.closest(".accordion");
  const body = accordion.querySelector(":scope > .accordion-body");
  const isOpen = accordion.classList.contains("open");

  // 같은 그룹(.accordion-group) 안에서는 한 번에 하나만 펼쳐지도록,
  // 새로 열기 전에 이미 열려있는 다른 아코디언들을 먼저 닫음.
  if (!isOpen) {
    const group = accordion.closest(".accordion-group");
    if (group) {
      group.querySelectorAll(".accordion.open").forEach((otherAccordion) => {
        if (otherAccordion !== accordion) {
          const otherBody = otherAccordion.querySelector(
            ":scope > .accordion-body",
          );
          closeAccordion(otherAccordion, otherBody);
        }
      });
    }
  }

  if (isOpen) {
    closeAccordion(accordion, body);
  } else {
    openAccordion(accordion, body);
  }
}

function openAccordion(accordion, body) {
  accordion.classList.add("open");

  const targetHeight = body.scrollHeight;
  body.style.height = "0px";

  requestAnimationFrame(() => {
    body.style.height = `${targetHeight}px`;
  });

  body.addEventListener("transitionend", function handler(event) {
    if (event.propertyName === "height") {
      if (accordion.classList.contains("open")) {
        body.style.height = "auto";
      }
      body.removeEventListener("transitionend", handler);
    }
  });
}

function closeAccordion(accordion, body) {
  const currentHeight = body.scrollHeight;
  body.style.height = `${currentHeight}px`;
  accordion.classList.remove("open");

  requestAnimationFrame(() => {
    body.style.height = "0px";
  });
}

function initAccordions() {
  document.querySelectorAll(".accordion-header").forEach((header) => {
    header.addEventListener("click", () => toggleAccordion(header));
  });
}

// DOM 로드 후 이벤트 연결
document.addEventListener("DOMContentLoaded", () => {
  initAccordions();
  document
    .getElementById("qr-type-select")
    .addEventListener("change", syncTypeFields);
  syncTypeFields(); // 초기 상태 반영

  document
    .getElementById("btn-convert")
    .addEventListener("click", renderQrPreview);
  document
    .getElementById("btn-export")
    .addEventListener("click", openExportModal);
  document
    .getElementById("btn-download")
    .addEventListener("click", downloadQrCode);
  document
    .getElementById("modal-close-btn")
    .addEventListener("click", closeExportModal);

  // 모달 바깥(배경) 클릭 시 닫기
  document.getElementById("export-modal").addEventListener("click", (event) => {
    if (event.target.id === "export-modal") {
      closeExportModal();
    }
  });

  // 그라데이션 체크박스 4개: 체크 안 되어 있으면 관련 입력 숨김
  ["dots", "bg", "corners-square", "corners-dot"].forEach((prefix) => {
    const toggle = document.getElementById(`${prefix}-gradient-toggle`);
    const fields = document.getElementById(`${prefix}-gradient-fields`);

    const syncVisibility = () => {
      fields.style.display = toggle.checked ? "" : "none";
    };

    toggle.addEventListener("change", syncVisibility);
    syncVisibility(); // 초기 상태 반영
  });

  // 스타일 저장/불러오기
  refreshPresetSelect();
  document
    .getElementById("btn-save-preset")
    .addEventListener("click", saveCurrentStylePreset);
  document
    .getElementById("btn-load-preset")
    .addEventListener("click", loadSelectedStylePreset);
  document
    .getElementById("btn-delete-preset")
    .addEventListener("click", deleteSelectedStylePreset);

  // 히스토리 사용 여부 토글
  const historyToggle = document.getElementById("history-enabled-toggle");
  historyToggle.checked = getHistoryEnabled();
  historyToggle.addEventListener("change", (event) => {
    setHistoryEnabled(event.target.checked);
  });

  // 개인정보 항목별 기록 허용 토글
  const privacySettings = getPrivacySettings();
  document
    .querySelectorAll("#history-settings input[data-field]")
    .forEach((input) => {
      const fieldId = input.dataset.field;
      input.checked = Boolean(privacySettings[fieldId]);
      input.addEventListener("change", () => {
        const current = getPrivacySettings();
        current[fieldId] = input.checked;
        setPrivacySettings(current);
      });
    });

  // 히스토리 목록 + 전체 삭제
  renderHistoryList();
  document
    .getElementById("btn-clear-history")
    .addEventListener("click", clearHistory);
});