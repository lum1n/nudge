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

android {
    namespace = "app.nudge"
    compileSdk = 37

    defaultConfig {
        applicationId = "app.nudge.dev"
        minSdk = 26
        targetSdk = 37
        versionCode = 1
        versionName = "0.1.0"
        buildConfigField("boolean", "FIREBASE", firebase.toString())
        buildConfigField("String", "PUSH_RELAY", "\"$pushRelay\"")
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    buildTypes {
        release {
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
    implementation(libs.lifecycle.viewmodel.compose)
    implementation(libs.lifecycle.runtime.compose)
    implementation(libs.lifecycle.process)
    implementation(libs.coroutines.android)
    implementation(platform(libs.firebase.bom))
    implementation(libs.firebase.messaging)
    // Geofences for reminders when the player gets somewhere.
    implementation(libs.play.services.location)
    implementation(libs.coroutines.play.services)
    testImplementation(libs.junit)
}
