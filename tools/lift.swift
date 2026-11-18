// Lift the main subject(s) out of a photo with macOS Vision (offline), like
// "lift subject from background". Writes a full-size grayscale mask.
//
//   swiftc -O tools/lift.swift -o /tmp/lift && /tmp/lift PHOTO MASK_OUT.png
import Foundation
import Vision
import ImageIO
import UniformTypeIdentifiers

let a = CommandLine.arguments
guard a.count >= 3 else { print("usage: lift PHOTO MASK_OUT.png"); exit(1) }
guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: a[1]) as CFURL, nil),
      let cg = CGImageSourceCreateImageAtIndex(src, 0, nil) else { print("cannot read image"); exit(1) }

let handler = VNImageRequestHandler(cgImage: cg, options: [:])
let req = VNGenerateForegroundInstanceMaskRequest()
do { try handler.perform([req]) } catch { print("vision failed: \(error)"); exit(1) }
guard let obs = req.results?.first,
      let mb = try? obs.generateScaledMaskForImage(forInstances: obs.allInstances, from: handler) else {
  print("no subject found"); exit(2)
}
CVPixelBufferLockBaseAddress(mb, .readOnly)
let w = CVPixelBufferGetWidth(mb), h = CVPixelBufferGetHeight(mb), rb = CVPixelBufferGetBytesPerRow(mb)
let base = CVPixelBufferGetBaseAddress(mb)!
let isFloat = CVPixelBufferGetPixelFormatType(mb) == kCVPixelFormatType_OneComponent32Float
var bytes = [UInt8](repeating: 0, count: w * h)
for y in 0..<h {
  let row = base.advanced(by: y * rb)
  for x in 0..<w {
    let v: Float = isFloat ? row.assumingMemoryBound(to: Float.self)[x] : Float(row.assumingMemoryBound(to: UInt8.self)[x]) / 255
    bytes[y * w + x] = UInt8(max(0, min(255, v * 255)))
  }
}
CVPixelBufferUnlockBaseAddress(mb, .readOnly)
let ctx = CGContext(data: &bytes, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w,
                    space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue)!
let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: a[2]) as CFURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(dest, ctx.makeImage()!, nil)
CGImageDestinationFinalize(dest)
print("ok: \(obs.allInstances.count) subject(s), mask \(w)x\(h)")
