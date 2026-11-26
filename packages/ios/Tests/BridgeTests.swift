import AppIntents
import XCTest
import WebKit
@testable import YepAnywhere

final class BridgeTests: XCTestCase {
  func testFrameSequenceRejectsReplayAndOversize() throws {
    var receiver = NativeFrameReceiver()
    let chunk = Data(repeating: 42, count: NativeFrame.chunkLimit)
    let first = try NativeFrame.encode(id: 1, offset: 0, total: chunk.count + 1, data: chunk)
    XCTAssertNil(try receiver.accept(NativeFrame(first)))
    XCTAssertThrowsError(try receiver.accept(NativeFrame(first)))
    let last = try NativeFrame.encode(
      id: 1, offset: chunk.count, total: chunk.count + 1, data: Data([7]))
    let result = try receiver.accept(NativeFrame(last))
    XCTAssertEqual(result?.1.count, chunk.count + 1)
    XCTAssertEqual(result?.1.last, 7)
    XCTAssertThrowsError(
      try NativeFrame.encode(id: 1, offset: 0, total: NativeFrame.messageLimit + 1, data: Data([1]))
    )
    XCTAssertThrowsError(try NativeFrame(Data(repeating: 0, count: 17)))
  }

  func testAssetsStayInsideBundleAndRoutesUseSPA() throws {
    let root = try XCTUnwrap(Bundle.main.url(forResource: "web", withExtension: nil))
    let assets = BundledAssets(root: root)
    let (entry, mime) = try assets.resource(
      URL(string: "yepapp://bundle/projects/fixture/sessions/example")!)
    XCTAssertEqual(mime, "text/html")
    XCTAssertTrue(
      String(decoding: entry, as: UTF8.self).contains("remote-main") || entry.count > 500)
    XCTAssertThrowsError(try assets.resource(URL(string: "yepapp://foreign/remote.html")!))
    XCTAssertThrowsError(try assets.resource(URL(string: "yepapp://bundle/%2e%2e/App/Info.plist")!))
    XCTAssertThrowsError(try assets.resource(URL(string: "yepapp://bundle/assets/missing.js")!))
  }

  @MainActor
  func testBundledAppBootstrapsNativeTransportWithoutWebLogin() async throws {
    let source = FixtureSource()
    let bridge = NativeBridge(source: source)
    let root = try XCTUnwrap(Bundle.main.url(forResource: "web", withExtension: nil))
    let view = bridge.makeWebView(root: root)
    let scene = try XCTUnwrap(
      UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
    let window = UIWindow(windowScene: scene)
    window.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
    let controller = UIViewController()
    controller.view = view
    view.frame = window.bounds
    window.rootViewController = controller
    window.makeKeyAndVisible()
    defer { bridge.close(); window.isHidden = true }
    view.load(URLRequest(url: URL(string: "yepapp://bundle/")!))
    let deadline = Date().addingTimeInterval(20)
    while source.requests == 0, Date() < deadline {
      try await Task.sleep(nanoseconds: 50_000_000)
    }
    XCTAssertGreaterThan(
      source.requests, 0, "The shipped React application must issue native source requests")
    XCTAssertGreaterThan(bridge.framesReceived, 0)
    let body = try await view.evaluateJavaScript("document.body.textContent") as? String ?? ""
    XCTAssertFalse(body.contains("Sign in to your server"))
    XCTAssertFalse(bridge.closed)
    view.layoutIfNeeded()
    let image = try await view.capturedImage()
    let attachment = XCTAttachment(image: image)
    attachment.name = "ios-bundled-app"; attachment.lifetime = .keepAlways
    add(attachment)
    bridge.close()
    XCTAssertTrue(source.closed)
  }
}

@MainActor
private final class FixtureSource: NativeSource {
  let profileID = "fixture"
  let label = "Simulator fixture"
  var requests = 0
  var closed = false
  private var waiter: CheckedContinuation<Data, Error>?

