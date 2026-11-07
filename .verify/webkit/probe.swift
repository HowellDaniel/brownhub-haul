// BrownHub Haul — the WebKit half of the verification story.
//
// Blink (headless Chrome over CDP) proves the app works. This proves the page
// renders the same way on the OTHER engine on this machine — Apple's WebKit,
// the one in every iOS Safari — because flex min-content, grid tracks and
// intrinsic SVG widths are decided differently there and a Blink-only green
// suite cannot see a WebKit layout bug.
//
// build:  swiftc -O probe.swift -o probe
// usage:  probe <url> <width> <height> <probeJsFile> [waitMs]
//           env PROBE_TOKEN=…   written into sessionStorage at document start
//                               (before the page's own modules run)
//           env SHOT=/path.png  also capture a snapshot of the frame
//
// It prints one line: the JSON string the injected probe left in
// window.__probeOut. evaluateJavaScript cannot return a Promise, so the probe
// file polls for that variable instead — and the probe file MUST assign a
// string (JSON.stringify), not an object, or nothing ever arrives.
//
// A WKWebView that is not in a window hands out zero animation frames and never
// advances a transition, so the view is placed in an off-screen borderless
// window and a document-start shim replaces requestAnimationFrame with a
// setTimeout fallback.

import Cocoa
import WebKit

let ProbeLock = NSLock()
var probeResult = ""
var probeDone = false
let probeSem = DispatchSemaphore(value: 0)

func emit(_ value: String) {
  ProbeLock.lock()
  probeResult = value
  probeDone = true
  ProbeLock.unlock()
  probeSem.signal()
}

let args = CommandLine.arguments
guard args.count >= 5 else {
  FileHandle.standardError.write("usage: probe <url> <w> <h> <jsFile> [waitMs]\n".data(using: .utf8)!)
  exit(2)
}
let urlString = args[1]
let width = Double(args[2]) ?? 1280
let height = Double(args[3]) ?? 900
let jsFile = args[4]
let waitMs = args.count > 5 ? (Double(args[5]) ?? 12000) : 12000
let shotPath = ProcessInfo.processInfo.environment["SHOT"]

guard let url = URL(string: urlString) else {
  print("{\"error\":\"bad url\"}")
  exit(2)
}
let probeJS = (try? String(contentsOfFile: jsFile, encoding: .utf8))
  ?? "window.__probeOut=JSON.stringify({error:'probe file unreadable'})"

let cfg = WKWebViewConfiguration()
let ucc = WKUserContentController()
var scripts = [
  "window.requestAnimationFrame=function(cb){return setTimeout(function(){cb(Date.now());},16);};void 0;"
]
if let token = ProcessInfo.processInfo.environment["PROBE_TOKEN"], !token.isEmpty {
  let escaped = token.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "'", with: "\\'")
  scripts.append("try{sessionStorage.setItem('haul.dispatch.token','\(escaped)');}catch(e){}")
}
for src in scripts {
  ucc.addUserScript(WKUserScript(source: src, injectionTime: .atDocumentStart, forMainFrameOnly: true))
}
cfg.userContentController = ucc
cfg.defaultWebpagePreferences.allowsContentJavaScript = true
// A brand-new engine every run: no cache, no sessionStorage, no service worker
// left over from the last scenario to quietly answer for this one.
cfg.websiteDataStore = .nonPersistent()

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)

final class Handler: NSObject, WKNavigationDelegate {
  var injected = false

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    // didFinish can fire more than once (a redirect, an icon load); one injection only.
    guard !injected else { return }
    injected = true
    webView.evaluateJavaScript(probeJS) { _, err in
      if let e = err { FileHandle.standardError.write("inject error: \(e.localizedDescription)\n".data(using: .utf8)!) }
    }
    poll(webView, 0)
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    emit("{\"error\":\"navigation failed: \(error.localizedDescription)\"}")
  }

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    emit("{\"error\":\"no server: \(error.localizedDescription)\"}")
  }

  func poll(_ webView: WKWebView, _ tries: Int) {
    webView.evaluateJavaScript("window.__probeOut || ''") { res, err in
      if let s = res as? String, !s.isEmpty {
        self.finish(s, webView)
      } else if Double(tries * 250) < waitMs {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { self.poll(webView, tries + 1) }
      } else {
        let why = err.map { " (\($0.localizedDescription))" } ?? ""
        emit("{\"error\":\"__TIMEOUT__ — the probe never wrote window.__probeOut\(why)\"}")
      }
    }
  }

  func finish(_ value: String, _ webView: WKWebView) {
    guard let path = shotPath else { emit(value); return }
    // A window parked at -12000 never advances the animation timeline, so a view
    // whose entry effect is `animation: rise .32s both` sits at opacity 0 forever
    // and the snapshot is a blank page over a perfectly good DOM. Seek every
    // animation to its end state first; infinite ones (a pulsing dot) refuse and
    // are simply skipped.
    webView.evaluateJavaScript("if (document.getAnimations) document.getAnimations().forEach(function (a) { try { a.finish(); } catch (e) {} }); 'ok'") { _, _ in
      // On macOS takeSnapshot hands back an NSImage, not bytes — repack it as PNG.
      webView.takeSnapshot(with: nil) { image, _ in
        if let image = image,
           let tiff = image.tiffRepresentation,
           let bmp = NSBitmapImageRep(data: tiff),
           let png = bmp.representation(using: .png, properties: [:]) {
          try? png.write(to: URL(fileURLWithPath: path))
        }
        DispatchQueue.main.async { emit(value) }
      }
    }
  }
}

let handler = Handler()
let web = WKWebView(frame: NSRect(x: 0, y: 0, width: width, height: height), configuration: cfg)
// PROBE_UA lets a scenario speak as an iPhone without an iPhone: WebKit is the
// same engine either way, and this app branches on the UA only for install UX.
if let ua = ProcessInfo.processInfo.environment["PROBE_UA"], !ua.isEmpty {
  web.customUserAgent = ua
}
web.navigationDelegate = handler
let content = NSView(frame: NSRect(x: 0, y: 0, width: width, height: height))
content.addSubview(web)
let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: height),
                      styleMask: [.borderless], backing: .buffered, defer: false)
window.contentView = content
// Far off-screen, but a real window: that is what makes visibilityState "visible"
// and lets layout, transitions and the snapshot happen at all.
window.setFrame(NSRect(x: -12000, y: -12000, width: width, height: height), display: false)
window.orderFront(nil)

web.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30))

DispatchQueue.global().async {
  _ = probeSem.wait(timeout: .now() + (waitMs / 1000.0) + 8)
  ProbeLock.lock()
  let out = probeDone ? probeResult : "__NO_RESULT__"
  ProbeLock.unlock()
  print(out.isEmpty ? "__EMPTY__" : out)
  fflush(stdout)
  exit(0)
}

RunLoop.main.run()
