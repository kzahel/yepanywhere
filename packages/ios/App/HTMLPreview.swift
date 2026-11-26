import UIKit
import WebKit

/// A disposable document with no app origin, store, message handlers or opener.
@MainActor
final class HTMLPreview: UIViewController, WKNavigationDelegate {
  private let html: String
  private let interactive: Bool
  private(set) var viewer: WKWebView?
  init(html: String, title: String, interactive: Bool) {
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
    config.defaultWebpagePreferences.allowsContentJavaScript = interactive
    let web = WKWebView(frame: .zero, configuration: config)
    web.navigationDelegate = self; viewer = web; view = web
    let scripts = interactive ? "'unsafe-inline'" : "'none'"
    let policy =
      "default-src 'none'; script-src " + scripts
      + "; style-src 'unsafe-inline' data:; img-src blob: data:; media-src blob: data:; font-src data:; form-action 'none'; base-uri 'none'"
    web.loadHTMLString(
      "<meta http-equiv=\"Content-Security-Policy\" content=\"\(policy)\">" + html, baseURL: nil)
  }
  func webView(
    _ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
  ) {
    guard action.targetFrame?.isMainFrame == true,
      action.request.url?.absoluteString.components(separatedBy: "#").first == "about:blank"
    else { decisionHandler(.cancel); return }
    decisionHandler(.allow)
  }
}
