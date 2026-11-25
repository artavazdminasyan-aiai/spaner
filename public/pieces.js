/* Spaner — piece artwork (inline SVG, 100×100). Owner colour comes from CSS classes. */
(function () {
  'use strict';

  const BASE =
    '<path class="b" d="M29 87 C29 82.5 32 80 36 80 H64 C68 80 71 82.5 71 87 Z"/>' +
    '<path class="b" d="M21 95 C21 89.5 25 87 30 87 H70 C75 87 79 89.5 79 95 Z"/>' +
    '<path class="gem" d="M50 87.6 L53.2 91.2 L50 94.8 L46.8 91.2 Z"/>';

  const BODY_LOW = '<path class="b" d="M37 58 C39.5 68 35.5 74 31 80 H69 C64.5 74 60.5 68 63 58 Z"/>';

  const SHAPES = {
    P:
      '<path class="b" d="M42 49 C43 63 38.5 72 32 80 H68 C61.5 72 57 63 58 49 Z"/>' +
      '<ellipse class="b" cx="50" cy="47" rx="12.5" ry="4.2"/>' +
      '<circle class="b" cx="50" cy="31" r="12.5"/>' +
      '<path class="hl" d="M44 25 C46 22 49 21 51.5 21.5"/>',
    R:
      '<path class="b" d="M37 38 H63 L60.5 72 H39.5 Z"/>' +
      '<path class="b" d="M33 72 H67 L68.5 80 H31.5 Z"/>' +
      '<path class="b" d="M29 16 H38 V23 H45.5 V16 H54.5 V23 H62 V16 H71 V32 L65 38 H35 L29 32 Z"/>' +
      '<path class="ln" d="M36 32 H64"/>' +
      '<path class="gem" d="M50 47 L53.5 53 L50 59 L46.5 53 Z"/>',
    B:
      '<path class="b" d="M41 59 C43 68 38 74 32 80 H68 C62 74 57 68 59 59 Z"/>' +
      '<ellipse class="b" cx="50" cy="56" rx="15.5" ry="4.2"/>' +
      '<path class="b" d="M50 17 C37 26 32.5 40 37 52 H63 C67.5 40 63 26 50 17 Z"/>' +
      '<circle class="b" cx="50" cy="12.5" r="4.6"/>' +
      '<path class="ln" d="M56 27 L46.5 41"/>' +
      '<path class="gem" d="M50 43 L52.6 46.5 L50 50 L47.4 46.5 Z"/>',
    N:
      '<path class="b" d="M33 80 C35 68 41 60 45 53 C40 55.5 34 57.5 29.5 56.5 C24.5 55.5 20.5 51 21.8 46 C23 41.5 29 36 34.5 30 C37.5 26 41 22 45 19 L46 10.5 L51.5 17 C63 18 72.5 30.5 71.5 48.5 C70.8 62 66.5 70 70 80 Z"/>' +
      '<path class="ln" d="M53.5 21 C62 29 65 43 62.5 62"/>' +
      '<circle class="eye" cx="40.5" cy="30.5" r="2.4"/>' +
      '<circle class="eye" cx="26.2" cy="47.6" r="1.4"/>' +
      '<path class="gem" d="M57 66 L59.8 69.8 L57 73.6 L54.2 69.8 Z"/>',
    Q:
      BODY_LOW +
      '<path class="b" d="M29 58 H71 L69 52 H31 Z"/>' +
      '<path class="b" d="M31 52 L25 24 L37 38.5 L39 17 L47 35 L50 11 L53 35 L61 17 L63 38.5 L75 24 L69 52 Z"/>' +
      '<circle class="gem" cx="25" cy="22" r="3.6"/><circle class="gem" cx="39" cy="15" r="3.6"/>' +
      '<circle class="gem" cx="50" cy="9.5" r="3.8"/><circle class="gem" cx="61" cy="15" r="3.6"/>' +
      '<circle class="gem" cx="75" cy="22" r="3.6"/>' +
      '<path class="gem" d="M50 40 L53 44.5 L50 49 L47 44.5 Z"/>',
    K:
      BODY_LOW +
      '<path class="b" d="M29 58 H71 L69 52 H31 Z"/>' +
      '<path class="b" d="M31 52 C24 41 29.5 27 42 28.5 C46 29 48.3 31.5 50 34 C51.7 31.5 54 29 58 28.5 C70.5 27 76 41 69 52 Z"/>' +
      '<path class="b" d="M46.8 4 H53.2 V10 H59 V16.4 H53.2 V27 H46.8 V16.4 H41 V10 H46.8 Z"/>' +
      '<path class="gem" d="M50 39 L53.2 43.5 L50 48 L46.8 43.5 Z"/>',
    C:
      '<rect class="gem" x="66" y="6" width="3.6" height="74" rx="1.6"/>' +
      '<path class="gem" d="M67.8 1 L71 7 L64.6 7 Z"/>' +
      '<path class="b" d="M69.6 9 C77 5.5 83 12 93 8.5 C90.5 15.5 90.5 21.5 94 28 C85 31.5 78 25 69.6 28.5 Z"/>' +
      '<path class="gem" d="M81 13 L84 18 L81 23 L78 18 Z"/>' +
      '<path class="b" d="M27 80 C25.5 62 30 47 42 43.5 C53.5 46 59 58 58.5 80 Z"/>' +
      '<path class="b" d="M53 50 L66.5 45 L67.5 52 L55.5 57 Z"/>' +
      '<circle class="b" cx="42" cy="32" r="8.6"/>' +
      '<path class="b" d="M32.5 30 C32.5 19 51.5 19 51.5 30 Z"/>' +
      '<path class="ln" d="M42 20 C40 14 45 10.5 50 12.5"/>' +
      '<path class="ln" d="M29.5 64 H57.5"/>' +
      '<path class="gem" d="M43.5 61 L46.5 64 L43.5 67 L40.5 64 Z"/>',
    D:
      '<path class="b" d="M50 45 C55 31 66 20 86 13 C81.5 21 83 28 89 33 C81 33.5 78.5 39 80.5 45.5 C72.5 43 66 47 62 53 Z"/>' +
      '<path class="ln" d="M57 44 C64 35 72 27 83 18"/>' +
      '<path class="b" d="M28 80 C24.5 68 29 58 39.5 54 C33.5 46 31.5 36 37.5 28 L29 25.5 L35.5 21.5 L32.5 14.5 L42 18.5 C48.5 15.5 55 20 54.5 26.5 C54 32.5 50 36 48.5 40.5 C59 44 67 54.5 66.5 66.5 C66.3 72 70 76.5 75 80 Z"/>' +
      '<path class="ln" d="M41 56 C38.5 64 40.5 72 45 78"/>' +
      '<path class="ln" d="M59.5 71 C66 73.5 72.5 70 71 63.5"/>' +
      '<circle class="eye" cx="43" cy="24.5" r="2.2"/>',
    A:
      '<path class="b" d="M34 70 H66 L62.5 80 H37.5 Z"/>' +
      '<path class="fruit" d="M49 19 C35 25 26.5 43 29.5 66 C30.5 71.5 37.5 71.5 37 66 C36.5 46 42.5 32 52.5 24 Z"/>' +
      '<path class="fruit" d="M53 19 C67 25 75.5 43 72.5 66 C71.5 71.5 64.5 71.5 65 66 C65.5 46 59.5 32 49.5 24 Z"/>' +
      '<path class="fruit" d="M47.5 21 C44.5 37 44.5 53 48.5 71 C49.5 75.5 55.5 75.5 54.5 71 C52.5 53 53 37 55 21 Z"/>' +
      '<path class="stem" d="M46.5 9 H55.5 V22 H46.5 Z"/>' +
      '<path class="tip" d="M29.6 64 C29.8 67 31 69.5 33.2 70.2 L34.6 66 Z"/>' +
      '<path class="tip" d="M72.4 64 C72.2 67 71 69.5 68.8 70.2 L67.4 66 Z"/>' +
      '<path class="tip" d="M48.6 70 C49.2 73.5 51 75 52.6 75 L52.2 70.5 Z"/>',
  };

  const DEFS =
    '<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false"><defs>' +
    '<linearGradient id="g-w" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fffaf0"/><stop offset=".5" stop-color="#efdfba"/><stop offset="1" stop-color="#c9a873"/></linearGradient>' +
    '<linearGradient id="g-b" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#77706a"/><stop offset=".45" stop-color="#3a3531"/><stop offset="1" stop-color="#171413"/></linearGradient>' +
    '<linearGradient id="g-n" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7fd0c2"/><stop offset=".5" stop-color="#2f8a80"/><stop offset="1" stop-color="#16504a"/></linearGradient>' +
    '<linearGradient id="g-ban" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff59a"/><stop offset=".5" stop-color="#f7cf2b"/><stop offset="1" stop-color="#d99706"/></linearGradient>' +
    '<linearGradient id="g-gold" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fbe9a6"/><stop offset=".55" stop-color="#d4a94a"/><stop offset="1" stop-color="#94701f"/></linearGradient>' +
    '</defs></svg>';

  function svg(t, o) {
    return '<svg class="pc pc-' + o + '" viewBox="0 0 100 100" aria-hidden="true" focusable="false">' +
      (SHAPES[t] || '') + BASE + '</svg>';
  }

  function inject() {
    if (document.getElementById('g-w')) return;
    const holder = document.createElement('div');
    holder.innerHTML = DEFS;
    document.body.prepend(holder.firstChild);
  }

  window.SpanerPieces = { svg, inject };
})();
