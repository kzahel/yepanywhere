import java.net.URI
import java.time.Duration
import java.util.zip.ZipFile
import org.gradle.api.tasks.testing.Test
import org.gradle.api.tasks.testing.logging.TestLogEvent

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

fun buildConfigString(value: String): String =
    "\"${value.replace("\\", "\\\\").replace("\"", "\\\"")}\""

val debugWebClientUrl = providers.gradleProperty("yaWebClientUrl").orNull
    ?.trim()
    ?.takeIf(String::isNotEmpty)

// Hosts that every build may reach over plain HTTP, beside the certificate
// revocation hosts listed by the platform verifier.
val loopbackHosts = listOf("localhost", "127.0.0.1")

if (debugWebClientUrl != null) {
    val uri = URI(debugWebClientUrl)
    require(uri.scheme == "http" || uri.scheme == "https") {
        "yaWebClientUrl must use http or https"
    }
    require(uri.scheme == "https" || uri.host in loopbackHosts) {
        "yaWebClientUrl must use https or a loopback host (use adb reverse)"
    }
    require(uri.host != null && uri.userInfo == null) {
        "yaWebClientUrl must have a host and no user information"
    }
    require(uri.rawQuery == null && uri.rawFragment == null) {
        "yaWebClientUrl must not contain a query or fragment"
    }
}

val firebaseEnabled = providers.gradleProperty("yaFirebaseEnabled").orNull
    ?.trim()
    ?.let {
        require(it == "true" || it == "false") {
            "yaFirebaseEnabled must be true or false"
        }
        it.toBoolean()
    }
    ?: true
val hasFirebaseConfiguration = firebaseEnabled && file("google-services.json").isFile
if (hasFirebaseConfiguration) {
    apply(plugin = "com.google.gms.google-services")
} else if (!firebaseEnabled) {
    logger.lifecycle("yaFirebaseEnabled=false; Firebase messaging is disabled")
} else {
    logger.lifecycle("google-services.json not found; Firebase messaging is disabled")
}

val pushBrokerUrl = providers.gradleProperty("yaPushBrokerUrl").orNull
    ?.trim()
    ?.takeIf(String::isNotEmpty)
    ?: "https://push.yepanywhere.com/"
run {
    val uri = URI(pushBrokerUrl)
    require(uri.scheme == "https") {
        "yaPushBrokerUrl must use https"
    }
    require(uri.host != null && uri.userInfo == null) {
        "yaPushBrokerUrl must have a host and no user information"
    }
    require(uri.rawQuery == null && uri.rawFragment == null) {
        "yaPushBrokerUrl must not contain a query or fragment"
    }
    require(uri.path.isNullOrEmpty() || uri.path == "/") {
        "yaPushBrokerUrl must not contain a path"
    }
}

