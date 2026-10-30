// Tmavý režim je výchozí; volba návštěvnice se pamatuje (pokud to prohlížeč dovolí).
(function () {
  var t = 'dark';
  try { var v = localStorage.getItem('hn_theme'); if (v === 'light' || v === 'dark') t = v; } catch (e) { /* bez paměti */ }
  document.documentElement.setAttribute('data-theme', t);
  var m = document.querySelector('meta[name="theme-color"]');
  if (m) m.setAttribute('content', t === 'dark' ? '#0e0e0e' : '#fbf7f3');
})();
