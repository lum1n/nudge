// The Android library: the Kotlin bindings of `nudge-ffi`, generated from the Rust library at
// build time, its native libraries for each ABI (built with cargo-ndk), and `nudge.client`.
// `-Pnudge.native=false` skips the cargo-ndk build, such as on a machine without the Android
// Rust targets; the unit tests use the host's build of the library either way.
plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.android)
}

val rust = rootProject.file("../rust")
val repository = rootProject.file("../..")
val hostLibrary = rust.resolve("target/debug")
val bindings = layout.buildDirectory.dir("generated/uniffi/kotlin")
val jniLibs = layout.buildDirectory.dir("generated/jniLibs")
val abis = listOf("arm64-v8a", "armeabi-v7a", "x86_64")
val buildNative = providers.gradleProperty("nudge.native").map { it != "false" }.orElse(true)

val cargoBuildHost by tasks.registering(Exec::class) {
    description = "Builds nudge-ffi for this machine, for bindgen and the unit tests."
    workingDir = rust
    commandLine("cargo", "build", "-p", "nudge-ffi")
}

val generateBindings by tasks.registering(Exec::class) {
    description = "Writes the Kotlin bindings of nudge-ffi."
    dependsOn(cargoBuildHost)
    workingDir = rust
    val library = hostLibrary.resolve(System.mapLibraryName("nudge_ffi"))
    val out = bindings.get().asFile
    inputs.file(library)
    outputs.dir(out)
    commandLine(
        "cargo", "run", "-q", "-p", "nudge-ffi", "--features", "cli", "--bin", "uniffi-bindgen",
        "--", "generate", "--no-format", "--library", library.path, "--language", "kotlin",
        "--out-dir", out.path,
    )
}

val cargoNdk by tasks.registering(Exec::class) {
    description = "Builds nudge-ffi for each Android ABI with cargo-ndk."
    onlyIf { buildNative.get() }
    workingDir = rust
    // Cargo knows what is up to date.
    val out = jniLibs.get().asFile
    commandLine(
        listOf("cargo", "ndk") + abis.flatMap { listOf("-t", it) } +
            listOf("-o", out.path, "build", "--release", "-p", "nudge-ffi"),
    )
}

android {
    namespace = "nudge.client"
    compileSdk = 35

    defaultConfig {
        minSdk = 26
        consumerProguardFiles("consumer-rules.pro")
    }

    sourceSets["main"].kotlin.srcDir(bindings)
    sourceSets["main"].jniLibs.srcDir(jniLibs)

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    testOptions.unitTests.all {
        it.dependsOn(cargoBuildHost)
        it.systemProperty("jna.library.path", hostLibrary.path)
        it.systemProperty("nudge.repository", repository.path)
        it.testLogging {
            events("passed", "skipped", "failed", "standardOut", "standardError")
            exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
        }
    }
}

kotlin {
    jvmToolchain(17)
}

tasks.named("preBuild") {
    dependsOn(generateBindings, cargoNdk)
}

dependencies {
    implementation("${libs.jna.get()}@aar")
    api(libs.coroutines.core)
    testImplementation(libs.jna)
    testImplementation(libs.junit)
}