android {
    namespace = "com.yepanywhere.mobile"
    compileSdk = 36
    ndkVersion = "28.2.13676358"

    defaultConfig {
        applicationId = "com.yepanywhere.mobile"
        minSdk = 24
        targetSdk = 36
        versionCode = providers.gradleProperty("yaVersionCode").orNull?.let {
            require(it.toIntOrNull() in 1..2100000000) { "Invalid yaVersionCode" }
            it.toInt()
        } ?: 1002
        versionName = providers.gradleProperty("yaVersionName").orNull ?: "0.1.4"
        ndk {
            // Keep the app's established modern Android ABI set and prevent
            // JNA's AAR from reintroducing obsolete armeabi/MIPS binaries.
            abiFilters += setOf("arm64-v8a", "armeabi-v7a", "x86", "x86_64")
        }
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        buildConfigField(
            "String",
            "DEBUG_WEB_CLIENT_URL",
            buildConfigString(debugWebClientUrl.orEmpty()),
        )
        buildConfigField(
            "String",
            "PUSH_BROKER_URL",
            buildConfigString(pushBrokerUrl),
        )
        buildConfigField(
            "boolean",
            "FIREBASE_CONFIGURED",
            hasFirebaseConfiguration.toString(),
        )
    }

    buildTypes {
        debug {
            isDebuggable = true
            // Exercise the shipping native reflection boundary with R8 on a
            // disposable cleartext fixture, without weakening Release policy.
            // AGP intentionally warns that debuggable R8 probes cannot enable
            // all Release optimizations. Debugging is required for WebView
            // instrumentation; the probe still checks the shrunk shared ABI.
            isMinifyEnabled = providers.gradleProperty("yaNativeProbeMinify").orNull == "true"
            testProguardFiles("test-proguard-rules.pro")
            if (isMinifyEnabled) proguardFiles("probe-proguard-rules.pro")
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
        release {
            isMinifyEnabled = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    flavorDimensions += "clientChannel"
    productFlavors {
        create("bundled") {
            dimension = "clientChannel"
            buildConfigField("boolean", "BUNDLED_CLIENT", "true")
            buildConfigField(
                "String",
                "WEB_CLIENT_URL",
                buildConfigString("https://appassets.androidplatform.net/"),
            )
        }
        create("hostedLatest") {
            dimension = "clientChannel"
            buildConfigField("boolean", "BUNDLED_CLIENT", "false")
            buildConfigField(
                "String",
                "WEB_CLIENT_URL",
                buildConfigString("https://latest.yepanywhere.com/"),
            )
        }
    }

    sourceSets {
        getByName("main") {
            java.srcDir(layout.buildDirectory.dir("generated/rustBindings"))
            jniLibs.srcDir(layout.buildDirectory.dir("generated/rustJniLibs"))
            res.srcDir(layout.buildDirectory.dir("generated/networkSecurityRes"))
        }
        getByName("bundled") {
            assets.srcDir(layout.buildDirectory.dir("generated/webAssets"))
        }
        getByName("test") {
            java.srcDir("src/sharedTest/java")
            resources.srcDir("src/sharedTest/resources")
            resources.srcDir("../../shared/test/fixtures")
        }
        getByName("androidTest") {
            java.srcDir("src/sharedTest/java")
            assets.srcDir("src/sharedTest/resources")
            assets.srcDir("../../shared/test/fixtures")
        }
    }

    buildFeatures {
        buildConfig = true
        compose = true
    }
    composeOptions {
        kotlinCompilerExtensionVersion = "1.5.15"
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    packaging {
        resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
        // JNA's Android AAR ships libjnidispatch prebuilt in a form the NDK
        // stripper does not recognize. Preserve it deliberately so builds do
        // not emit a misleading strip warning.
        jniLibs.keepDebugSymbols += "**/libjnidispatch.so"
    }
    lint {
        warningsAsErrors = true
        // Toolchain and library upgrades are reviewed changes. Network-based
        // freshness checks are not deterministic build-quality diagnostics.
        disable += setOf(
            "AndroidGradlePluginVersion",
            "GradleDependency",
            "NewerVersionAvailable",
        )
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2025.04.01")

    implementation(composeBom)
    androidTestImplementation(composeBom)

    implementation("androidx.activity:activity-compose:1.10.1")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.core:core-ktx:1.16.0")
    implementation("androidx.datastore:datastore-preferences:1.1.7")
    implementation("androidx.fragment:fragment-ktx:1.8.9")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.9.2")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.9.2")
    implementation("androidx.webkit:webkit:1.14.0")
    testImplementation("com.goterl:lazysodium-android:5.2.0") {
        // The AAR API is Java bytecode. Its POM's Kotlin 2.1 stdlib is used
        // only by transitive Android helpers and conflicts with this app's
        // Kotlin 1.9 compiler; the app already supplies a compatible stdlib.
        exclude(group = "org.jetbrains.kotlin", module = "kotlin-stdlib")
        // Android needs JNA's AAR-packaged libjnidispatch rather than the
        // ordinary JVM JAR selected by LazySodium's published POM.
        exclude(group = "net.java.dev.jna", module = "jna")
    }
    androidTestImplementation("com.goterl:lazysodium-android:5.2.0") {
        // The AAR API is Java bytecode. Its POM's Kotlin 2.1 stdlib is used
        // only by transitive Android helpers and conflicts with this app's
        // Kotlin 1.9 compiler; the app already supplies a compatible stdlib.
        exclude(group = "org.jetbrains.kotlin", module = "kotlin-stdlib")
        // Android needs JNA's AAR-packaged libjnidispatch rather than the
        // ordinary JVM JAR selected by LazySodium's published POM.
        exclude(group = "net.java.dev.jna", module = "jna")
    }
    implementation("net.java.dev.jna:jna:5.17.0@aar")
    implementation(platform("com.google.firebase:firebase-bom:34.16.0"))
    implementation("com.google.firebase:firebase-messaging")
    testImplementation("com.nimbusds:srp6a:2.1.0")
    androidTestImplementation("com.nimbusds:srp6a:2.1.0")
    implementation(files(layout.buildDirectory.file("generated/rustls-platform-verifier-0.2.0.aar")))
    // OkHttp 5.x is compiled with Kotlin 2.2. Keep the latest 4.x release
    // until the Android Kotlin/Compose compiler is upgraded deliberately.
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")

    debugImplementation("androidx.compose.ui:ui-tooling")

    testImplementation("junit:junit:4.13.2")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
    testImplementation("org.json:json:20240303")
    androidTestImplementation("androidx.test:core-ktx:1.6.1")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.7.0")
    androidTestImplementation("androidx.test.espresso:espresso-intents:3.7.0")
    androidTestImplementation("androidx.test.uiautomator:uiautomator:2.3.0")
}

val verifyBundledWebAssets = tasks.register("verifyBundledWebAssets") {
    val indexFile = layout.buildDirectory.file("generated/webAssets/index.html")
    inputs.file(indexFile)
    doLast {
        check(indexFile.get().asFile.isFile) {
            "Bundled web assets are missing; run `pnpm prepare-frontend` first"
        }
    }
}

tasks.matching {
    it.name.startsWith("mergeBundled") && it.name.endsWith("Assets")
}.configureEach {
    dependsOn(verifyBundledWebAssets)
}

tasks.matching {
    debugWebClientUrl != null &&
        it.name.startsWith("pre") &&
        it.name.endsWith("ReleaseBuild")
}.configureEach {
    doFirst {
        error("yaWebClientUrl is a debug-only override")
    }
}

tasks.withType<Test>().configureEach {
    timeout.set(Duration.ofMinutes(5))
    testLogging {
        events(
            TestLogEvent.STARTED,
            TestLogEvent.PASSED,
            TestLogEvent.SKIPPED,
            TestLogEvent.FAILED,
        )
    }
}

val prepareRustTransport = tasks.register<Exec>("prepareRustTransport") {
    workingDir(rootProject.projectDir.resolve("../.."))
    commandLine("node", "packages/mobile-core/scripts/run.mjs", "android")
    inputs.dir(rootProject.projectDir.resolve("../mobile-core/src"))
    inputs.dir(rootProject.projectDir.resolve("../mobile-core/scripts"))
    inputs.files(rootProject.projectDir.resolve("../mobile-core/Cargo.toml"), rootProject.projectDir.resolve("../mobile-core/Cargo.lock"), rootProject.projectDir.resolve("../mobile-core/rust-toolchain.toml"), rootProject.projectDir.resolve("../mobile-core/uniffi.toml"))
    outputs.dir(layout.buildDirectory.dir("generated/rustBindings"))
    outputs.dir(layout.buildDirectory.dir("generated/rustJniLibs"))
    outputs.file(layout.buildDirectory.file("generated/rustls-platform-verifier-0.2.0.aar"))
}

// Android allows one network security config per app. The platform verifier
// ships one that permits plain HTTP only to CA revocation-list hosts, which its
// revocation check needs for CRL-only certificates such as Let's Encrypt's.
// Every build uses that config, extended with loopback for local fixtures.
val generateNetworkSecurityConfig = tasks.register("generateNetworkSecurityConfig") {
    dependsOn(prepareRustTransport)
    val aar = layout.buildDirectory.file("generated/rustls-platform-verifier-0.2.0.aar")
    val output = layout.buildDirectory.file("generated/networkSecurityRes/xml/network_security_config.xml")
    val hosts = loopbackHosts
    inputs.file(aar)
    inputs.property("loopbackHosts", hosts)
    outputs.file(output)
    doLast {
        val upstream = ZipFile(aar.get().asFile).use { zip ->
            val entry = checkNotNull(zip.getEntry("res/xml/network_security_config.xml")) {
                "Platform verifier AAR has no network security config"
            }
            zip.getInputStream(entry).readBytes().toString(Charsets.UTF_8)
        }
        val base = "<base-config cleartextTrafficPermitted=\"false\" />"
        check(upstream.contains(base) && upstream.contains(".c.lencr.org<")) {
            "Platform verifier network security config changed shape"
        }
        val loopback = hosts.joinToString("\n", prefix = "\n  <domain-config cleartextTrafficPermitted=\"true\">\n", postfix = "\n  </domain-config>") {
            "    <domain includeSubdomains=\"false\">$it</domain>"
        }
        output.get().asFile.apply { parentFile.mkdirs() }.writeText(upstream.replace(base, base + loopback))
    }
}
tasks.named("preBuild") { dependsOn(prepareRustTransport, generateNetworkSecurityConfig) }
