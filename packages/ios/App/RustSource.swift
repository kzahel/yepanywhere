import Foundation

@MainActor
final class RustSource: NativeSource {
  let profileID: String
  let label: String
  private var session: (any NativeAuthenticatedSession)?
  private var phase: String
  private var epoch = 1
  private var closed = false
  private var statePending = false
  private var terminal: Error?
  private var waiter: CheckedContinuation<Void, Never>?
  private var acquisition: Task<Void, Error>?
  var acquire: (Bool) async throws -> any NativeAuthenticatedSession = { _ in
    throw CoreError.Unavailable
  }
  var checkIn: (any NativeAuthenticatedSession) async throws -> Void = { _ in }

  init(profile: HostProfile, session: (any NativeAuthenticatedSession)?) {
    profileID = profile.id; label = profile.label; self.session = session
    phase = session == nil ? "FAILED" : "CONNECTED"
  }

  var state: [String: Any] {
    ["type": "state", "phase": phase, "recoverable": terminal == nil, "connectionEpoch": epoch]
  }

  private func changed(_ next: String) {
    phase = next; statePending = true
    waiter?.resume(); waiter = nil
  }

  private func detach() {
    let old = session; session = nil; old?.close()
  }

  private func failed(_ error: Error) {
    detach()
    switch error as? CoreError {
    case .Unavailable, .Timeout, .Closed: break
    default: terminal = error
    }
    changed("FAILED")
  }

  private func reconnect(retry: Bool) async throws {
    if let terminal { throw terminal }
    guard !closed else { throw BridgeFailure.closed }
    if let acquisition { return try await acquisition.value }
    // Rust already owns quick retries after a live loss. A visible signal
    // during that cycle must not race another resume with the same credential.
    if phase == "RETRYING", session != nil { throw CoreError.Unavailable }
    detach()
    changed("CONNECTING")
    let task = Task {
      do {
        let lease = try await acquire(retry)
        do {
          try Task.checkCancellation()
          try await checkIn(lease)
          try Task.checkCancellation()
        } catch { lease.close(); throw error }
        session = lease; epoch += 1; changed("CONNECTED")
      } catch {
        if !closed { failed(error) }
        throw error
      }
    }
    acquisition = task
    defer { acquisition = nil }
    try await task.value
  }

  func dispatch(method: String, params: Data) async throws -> Data {
    guard !closed else { throw BridgeFailure.closed }
    if method == "status" { return try JSONSerialization.data(withJSONObject: state) }
    if method == "reconnect" {
      let options = try JSONSerialization.jsonObject(with: params) as? [String: Any]
      try await reconnect(retry: options?["retry"] as? Bool != false)
      return Data("{}".utf8)
    }
    guard let session, phase == "CONNECTED" else { throw CoreError.Unavailable }
    guard let text = String(data: params, encoding: .utf8) else {
      throw BridgeFailure.invalidCommand
    }
    return Data(try await session.dispatch(method: method, params: text).utf8)
  }
  func fetchResponse(_ params: [String: Any]) async throws -> NativeResponseStream {
    guard let session, phase == "CONNECTED" else { throw CoreError.Unavailable }
    var request = params; request["method"] = "GET"
    let text = String(decoding: try JSONSerialization.data(withJSONObject: request), as: UTF8.self)
    return try await session.fetchResponse(params: text)
  }
  func upload(_ payload: Data) async throws {
    guard let session, phase == "CONNECTED" else { throw CoreError.Unavailable }
    try await session.uploadChunk(payload: payload)
  }
  func nextEvent() async throws -> Data {
    while !closed {
      if let terminal { throw terminal }
      if statePending {
        statePending = false
        return try JSONSerialization.data(withJSONObject: state)
      }
      guard let lease = session else {
        await withCheckedContinuation { waiter = $0 }
        continue
      }
      do {
        let data = Data(try await lease.nextEvent().utf8)
        guard session === lease else { continue }
        let event = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        guard event?["type"] as? String == "state", let next = event?["phase"] as? String else {
          return data
        }
        if next == "REAUTHENTICATION_REQUIRED" { throw CoreError.ReauthenticationRequired }
        if next == "FAILED" {
          failed(
            event?["recoverable"] as? Bool == true
              ? CoreError.Unavailable : CoreError.InvalidMessage)
        } else if next == "CONNECTED" {
          phase = "CONNECTING"
          try await checkIn(lease)
          guard session === lease else { continue }
          epoch += 1; changed(next)
        } else {
          changed(next)
        }
      } catch {
        guard session === lease else { continue }
        failed(error)
      }
    }
    throw BridgeFailure.closed
  }

  func close() {
    closed = true; acquisition?.cancel(); detach(); waiter?.resume(); waiter = nil
  }
}
