import Foundation
import XCTest
@testable import LegalWorkKeyMonitor

final class WorkdayForegroundTests: XCTestCase {
    func testOnlyBasenameLeavesTheNativeProcess() {
        XCTAssertEqual(workdayDocumentName("file:///Users/fixture/Private%20folder/Draft%20brief.docx"), "Draft brief.docx")
        XCTAssertEqual(workdayDocumentName(URL(fileURLWithPath: "/private/test/Exhibit A.pdf")), "Exhibit A.pdf")
        XCTAssertEqual(workdayDocumentName("file://localhost/tmp/sample.txt"), "sample.txt")
    }

    func testIgnoresCloudUrlsDirectoriesTitlesAndInvalidFilenames() {
        let rejected = [
            "https://example.test/editor/brief.docx", "file://server.local/share/brief.docx",
            "file://user:pass@localhost/notes.txt", "file://localhost:443/share/brief.docx",
            "file:///tmp/brief.docx?token=value", "file:///tmp/brief.docx#personal",
            "file:///private/folder/", "file:///private/.secret", "/private/folder/document",
            "Example title", "file:///tmp/part%0Adocument", "file:///tmp/C%3A%5Cnotes.txt"
        ]
        for value in rejected { XCTAssertNil(workdayDocumentName(value), value) }
        XCTAssertNil(workdayDocumentName(42))
    }
}
