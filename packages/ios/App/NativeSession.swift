import Foundation

// Keep the platform's source close vocabulary while avoiding Kotlin UniFFI's
// AutoCloseable.close binding name. Shutdown releases transport immediately.
extension NativeSession {
  func close() { shutdown() }
}

protocol NativeAuthenticatedSession: AnyObject {
  func dispatch(method: String, params: String) async throws -> String
  func fetchResponse(params: String) async throws -> NativeResponseStream
  func uploadChunk(payload: Data) async throws
  func nextEvent() async throws -> String
  func securityBinding() throws -> NativeSecurityBinding
  func close()
}
extension NativeSession: NativeAuthenticatedSession {}
extension NativeSourceLease: NativeAuthenticatedSession {
  func close() { release() }
}

extension NativeAuthenticatedSession {
  func fetchResponse(params: String) async throws -> NativeResponseStream {
    throw CoreError.InvalidMessage
  }
}
