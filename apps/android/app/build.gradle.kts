// The app. Push needs a Firebase project: put its `google-services.json` here (see the README).
// Without one the app builds and works, without notifications.
plugins {
    // AGP 9 compiles Kotlin itself; no Kotlin Android plugin.
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
}

val firebase = file("google-services.json").exists()
if (firebase) apply(plugin = libs.plugins.google.services.get().pluginId)
// The push relay for servers without this app's Firebase credentials: -Pnudge.pushRelay=https://…
val pushRelay = (findProperty("nudge.pushRelay") as String?)?.trimEnd('/') ?: ""
// A release's version, from its tag (release.yml): -Pnudge.versionName=0.9.0 -Pnudge.versionCode=…
val versionNameProperty = findProperty("nudge.versionName") as String?
val versionCodeProperty = (findProperty("nudge.versionCode") as String?)?.toInt()
// The release signing key, as release.yml passes it: a keystore and its passwords in the
// environment. Without NUDGE_KEYSTORE the release build is unsigned.
fun env(name: String): String? = System.getenv(name)?.takeIf { it.isNotEmpty() }
val keystore = env("NUDGE_KEYSTORE")?.let(::file)

android {
    namespace = "app.nudge"
    compileSdk = 37

    defaultConfig {
        applicationId = "app.nudge.dev"
        minSdk = 26
        targetSdk = 37
        versionCode = versionCodeProperty ?: 1
        versionName = versionNameProperty ?: "0.1.0"
        buildConfigField("boolean", "FIREBASE", firebase.toString())
        buildConfigField("String", "PUSH_RELAY", "\"$pushRelay\"")
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    signingConfigs {
        if (keystore != null) {
            create("release") {
                storeFile = keystore
                storePassword = env("NUDGE_KEYSTORE_PASSWORD")
                keyAlias = env("NUDGE_KEY_ALIAS")
                keyPassword = env("NUDGE_KEY_PASSWORD") ?: env("NUDGE_KEYSTORE_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            if (keystore != null) signingConfig = signingConfigs.getByName("release")
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    // JNA ships its native part for ABIs the Rust core isn't built for.
    packaging.jniLibs.excludes += listOf("lib/armeabi/**", "lib/mips/**", "lib/mips64/**", "lib/x86/**")

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    implementation("app.nudge:nudge")
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.core.ktx)
    implementation(libs.adaptive)
    implementation(libs.adaptive.layout)
    implementation(libs.adaptive.navigation)
    implementation(libs.compose.material3)
    implementation(libs.compose.material.icons)
    implementation(libs.activity.compose)
    implementation(libs.fragment)
    implementation(libs.lifecycle.viewmodel.compose)
    implementation(libs.lifecycle.runtime.compose)
    implementation(libs.lifecycle.process)
    implementation(libs.coroutines.android)
    implementation(platform(libs.firebase.bom))
    implementation(libs.firebase.messaging)
    // Geofences for reminders when the player gets somewhere.
    implementation(libs.play.services.location)
    implementation(libs.coroutines.play.services)
    // QR codes of pairing links, for another phone to scan.
    implementation(libs.zxing.core)
    testImplementation(libs.junit)
}
