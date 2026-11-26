import Foundation

enum BridgeFailure: Error {
  case invalidFrame, staleDocument, overflow, closed, timeout, invalidCommand
}

struct NativeFrame {
  static let chunkLimit = 65_536
  static let messageLimit = 32 * 1024 * 1024
  let kind: UInt8
  let id: UInt32
  let offset: Int
  let total: Int
  let data: Data

  init(_ bytes: Data) throws {
    guard bytes.count > 16, bytes.count <= 16 + Self.chunkLimit,
      bytes[0] == 0x59, bytes[1] == 0x41, bytes[2] == 1,
      bytes[3] == 1 || bytes[3] == 2
    else { throw BridgeFailure.invalidFrame }
    func integer(_ at: Int) -> UInt32 {
      bytes[at..<(at + 4)].reduce(0) { ($0 << 8) | UInt32($1) }
    }
    kind = bytes[3]; id = integer(4); offset = Int(integer(8)); total = Int(integer(12))
    data = bytes.subdata(in: 16..<bytes.count)
    guard id > 0, total > 0, total <= Self.messageLimit,
      offset <= total - data.count
    else { throw BridgeFailure.invalidFrame }
  }

  static func encode(kind: UInt8 = 1, id: UInt32, offset: Int, total: Int, data: Data) throws
    -> Data
  {
    guard id > 0, offset >= 0, total > 0, total <= messageLimit,
      !data.isEmpty, data.count <= chunkLimit, offset <= total - data.count
    else {
      throw BridgeFailure.invalidFrame
    }
    var bytes = Data([0x59, 0x41, 1, kind])
    for value in [id, UInt32(offset), UInt32(total)] {
      bytes.append(contentsOf: [
        UInt8(truncatingIfNeeded: value >> 24), UInt8(truncatingIfNeeded: value >> 16),
        UInt8(truncatingIfNeeded: value >> 8), UInt8(truncatingIfNeeded: value),
      ])
    }
    bytes.append(data)
    return bytes
  }
}

struct NativeFrameReceiver {
  private var nextID: UInt32 = 1
  private var kind: UInt8 = 0
  private var total = 0
  private var buffer = Data()

  mutating func accept(_ frame: NativeFrame) throws -> (UInt8, Data)? {
    guard frame.id == nextID, frame.offset == buffer.count else { throw BridgeFailure.invalidFrame }
    if buffer.isEmpty { kind = frame.kind; total = frame.total }
    guard frame.kind == kind, frame.total == total else { throw BridgeFailure.invalidFrame }
    buffer.append(frame.data)
    guard buffer.count == total else { return nil }
    guard nextID < UInt32.max else { throw BridgeFailure.overflow }
    let completed = buffer
    buffer = Data(); nextID += 1
    return (kind, completed)
  }
}
