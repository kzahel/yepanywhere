import XCTest
import WebKit
@testable import YepAnywhere

@MainActor
final class LiveTests: XCTestCase {
  private func fixture() throws -> (SessionOptions, Int) {
    let url = try XCTUnwrap(
      Bundle(for: Self.self).url(forResource: "fixture", withExtension: "json"))
    let data = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
    return (
      SessionOptions(
        endpoint: data["endpoint"] as! String, relayTarget: nil, username: "ios-fixture"),
      data["port"] as! Int
    )
  }
  func testIsolatedPreviewLoadsGrantedSiblingFiles() async throws {
    let url = try XCTUnwrap(
      Bundle(for: Self.self).url(forResource: "fixture", withExtension: "json"))
    let fixture = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
    let recovery = try XCTUnwrap(fixture["recovery"] as? [String: String])
    let endpoint = try XCTUnwrap(recovery["direct"])
    let path = try XCTUnwrap(recovery["previewPath"])
    let options = SessionOptions(endpoint: endpoint, relayTarget: nil, username: "ios-fixture")
    let session = try await nativeLogin(options: options, password: "native-fixture-password")
    let profile = HostProfile(
      id: UUID().uuidString, label: "Preview", endpoint: endpoint, username: options.username,
      lastConnected: Date())
    let source = RustSource(profile: profile, session: session)
    defer { source.close() }
    let client = SecurityClientCoordinator(store: HostStore(backend: MemoryProtectedStore()))
    let admitted = try await client.request(
      session, "POST", "/api/artifact-previews", ["path": path])
    XCTAssertEqual(admitted.status, 200)
    let id = try XCTUnwrap(admitted.body["id"] as? String)
    let files = try PreviewFiles(grant: ["id": id], source: source)
    let preview = HTMLPreview(
      html: """
        <link rel="stylesheet" href="report.css"><body>Report<script src="report.js"></script>
        <script>fetch('values.json').then(r=>r.json()).then(x=>document.body.dataset.value=x.value).catch(e=>document.body.dataset.error=e.message)</script></body>
        """, title: "Report", interactive: true, files: files)
    preview.loadViewIfNeeded()
    defer { preview.finish() }
    let web = try XCTUnwrap(preview.viewer)
    let deadline = Date().addingTimeInterval(12)
    var evidence = ""
    repeat {
      evidence =
        (try? await web.evaluateJavaScript(
          "JSON.stringify([document.documentElement.dataset.script,document.body?.dataset.value,document.body?.dataset.error,getComputedStyle(document.body).color,!!window.yaNativeTransport])"
        )) as? String ?? ""
      if evidence == #"["loaded","42",null,"rgb(12, 34, 56)",false]"# { break }
      try await Task.sleep(for: .milliseconds(80))
    } while Date() < deadline
    XCTAssertEqual(evidence, #"["loaded","42",null,"rgb(12, 34, 56)",false]"#)
    let revoked = try await client.request(session, "DELETE", "/api/artifact-previews/" + id)
    XCTAssertEqual(revoked.status, 200)
  }
  func testRustLoginKeychainAndResumeOnSimulator() async throws {
    let (options, _) = try fixture()
    let store = HostStore(service: "com.yepanywhere.ios.tests." + UUID().uuidString)
    defer { try? store.delete("hosts-state.v1") }
    let profile = HostProfile(
      id: UUID().uuidString, label: "Simulator host", endpoint: options.endpoint,
      username: options.username, lastConnected: Date())
    let session = try await nativeLoginStored(
      options: options, password: "native-fixture-password",
      storage: SavedCredential(store: store, profile: profile, pairing: true))
    defer { session.close() }
    XCTAssertEqual(try store.catalog().profiles.map(\.id), [profile.id])
    let credential = try XCTUnwrap(store.credential(profile.id))
    XCTAssertEqual(credential, try session.credentialData())
    let response = try await session.dispatch(
      method: "request", params: "{\"method\":\"GET\",\"path\":\"/api/projects\"}")
    XCTAssertTrue(response.contains("200")); session.close()
    let resumed = try await nativeResumeStored(
      options: options, credential: credential,
      storage: SavedCredential(store: store, profile: profile))
    defer { resumed.close() }
    XCTAssertEqual(try store.credential(profile.id), try resumed.credentialData())
    let version = try await resumed.dispatch(
      method: "request", params: "{\"method\":\"GET\",\"path\":\"/api/version\"}")
    XCTAssertTrue(version.contains("200"))
    try store.forgetCredential(profile.id)
    XCTAssertNil(try store.credential(profile.id))
    XCTAssertEqual(try store.catalog().profiles.count, 1)
  }
  func testSwitchHostPreservesSiblingAndSuspensionRetiresRuntime() async throws {
    let (options, _) = try fixture()
    let store = HostStore(service: "com.yepanywhere.ios.leases." + UUID().uuidString)
    let model = HostModel(store: store)
    defer {
      model.background()
      for profile in (try? store.catalog().profiles) ?? [] {
        try? SecurityClientCoordinator(store: store).forget(profile)
        _ = try? store.remove(profile.id)
      }
      try? store.delete("hosts-state.v1")
    }
    model.login(
      label: "Shared source", endpoint: options.endpoint, target: nil,
      username: options.username, password: "native-fixture-password")
    let deadline = Date().addingTimeInterval(15)
    while model.busy && Date() < deadline { try await Task.sleep(nanoseconds: 25_000_000) }
    XCTAssertNil(model.error)
    XCTAssertNotNil(model.webView)
    let profile = try XCTUnwrap(model.catalog.profiles.first)
    let sibling = try await model.connections.acquire(
      profileId: profile.id,
      routes: [profile.nativeRoute], username: profile.username,
      credential: XCTUnwrap(store.credential(profile.id)),
      storage: SavedCredential(store: store, profile: profile))
    defer { sibling.release() }
    model.switchHost()
    XCTAssertNil(model.webView)
    let response = try await sibling.dispatch(
      method: "request",
      params: "{\"method\":\"GET\",\"path\":\"/api/projects\"}")
    XCTAssertTrue(response.contains("200"))
    model.open(profile)
    let reopen = Date().addingTimeInterval(15)
    while model.busy && Date() < reopen { try await Task.sleep(nanoseconds: 25_000_000) }
    XCTAssertNil(model.error)
    XCTAssertNotNil(model.webView)
    model.background()
    XCTAssertThrowsError(try sibling.securityBinding())
    XCTAssertNotNil(try store.credential(profile.id))
  }
  func testFullBundledApplicationOverEncryptedRustSource() async throws {
    let (options, _) = try fixture()
    let session = try await nativeLogin(options: options, password: "native-fixture-password")
    let profile = HostProfile(
      id: UUID().uuidString, label: "Simulator host", endpoint: options.endpoint,
      username: options.username, lastConnected: Date())
    let bridge = NativeBridge(source: RustSource(profile: profile, session: session))
    let view = bridge.makeWebView(
      root: try XCTUnwrap(Bundle.main.url(forResource: "web", withExtension: nil)))
    view.configuration.userContentController.addUserScript(
      WKUserScript(
        source:
          "window.qaErrors=[];for(const name of ['warn','error']){const original=console[name];console[name]=(...args)=>{window.qaErrors.push(args.map(String).join(' '));original(...args)}};window.addEventListener('error',e=>window.qaErrors.push(e.message));",
        injectionTime: .atDocumentStart, forMainFrameOnly: true))
    let scene = try XCTUnwrap(
      UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
    let window = UIWindow(windowScene: scene)
    window.frame = UIScreen.main.bounds
    let controller = UIViewController(); controller.view = view; view.frame = window.bounds
    window.rootViewController = controller; window.makeKeyAndVisible()
    defer { bridge.close(); window.isHidden = true }
    view.load(URLRequest(url: URL(string: BundledAssets.origin + "/")!))
    var body = ""
    for _ in 0..<300 {
      body =
        (try? await view.evaluateJavaScript("document.body?.textContent ?? ''")) as? String ?? ""
      if body.contains("Projects") { break }
      try await Task.sleep(nanoseconds: 50_000_000)
    }
    XCTAssertTrue(body.contains("Projects"), body)
    XCTAssertFalse(bridge.closed)
    // Projects can render before the independent version request completes.
    // Hosted run 36884537650 reached Projects with only 5 frames delivered;
    // allow 3x that run's 10.2s flow for the padded response to cross the bridge.
    let chunkDeadline = Date().addingTimeInterval(30)
    while bridge.framesSent <= 16 && !bridge.closed && Date() < chunkDeadline {
      try await Task.sleep(nanoseconds: 50_000_000)
    }
    XCTAssertGreaterThan(
      bridge.framesSent, 16, "The 1 MiB version response must cross chunked frames")
    let errors = try await view.evaluateJavaScript("window.qaErrors") as? [String] ?? []
    XCTAssertEqual(errors, [])
    let screenshot = XCTAttachment(image: try await view.capturedImage())
    screenshot.name = "ios-rust-projects"; screenshot.lifetime = .keepAlways; add(screenshot)
    let secrets =
      try await view.evaluateJavaScript(
        "JSON.stringify({keys:Object.keys(window.yaNativeTransport),storage:JSON.stringify(localStorage)})"
      ) as? String ?? ""
    XCTAssertFalse(secrets.contains("base_key")); XCTAssertFalse(secrets.contains("session_id"))
    // Even a same-origin srcdoc must not be able to execute through parent.
    _ = try await view.evaluateJavaScript(
      "window.qaChildRan=false;const f=document.createElement('iframe');f.srcdoc='<script>parent.qaChildRan=true<\\/script>';document.body.append(f)"
    )
    try await Task.sleep(nanoseconds: 100_000_000)
    let childRan = try await view.evaluateJavaScript("window.qaChildRan") as? Bool
    XCTAssertEqual(childRan, false)
    view.reload()
    for _ in 0..<40 { if bridge.closed { break }; try await Task.sleep(nanoseconds: 25_000_000) }
    XCTAssertTrue(bridge.closed, "A replacement document must retire its native handle")
  }
}

@MainActor
final class SecurityAcceptanceTests: XCTestCase {
  func testNativeContinuityRegistrationResumeCheckInAndRevocation() async throws {
    let url = try XCTUnwrap(
      Bundle(for: Self.self).url(forResource: "fixture", withExtension: "json"))
    let fixture = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
    let options = SessionOptions(
      endpoint: fixture["endpoint"] as! String, relayTarget: nil, username: "ios-fixture")
    let profile = HostProfile(
      id: UUID().uuidString, label: "Native security fixture", endpoint: options.endpoint,
      username: options.username, lastConnected: Date())
    let backend = MemoryProtectedStore()
    let store = HostStore(
      service: "com.yepanywhere.ios.security-test." + UUID().uuidString, backend: backend)
    let security = SecurityClientCoordinator(store: store)
    defer { try? security.forget(profile) }
    let session = try await nativeLoginStored(
      options: options, password: "native-fixture-password",
      storage: SavedCredential(store: store, profile: profile, pairing: true))
    defer { session.close() }
    XCTAssertEqual(try store.catalog().profiles.map(\.id), [profile.id])
    XCTAssertNotNil(
      try store.credential(profile.id),
      "The profile must be recoverable before continuity registration")
    backend.failAccount = "security." + profile.id; backend.writesBeforeFailure = 1
    do {
      try await security.ensure(profile, session: session);
      XCTFail("Post-registration storage fault was ignored")
    } catch is KeychainFailure {}
    let pending = try JSONDecoder().decode(
      SecurityClientBinding.self, from: XCTUnwrap(store.read("security." + profile.id)))
    XCTAssertNil(pending.clientID)
    let list = try await session.dispatch(
      method: "request", params: "{\"method\":\"GET\",\"path\":\"/api/security/clients\"}")
    let response = try JSONSerialization.jsonObject(with: Data(list.utf8)) as! [String: Any]
    let body = response["body"] as! [String: Any]
    let before = body["clients"] as! [[String: Any]]
    let idsBefore = Set(before.compactMap { $0["clientId"] as? String })
    backend.failAccount = nil
    try await security.ensure(profile, session: session)
    let first = try JSONDecoder().decode(
      SecurityClientBinding.self, from: XCTUnwrap(store.read("security." + profile.id)))
    let clientID = try XCTUnwrap(first.clientID)
    XCTAssertEqual(first.requestID, pending.requestID);
    XCTAssertTrue(idsBefore.contains(clientID), "Retry must recover the already registered client")
    let credential = try session.credentialData();
    let initialNonce = try session.securityBinding().transportNonce
    session.close()
    let resumed = try await nativeResume(options: options, credential: credential)
    defer { resumed.close() }
    XCTAssertNotEqual(try resumed.securityBinding().transportNonce, initialNonce)
    try await security.ensure(profile, session: resumed)
    let next = try JSONDecoder().decode(
      SecurityClientBinding.self, from: XCTUnwrap(store.read("security." + profile.id)))
    XCTAssertEqual(next.clientID, clientID); XCTAssertEqual(next.requestID, first.requestID)
    let admin = try await nativeLogin(options: options, password: "native-fixture-password")
    defer { admin.close() }
    let revoked = try await admin.dispatch(
      method: "request",
      params:
        "{\"method\":\"DELETE\",\"path\":\"/api/security/clients/\(clientID)\",\"headers\":{\"X-Yep-Anywhere\":\"true\"}}"
    )
    XCTAssertTrue(revoked.contains("200"))
    // Full SRP still authenticates the owner; the durable revoked client
    // binding must then refuse continuity rather than silently re-enroll.
    let fresh = try await nativeLogin(options: options, password: "native-fixture-password")
    defer { fresh.close() }
    do {
      try await security.ensure(profile, session: fresh);
      XCTFail("Revoked installation re-enrolled")
    } catch NativeSecurityFailure.revoked {}
    XCTAssertNil(try store.credential(profile.id))
    do {
      let refused = try await nativeLoginStored(
        options: options, password: "native-fixture-password",
        storage: SavedCredential(store: store, profile: profile))
      refused.close(); XCTFail("A known revoked installation persisted a fresh owner credential")
    } catch CoreError.Unavailable {}
    XCTAssertNil(try store.credential(profile.id))
    let final = try JSONDecoder().decode(
      SecurityClientBinding.self, from: XCTUnwrap(store.read("security." + profile.id)))
    XCTAssertTrue(final.revoked)
  }
}
