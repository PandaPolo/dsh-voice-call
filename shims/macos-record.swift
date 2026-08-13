#!/usr/bin/env swift
// macos-record.swift — dsh-voice macOS mic-recording shim.
//
// Records from the default microphone for `seconds` (default 5) into an AAC
// .m4a at the given path. Used when ffmpeg is not available. The process
// blocks until recording finishes, then prints the output path.
//
// Usage: swift macos-record.swift <out-file.m4a> [seconds]

import Foundation
import AVFoundation

guard CommandLine.arguments.count >= 2 else {
    FileHandle.standardError.write("usage: macos-record <out-file> [seconds]\n".data(using: .utf8)!)
    exit(2)
}

let outPath = CommandLine.arguments[1]
let seconds = CommandLine.arguments.count >= 3 ? (Double(CommandLine.arguments[2]) ?? 5.0) : 5.0
let url = URL(fileURLWithPath: outPath)

let settings: [String: Any] = [
    AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
    AVSampleRateKey: 44100,
    AVNumberOfChannelsKey: 1,
    AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
]

let session = AVAudioSession.sharedInstance()
do {
    try session.setCategory(.record, mode: .default)
    try session.setActive(true)
} catch {
    FileHandle.standardError.write("record: cannot start audio session: \(error)\n".data(using: .utf8)!)
    exit(1)
}

guard let recorder = try? AVAudioRecorder(url: url, settings: settings), recorder.record(forDuration: seconds) else {
    FileHandle.standardError.write("record: cannot start recording (is a microphone available?)\n".data(using: .utf8)!)
    try? session.setActive(false)
    exit(1)
}

RunLoop.main.run(until: Date().addingTimeInterval(seconds + 2.0))
recorder.stop()
try? session.setActive(false)
print(outPath)
