import UIKit
import WebKit

/// A disposable document with no app origin, store, message handlers or opener.
@MainActor
final class HTMLPreview: UIViewController, WKNavigationDelegate {
  private let html: String
  private let interactive: Bool
  private let files: PreviewFiles?
  private var completion: (() -> Void)?
  private var finished = false
  private(set) var viewer: WKWebView?
  init(html: String, title: String, interactive: Bool, files: PreviewFiles? = nil) {
    self.files = files
    self.html = html; self.interactive = interactive
    super.init(nibName: nil, bundle: nil); self.title = String(title.prefix(160))
    navigationItem.rightBarButtonItem = UIBarButtonItem(
      systemItem: .done,
      primaryAction: UIAction { [weak self] _ in
        self?.dismiss(animated: true)
      })
  }
  required init?(coder: NSCoder) { nil }

  override func loadView() {
    let config = WKWebViewConfiguration()
    config.websiteDataStore = .nonPersistent()
    if let files { config.setURLSchemeHandler(files, forURLScheme: PreviewFiles.scheme) }
    config.defaultWebpagePreferences.allowsContentJavaScript = interactive
    let web = WKWebView(frame: .zero, configuration: config)
    web.navigationDelegate = self; viewer = web; view = web
    let scope = files == nil ? "" : " yapreview:"
    let scripts = interactive ? "'unsafe-inline'" + scope : "'none'"
    let policy =
      "default-src 'none'; script-src " + scripts
      + "; style-src 'unsafe-inline' data:" + scope + "; img-src blob: data:" + scope
      + "; media-src blob: data:" + scope + "; font-src data:" + scope
      + "; connect-src " + (files == nil ? "'none'" : "yapreview:")
      + "; form-action 'none'; base-uri 'none'"
    web.loadHTMLString(
      "<meta http-equiv=\"Content-Security-Policy\" content=\"\(policy)\">" + html,
      baseURL: files?.baseURL)
  }
  func waitForDismissal() async {
    guard !finished else { return }
    await withCheckedContinuation { continuation in completion = { continuation.resume() } }
  }
  func finish() {
    guard !finished else { return }
    finished = true
    files?.close(); completion?(); completion = nil
  }
  override func viewDidDisappear(_ animated: Bool) {
    super.viewDidDisappear(animated)
    finish()
  }
  func webView(
    _ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
  ) {
    guard action.targetFrame?.isMainFrame == true,
      let target = action.request.url?.absoluteString.components(separatedBy: "#").first,
      target == "about:blank" || target == files?.baseURL.absoluteString
    else { decisionHandler(.cancel); return }
    decisionHandler(.allow)
  }
}
