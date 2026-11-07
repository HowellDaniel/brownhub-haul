window.__probeOut = null;
var out = {}, deferred = false;
function finish () { window.__probeOut = JSON.stringify(out); }
setTimeout(function () {
  out.webkit = /AppleWebKit\/[\d.]+/.test(navigator.userAgent) && !/Chrom(e|ium)/.test(navigator.userAgent);
  out.poppinsCedi = document.fonts ? document.fonts.check('600 16px Poppins', '\u20b5') : null;
  var de = document.documentElement;
  out.clientWidth = de.clientWidth;
  out.scrollWidth = de.scrollWidth;
  out.innerWidth = innerWidth;
  /** Deliberate swipe-scrollers and clipped media frames (the parallax hero is
   *  scaled past its bounds on purpose) are not page overflow. Measure the frame. */
  out.offenders = (function () {
    function clippedBy (el) {
      for (var a = el.parentElement; a && a !== de; a = a.parentElement) {
        var ox = getComputedStyle(a).overflowX;
        if (ox === 'auto' || ox === 'scroll' || ox === 'hidden' || ox === 'clip') return a.getBoundingClientRect().right <= de.clientWidth + 1;
      }
      return false;
    }
    var list = [], all = document.querySelectorAll('body *');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.classList.contains('skip')) continue;
      var r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      if ((r.right > de.clientWidth + 1 || r.left < -1) && !clippedBy(el)) {
        list.push(el.tagName.toLowerCase() + '.' + String(el.className || '').split(' ')[0] + ' ' + Math.round(r.left) + '..' + Math.round(r.right));
      }
      if (list.length > 5) break;
    }
    return list;
  })();
  /** An off-screen window never ticks the animation timeline, and every view in
   *  this app enters with "animation: rise .32s both" — fill-mode both means the
   *  element sits at opacity 0 until a frame advances. Seek to the end state
   *  before measuring, or the snapshot is a blank page over a healthy DOM. */
  out.animsSeeked = (function () {
    var n = 0;
    if (document.getAnimations) document.getAnimations().forEach(function (a) { n++; try { a.finish(); } catch (e) {} });
    return n;
  })();
  out.viewOpacity = (function () { var v = document.querySelector('.view:not([hidden])'); return v ? getComputedStyle(v).opacity : null; })();
  try { 
      deferred = true;
      var tries = 0;
      var timer = setInterval(function () {
        var b = document.getElementById('install-app');
        if (b && !b.hidden) {
          clearInterval(timer);
          b.click();
          setTimeout(function () {
            var s = document.getElementById('install-sheet');
            out.sheetOpen = !!(s && !s.hidden);
            out.lead = (document.getElementById('install-lead') || {}).textContent || '';
            finish();
          }, 250);
        } else if (++tries > 40) { clearInterval(timer); out.fail = 'button never appeared'; finish(); }
      }, 100);
     } catch (e) { out.error = String((e && e.message) || e); finish(); return; }
  if (!deferred) finish();
}, 2200);
void 0;