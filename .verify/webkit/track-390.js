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
      var t = document.querySelector('.track-card');
      out.card = !!t;
      out.stages = document.querySelectorAll('.tl li').length;
      out.reached = document.querySelectorAll('.tl li.done, .tl li.now').length;
      out.now = (document.querySelector('.now-card .big') || {}).textContent || '';
      out.distance = (document.querySelector('.route-strip .muted') || {}).textContent || '';
      var img = document.querySelector('.gallery .shot img');
      out.photo = img ? { src: img.getAttribute('src'), w: img.naturalWidth } : null;
      out.photoMentions = ((t ? t.textContent : '').match(/photo/gi) || []).length;
      out.galleryLbl = (document.querySelector('.gallery .lbl') || {}).textContent || '';
      out.driver = /Kwesi/.test((document.querySelector('.now-card') || {}).textContent || '');
      out.text = t ? t.textContent.replace(/\s+/g, ' ').slice(0, 900) : '';
     } catch (e) { out.error = String((e && e.message) || e); finish(); return; }
  if (!deferred) finish();
}, 2200);
void 0;