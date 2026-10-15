// The Android library: the Kotlin bindings of `nudge-ffi`, generated from the Rust library at
// build time, its native libraries for each ABI (built with cargo-ndk), and `nudge.client`.
// `-Pnudge.native=false` skips the cargo-ndk build, such as on a machine without the Android
// Rust targets; the unit tests use the host's build of the library either way.
import java.util.Properties

plugins {
    // AGP 9 compiles Kotlin itself; no Kotlin Android plugin.
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.serialization)
}

// `app.nudge:nudge`, for builds that include this one, such as the app in `apps/android`.
group = "app.nudge"

val rust = rootProject.file("../rust")
val repository = rootProject.file("../..")
val hostLibrary = rust.resolve("target/debug")
val bindingsDir = layout.buildDirectory.dir("generated/uniffi/kotlin")
val jniLibsDir = layout.buildDirectory.dir("generated/jniLibs")
val abis = listOf("arm64-v8a", "armeabi-v7a", "x86_64")
val buildNative = providers.gradleProperty("nudge.native").map { it != "false" }.orElse(true)

// `nudge.cargoHome` (and `nudge.rustupHome`), as a Gradle property or in `local.properties`, point
// cargo-ndk at a rustup install of its own with the Android targets, next to a system Rust.
val localProperties = Properties().apply {
    rootProject.file("local.properties").takeIf { it.exists() }?.reader()?.use { load(it) }
}
fun setting(name: String): String? = providers.gradleProperty(name).orNull ?: localProperties.getProperty(name)
val cargoHome = setting("nudge.cargoHome")
val rustupHome = setting("nudge.rustupHome")

val cargoBuildHost = tasks.register<Exec>("cargoBuildHost") {
    description = "Builds nudge-ffi for this machine, for bindgen and the unit tests."
    workingDir = rust
    commandLine("cargo", "build", "-p", "nudge-ffi")
}

val generateBindings = tasks.register<Exec>("generateBindings") {
    description = "Writes the Kotlin bindings of nudge-ffi."
    dependsOn(cargoBuildHost)
    workingDir = rust
    val library = hostLibrary.resolve(System.mapLibraryName("nudge_ffi"))
    val out = bindingsDir.get().asFile
    inputs.file(library)
    outputs.dir(out)
    commandLine(
        "cargo", "run", "-q", "-p", "nudge-ffi", "--features", "cli", "--bin", "uniffi-bindgen",
        "--", "generate", "--no-format", "--library", library.path, "--language", "kotlin",
        "--out-dir", out.path,
    )
}

val cargoNdk = tasks.register<Exec>("cargoNdk") {
    description = "Builds nudge-ffi for each Android ABI with cargo-ndk."
    onlyIf { buildNative.get() }
    workingDir = rust
    if (cargoHome != null) {
        environment("CARGO_HOME", cargoHome)
        environment("PATH", File(cargoHome, "bin").path + File.pathSeparator + System.getenv("PATH"))
        rustupHome?.let { environment("RUSTUP_HOME", it) }
        // Some crates carry a rust-toolchain.toml; without this, rustup follows it when compiling them.
        environment("RUSTUP_TOOLCHAIN", System.getenv("RUSTUP_TOOLCHAIN") ?: "stable")
    }
    // Cargo knows what is up to date.
    val out = jniLibsDir.get().asFile
    commandLine(
        listOf("cargo", "ndk") + abis.flatMap { listOf("-t", it) } +
            listOf("-o", out.path, "build", "--release", "-p", "nudge-ffi"),
    )
}

android {
    namespace = "nudge.client"
    compileSdk = 37

    defaultConfig {
        minSdk = 26
        consumerProguardFiles("consumer-rules.pro")
    }


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

// Through the new DSL's types: the `android` block's own `sourceSets` are AGP's old ones.
extensions.getByType<com.android.build.api.dsl.LibraryExtension>().sourceSets.named("main") {
    kotlin.srcDir(bindingsDir.get().asFile)
    jniLibs.srcDir(jniLibsDir.get().asFile)
}

tasks.named("preBuild") {
    dependsOn(generateBindings, cargoNdk)
}

dependencies {
    implementation("${libs.jna.get()}@aar")
    api(libs.coroutines.core)
    implementation(libs.serialization.json)
    testImplementation(libs.jna)
    testImplementation(libs.junit)
}
