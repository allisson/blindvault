// The APK (android.md §2): the shell in Kotlin and apps/web's Android build in assets/web/, both
// written there by build/assets.ts with version.properties. The release is unsigned, with no R8,
// no baseline profile, no VCS information and no dependency block, so its bytes depend only on the
// pinned inputs; the maintainer signs it (§10). The debug build is another package, over ADB only.
import java.util.Properties

plugins {
    id("com.android.application")
}

val versionFile = file("version.properties")
check(versionFile.isFile) { "No ${versionFile.path}: run `node build/assets.ts` first (android.md §2)." }
val version = Properties().apply { versionFile.inputStream().use { load(it) } }

android {
    namespace = "io.github.allisson.blindvault"
    compileSdk = 36
    buildToolsVersion = "36.0.0"

    defaultConfig {
        applicationId = "io.github.allisson.blindvault"
        minSdk = 34
        targetSdk = 36
        versionCode = version.getProperty("versionCode").toInt()
        versionName = version.getProperty("versionName")
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            vcsInfo.include = false
        }
        debug {
            applicationIdSuffix = ".debug"
        }
    }

    dependenciesInfo {
        includeInApk = false
        includeInBundle = false
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation("androidx.webkit:webkit:1.18.0")
    implementation("androidx.credentials:credentials:1.6.0")
    testImplementation("junit:junit:4.13.2")
    // Android's org.json is a stub on the JVM; the tests run the bridge's validation on this one.
    testImplementation("org.json:json:20260814")
}