  func dispatch(method: String, params: Data) async throws -> Data {
    requests += 1
    let p = try JSONSerialization.jsonObject(with: params) as? [String: Any] ?? [:]
    let path = p["path"] as? String ?? ""
    let body: Any
    if path.contains("projects") {
      body = ["projects": []]
    } else if path.contains("sessions") {
      body = ["sessions": []]
    } else if path.contains("providers") {
      body = ["providers": []]
    } else if path.contains("version") {
      body = [
        "current": "0.9.2", "latest": NSNull(), "updateAvailable": false,
        "resumeProtocolVersion": 3,
      ]
    } else {
      body = [:]
    }
    let result: Any = method == "request" ? ["status": 200, "headers": [:], "body": body] : [:]
    return try JSONSerialization.data(withJSONObject: result)
  }
  func upload(_ payload: Data) async throws {}
  func nextEvent() async throws -> Data {
    try await withCheckedThrowingContinuation { waiter = $0 }
  }
  func close() { closed = true; waiter?.resume(throwing: BridgeFailure.closed); waiter = nil }
}

@MainActor
final class BridgeOwnershipTests: XCTestCase {
  func testUploadAckWaitsForNativeConsumptionAndStaleTokenIsIgnored() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    try Data("<html><head></head><body>Transport fixture</body></html>".utf8).write(
      to: root.appendingPathComponent("remote.html"))
    defer { try? FileManager.default.removeItem(at: root) }
    let started = expectation(description: "Native upload consumer received the frame")
    let source = HeldUploadSource(); source.started = { started.fulfill() }
    let bridge = NativeBridge(source: source); let view = bridge.makeWebView(root: root)
    let scene = try XCTUnwrap(
      UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
    let window = UIWindow(windowScene: scene); window.frame = UIScreen.main.bounds
    let controller = UIViewController(); controller.view = view; view.frame = window.bounds;
    window.rootViewController = controller; window.makeKeyAndVisible()
    defer { bridge.close(); window.isHidden = true }
    view.load(URLRequest(url: URL(string: "yepapp://bundle/")!))
    var ready = false
    for _ in 0..<500 {
      if (try? await view.evaluateJavaScript(
        "location.protocol === 'yepapp:' && document.readyState === 'complete' && !!window.yaNativeTransport"
      )) as? Bool == true {
        ready = true; break
      }
      try await Task.sleep(nanoseconds: 10_000_000)
    }
    XCTAssertTrue(ready, "The fixture document must finish loading its document-scoped bridge")
    _ = try await view.evaluateJavaScript(
      "window.qaAck=false;window.yaNativeTransport.onmessage=e=>{if(e.data.startsWith('ack:'))window.qaAck=true};true"
    )
    var frame = try NativeFrame.encode(
      id: 1, offset: 0, total: 25, data: Data(repeating: 1, count: 25));
    frame[3] = 2
    _ = try await view.callAsyncJavaScript(
      "window.yaNativeTransport.postMessage(data);return true",
      arguments: ["data": "frame:" + frame.base64EncodedString()], in: nil, contentWorld: .page)
    await fulfillment(of: [started], timeout: 10)
    let early = try await view.evaluateJavaScript("window.qaAck") as? Bool
    XCTAssertEqual(early, false, "Acknowledgement must follow native upload consumption")
    source.release()
    var acknowledged = false
    for _ in 0..<100 {
      acknowledged = (try await view.evaluateJavaScript("window.qaAck")) as? Bool ?? false
      if acknowledged { break }; try await Task.sleep(nanoseconds: 10_000_000)
    }
    XCTAssertTrue(acknowledged); XCTAssertEqual(bridge.framesReceived, 1)
    _ = try await view.evaluateJavaScript(
      "window.webkit.messageHandlers.ya.postMessage({document:'retired-token',channel:'source',data:'invalid'});true"
    )
    XCTAssertFalse(bridge.closed); XCTAssertEqual(bridge.framesReceived, 1)
    // A short PCM WAV proves the real bundled origin can load Blob media.
    let media = try await view.callAsyncJavaScript(
      "const bytes=new Uint8Array(8044);const v=new DataView(bytes.buffer);const text=(s,p)=>[...s].forEach((c,i)=>bytes[p+i]=c.charCodeAt(0));text('RIFF',0);v.setUint32(4,8036,true);text('WAVEfmt ',8);v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,8000,true);v.setUint32(28,16000,true);v.setUint16(32,2,true);v.setUint16(34,16,true);text('data',36);v.setUint32(40,8000,true);const url=URL.createObjectURL(new Blob([bytes],{type:'audio/wav'}));const audio=new Audio(url);try{return await new Promise((resolve,reject)=>{audio.onloadedmetadata=()=>resolve(audio.duration);audio.onerror=()=>reject(new Error('Media metadata failed'));audio.load()})}finally{URL.revokeObjectURL(url)}",
      arguments: [:], in: nil, contentWorld: .page)
    XCTAssertEqual(try XCTUnwrap(media as? Double), 0.5, accuracy: 0.01)
  }
  func testEntryPolicyInsertionFailsClosedForUnexpectedHTML() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    for bytes in [Data("<html><HEAD></HEAD></html>".utf8), Data([0xff, 0xfe])] {
      try bytes.write(to: root.appendingPathComponent("remote.html"))
      XCTAssertThrowsError(try BundledAssets(root: root).resource(URL(string: "yepapp://bundle/")!))
    }
  }
}
@MainActor
private final class HeldUploadSource: NativeSource {
  let profileID = UUID().uuidString
  let label = "Upload fixture"
  var started: () -> Void = {}
  private var pending: CheckedContinuation<Void, Error>?
  func dispatch(method: String, params: Data) async throws -> Data { Data("{}".utf8) }
  func upload(_ payload: Data) async throws {
    try await withCheckedThrowingContinuation {
      pending = $0; started()
    }
  }
  func nextEvent() async throws -> Data { throw BridgeFailure.closed }
  func release() { pending?.resume(); pending = nil }
  func close() { pending?.resume(throwing: BridgeFailure.closed); pending = nil }
}

