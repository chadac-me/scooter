/* Play demo videos only while on screen, so the page loads one at a time. */
(function () {
  function init() {
    var videos = document.querySelectorAll(".scooter-demos video");
    if (!videos.length || !("IntersectionObserver" in window)) return;
    var seen = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) e.target.play().catch(function () {});
        else e.target.pause();
      });
    }, { threshold: 0.4 });
    videos.forEach(function (v) { seen.observe(v); });
  }
  // Material's instant navigation swaps pages without a reload.
  if (window.document$) window.document$.subscribe(init);
  else document.addEventListener("DOMContentLoaded", init);
})();
