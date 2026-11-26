import AppIntents
import XCTest

final class ShellTests: XCTestCase {
  func testNativeShellLaunches() {
    let app = XCUIApplication()
    app.launch()
    XCTAssertTrue(app.textFields["host-username"].waitForExistence(timeout: 10))
    XCTAssertFalse(app.textFields["host-url"].exists)
    XCTAssertTrue(app.textFields["host-username"].exists)
    XCTAssertTrue(app.secureTextFields["host-password"].exists)
    XCTAssertTrue(app.buttons["host-sign-in"].exists)
  }
}
