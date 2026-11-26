import Foundation
import Security

struct HostProfile: Codable, Identifiable, Equatable {
  var id: String
  var label: String
  var endpoint: String
  var relayTarget: String?
  var username: String
  var forgetting: Bool?
  var lastConnected: Date
  var nativeRoute: NativeRoute {
    NativeRoute(routeId: id, endpoint: endpoint, relayTarget: relayTarget)
  }
  var options: SessionOptions {
    SessionOptions(endpoint: endpoint, relayTarget: relayTarget, username: username)
  }
}
struct HostCatalog: Codable {
  var profiles: [HostProfile] = []
  var selected: String?
  var tabs: [HostTab]?
}
private struct HostState: Codable {
  var catalog = HostCatalog()
  var credentials: [String: Data] = [:]
}
protocol ProtectedStore {
  func read(_ account: String) throws -> Data?
  func write(_ account: String, _ data: Data) throws
  func delete(_ account: String) throws
}
struct KeychainFailure: Error { let status: OSStatus }

final class HostStore: ProtectedStore {
  let service: String
  private let backend: ProtectedStore?
  init(service: String = "com.yepanywhere.ios.hosts.v1", backend: ProtectedStore? = nil) {
    self.service = service; self.backend = backend
  }
  private func query(_ account: String) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
      kSecAttrAccount as String: account, kSecAttrSynchronizable as String: false,
    ]
  }
  func read(_ account: String) throws -> Data? {
    if let backend { return try backend.read(account) }
    var q = query(account)
    q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(q as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let bytes = result as? Data else {
      throw KeychainFailure(status: status)
    }
    return bytes
  }
  func write(_ account: String, _ data: Data) throws {
    if let backend { try backend.write(account, data); return }
    let q = query(account)
    let attributes: [String: Any] = [
      kSecValueData as String: data,
      kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
    ]
    var status = SecItemUpdate(q as CFDictionary, attributes as CFDictionary)
    if status == errSecItemNotFound {
      status = SecItemAdd(q.merging(attributes) { _, new in new } as CFDictionary, nil)
    }
    guard status == errSecSuccess else { throw KeychainFailure(status: status) }
  }
  func delete(_ account: String) throws {
    if let backend { try backend.delete(account); return }
    let status = SecItemDelete(query(account) as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw KeychainFailure(status: status)
    }
  }
  private func state() throws -> HostState {
    guard let bytes = try read("hosts-state.v1") else { return HostState() }
    guard bytes.count <= 256 * 1024 else { throw BridgeFailure.overflow }
    let value = try JSONDecoder().decode(HostState.self, from: bytes)
    try validate(value)
    return value
  }
  private func validate(_ value: HostState) throws {
    let ids = Set(value.catalog.profiles.map(\.id))
    guard ids.count == value.catalog.profiles.count, ids.count <= 20,
      value.catalog.selected == nil || ids.contains(value.catalog.selected!),
      value.credentials.keys.allSatisfy({ ids.contains($0) }),
      value.credentials.values.allSatisfy({ $0.count <= 4096 }),
      value.catalog.profiles.allSatisfy({
        UUID(uuidString: $0.id) != nil && $0.label.utf8.count <= 256
          && $0.endpoint.utf8.count <= 2048 && (3...128).contains($0.username.utf8.count)
      })
    else { throw BridgeFailure.invalidCommand }
  }
  private func persist(_ value: HostState) throws {
    try validate(value)
    let bytes = try JSONEncoder().encode(value)
    guard bytes.count <= 256 * 1024 else { throw BridgeFailure.overflow }
    try write("hosts-state.v1", bytes)
  }
  func catalog() throws -> HostCatalog { try state().catalog }
  func save(_ catalog: HostCatalog) throws {
    var value = try state(); value.catalog = catalog
    value.credentials = value.credentials.filter { item in
      catalog.profiles.contains { $0.id == item.key }
    }
    try persist(value)
  }
  func pair(_ profile: HostProfile, _ credential: Data) throws -> HostCatalog {
    guard credential.count <= 4096 else { throw BridgeFailure.overflow }
    var value = try state(); var profile = profile; profile.lastConnected = Date()
    value.catalog.profiles.removeAll { $0.id == profile.id }; value.catalog.profiles.append(profile)
    guard value.catalog.profiles.count <= 20 else { throw BridgeFailure.overflow }
    value.catalog.selected = profile.id; value.credentials[profile.id] = credential
    try persist(value); return value.catalog
  }
  func credential(_ id: String) throws -> Data? { try state().credentials[id] }
  func saveCredential(_ id: String, _ credential: Data) throws {
    var value = try state()
    guard value.catalog.profiles.contains(where: { $0.id == id && $0.forgetting != true }),
      credential.count <= 4096
    else {
      throw BridgeFailure.invalidCommand
    }
    value.credentials[id] = credential; try persist(value)
  }
  func forgetCredential(_ id: String) throws {
    var value = try state(); value.credentials.removeValue(forKey: id); try persist(value)
  }
  func markForRemoval(_ id: String) throws -> HostCatalog {
    var value = try state()
    guard let index = value.catalog.profiles.firstIndex(where: { $0.id == id }) else {
      throw BridgeFailure.invalidCommand
    }
    value.catalog.profiles[index].forgetting = true; value.credentials.removeValue(forKey: id)
    if value.catalog.selected == id { value.catalog.selected = nil }
    try persist(value); return value.catalog
  }
  func remove(_ id: String) throws -> HostCatalog {
    var value = try state(); value.credentials.removeValue(forKey: id);
    value.catalog.profiles.removeAll { $0.id == id }
    value.catalog.tabs?.removeAll { $0.profileID == id }
    if value.catalog.selected == id { value.catalog.selected = nil }
    try persist(value); return value.catalog
  }
}
