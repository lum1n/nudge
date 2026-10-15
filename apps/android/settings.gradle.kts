// The Nudge app for Android. The client library comes from `clients/android` (the Rust core
// through UniFFI), included as a build of its own: its native libraries and bindings are built
// with it.
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "nudge-app"
includeBuild("../../clients/android")
include(":app")
