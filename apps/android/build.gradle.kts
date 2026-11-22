// AGP 9 compiles Kotlin itself: no Kotlin plugin to apply (docs/architecture.md).
plugins {
    id("com.android.application") version "9.5.1" apply false
}

// Gradle writes its reports under the root project's build directory, which would be build/,
// where build/assets.ts lives.
layout.buildDirectory.set(file(".gradle-build"))
