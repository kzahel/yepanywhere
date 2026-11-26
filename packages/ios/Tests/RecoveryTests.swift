import XCTest
import WebKit
@testable import YepAnywhere

@MainActor
final class RecoveryTests: XCTestCase {
  func testDirectForegroundOutageAndOfflineRelaunch() async throws {
    try await exercise("direct", faults: ["disconnect", "outage", "silent", "cold"])
  }
  func testMuxRestartAndWakeIntoOutage() async throws {
    try await exercise("mux", faults: ["restart", "wake"])
  }
  private func until(
    _ description: String, seconds: Double = 45,
    _ predicate: () async throws -> Bool
  ) async throws {
    let end = Date().addingTimeInterval(seconds)
    while Date() < end {
      if try await predicate() { return }
      try await Task.sleep(for: .milliseconds(150))
    }
    print("iOS recovery timed out: " + description)
    throw NSError(
      domain: "RecoveryTests", code: 1,
      userInfo: [NSLocalizedDescriptionKey: "Timed out waiting for " + description])
  }
  private func exercise(_ route: String, faults: [String]) async throws {
    let url = try XCTUnwrap(
      Bundle(for: Self.self).url(forResource: "fixture", withExtension: "json"))
    let fixture = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
    let config = try XCTUnwrap(fixture["recovery"] as? [String: String])
    let control = URL(string: config["control"]!)!
    func gate(_ action: String) async throws -> [String: Any] {
      var request = URLRequest(
        url: control.appendingPathComponent(route).appendingPathComponent(action))
      request.httpMethod = "POST"
      let (data, response) = try await URLSession.shared.data(for: request)
      XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
      return try JSONSerialization.jsonObject(with: data) as! [String: Any]
    }

    let store = HostStore(
      service: "com.yepanywhere.ios.recovery." + UUID().uuidString,
      backend: MemoryProtectedStore())
    var model = HostModel(store: store)
    let scene = try XCTUnwrap(
      UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
    let window = UIWindow(windowScene: scene)
    let controller = UIViewController()
    window.rootViewController = controller; window.makeKeyAndVisible()
    defer {
      model.background(); window.isHidden = true
      for profile in model.catalog.profiles {
        try? SecurityClientCoordinator(store: store).forget(profile)
      }
    }
    model.login(
      label: "Recovery fixture", endpoint: config[route]!,
      target: route == "mux" ? "ios-fixture" : nil,
      username: "ios-fixture", password: "native-fixture-password")
    func mount() async throws -> WKWebView {
      try await until("saved host document: " + (model.error ?? route)) { model.webView != nil }
      let view = try XCTUnwrap(model.webView)
      controller.view = view; view.frame = window.bounds
      return view
    }
    var view = try await mount()
    let path = config["sessionPath"]!
    try await until("projects loaded") {
      try await view.evaluateJavaScript("!!document.querySelector('a[href*=projects]')") as? Bool
        == true
    }
    _ = try await view.callAsyncJavaScript(
      "history.pushState({}, '', path); dispatchEvent(new PopStateEvent('popstate'))",
      arguments: ["path": path], in: nil, contentWorld: .page)
    try await until("composer") {
      try await view.evaluateJavaScript("!!document.querySelector('textarea[data-composer-input]')")
        as? Bool == true
    }
    let draft = "Keep this draft through " + route
    _ = try await view.callAsyncJavaScript(
      """
      const el = document.querySelector('textarea[data-composer-input]');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el, draft);
      el.dispatchEvent(new Event('input', {bubbles:true}));
      """, arguments: ["draft": draft], in: nil, contentWorld: .page)
    for fault in faults {
      let previous = view
      let original = try await gate("status")
      print("iOS recovery starting \(route) \(fault)")
      switch fault {
      case "restart": _ = try await gate("stop-relay")
      case "disconnect": _ = try await gate("disconnect")
      case "silent": _ = try await gate("silent")
      default: _ = try await gate("refuse")
      }
      if fault == "wake" || fault == "cold" {
        model.background()
        if fault == "cold" {
          model = HostModel(store: store); model.start()
        } else {
          model.foreground()
        }
        view = try await mount()
        XCTAssertFalse(view === previous)
      }
      if ["outage", "cold", "wake"].contains(fault) {
        let before = original["refused"] as! Int
        try await until("native quick retries exhausted") {
          (try await gate("status")["refused"] as! Int) >= before + 3
        }
      } else if fault == "restart" || fault == "silent" {
        try await Task.sleep(for: .seconds(8))
      }
      let update = try await gate("append")
      let message = try XCTUnwrap(update["message"] as? String)
      if fault == "restart" {
        _ = try await gate("start-relay")
      } else {
        _ = try await gate("pass")
      }
      print("iOS path restored " + fault)
      var sampleAt = Date()
      try await until("passive transcript catch-up after " + fault, seconds: 75) {
        if Date() > sampleAt {
          let ui = try? await view.evaluateJavaScript(
            "JSON.stringify({path:location.pathname,state:[...document.querySelectorAll('[data-connection-status]')].map(e=>e.dataset.connectionStatus),visible:document.visibilityState,tail:document.body.innerText.slice(-180)})"
          )
          print(
            "iOS recovery evidence", fault, model.webView === view, model.error ?? "", ui ?? "",
            try await gate("status"))
          sampleAt = Date().addingTimeInterval(8)
        }
        return try await view.callAsyncJavaScript(
          "return document.body.innerText.includes(message)",
          arguments: ["message": message], in: nil, contentWorld: .page) as? Bool == true
      }
      XCTAssertTrue(model.webView === view)
      if fault != "cold" && fault != "wake" { XCTAssertTrue(view === previous) }
      let actualDraft = try await view.evaluateJavaScript(
        "document.querySelector('textarea[data-composer-input]')?.value")
      XCTAssertEqual(actualDraft as? String, draft)
      XCTAssertEqual(view.url?.path, path)
      XCTAssertNil(model.reauthenticate)
      print("iOS recovery passed \(route) \(fault)")
    }
  }
}
