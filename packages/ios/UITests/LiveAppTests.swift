import AppIntents
import XCTest

private final class AppendControl: @unchecked Sendable {
  private let lock = NSLock(); private var finished = false
  var stopped: Bool { lock.lock(); defer { lock.unlock() }; return finished }
  func stop() { lock.lock(); finished = true; lock.unlock() }
}

final class LiveAppTests: XCTestCase {
  override func setUp() { continueAfterFailure = false }
  private func capture(_ app: XCUIApplication, _ name: String) {
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
  }
  @MainActor
  func testNativeLoginWebConversationTypingAndRelaunch() async throws {
    let fixture = try XCTUnwrap(
      Bundle(for: Self.self).url(forResource: "fixture", withExtension: "json"))
    let data = try JSONSerialization.jsonObject(with: Data(contentsOf: fixture)) as! [String: Any]
    var probe = try XCTUnwrap(URLComponents(string: data["endpoint"] as! String))
    probe.scheme = probe.scheme == "wss" ? "https" : "http"
    probe.path = "/__probe/append"; probe.query = nil
    let appendURL = try XCTUnwrap(probe.url)
    // Hardware can use a host-owned producer: the background XCTest runner
    // has its own local-network privacy gate. DOM evidence still proves that
    // more updates than keys overlap typing; the input ceiling is unchanged.
    let externalProducer = data["externalProducer"] as? Bool ?? false
    let app = XCUIApplication(); app.launchArguments = ["-qa-input-metrics", "-qa-reset-hosts"]
    app.launch(); app.launchArguments = ["-qa-input-metrics"]
    let label = app.textFields["host-label"]
    XCTAssertTrue(label.waitForExistence(timeout: 10))
    capture(app, "ios-native-login")
    label.tap(); label.typeText("Simulator host")
    let endpoint = app.textFields["host-url"]; endpoint.tap();
    endpoint.typeText(data["endpoint"] as! String)
    let username = app.textFields["host-username"]; username.tap(); username.typeText("ios-fixture")
    let password = app.secureTextFields["host-password"]; password.tap();
    password.typeText("native-fixture-password")
    app.buttons["host-sign-in"].tap()
    XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 15), app.debugDescription)
    capture(app, "ios-live-projects")
    let skip = app.buttons["Skip all"]
    if skip.waitForExistence(timeout: 2) { skip.tap() }
    let project = app.links.matching(NSPredicate(format: "label CONTAINS %@", "preview-project"))
      .firstMatch
    XCTAssertTrue(project.waitForExistence(timeout: 10), app.debugDescription);
    project.coordinate(withNormalizedOffset: CGVector(dx: 0.75, dy: 0.8)).tap()
    let session = app.links.matching(
      NSPredicate(format: "label CONTAINS %@", "Android conversation fixture")
    ).firstMatch
    XCTAssertTrue(session.waitForExistence(timeout: 10), app.debugDescription);
    session.coordinate(withNormalizedOffset: CGVector(dx: 0.35, dy: 0.4)).tap()
    let composer = app.webViews.textViews.firstMatch
    let composerExists = composer.waitForExistence(timeout: 10)
    capture(app, "ios-session-navigation")
    XCTAssertTrue(composerExists, app.debugDescription)
    // Real server updates overlap each sequential keyboard input in a 50-row
    // transcript; each beforeinput-to-paint observation must stay <=100 ms.
    // Use the rendered element frame, as with the navigation links below.
    // XCTest's WebView tap can scroll/re-resolve the field before delivery.
    composer.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
    capture(app, "ios-composer-focus")
    let keyboardReady = app.staticTexts["QA keyboard ready"]
    XCTAssertTrue(keyboardReady.waitForExistence(timeout: 10), app.debugDescription)
    let control = AppendControl()
    let updater: Task<Int, Never>? = externalProducer ? nil : Task.detached {
      var successes = 0
      for _ in 0..<1200 {
        if control.stopped || Task.isCancelled { break }
        var request = URLRequest(url: appendURL)
        request.httpMethod = "POST"
        if let (_, response) = try? await URLSession.shared.data(for: request),
          (response as? HTTPURLResponse)?.statusCode == 200
        {
          successes += 1
        }
        try? await Task.sleep(nanoseconds: 50_000_000)
      }
      return successes
    }
    defer { control.stop(); updater?.cancel() }
    let text = "Simulator typing while updates stream"
    // Each call synthesizes one literal keyboard input. Individual calls
    // exercise ordinary mobile typing while the 20 Hz server producer
    // remains active for the whole edit, including after row virtualization.
    for character in text { composer.typeText(String(character)) }
    control.stop()
    let finalValue = expectation(
      for: NSPredicate(format: "value == %@", text), evaluatedWith: composer)
    // WebKit's AX snapshot can lag the painted DOM; the separate in-page
    // beforeinput measurements below enforce the actual 100 ms contract.
    capture(app, "ios-typing-evidence")
    await fulfillment(of: [finalValue], timeout: 10)
    XCTAssertEqual(composer.value as? String, text, app.debugDescription)
    if let updates = await updater?.value { XCTAssertGreaterThan(updates, text.count) }
    let metrics = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'QA input='"))
      .firstMatch
    XCTAssertTrue(metrics.waitForExistence(timeout: 5), app.debugDescription)
    let report = metrics.label
    XCTAssertTrue(report.contains("input=\(text.count);"), report)
    XCTAssertTrue(report.contains("dropped=0"), report)
    let stream = Int(report.components(separatedBy: "stream=").last ?? "0") ?? 0
    XCTAssertGreaterThan(stream, externalProducer ? text.count : 0, report)
    let maximum =
      Int(report.components(separatedBy: "max=").last?.components(separatedBy: ";").first ?? "1000")
      ?? 1000
    XCTAssertLessThanOrEqual(maximum, 100, report)
    capture(app, "ios-live-conversation")
    XCUIDevice.shared.press(.home); app.activate()
    let foregroundComposer = app.webViews.textViews.firstMatch
    XCTAssertTrue(foregroundComposer.waitForExistence(timeout: 15), app.debugDescription)
    let preserved = expectation(
      for: NSPredicate(format: "value == %@", text), evaluatedWith: foregroundComposer)
    await fulfillment(of: [preserved], timeout: 10)
    app.terminate(); app.launch()
    XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 15), app.debugDescription)
    XCTAssertFalse(app.secureTextFields["host-password"].exists)
    let relaunched = app.webViews.textViews.firstMatch
    XCTAssertTrue(relaunched.waitForExistence(timeout: 15), app.debugDescription)
    XCTAssertEqual(relaunched.value as? String, text)
    let sidebarOpener = app.buttons["Open sidebar"]
    XCTAssertTrue(sidebarOpener.isHittable, app.debugDescription)
    // Use the current WebKit element frame, as with the project/session links.
    // On iOS 18 the default tap after relaunch left the drawer closed.
    sidebarOpener.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
    // AX existence/hittability can precede WebKit's painted drawer. The QA
    // marker requires its Switch Host button to win DOM hit testing for two
    // frames; all host-picker and draft/input assertions stay unchanged.
    XCTAssertTrue(
      app.staticTexts["QA host switch ready"].waitForExistence(timeout: 5), app.debugDescription)
    capture(app, "ios-host-sidebar")
    let switchHost = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] 'Switch host'"))
      .firstMatch
    XCTAssertTrue(switchHost.waitForExistence(timeout: 5), app.debugDescription)
    XCTAssertTrue(switchHost.isHittable, app.debugDescription)
    switchHost.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
    XCTAssertTrue(
      app.descendants(matching: .any)["host-add"].waitForExistence(timeout: 10), app.debugDescription)
    XCTAssertFalse(app.webViews.firstMatch.exists)
  }
}
