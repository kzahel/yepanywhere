import Foundation

struct HostTab: Identifiable, Codable {
  var id = UUID().uuidString
  let profileID: String
  var path: String
  var selected = Date()

  static func savedPath(_ value: String) -> String {
    let path = String(value.prefix { $0 != "?" && $0 != "#" })
    guard path.hasPrefix("/"), !path.hasPrefix("//"), !path.contains("\\"),
      !path.hasPrefix("/login"), !path.hasPrefix("/open"), path.utf8.count <= 4096,
      !path.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains)
    else { return "/projects" }
    return path
  }
}

extension HostCatalog {
  func lastTab(_ profile: String) -> HostTab? {
    tabs?.filter { $0.profileID == profile }.max { $0.selected < $1.selected }
  }
}
