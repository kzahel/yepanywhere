import UIKit
import WebKit

@MainActor
final class DocumentDownload: NSObject, WKDownloadDelegate {
  private let directory: URL
  private var file: URL?
  private weak var download: WKDownload?
  private let delivered: (URL) -> Void
  private let failed: () -> Void
  init(_ download: WKDownload, delivered: @escaping (URL) -> Void, failed: @escaping () -> Void)
    throws
  {
    self.download = download
    directory = FileManager.default.temporaryDirectory.appendingPathComponent(
      UUID().uuidString, isDirectory: true)
    self.delivered = delivered; self.failed = failed
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
    super.init()
    download.delegate = self
  }
  func download(
    _ download: WKDownload, decideDestinationUsing response: URLResponse,
    suggestedFilename: String, completionHandler: @escaping (URL?) -> Void
  ) {
    let name = (suggestedFilename as NSString).lastPathComponent
    guard !name.isEmpty, name != ".", name != "..", name.utf8.count <= 240,
      response.expectedContentLength >= 0, response.expectedContentLength <= 100 * 1024 * 1024
    else { completionHandler(nil); failed(); return }
    let destination = directory.appendingPathComponent(name)
    file = destination; completionHandler(destination)
  }
  func downloadDidFinish(_ download: WKDownload) {
    guard let file else { failed(); return }
    delivered(file)
  }
  func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
    failed()
  }
  func close() {
    download?.delegate = nil
    download?.cancel { _ in }
    try? FileManager.default.removeItem(at: directory)
  }
}
