import Foundation
import WebKit

/// WebKit can ask only for files inside this single server-issued preview grant.
@MainActor
final class PreviewFiles: NSObject, WKURLSchemeHandler {
  static let scheme = "yapreview"
  let baseURL: URL
  private let endpoint: String
  private let source: NativeSource
  private var readers: [ObjectIdentifier: Task<Void, Never>] = [:]
  private var streams: [ObjectIdentifier: NativeResponseStream] = [:]
  private var closed = false

  init(grant: [String: Any], source: NativeSource) throws {
    guard let id = grant["id"] as? String, UUID(uuidString: id) != nil else {
      throw BridgeFailure.invalidCommand
    }
    var base = "/api"
    if let value = grant["sessionId"] {
      guard let session = value as? String, !session.isEmpty, session.utf8.count <= 256,
        session != ".", session != "..", !session.contains("/"), !session.contains("\\"),
        let encoded = session.addingPercentEncoding(withAllowedCharacters: .alphanumerics)
      else { throw BridgeFailure.invalidCommand }
      base += "/sessions/" + encoded
    }
    self.endpoint = base + "/artifact-previews/" + id + "/file"
    self.source = source
    // This origin is local to this viewer and carries no server credential.
    self.baseURL = URL(string: Self.scheme + "://" + UUID().uuidString.lowercased() + "/")!
    super.init()
  }

  private func request(for request: URLRequest) throws -> [String: Any] {
    guard request.httpMethod == "GET", let url = request.url,
      url.scheme == Self.scheme, url.host == baseURL.host, url.user == nil,
      url.password == nil, url.port == nil,
      let path = URLComponents(url: url, resolvingAgainstBaseURL: false)?.path,
      path.hasPrefix("/"), path.utf8.count <= 4096, !path.contains("\\"),
      !path.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains)
    else { throw BridgeFailure.invalidCommand }
    let relative = String(path.dropFirst())
    guard
      relative.split(separator: "/", omittingEmptySubsequences: false).allSatisfy({
        !$0.isEmpty && !$0.hasPrefix(".")
      })
    else { throw BridgeFailure.invalidCommand }
    var components = URLComponents()
    // endpoint already contains the escaped session segment.
    components.percentEncodedPath = endpoint
    components.queryItems = [
      URLQueryItem(name: "path", value: relative), URLQueryItem(name: "download", value: "true"),
    ]
    // The server decodes application/x-www-form-urlencoded queries.
    components.percentEncodedQuery = components.percentEncodedQuery?.replacingOccurrences(
      of: "+", with: "%2B")
    var headers = ["X-Yep-Anywhere": "true"]
    if let range = request.value(forHTTPHeaderField: "Range"), range.utf8.count <= 128 {
      headers["Range"] = range
    }
    guard let path = components.string else { throw BridgeFailure.invalidCommand }
    return ["path": path, "headers": headers]
  }

  func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
    let key = ObjectIdentifier(task)
    guard !closed, readers.count < 32, let url = task.request.url,
      let params = try? request(for: task.request)
    else { task.didFailWithError(BridgeFailure.invalidCommand); return }
    readers[key] = Task {
      defer { readers.removeValue(forKey: key); streams.removeValue(forKey: key)?.cancel() }
      do {
        let stream = try await source.fetchResponse(params)
        guard !Task.isCancelled else { stream.cancel(); return }
        streams[key] = stream
        guard
          let head = try JSONSerialization.jsonObject(with: Data(stream.metadata().utf8))
            as? [String: Any],
          let status = head["status"] as? Int, status == 200 || status == 206
        else { throw BridgeFailure.invalidCommand }
        let headers = head["headers"] as? [String: String] ?? [:]
        var safe = [
          "Access-Control-Allow-Origin": "*", "X-Content-Type-Options": "nosniff",
          "Cache-Control": "no-store",
        ]
        for (name, value) in headers
        where ["content-type", "content-length", "content-range", "accept-ranges"].contains(
          name.lowercased())
        {
          safe[name] = value
        }
        guard
          let response = HTTPURLResponse(
            url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: safe)
        else { throw BridgeFailure.invalidCommand }
        task.didReceive(response)
        if head["streaming"] as? Bool == true {
          while let bytes = try await stream.nextChunk() {
            guard !Task.isCancelled else { return }
            task.didReceive(bytes)
          }
        } else {
          let body = head["body"]
          if let envelope = body as? [String: Any], envelope["_binary"] as? Bool == true,
            let encoded = envelope["data"] as? String, let bytes = Data(base64Encoded: encoded)
          {
            task.didReceive(bytes)
          } else if let string = body as? String {
            task.didReceive(Data(string.utf8))
          } else if let body, !(body is NSNull) {
            task.didReceive(
              try JSONSerialization.data(withJSONObject: body, options: .fragmentsAllowed))
          }
        }
        if !Task.isCancelled { task.didFinish() }
      } catch {
        if !Task.isCancelled { task.didFailWithError(error) }
      }
    }
  }

  func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
    let key = ObjectIdentifier(task)
    readers[key]?.cancel(); streams[key]?.cancel()
  }

  func close() {
    closed = true
    for task in readers.values { task.cancel() }
    for stream in streams.values { stream.cancel() }
  }
}
