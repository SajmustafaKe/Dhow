// ocr: prints one JSON line per recognized text line, with bounding boxes.
//
// This is the macOS OCR path for Data Mode (see apps/x/DATA_MODE_PLAN.md 3.4).
// Apple's Vision framework runs entirely on device: no network, no API key, no
// per-page cost, ~1.05 s for a full page warm, 30 languages, and confidence
// scores good enough to decide when to escalate to an LLM instead.
//
// Bounding boxes are the whole point. OCR text alone is a bag of lines and a
// model asked to infer column alignment from it will hallucinate; with boxes,
// table-from-boxes.ts clusters by y for rows and sorts by x for columns and
// reconstructs the actual grid.
//
// usesLanguageCorrection is OFF deliberately: correction "fixes" numeric
// tokens, and on an invoice the numbers are the entire payload.
//
// Protocol (matches native/mic-monitor.swift): one JSON object per line on
// stdout, then a final {"__meta":{...}} line. Nothing else is written to
// stdout, so the consumer can parse line by line.
//
//   {"text":"TOTAL DUE","confidence":1.0,"x":0.04,"y":0.19,"w":0.11,"h":0.04,"page":0}
//   {"__meta":{"ms":1052,"lineCount":26,"pages":1,"engine":"vision"}}
//
// Compiled by apps/main/bundle.mjs (best-effort, macOS only) to
// .package/dist/ocr. If the binary is absent the caller falls back to
// tesseract.js, so a missing swiftc must never be fatal.

import Foundation
import AppKit
import PDFKit
import Vision

struct Line: Codable {
    let text: String
    let confidence: Float
    let x: Double
    let y: Double
    let w: Double
    let h: Double
    let page: Int
}

func fail(_ message: String) -> Never {
    // Errors go to stderr so stdout stays a clean JSON stream.
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

func recognize(_ cgImage: CGImage, page: Int) throws -> [Line] {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    // Off on purpose: language correction rewrites numeric tokens, and on a
    // financial document the numbers are the payload.
    request.usesLanguageCorrection = false
    if #available(macOS 13.0, *) {
        request.revision = VNRecognizeTextRequestRevision3
    }
    try VNImageRequestHandler(cgImage: cgImage, options: [:]).perform([request])
    return (request.results ?? []).compactMap { observation in
        guard let candidate = observation.topCandidates(1).first else { return nil }
        let box = observation.boundingBox
        return Line(
            text: candidate.string,
            confidence: candidate.confidence,
            // Vision's origin is BOTTOM-left, normalized 0..1. The TypeScript
            // side treats that as canonical and converts tesseract to match.
            x: box.origin.x,
            y: box.origin.y,
            w: box.width,
            h: box.height,
            page: page
        )
    }
}

func imagesForPDF(_ url: URL, scale: CGFloat = 2.0) -> [CGImage] {
    guard let document = PDFDocument(url: url) else { return [] }
    var images: [CGImage] = []
    for index in 0..<document.pageCount {
        guard let page = document.page(at: index) else { continue }
        let bounds = page.bounds(for: .mediaBox)
        let size = CGSize(width: bounds.width * scale, height: bounds.height * scale)
        guard size.width > 0, size.height > 0 else { continue }
        // Render at 2x: Vision's accuracy falls off badly on 72 dpi page text.
        let nsImage = NSImage(size: size)
        nsImage.lockFocus()
        NSColor.white.setFill()
        NSRect(origin: .zero, size: size).fill()
        if let context = NSGraphicsContext.current?.cgContext {
            context.scaleBy(x: scale, y: scale)
            page.draw(with: .mediaBox, to: context)
        }
        nsImage.unlockFocus()
        if let cg = nsImage.cgImage(forProposedRect: nil, context: nil, hints: nil) {
            images.append(cg)
        }
    }
    return images
}

let arguments = CommandLine.arguments
guard arguments.count >= 2 else { fail("usage: ocr <path-to-image-or-pdf>") }
let inputURL = URL(fileURLWithPath: arguments[1])
guard FileManager.default.fileExists(atPath: inputURL.path) else {
    fail("no such file: \(inputURL.path)")
}

let started = Date()
var allLines: [Line] = []
var pageCount = 0

if inputURL.pathExtension.lowercased() == "pdf" {
    let pages = imagesForPDF(inputURL)
    pageCount = pages.count
    for (index, image) in pages.enumerated() {
        do {
            allLines.append(contentsOf: try recognize(image, page: index))
        } catch {
            fail("vision failed on page \(index): \(error.localizedDescription)")
        }
    }
} else {
    guard let source = NSImage(contentsOf: inputURL),
          let cgImage = source.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        fail("could not decode image: \(inputURL.path)")
    }
    pageCount = 1
    do {
        allLines = try recognize(cgImage, page: 0)
    } catch {
        fail("vision failed: \(error.localizedDescription)")
    }
}

let encoder = JSONEncoder()
for line in allLines {
    if let data = try? encoder.encode(line), let json = String(data: data, encoding: .utf8) {
        print(json)
    }
}

let elapsed = Int(Date().timeIntervalSince(started) * 1000)
let meta: [String: Any] = [
    "__meta": [
        "ms": elapsed,
        "lineCount": allLines.count,
        "pages": pageCount,
        "engine": "vision",
    ] as [String: Any],
]
if let data = try? JSONSerialization.data(withJSONObject: meta),
   let json = String(data: data, encoding: .utf8) {
    print(json)
}
