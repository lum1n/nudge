// swift-tools-version: 6.2
// The Swift client of Nudge: the bindings of `nudge-ffi` (`NudgeFFI`, over the C module
// `NudgeFFIC`) and `Nudge`, observable models for SwiftUI. Run `scripts/build.sh` first: it
// writes the bindings and, on macOS with `--xcframework`, builds `NudgeFFIC.xcframework` for
// iOS, the iOS simulator and macOS. On Linux `NudgeFFIC` links the host's
// `../rust/target/debug/libnudge_ffi.so` instead, for the tests.
import PackageDescription

#if os(Linux)
let library = Context.packageDirectory + "/../rust/target/debug"
let ffi: Target = .systemLibrary(name: "NudgeFFIC", path: "Sources/NudgeFFIC")
let linkLibrary: [LinkerSetting] = [.unsafeFlags(["-L", library, "-Xlinker", "-rpath", "-Xlinker", library])]
#else
let ffi: Target = .binaryTarget(name: "NudgeFFIC", path: "NudgeFFIC.xcframework")
let linkLibrary: [LinkerSetting] = [.linkedFramework("SystemConfiguration")]
#endif

let package = Package(
    name: "Nudge",
    platforms: [.iOS(.v26), .macOS(.v26)],
    products: [
        .library(name: "Nudge", targets: ["Nudge"]),
    ],
    targets: [
        ffi,
        .target(
            name: "NudgeFFI",
            dependencies: ["NudgeFFIC"],
            // The generated code predates Swift 6's checks.
            swiftSettings: [.swiftLanguageMode(.v5)],
            linkerSettings: linkLibrary
        ),
        .target(name: "Nudge", dependencies: ["NudgeFFI"]),
        .testTarget(name: "NudgeTests", dependencies: ["Nudge"]),
    ]
)
