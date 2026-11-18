// Cut a person out of a photo with macOS Vision (offline, no downloads).
//
//   swift tools/cutout.swift PHOTO MASK_OUT.png LANDMARKS_OUT.json HINT_X HINT_Y
//
// HINT_X/HINT_Y: a pixel roughly on the face you want (picks the right person when
// there are several). Writes a full-size grayscale mask of that person and a JSON file
// with the face box and eye / pupil landmark points (pixel coords, top-left origin).
import Foundation
import Vision
import ImageIO
import UniformTypeIdentifiers

let a = CommandLine.arguments
guard a.count >= 6, let hx = Double(a[4]), let hy = Double(a[5]) else {
  print("usage: cutout.swift PHOTO MASK_OUT LANDMARKS_OUT HINT_X HINT_Y"); exit(1)
}
guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: a[1]) as CFURL, nil),
      let cg = CGImageSourceCreateImageAtIndex(src, 0, nil) else { print("cannot read image"); exit(1) }
let W = Double(cg.width), H = Double(cg.height)

let handler = VNImageRequestHandler(cgImage: cg, options: [:])
let faceReq = VNDetectFaceLandmarksRequest()
let maskReq = VNGeneratePersonInstanceMaskRequest()   // one instance per person
do { try handler.perform([faceReq, maskReq]) } catch { print("vision failed: \(error)"); exit(1) }

// face closest to the hint
var face: VNFaceObservation?
var bestD = Double.infinity
for f in faceReq.results ?? [] {
  let c = (f.boundingBox.midX * W, (1 - f.boundingBox.midY) * H)
  let d = hypot(c.0 - hx, c.1 - hy)
  if d < bestD { bestD = d; face = f }
}
guard let face else { print("no face found"); exit(2) }
let bb = face.boundingBox
let fc = (bb.midX * W, (1 - bb.midY) * H)

guard let obs = maskReq.results?.first else { print("no subject found"); exit(3) }

// which instance is under the face?
let inst = obs.instanceMask
CVPixelBufferLockBaseAddress(inst, .readOnly)
let iw = CVPixelBufferGetWidth(inst), ih = CVPixelBufferGetHeight(inst), irb = CVPixelBufferGetBytesPerRow(inst)
let ib = CVPixelBufferGetBaseAddress(inst)!.assumingMemoryBound(to: UInt8.self)
var counts = [Int: Int]()
for dy in -3...3 { for dx in -3...3 {
  let x = min(iw - 1, max(0, Int(fc.0 / W * Double(iw)) + dx))
  let y = min(ih - 1, max(0, Int(fc.1 / H * Double(ih)) + dy))
  let l = Int(ib[y * irb + x]); if l > 0 { counts[l, default: 0] += 1 }
}}
CVPixelBufferUnlockBaseAddress(inst, .readOnly)
let label = counts.max(by: { $0.value < $1.value })?.key
let instances = label.map { IndexSet(integer: $0) } ?? obs.allInstances

guard let mb = try? obs.generateScaledMaskForImage(forInstances: instances, from: handler) else { print("mask failed"); exit(4) }
CVPixelBufferLockBaseAddress(mb, .readOnly)
let mw = CVPixelBufferGetWidth(mb), mh = CVPixelBufferGetHeight(mb), mrb = CVPixelBufferGetBytesPerRow(mb)
let mbase = CVPixelBufferGetBaseAddress(mb)!
let isFloat = CVPixelBufferGetPixelFormatType(mb) == kCVPixelFormatType_OneComponent32Float
var bytes = [UInt8](repeating: 0, count: mw * mh)
for y in 0..<mh {
  let row = mbase.advanced(by: y * mrb)
  for x in 0..<mw {
    let v: Float = isFloat ? row.assumingMemoryBound(to: Float.self)[x] : Float(row.assumingMemoryBound(to: UInt8.self)[x]) / 255
    bytes[y * mw + x] = UInt8(max(0, min(255, v * 255)))
  }
}
CVPixelBufferUnlockBaseAddress(mb, .readOnly)
let ctx = CGContext(data: &bytes, width: mw, height: mh, bitsPerComponent: 8, bytesPerRow: mw,
                    space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue)!
let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: a[2]) as CFURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(dest, ctx.makeImage()!, nil)
CGImageDestinationFinalize(dest)

func pts(_ r: VNFaceLandmarkRegion2D?) -> [[Double]] {
  guard let r else { return [] }
  return r.pointsInImage(imageSize: CGSize(width: W, height: H)).map { [Double($0.x), H - Double($0.y)] }
}
let lm = face.landmarks
let info: [String: Any] = [
  "face": [bb.minX * W, (1 - bb.maxY) * H, bb.width * W, bb.height * H],
  "leftEye": pts(lm?.leftEye), "rightEye": pts(lm?.rightEye),
  "leftPupil": pts(lm?.leftPupil), "rightPupil": pts(lm?.rightPupil),
  "instance": label ?? -1, "maskSize": [mw, mh],
]
try! JSONSerialization.data(withJSONObject: info, options: [.prettyPrinted]).write(to: URL(fileURLWithPath: a[3]))
print("ok: face \(Int(bb.width * W))x\(Int(bb.height * H)) at \(Int(fc.0)),\(Int(fc.1)), instance \(label ?? -1), mask \(mw)x\(mh)")
