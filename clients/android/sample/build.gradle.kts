// A small app on the library: sign in with a pairing code, the room list, and a room's chat.
plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
}

android {
    namespace = "nudge.sample"
    compileSdk = 35

    defaultConfig {
        applicationId = "nudge.sample"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.0.0"
    }

    buildFeatures.compose = true

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    implementation(project(":nudge"))
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.material3)
    implementation(libs.activity.compose)
    implementation(libs.lifecycle.viewmodel.compose)
    implementation(libs.lifecycle.runtime.compose)
    implementation(libs.coroutines.android)
}
