// The throwaway WebView shell of the Phase 10 spike (D281). Debug only, under a package other than
// the release's (D274). The assets are the apps/web build and the spike pages, written to
// ../dist/assets by build.mjs. `-PspikeVersion=2` builds the update installed with `adb install -r`.
plugins {
    id("com.android.application")
}

val spikeVersion = (findProperty("spikeVersion") as String?)?.toInt() ?: 1

android {
    namespace = "io.github.allisson.blindvault.spike"
    compileSdk = 36

    defaultConfig {
        applicationId = "io.github.allisson.blindvault.spike"
        minSdk = 30
        targetSdk = 36
        versionCode = spikeVersion
        versionName = "0.0.$spikeVersion"
    }

    sourceSets["main"].assets.directories.add("../dist/assets")

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation("androidx.webkit:webkit:1.18.0")
}
