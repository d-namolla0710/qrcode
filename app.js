// qr-code-styling.js를 <script> 태그로 불러오면 전역 변수 QRCodeStyling으로 노출됨
// (ES 모듈 import 아님 — 브라우저 전역 스크립트 방식)

let currentQrCode = null;
// 도트/모서리를 "투명(구멍 뚫기)"으로 설정했을 때, 뚫린 구멍이 반영된 svg
// 엘리먼트와 원본 크기(px). 내보내기(다운로드) 시 qr-code-styling의 기본
// download()는 이 구멍을 반영하지 않으므로(내부적으로 옵션에서 svg를 다시
// 만들기 때문), 이 값이 있으면 그것을 직접 사용해 다운로드한다.
let currentHolePunchedSvg = null;
let logoDataUrl = null;
let autoPreviewTimer = null;
let autoHistoryTimer = null;
let suppressHistoryRecord = false;
let historyCurrentPage = 1;

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
function buildDataString(type, { silent = false } = {}) {
  switch (type) {
    case "text": {
      const text = document.getElementById("text-content").value.trim();
      if (!text) {
        if (!silent) alert("텍스트를 입력해주세요.");
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
        if (!silent) alert("네트워크 이름(SSID)을 입력해주세요.");
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
        if (!silent) alert("URL을 입력해주세요.");
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
        if (!silent) alert("받는 사람 이메일을 입력해주세요.");
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
        if (!silent) alert("전화번호를 입력해주세요.");
        return null;
      }
      return `tel:${number.replace(/[\s-]/g, "")}`;
    }

    case "sms": {
      const number = document.getElementById("sms-number").value.trim();
      const message = document.getElementById("sms-message").value.trim();

      if (!number) {
        if (!silent) alert("전화번호를 입력해주세요.");
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
        if (!silent) alert("이름을 입력해주세요.");
        return null;
      }

      const lines = [
        "BEGIN:VCARD",
        "VERSION:3.0",
        `N:;${escapeVcardValue(name)};;;`,
        `FN:${escapeVcardValue(name)}`,
      ];

      if (org) lines.push(`ORG:${escapeVcardValue(org)}`);
      if (phone)
        lines.push(
          `TEL;TYPE=CELL:${escapeVcardValue(phone.replace(/[\s-]/g, ""))}`,
        );
      if (email) lines.push(`EMAIL:${escapeVcardValue(email)}`);

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
        if (!silent) alert("제목과 시작 일시를 입력해주세요.");
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
        if (!silent) alert("위도와 경도를 입력해주세요.");
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
/* ==================== 명도 대비 검사 (WCAG relative luminance) ==================== */

function sRGBToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function getRelativeLuminance(hex) {
  hex = hex.replace(/^#/, "");
  if (hex.length === 3)
    hex = hex
      .split("")
      .map((c) => c + c)
      .join("");
  const r = sRGBToLinear(parseInt(hex.slice(0, 2), 16) / 255);
  const g = sRGBToLinear(parseInt(hex.slice(2, 4), 16) / 255);
  const b = sRGBToLinear(parseInt(hex.slice(4, 6), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function getContrastRatio(hex1, hex2) {
  const L1 = getRelativeLuminance(hex1);
  const L2 = getRelativeLuminance(hex2);
  const lighter = Math.max(L1, L2);
  const darker = Math.min(L1, L2);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * backgroundOptions/dotsOptions/cornersSquareOptions/cornersDotOptions 형태의
 * 옵션 객체에서 실제로 비교에 쓰일 색상 문자열 목록을 뽑아낸다.
 * 투명(color === "transparent")이면 대비를 계산할 색이 없다고 보고 빈 배열 반환.
 */
function extractColorsForContrast(options) {
  if (!options || options.color === "transparent") return [];
  if (options.gradient) {
    return options.gradient.colorStops.map((stop) => stop.color);
  }
  return options.color != null ? [options.color] : [];
}

function computeMinContrastRatio() {
  const settings = collectSettingsFromForm();
  const bgColors = extractColorsForContrast(settings.backgroundOptions);
  const fgColorGroups = [
    extractColorsForContrast(settings.dotsOptions),
    extractColorsForContrast(settings.cornersSquareOptions),
    extractColorsForContrast(settings.cornersDotOptions),
  ];

  let minRatio = 21;
  for (const bg of bgColors) {
    for (const fgColors of fgColorGroups) {
      for (const fg of fgColors) {
        try {
          minRatio = Math.min(minRatio, getContrastRatio(bg, fg));
        } catch {
          // 유효하지 않은 색상 무시
        }
      }
    }
  }
  return minRatio;
}

function applyContrastWarning(warningEl, textEl, ratio) {
  if (!warningEl) return;
  const boxEl = warningEl.querySelector(".contrast-warning-box");
  let level = null;
  let msg = "";
  if (ratio < 1.5) {
    level = "severe";
    msg = `명도 대비 ${ratio.toFixed(1)}:1 — 배경색과 QR 색상이 거의 구별되지 않아 대부분의 기기에서 인식이 불가능합니다.`;
  } else if (ratio < 3) {
    level = "moderate";
    msg = `명도 대비 ${ratio.toFixed(1)}:1 — 대비가 낮아 일부 기기(구형·저가형·카메라 품질이 낮은 기기)에서 인식이 잘 안 될 수 있습니다.`;
  }
  if (level) {
    if (textEl) textEl.textContent = msg;
    if (boxEl) boxEl.className = `contrast-warning-box warning-${level}`;
    warningEl.style.display = "";
  } else {
    warningEl.style.display = "none";
  }
}

function updateContrastWarning() {
  const ratio = computeMinContrastRatio();
  applyContrastWarning(
    document.getElementById("qr-contrast-warning"),
    document.getElementById("contrast-warning-text"),
    ratio,
  );
  return ratio;
}

/**
 * 한글 등 UTF-8에서 여러 바이트를 차지하는 문자가 많으면 QR에 담기는
 * 실제 바이트 수가 늘어나고, 그만큼 모듈(점) 개수도 늘어나(=버전이 올라가)
 * 코드가 조밀해진다. qr-code-styling(qrcode-generator 기반)이 내부적으로
 * 계산해 둔 실제 격자 크기(_qr.getModuleCount())를 그대로 읽어서 판단하므로
 * 버전별 용량 표를 별도로 유지보수할 필요가 없다.
 */
function applyDensityWarning(warningEl, textEl, moduleCount, byteLength) {
  if (!warningEl) return;
  const boxEl = warningEl.querySelector(".contrast-warning-box");
  let level = null;
  let msg = "";
  if (moduleCount >= 97) {
    level = "severe";
    msg = `입력한 내용이 많아 QR 코드가 매우 조밀합니다 (${moduleCount}×${moduleCount} 모듈, ${byteLength}바이트). 작게 인쇄하거나 카메라 성능이 낮은 기기에서는 스캔이 잘 안 될 수 있습니다.`;
  } else if (moduleCount >= 57) {
    level = "moderate";
    msg = `입력한 내용이 많아 QR 코드가 다소 조밀합니다 (${moduleCount}×${moduleCount} 모듈, ${byteLength}바이트). 일부 기기에서 카메라 초점이 잘 안 맞을 수 있습니다.`;
  }
  if (level) {
    if (textEl) textEl.textContent = msg;
    if (boxEl) boxEl.className = `contrast-warning-box warning-${level}`;
    warningEl.style.display = "";
  } else {
    warningEl.style.display = "none";
  }
}

function updateDensityWarning(qrCode, data) {
  const warningEl = document.getElementById("qr-density-warning");
  const moduleCount = qrCode?._qr?.getModuleCount?.();
  if (!moduleCount) {
    if (warningEl) warningEl.style.display = "none";
    return;
  }
  const byteLength = new TextEncoder().encode(data).length;
  applyDensityWarning(
    warningEl,
    document.getElementById("density-warning-text"),
    moduleCount,
    byteLength,
  );
}

/* ==================== QR 코드 생성 ==================== */

function generate(data, settings = {}, type = "canvas") {
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
    type,
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
 * 도트/모서리 사각형/모서리 도트를 "투명(구멍 뚫기)"으로 설정했을 때, 그
 * 요소가 있던 자리의 배경만 정확히 뚫어서 비우고 나머지 배경(여백 등)은
 * 그대로 남긴다.
 *
 * qr-code-styling이 svg 안에 이미 만들어 둔 "clip-path-dot-color-*" /
 * "clip-path-corners-square-color-*" / "clip-path-corners-dot-color-*"
 * 클립패스(해당 요소 하나하나의 정확한 모양/회전 — 실제 렌더링과 100% 동일)를
 * 그대로 재사용해서, 배경을 그리는 사각형에 mask로 적용한다. 그런 다음 해당
 * 요소 자체를 칠하던 rect는 지워서 순수하게 "뚫린 구멍"만 남긴다.
 *
 * @param {{dots?: boolean, cornersSquare?: boolean, cornersDot?: boolean}} punch
 */
function applyQrHolePunch(svgEl, punch) {
  const clipPathPrefixes = [];
  if (punch.dots) clipPathPrefixes.push("clip-path-dot-color-");
  if (punch.cornersSquare) clipPathPrefixes.push("clip-path-corners-square-color-");
  if (punch.cornersDot) clipPathPrefixes.push("clip-path-corners-dot-color-");
  if (!clipPathPrefixes.length) return;

  const bgRects = svgEl.querySelectorAll(
    '[clip-path*="clip-path-background-color-"]',
  );
  const holeClipPaths = clipPathPrefixes.flatMap((prefix) =>
    [...svgEl.querySelectorAll(`[id^="${prefix}"]`)],
  );
  if (!bgRects.length || !holeClipPaths.length) return;

  const svgNS = "http://www.w3.org/2000/svg";
  const width = svgEl.getAttribute("width") || 300;
  const height = svgEl.getAttribute("height") || 300;

  let defs = svgEl.querySelector("defs");
  if (!defs) {
    defs = document.createElementNS(svgNS, "defs");
    svgEl.insertBefore(defs, svgEl.firstChild);
  }

  const maskId = `qr-hole-mask-${Math.random().toString(36).slice(2, 9)}`;
  const mask = document.createElementNS(svgNS, "mask");
  mask.setAttribute("id", maskId);
  mask.setAttribute("maskUnits", "userSpaceOnUse");
  mask.setAttribute("x", "0");
  mask.setAttribute("y", "0");
  mask.setAttribute("width", String(width));
  mask.setAttribute("height", String(height));

  // mask는 흰색=보임/검정색=숨김이므로, 전체를 흰색으로 채운 뒤 구멍 낼 모양만
  // 검정으로 덮어써서 그 자리만 구멍이 뚫리게 한다.
  const visibleRect = document.createElementNS(svgNS, "rect");
  visibleRect.setAttribute("x", "0");
  visibleRect.setAttribute("y", "0");
  visibleRect.setAttribute("width", String(width));
  visibleRect.setAttribute("height", String(height));
  visibleRect.setAttribute("fill", "white");
  mask.appendChild(visibleRect);

  const holesGroup = document.createElementNS(svgNS, "g");
  holesGroup.setAttribute("fill", "black");
  holeClipPaths.forEach((clipPath) => {
    [...clipPath.children].forEach((shape) => {
      holesGroup.appendChild(shape.cloneNode(true));
    });
  });
  mask.appendChild(holesGroup);
  defs.appendChild(mask);

  bgRects.forEach((rect) => rect.setAttribute("mask", `url(#${maskId})`));

  // 구멍 낸 요소 자체를 칠하던 rect는 제거해서 순수하게 "뚫린 구멍"만 남긴다
  clipPathPrefixes.forEach((prefix) => {
    svgEl
      .querySelectorAll(`[clip-path*="${prefix}"]`)
      .forEach((el) => el.remove());
  });
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

  const width =
    svgEl.getAttribute("width") || svgEl.style.width.replace("px", "");
  const height =
    svgEl.getAttribute("height") || svgEl.style.height.replace("px", "");

  if (width && height) {
    svgEl.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svgEl.removeAttribute("width");
    svgEl.removeAttribute("height");
    svgEl.style.width = "";
    svgEl.style.height = "";
  }
}

/**
 * 새 QR을 생성해 기존 SVG와 원자적으로 교체한다 (replaceChildren).
 * innerHTML 초기화를 하지 않으므로 깜빡임이 없다.
 */
function renderQrPreviewAuto(data, settings) {
  const holePunch = {
    dots: settings.dotsOptions?.color === "transparent",
    cornersSquare: settings.cornersSquareOptions?.color === "transparent",
    cornersDot: settings.cornersDotOptions?.color === "transparent",
  };
  const needsHolePunch =
    holePunch.dots || holePunch.cornersSquare || holePunch.cornersDot;
  const newQrCode = generate(data, settings, needsHolePunch ? "svg" : "canvas");
  const temp = document.createElement("div");
  newQrCode.append(temp);

  currentHolePunchedSvg = null;
  if (needsHolePunch) {
    const svgEl = temp.querySelector("svg");
    if (svgEl) {
      applyQrHolePunch(svgEl, holePunch);
      currentHolePunchedSvg = {
        el: svgEl,
        width: settings.width ?? 300,
        height: settings.height ?? 300,
      };
    }
  }

  makeQrSvgResponsive(temp);
  const newEl = temp.firstElementChild;
  if (!newEl) return;
  document.getElementById("qr-preview").replaceChildren(newEl);
  currentQrCode = newQrCode;
  updateContrastWarning();
  updateDensityWarning(newQrCode, data);
  updatePreviewSize();
}

/* ==================== 미리보기 보기 모드 (너비 기준 / 높이 기준 / 직접 조절) ==================== */
const PREVIEW_VIEW_MODE_KEY = "qr-preview-view-mode-v1";
const PREVIEW_MANUAL_SIZE_KEY = "qr-preview-manual-size-v1";
const PREVIEW_MANUAL_SIZE_DEFAULT = 320;

function getPreviewViewMode() {
  const v = localStorage.getItem(PREVIEW_VIEW_MODE_KEY);
  return v === "width" || v === "manual" ? v : "height";
}

function setPreviewViewMode(mode) {
  localStorage.setItem(PREVIEW_VIEW_MODE_KEY, mode);
}

/**
 * "직접 조절" 모드는 1:1 비율 고정이라 width 한 값만 저장하면 되고,
 * height는 CSS aspect-ratio가 그대로 따라가게 둔다.
 */
function getManualPreviewSize() {
  const saved = Number(localStorage.getItem(PREVIEW_MANUAL_SIZE_KEY));
  return saved > 0 ? saved : PREVIEW_MANUAL_SIZE_DEFAULT;
}

function saveManualPreviewSize(width) {
  localStorage.setItem(PREVIEW_MANUAL_SIZE_KEY, String(Math.round(width)));
}

/** 저장되어 있던(또는 기본) 폭을 #qr-preview에 인라인 width로 적용 (height는 aspect-ratio가 계산) */
function applyManualPreviewSize() {
  const previewEl = document.getElementById("qr-preview");
  previewEl.style.width = `${getManualPreviewSize()}px`;
  previewEl.style.removeProperty("height");
}

function outerHeight(el) {
  if (!el) return 0;
  const style = getComputedStyle(el);
  return (
    el.offsetHeight +
    parseFloat(style.marginTop || "0") +
    parseFloat(style.marginBottom || "0")
  );
}

/**
 * "높이 기준" 모드에서 #qr-preview의 높이를
 * 100dvh - (미리보기 위/아래에 있는 요소들의 실제 높이 합) 으로 계산해 적용한다.
 * "너비 기준" 모드에서는 인라인 height를 지워 CSS(min(90dvw,360px) 등)가 그대로 적용되게 하고,
 * "직접 조절" 모드에서는 사용자가 드래그로 정한 크기를 건드리지 않는다.
 */
function updatePreviewSize() {
  const previewEl = document.getElementById("qr-preview");
  if (!previewEl) return;

  const mode = getPreviewViewMode();
  if (mode === "manual") return;

  if (mode !== "height") {
    previewEl.style.removeProperty("height");
    return;
  }

  const spaceAbove = previewEl.offsetTop;
  const spaceBelow =
    outerHeight(document.getElementById("btn-export")) +
    parseFloat(getComputedStyle(document.body).paddingBottom || "0") +
    parseFloat(getComputedStyle(previewEl).marginBottom || "0");

  const reserved = Math.round(spaceAbove + spaceBelow);
  previewEl.style.height = `max(160px, calc(100dvh - ${reserved}px))`;
}

let previewSizeRaf = null;
function schedulePreviewSizeUpdate() {
  if (previewSizeRaf) cancelAnimationFrame(previewSizeRaf);
  previewSizeRaf = requestAnimationFrame(() => {
    previewSizeRaf = null;
    updatePreviewSize();
  });
}

function applyPreviewViewMode(mode) {
  const previewEl = document.getElementById("qr-preview");
  previewEl.classList.toggle("view-mode-width", mode === "width");
  previewEl.classList.toggle("view-mode-height", mode === "height");
  previewEl.classList.toggle("view-mode-manual", mode === "manual");
  document
    .querySelectorAll('input[name="preview-view-mode"]')
    .forEach((input) => {
      input.checked = input.value === mode;
    });

  if (mode === "manual") {
    applyManualPreviewSize();
  } else {
    previewEl.style.removeProperty("width");
    updatePreviewSize();
  }
}

/**
 * "직접 조절" 모드에서 사용자가 리사이즈 핸들을 드래그해 박스 크기를 바꾸면
 * 그 크기를 감지해 localStorage에 저장(다음 접속 시 그대로 복원)한다.
 */
function initManualPreviewResizeObserver() {
  const previewEl = document.getElementById("qr-preview");
  if (!previewEl || typeof ResizeObserver === "undefined") return;

  const observer = new ResizeObserver((entries) => {
    if (getPreviewViewMode() !== "manual") return;
    const entry = entries[0];
    const box = entry.borderBoxSize?.[0];
    const width = box ? box.inlineSize : entry.contentRect.width;
    if (width > 0) saveManualPreviewSize(width);
  });
  observer.observe(previewEl);
}

function initPreviewViewMode() {
  applyPreviewViewMode(getPreviewViewMode());
  initManualPreviewResizeObserver();

  document
    .querySelectorAll('input[name="preview-view-mode"]')
    .forEach((input) => {
      input.addEventListener("change", (e) => {
        if (!e.target.checked) return;
        setPreviewViewMode(e.target.value);
        applyPreviewViewMode(e.target.value);
      });
    });

  window.addEventListener("resize", schedulePreviewSizeUpdate);
  window.addEventListener("orientationchange", schedulePreviewSizeUpdate);
  window.addEventListener("load", schedulePreviewSizeUpdate);
}

/**
 * 미리보기 화면 전용 배경(테마 배경/체크무늬/단색/그라데이션) 설정.
 * QR 자체의 배경(backgroundOptions)과는 완전히 별개이며, 내보내기 결과물에는
 * 영향을 주지 않는다. 투명 배경·투명 도트를 화면에서 알아보기 쉽게 하기 위한
 * 화면 표시용 설정.
 */
const PREVIEW_BG_KEY = "qr-preview-bg-v1";

function getPreviewBgSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(PREVIEW_BG_KEY));
    if (raw && typeof raw === "object") return raw;
  } catch {
    // 저장된 값이 손상된 경우 기본값 사용
  }
  return { mode: "theme" };
}

function savePreviewBgSettings(settings) {
  localStorage.setItem(PREVIEW_BG_KEY, JSON.stringify(settings));
}

function readPreviewBgSettingsFromForm() {
  return {
    mode: document.getElementById("preview-bg-mode-select").value,
    solidColor: document.getElementById("preview-bg-solid-color-input").value,
    gradientType: document.getElementById("preview-bg-gradient-type-select")
      .value,
    gradientRotation: Number(
      document.getElementById("preview-bg-gradient-rotation-input").value,
    ),
    gradientColor1: document.getElementById("preview-bg-gradient-color1-input")
      .value,
    gradientColor2: document.getElementById("preview-bg-gradient-color2-input")
      .value,
  };
}

function applyPreviewBgSettingsToForm(settings) {
  document.getElementById("preview-bg-mode-select").value =
    settings.mode ?? "theme";
  document.getElementById("preview-bg-solid-color-input").value =
    settings.solidColor ?? "#f2f2f2";
  document.getElementById("preview-bg-gradient-type-select").value =
    settings.gradientType ?? "linear";
  document.getElementById("preview-bg-gradient-rotation-input").value =
    settings.gradientRotation ?? 0;
  document.getElementById("preview-bg-gradient-color1-input").value =
    settings.gradientColor1 ?? "#ffffff";
  document.getElementById("preview-bg-gradient-color2-input").value =
    settings.gradientColor2 ?? "#000000";
}

function applyPreviewBgSettings(settings) {
  const previewEl = document.getElementById("qr-preview");
  if (!previewEl) return;
  const mode = settings.mode ?? "theme";

  previewEl.classList.toggle("preview-bg-checkerboard", mode === "checkerboard");
  previewEl.style.removeProperty("background-color");
  previewEl.style.removeProperty("background-image");

  document.getElementById("preview-bg-solid-field").style.display =
    mode === "solid" ? "" : "none";
  document.getElementById("preview-bg-gradient-fields").style.display =
    mode === "gradient" ? "" : "none";

  if (mode === "solid") {
    previewEl.style.backgroundColor = settings.solidColor ?? "#f2f2f2";
  } else if (mode === "gradient") {
    const type = settings.gradientType ?? "linear";
    const rotation = settings.gradientRotation ?? 0;
    const color1 = settings.gradientColor1 ?? "#ffffff";
    const color2 = settings.gradientColor2 ?? "#000000";
    previewEl.style.backgroundImage =
      type === "radial"
        ? `radial-gradient(circle, ${color1}, ${color2})`
        : `linear-gradient(${rotation}deg, ${color1}, ${color2})`;
  }
  // mode === "theme"이면 클래스/인라인 스타일을 모두 제거한 상태로 두어
  // 기존처럼 페이지 테마 배경이 그대로 비쳐 보이게 한다.
}

function initPreviewBgSettings() {
  const saved = getPreviewBgSettings();
  applyPreviewBgSettingsToForm(saved);
  applyPreviewBgSettings(saved);

  document.querySelectorAll(".preview-bg-controls input, .preview-bg-controls select")
    .forEach((el) => {
      el.addEventListener("input", () => {
        const settings = readPreviewBgSettingsFromForm();
        savePreviewBgSettings(settings);
        applyPreviewBgSettings(settings);
      });
    });
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
 * "투명" 체크박스(dots/bg 공통) 상태에 맞춰 색상·그라데이션 입력칸을 숨김/표시.
 */
function syncTransparentVisibility(prefix) {
  const toggle = document.getElementById(`${prefix}-transparent-toggle`);
  if (!toggle) return;

  const hide = toggle.checked;
  const colorLabel = document
    .getElementById(`${prefix}-color-input`)
    ?.closest("label");
  const gradientToggle = document.getElementById(`${prefix}-gradient-toggle`);
  const gradientLabel = gradientToggle?.closest("label");
  const gradientFields = document.getElementById(`${prefix}-gradient-fields`);

  if (colorLabel) colorLabel.style.display = hide ? "none" : "";
  if (gradientLabel) gradientLabel.style.display = hide ? "none" : "";
  if (gradientFields) {
    gradientFields.style.display =
      !hide && gradientToggle?.checked ? "" : "none";
  }
}

/**
 * 모서리 사각형/도트의 "색상" 선택(select)이 "직접 지정"이 아니면
 * 색상·그라데이션 입력칸을 숨긴다.
 */
function syncColorModeVisibility(prefix) {
  const select = document.getElementById(`${prefix}-color-mode-select`);
  const fields = document.getElementById(`${prefix}-color-fields`);
  if (!select || !fields) return;
  fields.style.display = select.value === "custom" ? "" : "none";
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
  const logoSource =
    document.querySelector('input[name="logo-source"]:checked')?.value ?? "url";
  const image =
    logoSource === "upload"
      ? logoDataUrl || undefined
      : document.getElementById("logo-url-input").value || undefined;

  const dotsTransparent = document.getElementById(
    "dots-transparent-toggle",
  ).checked;
  const dotsOptions = {
    color: dotsTransparent
      ? "transparent"
      : document.getElementById("dots-color-input").value,
    type: document.getElementById("dots-type-select").value,
    gradient: dotsTransparent ? undefined : readGradient("dots"),
  };

  const bgTransparent = document.getElementById(
    "bg-transparent-toggle",
  ).checked;
  const backgroundOptions = {
    color: bgTransparent
      ? "transparent"
      : document.getElementById("bg-color-input").value,
    gradient: bgTransparent ? undefined : readGradient("bg"),
  };

  // 모서리 사각형 색상: 직접 지정 / 투명(구멍 뚫기) / 점 스타일 색상 따라가기(기본).
  // "따라가기"인데 도트가 "투명(구멍 뚫기)" 상태라 따라갈 실제 색이 없는 경우에는
  // 모서리(파인더 패턴)까지 함께 사라져 인식이 아예 불가능해지므로, 기본 검정색으로
  // 대체한다 — 모서리를 투명하게 하고 싶으면 아래에서 명시적으로 "투명"을 선택해야 한다.
  const cornersSquareColorMode = document.getElementById(
    "corners-square-color-mode-select",
  ).value;
  const cornersSquareOptions =
    cornersSquareColorMode === "custom"
      ? {
          colorMode: "custom",
          color: document.getElementById("corners-square-color-input").value,
          type: cornersSquareType || undefined,
          gradient: readGradient("corners-square"),
        }
      : cornersSquareColorMode === "transparent"
        ? {
            colorMode: "transparent",
            color: "transparent",
            type: cornersSquareType || undefined,
            gradient: undefined,
          }
        : {
            colorMode: "follow-dots",
            color: dotsOptions.color === "transparent" ? "#000000" : dotsOptions.color,
            type: cornersSquareType || undefined,
            gradient: dotsOptions.color === "transparent" ? undefined : dotsOptions.gradient,
          };

  // 모서리 도트 색상: 직접 지정 / 투명(구멍 뚫기) / 모서리 사각형 색상 따라가기 /
  // 점 스타일 색상 따라가기(기본)
  const cornersDotColorMode = document.getElementById(
    "corners-dot-color-mode-select",
  ).value;
  const cornersDotColorSource =
    cornersDotColorMode === "custom"
      ? {
          color: document.getElementById("corners-dot-color-input").value,
          gradient: readGradient("corners-dot"),
        }
      : cornersDotColorMode === "transparent"
        ? { color: "transparent", gradient: undefined }
        : cornersDotColorMode === "follow-corners-square"
          ? {
              color: cornersSquareOptions.color,
              gradient: cornersSquareOptions.gradient,
            }
          : {
              color:
                dotsOptions.color === "transparent" ? "#000000" : dotsOptions.color,
              gradient:
                dotsOptions.color === "transparent" ? undefined : dotsOptions.gradient,
            };
  const cornersDotOptions = {
    colorMode: cornersDotColorMode,
    color: cornersDotColorSource.color,
    type: cornersDotType || undefined,
    gradient: cornersDotColorSource.gradient,
  };

  return {
    errorCorrLvl: document.getElementById("error-corr-select").value,
    image,
    margin: Number(document.getElementById("margin-input").value),
    shape: document.getElementById("shape-select").value,
    width: Number(document.getElementById("width-input").value),
    height: Number(document.getElementById("height-input").value),

    imageOptions: {
      imageSize: Number(document.getElementById("image-size-input").value),
      margin: Number(document.getElementById("image-margin-input").value),
    },

    dotsOptions,
    backgroundOptions,
    cornersSquareOptions,
    cornersDotOptions,
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
  document.querySelector('input[name="logo-source"][value="url"]').checked =
    true;
  document.getElementById("logo-url-area").style.display = "";
  document.getElementById("logo-upload-area").style.display = "none";
  logoDataUrl = null;
  document.getElementById("logo-file-preview").style.display = "none";
  document.getElementById("margin-input").value = settings.margin ?? 0;
  document.getElementById("shape-select").value = settings.shape ?? "square";
  document.getElementById("width-input").value = settings.width ?? 300;
  document.getElementById("height-input").value = settings.height ?? 300;

  document.getElementById("image-size-input").value =
    settings.imageOptions?.imageSize ?? 0.4;
  document.getElementById("image-margin-input").value =
    settings.imageOptions?.margin ?? 0;

  const bgTransparent = settings.backgroundOptions?.color === "transparent";
  document.getElementById("bg-transparent-toggle").checked = bgTransparent;
  document.getElementById("bg-color-input").value = bgTransparent
    ? "#ffffff"
    : (settings.backgroundOptions?.color ?? "#ffffff");
  applyGradientToForm("bg", settings.backgroundOptions?.gradient);
  syncTransparentVisibility("bg");

  const dotsTransparent = settings.dotsOptions?.color === "transparent";
  document.getElementById("dots-transparent-toggle").checked = dotsTransparent;
  document.getElementById("dots-color-input").value = dotsTransparent
    ? "#000000"
    : (settings.dotsOptions?.color ?? "#000000");
  document.getElementById("dots-type-select").value =
    settings.dotsOptions?.type ?? "square";
  applyGradientToForm("dots", settings.dotsOptions?.gradient);
  syncTransparentVisibility("dots");

  // colorMode가 없는(신규 기능 이전에 저장된) 기존 프리셋/히스토리는 사용자가
  // 직접 지정했던 색을 그대로 보존해야 하므로 "custom"으로 취급한다.
  const cornersSquareColorMode = settings.cornersSquareOptions?.colorMode;
  document.getElementById("corners-square-color-mode-select").value = [
    "follow-dots",
    "transparent",
  ].includes(cornersSquareColorMode)
    ? cornersSquareColorMode
    : "custom";
  document.getElementById("corners-square-color-input").value =
    settings.cornersSquareOptions?.color ?? "#000000";
  document.getElementById("corners-square-type-select").value =
    settings.cornersSquareOptions?.type ?? "";
  applyGradientToForm(
    "corners-square",
    settings.cornersSquareOptions?.gradient,
  );
  syncColorModeVisibility("corners-square");

  const cornersDotColorMode = settings.cornersDotOptions?.colorMode;
  document.getElementById("corners-dot-color-mode-select").value = [
    "follow-dots",
    "follow-corners-square",
    "transparent",
    "custom",
  ].includes(cornersDotColorMode)
    ? cornersDotColorMode
    : "custom";
  document.getElementById("corners-dot-color-input").value =
    settings.cornersDotOptions?.color ?? "#000000";
  document.getElementById("corners-dot-type-select").value =
    settings.cornersDotOptions?.type ?? "";
  applyGradientToForm("corners-dot", settings.cornersDotOptions?.gradient);
  syncColorModeVisibility("corners-dot");
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
 * 입력값 또는 디자인 설정 변경 시 500ms 디바운스 후 자동으로 미리보기를 갱신하고,
 * 2000ms 후 히스토리에 기록한다.
 */
function scheduleAutoPreview() {
  clearTimeout(autoPreviewTimer);
  clearTimeout(autoHistoryTimer);

  autoPreviewTimer = setTimeout(() => {
    const type = document.getElementById("qr-type-select").value;
    const data = buildDataString(type, { silent: true });
    if (!data) return;
    const settings = collectSettingsFromForm();
    renderQrPreviewAuto(data, settings);
  }, 500);

  autoHistoryTimer = setTimeout(() => {
    if (suppressHistoryRecord) return;
    const type = document.getElementById("qr-type-select").value;
    const data = buildDataString(type, { silent: true });
    if (!data) return;
    const settings = collectSettingsFromForm();
    recordHistoryEntry(type, data, settings);
  }, 2000);
}

/**
 * jpeg는 알파 채널을 지원하지 않으므로, 투명 배경/도트를 사용 중인데
 * jpeg를 선택했으면 안내 문구를 보여준다.
 */
function updateExportTransparentNote() {
  const noteEl = document.getElementById("export-transparent-note");
  if (!noteEl) return;
  const ext = document.getElementById("download-ext-select").value;
  const anyTransparent =
    document.getElementById("bg-transparent-toggle").checked ||
    document.getElementById("dots-transparent-toggle").checked ||
    document.getElementById("corners-square-color-mode-select").value ===
      "transparent" ||
    document.getElementById("corners-dot-color-mode-select").value ===
      "transparent";
  noteEl.style.display = anyTransparent && ext === "jpeg" ? "" : "none";
}

/**
 * "내보내기" 버튼 클릭 시: 현재 입력값/스타일로 QR을 갱신한 뒤 다운로드 모달을 띔
 */
function openExportModal() {
  const type = document.getElementById("qr-type-select").value;
  const data = buildDataString(type);
  if (!data) return;

  const settings = collectSettingsFromForm();
  renderQrPreviewAuto(data, settings); // 내부에서 updateContrastWarning()/updateDensityWarning() 호출됨

  // 내보내기 모달에도 동일한 대비 경고 표시
  const ratio = computeMinContrastRatio();
  applyContrastWarning(
    document.getElementById("export-contrast-warning"),
    document.getElementById("export-contrast-warning-text"),
    ratio,
  );
  updateExportTransparentNote();

  document.getElementById("export-modal").style.display = "flex";
}

function closeExportModal() {
  document.getElementById("export-modal").style.display = "none";
}

function openPatchNotesModal() {
  document.getElementById("patch-notes-modal").style.display = "flex";
}

function closePatchNotesModal() {
  document.getElementById("patch-notes-modal").style.display = "none";
}

/**
 * 모달의 "다운로드" 버튼 클릭 시: 선택한 확장자로 현재 QR 코드 다운로드
 */
function triggerBlobDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function loadImageFromUrl(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

/**
 * 도트 구멍 뚫기가 적용된 svg는 qr-code-styling의 기본 download()로 내보내면
 * 구멍이 사라진 채(내부적으로 옵션만 보고 svg를 다시 그리기 때문) 저장되므로,
 * 화면에 실제로 그려진(구멍이 반영된) svg 엘리먼트를 직접 직렬화/래스터화해서
 * 내보낸다.
 */
async function downloadMaskedSvg({ el, width, height }, extension) {
  const svgString = new XMLSerializer().serializeToString(el);

  if (extension === "svg") {
    triggerBlobDownload(
      new Blob([svgString], { type: "image/svg+xml" }),
      "qrcode.svg",
    );
    return;
  }

  const svgUrl = URL.createObjectURL(
    new Blob([svgString], { type: "image/svg+xml" }),
  );
  try {
    const img = await loadImageFromUrl(svgUrl);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d").drawImage(img, 0, 0, width, height);
    const mime =
      extension === "jpeg"
        ? "image/jpeg"
        : extension === "webp"
          ? "image/webp"
          : "image/png";
    canvas.toBlob((blob) => {
      if (blob) triggerBlobDownload(blob, `qrcode.${extension}`);
    }, mime);
  } finally {
    URL.revokeObjectURL(svgUrl);
  }
}

function downloadQrCode() {
  if (!currentQrCode) {
    alert("먼저 QR 코드를 생성해주세요.");
    return;
  }

  const extension = document.getElementById("download-ext-select").value;
  if (currentHolePunchedSvg) {
    downloadMaskedSvg(currentHolePunchedSvg, extension);
    return;
  }
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
  scheduleAutoPreview();
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
const HISTORY_MAX_KEY = "qrgen-history-max";
const HISTORY_MAX_DEFAULT = 50;
const HISTORY_PAGE_SIZE_KEY = "qrgen-history-page-size";
const HISTORY_PAGE_SIZE_DEFAULT = 5;
const LAST_QR_TYPE_KEY = "qrgen-last-type";
const THEME_KEY = "qrgen-theme";

/* ==================== 테마 ==================== */

function initTheme() {
  updateThemeBtn(
    document.documentElement.getAttribute("data-theme") || "light",
  );

  // 시스템 설정 변경 시 명시적 override 없으면 자동 반영
  window
    .matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", (e) => {
      if (!localStorage.getItem(THEME_KEY)) {
        applyTheme(e.matches ? "dark" : "light", false);
      }
    });
}

function applyTheme(theme, save = true) {
  document.documentElement.setAttribute("data-theme", theme);
  if (save) {
    localStorage.setItem(THEME_KEY, theme);
  }
  updateThemeBtn(theme);
}

function updateThemeBtn(theme) {
  const btn = document.getElementById("theme-toggle");
  if (!btn) return;
  if (theme === "dark") {
    btn.textContent = "☀️";
    btn.title = "라이트 모드로 전환";
  } else {
    btn.textContent = "🌙";
    btn.title = "다크 모드로 전환";
  }
}

function toggleTheme() {
  const current =
    document.documentElement.getAttribute("data-theme") || "light";
  applyTheme(current === "dark" ? "light" : "dark");
}

function getHistoryMaxItems() {
  const v = parseInt(localStorage.getItem(HISTORY_MAX_KEY), 10);
  return isNaN(v) || v < 1 ? HISTORY_MAX_DEFAULT : v;
}

function setHistoryMaxItems(value) {
  localStorage.setItem(HISTORY_MAX_KEY, String(value));
}

function getHistoryPageSize() {
  const v = parseInt(localStorage.getItem(HISTORY_PAGE_SIZE_KEY), 5);
  return isNaN(v) || v < 1 ? HISTORY_PAGE_SIZE_DEFAULT : v;
}

function setHistoryPageSize(value) {
  localStorage.setItem(HISTORY_PAGE_SIZE_KEY, String(value));
}

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
  const max = getHistoryMaxItems();
  let trimmed = [...list];

  if (trimmed.length > max) {
    const excess = trimmed.length - max;
    let removed = 0;
    for (let i = 0; i < trimmed.length && removed < excess; ) {
      if (!trimmed[i].favorite) {
        trimmed.splice(i, 1);
        removed++;
      } else {
        i++;
      }
    }
    while (trimmed.length > max) {
      trimmed.shift();
    }
  }

  localStorage.setItem(HISTORY_KEY, JSON.stringify(trimmed));
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
  if (!getHistoryEnabled() || suppressHistoryRecord) return;

  const disallowed = typeHasDisallowedSensitiveField(type);

  const entry = {
    id: Date.now(),
    type,
    createdAt: new Date().toISOString(),
    fields: buildHistoryFieldsSnapshot(type),
    data: disallowed ? null : data,
    settings,
    favorite: false,
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

function toggleFavorite(id) {
  const history = getHistory();
  const entry = history.find((item) => item.id === id);
  if (!entry) return;
  entry.favorite = !entry.favorite;
  saveHistory(history);
  renderHistoryList();
}

function clearHistory() {
  if (!confirm("모든 히스토리를 삭제할까요?")) return;
  saveHistory([]);
  renderHistoryList();
}

/**
 * 히스토리 항목을 입력 폼에 다시 채워줌.
 * 비공개(redacted) 항목은 빈 값으로 채워 사용자가 재입력할 수 있도록 함.
 */
function loadHistoryEntry(id) {
  const history = getHistory();
  const entry = history.find((item) => item.id === id);
  if (!entry) return;

  document.getElementById("qr-type-select").value = entry.type;
  syncTypeFields();
  localStorage.setItem(LAST_QR_TYPE_KEY, entry.type);

  const defs = TYPE_FIELD_DEFS[entry.type] || [];
  defs.forEach((def, index) => {
    const snapshot = entry.fields[index];
    const el = document.getElementById(def.id);
    if (!el || !snapshot) return;

    if (snapshot.redacted) {
      if (def.isCheckbox) el.checked = false;
      else el.value = "";
      return;
    }

    if (def.isCheckbox) {
      el.checked = snapshot.value === "예";
    } else {
      el.value = snapshot.value ?? "";
    }
  });

  applySettingsToForm(entry.settings);

  suppressHistoryRecord = true;
  clearTimeout(autoHistoryTimer);
  scheduleAutoPreview();
  setTimeout(() => {
    suppressHistoryRecord = false;
  }, 2500);

  const hasRedacted = entry.fields.some((field) => field.redacted);
  if (hasRedacted) {
    alert(
      "개인정보 보호 설정으로 기록되지 않은 항목은 비워져 있습니다. 직접 입력해 주세요.",
    );
  }
}

function renderHistoryList() {
  const container = document.getElementById("history-list");
  const paginationEl = document.getElementById("history-pagination");
  const countLabel = document.getElementById("history-count-label");
  const allHistory = getHistory();

  if (countLabel) countLabel.textContent = `총 ${allHistory.length}개`;

  const reversed = allHistory.slice().reverse();
  const favorites = reversed.filter((e) => e.favorite);
  const nonFavorites = reversed.filter((e) => !e.favorite);
  const sorted = [...favorites, ...nonFavorites];

  container.innerHTML = "";

  if (sorted.length === 0) {
    container.innerHTML =
      '<p class="history-empty">아직 생성 기록이 없습니다.</p>';
    if (paginationEl) paginationEl.innerHTML = "";
    return;
  }

  const pageSize = getHistoryPageSize();
  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));

  if (historyCurrentPage > totalPages) historyCurrentPage = totalPages;
  if (historyCurrentPage < 1) historyCurrentPage = 1;

  const startIdx = (historyCurrentPage - 1) * pageSize;
  const pageItems = sorted.slice(startIdx, startIdx + pageSize);

  pageItems.forEach((entry) => {
    const item = document.createElement("div");
    item.className = "history-item" + (entry.favorite ? " is-favorite" : "");

    const thumb = document.createElement("div");
    thumb.className = "history-thumb";

    if (entry.data) {
      try {
        const thumbQr = generate(entry.data, {
          ...entry.settings,
          width: 45,
          height: 45,
          image: undefined,
        });
        const tempDiv = document.createElement("div");
        thumbQr.append(tempDiv);
        const canvasEl = tempDiv.querySelector("canvas");
        const canvasCtx = canvasEl.getContext("2d");
        if (canvasEl) {
          const svgStr = new XMLSerializer().serializeToString(canvasEl); // svg 로드
          const b64 = btoa(unescape(encodeURIComponent(svgStr)));
          const img = new Image();
          img.src = `data:image/svg+xml;base64,${b64}`;
          img.onload = function () {
            // drawImage(이미지객체, x좌표, y좌표, 가로크기, 세로크기)
            canvasCtx.drawImage(img, 0, 0, canvasEl.width, canvasEl.height);
            // console.log(thumb);
          };
          thumb.appendChild(tempDiv);
        }
      } catch (e) {
        // 오류 예외 처리
        console.error(e);
        thumb.classList.add("history-thumb-locked");
        thumb.textContent = "?";
      }
    } else {
      // 민감 정보 포함 시 랜더링 x
      thumb.classList.add("history-thumb-locked");
      thumb.textContent = "🔒";
    }

    const info = document.createElement("div");
    info.className = "history-info";

    const titleRow = document.createElement("div");
    titleRow.className = "history-title-row";

    const title = document.createElement("strong");
    title.textContent = QR_TYPE_LABELS[entry.type] || entry.type;

    const date = document.createElement("span");
    date.className = "history-date";
    date.textContent = formatHistoryDate(entry.createdAt);

    titleRow.appendChild(title);
    titleRow.appendChild(date);

    const fieldList = document.createElement("ul");
    entry.fields.forEach((field) => {
      const li = document.createElement("li");
      li.textContent = `${field.label}: ${field.redacted ? "비공개" : field.value || "-"}`;
      fieldList.appendChild(li);
    });

    const actions = document.createElement("div");
    actions.className = "history-actions";

    const favBtn = document.createElement("button");
    favBtn.type = "button";
    favBtn.className = "history-fav-btn" + (entry.favorite ? " favorited" : "");
    favBtn.title = entry.favorite ? "즐겨찾기 해제" : "즐겨찾기";
    favBtn.textContent = "★";
    favBtn.addEventListener("click", () => toggleFavorite(entry.id));

    const loadBtn = document.createElement("button");
    loadBtn.type = "button";
    loadBtn.textContent = "불러오기";
    loadBtn.addEventListener("click", () => loadHistoryEntry(entry.id));

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.textContent = "삭제";
    deleteBtn.addEventListener("click", () => deleteHistoryEntry(entry.id));

    actions.appendChild(favBtn);
    actions.appendChild(loadBtn);
    actions.appendChild(deleteBtn);

    info.appendChild(titleRow);
    info.appendChild(fieldList);
    info.appendChild(actions);

    item.appendChild(thumb);
    item.appendChild(info);
    container.appendChild(item);
  });

  // 페이지네이션 컨트롤 렌더링
  if (!paginationEl) return;
  paginationEl.innerHTML = "";

  const row = document.createElement("div");
  row.className = "history-pagination-row";

  const prevBtn = document.createElement("button");
  prevBtn.type = "button";
  prevBtn.className = "history-page-btn";
  prevBtn.textContent = "‹";
  prevBtn.disabled = historyCurrentPage <= 1;
  prevBtn.addEventListener("click", () => {
    historyCurrentPage--;
    renderHistoryList();
  });

  const pageInfo = document.createElement("span");
  pageInfo.className = "history-page-info";
  pageInfo.textContent = `${historyCurrentPage} / ${totalPages}`;

  const nextBtn = document.createElement("button");
  nextBtn.type = "button";
  nextBtn.className = "history-page-btn";
  nextBtn.textContent = "›";
  nextBtn.disabled = historyCurrentPage >= totalPages;
  nextBtn.addEventListener("click", () => {
    historyCurrentPage++;
    renderHistoryList();
  });

  const pageSizeInput = document.createElement("input");
  pageSizeInput.type = "number";
  pageSizeInput.className = "history-page-size-input";
  pageSizeInput.value = pageSize;
  pageSizeInput.min = 1;
  pageSizeInput.max = 100;
  pageSizeInput.addEventListener("change", (e) => {
    const v = parseInt(e.target.value, 5);
    if (!isNaN(v) && v >= 1) {
      setHistoryPageSize(v);
      historyCurrentPage = 1;
      renderHistoryList();
    }
  });

  const pageSizeLabel = document.createElement("span");
  pageSizeLabel.className = "history-page-size-label";
  pageSizeLabel.textContent = "개 씩 표시";

  row.appendChild(prevBtn);
  row.appendChild(pageInfo);
  row.appendChild(nextBtn);
  row.appendChild(document.createElement("br"));
  row.appendChild(pageSizeInput);
  row.appendChild(pageSizeLabel);
  paginationEl.appendChild(row);
}

/* ==================== 디자인 초기값 리셋 버튼 ==================== */

const DESIGN_DEFAULTS = {
  "shape-select": "square",
  "width-input": "300",
  "height-input": "300",
  "margin-input": "0",
  "error-corr-select": "Q",
  "logo-url-input": "",
  "image-size-input": "0.4",
  "image-margin-input": "0",
  "dots-transparent-toggle": false,
  "dots-color-input": "#000000",
  "dots-type-select": "square",
  "dots-gradient-toggle": false,
  "dots-gradient-type-select": "linear",
  "dots-gradient-rotation-input": "0",
  "dots-gradient-color1-input": "#000000",
  "dots-gradient-color2-input": "#ffffff",
  "bg-transparent-toggle": false,
  "bg-color-input": "#ffffff",
  "bg-gradient-toggle": false,
  "bg-gradient-type-select": "linear",
  "bg-gradient-rotation-input": "0",
  "bg-gradient-color1-input": "#ffffff",
  "bg-gradient-color2-input": "#000000",
  "corners-square-color-mode-select": "follow-dots",
  "corners-square-color-input": "#000000",
  "corners-square-type-select": "",
  "corners-square-gradient-toggle": false,
  "corners-square-gradient-type-select": "linear",
  "corners-square-gradient-rotation-input": "0",
  "corners-square-gradient-color1-input": "#000000",
  "corners-square-gradient-color2-input": "#ffffff",
  "corners-dot-color-mode-select": "follow-dots",
  "corners-dot-color-input": "#000000",
  "corners-dot-type-select": "",
  "corners-dot-gradient-toggle": false,
  "corners-dot-gradient-type-select": "linear",
  "corners-dot-gradient-rotation-input": "0",
  "corners-dot-gradient-color1-input": "#000000",
  "corners-dot-gradient-color2-input": "#ffffff",
};

function initDesignResetButtons() {
  Object.entries(DESIGN_DEFAULTS).forEach(([id, defaultValue]) => {
    const el = document.getElementById(id);
    if (!el) return;

    const label = el.closest("label");
    if (!label) return;

    const isCheckbox = typeof defaultValue === "boolean";

    const resetBtn = document.createElement("button");
    resetBtn.type = "button";
    resetBtn.className = "input-reset-btn";
    resetBtn.title = "초기값으로 되돌리기";
    resetBtn.textContent = "↺";
    resetBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (isCheckbox) {
        el.checked = defaultValue;
        el.dispatchEvent(new Event("change", { bubbles: true }));
      } else {
        el.value = defaultValue;
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
      scheduleAutoPreview();
    });

    if (isCheckbox) {
      label.appendChild(resetBtn);
    } else {
      let textNode = null;
      for (const node of label.childNodes) {
        if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) {
          textNode = node;
          break;
        }
      }
      if (textNode) {
        const headerSpan = document.createElement("span");
        headerSpan.className = "label-header";
        headerSpan.textContent = textNode.textContent.trim();
        headerSpan.appendChild(resetBtn);
        label.replaceChild(headerSpan, textNode);
      }
    }
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

/* ==================== 브라우저 호환성 경고 ==================== */

const BROWSER_WARNING_DISMISSED_KEY = "qrgen-browser-warning-dismissed";

function isChromeBrowser() {
  const ua = navigator.userAgent;
  // CriOS = Chrome on iOS
  if (/CriOS\//.test(ua)) return true;
  // Chrome on desktop/Android: "Chrome/" 있고 Edge·Opera·Samsung 아님
  return (
    /Chrome\//.test(ua) &&
    !/Edg\//.test(ua) &&
    !/OPR\//.test(ua) &&
    !/SamsungBrowser\//.test(ua)
  );
}

function initBrowserWarning() {
  if (isChromeBrowser()) return;
  if (localStorage.getItem(BROWSER_WARNING_DISMISSED_KEY) === "true") return;

  const warningEl = document.getElementById("browser-warning");
  warningEl.style.display = "";
  updatePreviewSize();

  // 플랫폼별 Chrome으로 열기 링크 설정
  const currentUrl = window.location.href;
  const chromeLink = document.getElementById("browser-warning-chrome-link");
  const ua = navigator.userAgent;

  if (/iPhone|iPad|iPod/.test(ua)) {
    chromeLink.href = `googlechrome://navigate?url=${encodeURIComponent(currentUrl)}`;
  } else if (/Android/.test(ua)) {
    const host = currentUrl.replace(/^https?:\/\//, "");
    chromeLink.href = `intent://${host}#Intent;scheme=https;package=com.android.chrome;end`;
  } else {
    // 데스크톱: 원클릭으로 열 수 없으므로 링크 숨김
    chromeLink.style.display = "none";
  }

  document
    .getElementById("browser-warning-close")
    .addEventListener("click", () => {
      if (document.getElementById("browser-warning-noshow").checked) {
        localStorage.setItem(BROWSER_WARNING_DISMISSED_KEY, "true");
      }
      warningEl.style.display = "none";
      updatePreviewSize();
    });
}

// DOM 로드 후 이벤트 연결
document.addEventListener("DOMContentLoaded", () => {
  initTheme();
  document
    .getElementById("theme-toggle")
    .addEventListener("click", toggleTheme);

  initBrowserWarning();
  initAccordions();
  initDesignResetButtons();

  // 마지막으로 사용한 QR 유형 복원
  const savedType = localStorage.getItem(LAST_QR_TYPE_KEY) || "url";
  const typeSelect = document.getElementById("qr-type-select");
  typeSelect.value = savedType;
  syncTypeFields();

  typeSelect.addEventListener("change", (e) => {
    syncTypeFields();
    localStorage.setItem(LAST_QR_TYPE_KEY, e.target.value);
    updatePreviewSize();
  });

  // 미리보기 보기 모드(너비/높이 기준) 복원 + 초기 크기 계산
  initPreviewViewMode();
  initPreviewBgSettings();

  document
    .getElementById("btn-export")
    .addEventListener("click", openExportModal);
  document
    .getElementById("btn-download")
    .addEventListener("click", downloadQrCode);
  document
    .getElementById("modal-close-btn")
    .addEventListener("click", closeExportModal);
  document
    .getElementById("download-ext-select")
    .addEventListener("change", updateExportTransparentNote);

  // 모달 바깥(배경) 클릭 시 닫기
  document.getElementById("export-modal").addEventListener("click", (event) => {
    if (event.target.id === "export-modal") {
      closeExportModal();
    }
  });

  // 패치노트 모달
  document
    .getElementById("btn-patch-notes")
    .addEventListener("click", openPatchNotesModal);
  document
    .getElementById("patch-notes-close-btn")
    .addEventListener("click", closePatchNotesModal);
  document
    .getElementById("patch-notes-modal")
    .addEventListener("click", (event) => {
      if (event.target.id === "patch-notes-modal") {
        closePatchNotesModal();
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

  // 투명 체크박스(도트/배경): 켜지면 색상·그라데이션 입력 숨김.
  ["bg", "dots"].forEach((prefix) => {
    document
      .getElementById(`${prefix}-transparent-toggle`)
      .addEventListener("change", () => syncTransparentVisibility(prefix));
    syncTransparentVisibility(prefix); // 초기 상태 반영
  });

  // 모서리 사각형/도트 색상 선택(따라가기/직접 지정): 직접 지정일 때만 입력 표시
  ["corners-square", "corners-dot"].forEach((prefix) => {
    document
      .getElementById(`${prefix}-color-mode-select`)
      .addEventListener("change", () => syncColorModeVisibility(prefix));
    syncColorModeVisibility(prefix); // 초기 상태 반영
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

  // 히스토리 최대 개수 설정
  const historyMaxInput = document.getElementById("history-max-input");
  historyMaxInput.value = getHistoryMaxItems();
  historyMaxInput.addEventListener("change", (e) => {
    const v = parseInt(e.target.value, 10);
    if (!isNaN(v) && v >= 1) {
      setHistoryMaxItems(v);
      const history = getHistory();
      saveHistory(history);
      renderHistoryList();
    }
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

  // 자동 미리보기: 입력값/디자인 변경 시 디바운스 후 갱신
  ["input", "change"].forEach((eventName) => {
    document.addEventListener(eventName, (e) => {
      const t = e.target;
      if (t.id === "logo-file-input") return;
      if (t.id === "history-max-input") return;
      if (t.name === "preview-view-mode") return;
      if (t.closest(".preview-bg-controls")) return;

      if (t.name === "logo-source") {
        const isUpload = t.value === "upload";
        document.getElementById("logo-url-area").style.display = isUpload
          ? "none"
          : "";
        document.getElementById("logo-upload-area").style.display = isUpload
          ? ""
          : "none";
      }

      if (
        t.closest(".type-fields-section") ||
        t.closest(".panel-design") ||
        t.id === "qr-type-select"
      ) {
        scheduleAutoPreview();
      }
    });
  });

  // 로고 파일 업로드: FileReader로 data URL 변환 후 자동 미리보기
  document.getElementById("logo-file-input").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) {
      logoDataUrl = null;
      document.getElementById("logo-file-preview").style.display = "none";
      scheduleAutoPreview();
      return;
    }
    const reader = new FileReader();
    reader.onload = (ev) => {
      logoDataUrl = ev.target.result;
      document.getElementById("logo-file-thumb").src = logoDataUrl;
      document.getElementById("logo-file-preview").style.display = "flex";
      scheduleAutoPreview();
    };
    reader.readAsDataURL(file);
  });

  // 로고 이미지 제거 버튼
  document.getElementById("logo-file-clear").addEventListener("click", () => {
    logoDataUrl = null;
    document.getElementById("logo-file-input").value = "";
    document.getElementById("logo-file-preview").style.display = "none";
    scheduleAutoPreview();
  });
});
