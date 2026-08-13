#!/usr/bin/env swift
// macos-stt.swift — dsh-voice macOS STT shim.
//
// Runs one audio file through the built-in SFSpeechRecognizer and prints the
// transcript on stdout. Errors go to stderr with a nonzero exit. This is the
// "needs no install and no network setup" fallback of dsh-voice; recognition
// may use Apple's on-device or server recognizer as the OS decides.
//
// Usage: swift macos-stt.swift <audio-file>

import Foundation
import Speech

guard CommandLine.arguments.count >= 2 else {
    FileHandle.standardError.write("usage: macos-stt <audio-file>\n".data(using: .utf8)!)
    exit(2)
}

let path = CommandLine.arguments[1]
let url = URL(fileURLWithPath: path)
let semaphore = DispatchSemaphore(value: 0)
var transcript = ""
var failure: String? = nil

func fail(_ message: String) {
    failure = message
    semaphore.signal()
}

SFSpeechRecognizer.requestAuthorization { status in
    guard status == .authorized else {
        fail("speech recognition not authorized (status \(status.rawValue)); grant microphone/speech access to the terminal app")
        return
    }
    guard let recognizer = SFSpeechRecognizer(), recognizer.isAvailable else {
        fail("no speech recognizer available on this machine")
        return
    }
    let request = SFSpeechURLRecognitionRequest(url: url)
    request.shouldReportPartialResults = false
    recognizer.recognitionTask(with: request) { result, error in
        if let error = error {
            fail("recognition failed: \(error.localizedDescription)")
            return
        }
        if let result = result, result.isFinal {
            transcript = result.bestTranscription.formattedString
            semaphore.signal()
        }
    }
}

semaphore.wait()
if let failure = failure {
    FileHandle.standardError.write((failure + "\n").data(using: .utf8)!)
    exit(1)
}
print(transcript)
