import AppKit
import Foundation

// Invoked only by an explicitly enabled native companion. Clipboard content is
// carried on stdin/stdout, never on the command line or in logs.
let board = NSPasteboard.general
let mode = CommandLine.arguments.dropFirst().first ?? ""

func emit(_ object: [String: Any]) {
    guard let bytes = try? JSONSerialization.data(withJSONObject: object),
          let line = String(data: bytes, encoding: .utf8) else { exit(70) }
    print(line)
}

if mode == "read" {
    guard let value = board.string(forType: .string) else {
        emit(["error": "unsupported_clipboard_type", "revision": board.changeCount])
        exit(2)
    }
    guard Data(value.utf8).count <= 65536 else {
        emit(["error": "invalid_size"]); exit(2)
    }
    emit(["revision": board.changeCount,
          "contentBase64": Data(value.utf8).base64EncodedString()])
} else if mode == "write" {
    guard CommandLine.arguments.count == 3,
          let expected = Int(CommandLine.arguments[2]) else { exit(64) }
    let data = FileHandle.standardInput.readDataToEndOfFile()
    guard let value = String(data: data, encoding: .utf8) else {
        emit(["error": "invalid_utf8"]); exit(2)
    }
    guard !data.isEmpty && data.count <= 65536 else {
        emit(["error": "invalid_size"]); exit(2)
    }
    guard board.changeCount == expected else {
        emit(["error": "concurrent_change", "revision": board.changeCount]); exit(3)
    }
    board.clearContents()
    guard board.setString(value, forType: .string) else {
        emit(["error": "permission_denied"]); exit(4)
    }
    emit(["revision": board.changeCount])
} else {
    exit(64)
}
