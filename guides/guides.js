// 다크모드 토글 (다른 페이지와 동일한 localStorage 키 공유)
(function () {
  var THEME_KEY = "qrgen-theme";
  var btn = document.getElementById("theme-toggle");
  if (!btn) return;

  function updateBtn(theme) {
    if (theme === "dark") {
      btn.textContent = "☀️";
      btn.title = "라이트 모드로 전환";
    } else {
      btn.textContent = "🌙";
      btn.title = "다크 모드로 전환";
    }
  }

  updateBtn(document.documentElement.getAttribute("data-theme") || "light");

  btn.addEventListener("click", function () {
    var current =
      document.documentElement.getAttribute("data-theme") || "light";
    var next = current === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem(THEME_KEY, next);
    updateBtn(next);
  });
})();

// "사용해보기" 클릭 기록: index.html의 재방문자 리다이렉트 로직과 동일한 플래그
(function () {
  document.querySelectorAll('a[href="/app"]').forEach(function (link) {
    link.addEventListener("click", function () {
      try {
        localStorage.setItem("qrgen-visited", "true");
      } catch (e) {
        // localStorage를 못 쓰는 환경이면 그냥 넘어감
      }
    });
  });
})();