@MainActor
final class DocumentDeliveryTests: XCTestCase {
  func testIsolatedPreviewRunsWithoutAppBridgeOrPersistentStore() async throws {
    let preview = HTMLPreview(
      html: "<title>Preview</title><script>window.ran = true</script>",
      title: "Report", interactive: true)
    preview.loadViewIfNeeded()
    let web = try XCTUnwrap(preview.viewer)
    let end = Date().addingTimeInterval(10)
    var ran = false
    while !ran && Date() < end {
      ran = (try? await web.evaluateJavaScript("window.ran === true")) as? Bool == true
      if !ran { try await Task.sleep(for: .milliseconds(50)) }
    }
    XCTAssertTrue(ran)
    XCTAssertFalse(web.configuration.websiteDataStore.isPersistent)
    let isolated = try await web.evaluateJavaScript(
      "!window.yaNative && !window.yaNativeTransport && !window.webkit?.messageHandlers?.ya && !window.opener"
    )
    XCTAssertEqual(isolated as? Bool, true)
  }

  func testBundledBlobDownloadDeliversOriginalNamedFile() async throws {
    let bridge = NativeBridge(source: FixtureSource())
    let view = bridge.makeWebView(
      root: try XCTUnwrap(Bundle.main.url(forResource: "web", withExtension: nil)))
    let scene = try XCTUnwrap(
      UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
    let window = UIWindow(windowScene: scene)
    let controller = UIViewController(); controller.view = view
    window.rootViewController = controller; window.makeKeyAndVisible()
    defer { bridge.close(); window.isHidden = true }
    let exported = expectation(description: "Export offers original file")
    var shared: (URL, () -> Void)?
    bridge.shareFile = { file, done in
      shared = (file, done); exported.fulfill()
    }
    view.load(URLRequest(url: URL(string: BundledAssets.origin)!))
    let end = Date().addingTimeInterval(10)
    while view.url == nil || view.isLoading {
      guard Date() < end else { XCTFail("Bundled app did not load"); return }
      try await Task.sleep(for: .milliseconds(50))
    }
    _ = try await view.evaluateJavaScript(
      """
      const link = document.createElement('a');
      link.download = 'conversation.txt'; link.href = URL.createObjectURL(new Blob(['test export']));
      document.body.append(link); link.click(); link.remove(); true;
      """)
    await fulfillment(of: [exported], timeout: 10)
    let (file, done) = try XCTUnwrap(shared)
    XCTAssertFalse(bridge.closed)
    bridge.close()
    XCTAssertEqual(file.lastPathComponent, "conversation.txt")
    XCTAssertEqual(try Data(contentsOf: file), Data("test export".utf8))
    done()
    XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
  }
}
