package com.yepanywhere.mobile.web

import android.content.Intent
import android.os.Build
import android.webkit.WebView
import android.view.KeyCharacterMap
import android.view.inputmethod.InputMethodManager
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.espresso.intent.Intents
import androidx.test.espresso.intent.matcher.IntentMatchers.hasAction
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import com.yepanywhere.mobile.MainActivity
import com.yepanywhere.mobile.R
import com.yepanywhere.mobile.YepAnywhereApplication
import com.yepanywhere.mobile.connection.YaConnectionPhase
import com.yepanywhere.mobile.profiles.YaServerRoute
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Real native SRP/resume and the shipped bundled web app against an isolated server. */
@RunWith(AndroidJUnit4::class)
class YaNativeWebAppInstrumentedTest {
    @get:org.junit.Rule
    val launcherAnrRecovery = com.yepanywhere.mobile.LauncherAnrRecoveryRule()
    @Test
    fun fullWebAppUsesNativeSessionAndReleasesOnlyItsLease() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val args = InstrumentationRegistry.getArguments()
        val ws = args.getString("yaProbeWsUrl")
        val username = args.getString("yaProbeUsername")
        val password = args.getString("yaProbePassword")
        val relayWs = args.getString("yaProbeRelayWsUrl")
        val uploadBytes = args.getString("yaProbeUploadBytes")?.toInt() ?: 1024 * 1024
        require(uploadBytes in 1..(100 * 1024 * 1024))
        assumeTrue("Disposable probe arguments absent in config-free CI", ws != null && username != null && password != null)
        val device = UiDevice.getInstance(instrumentation)
        val testNetwork = args.getString("yaProbeNetworkLifecycle") == "true"
        val wifiEnabled = testNetwork && device.executeShellCommand("settings get global wifi_on").trim() == "1"
        val dataEnabled = testNetwork && device.executeShellCommand("settings get global mobile_data").trim() == "1"
        val application = instrumentation.targetContext.applicationContext as YepAnywhereApplication
        val runtime = application.nativeRuntime
        val previous = runBlocking { runtime.pairedServers.selectedProfileId.first() }
        val hostLabel = "WebView probe ${java.util.UUID.randomUUID().toString().take(8)}"
        val profile = runBlocking { withTimeout(15_000) {
            // Match the native login ViewModel's Main dispatcher. Starting this
            // on the instrumentation thread hid TLS revocation network checks
            // running on Main in the shipping login form.
            withContext(Dispatchers.Main) {
                runtime.pairing.pair(hostLabel, checkNotNull(username), checkNotNull(password),
                    if (relayWs == null) YaServerRoute.direct(checkNotNull(ws)) else YaServerRoute.relay(relayWs, checkNotNull(username)))
            }
        } }
        val secondHostLabel = "Second host ${java.util.UUID.randomUUID().toString().take(8)}"
        val secondProfile = args.getString("yaProbeSecondUsername")?.let { secondUsername ->
            runBlocking { withTimeout(15_000) {
                runtime.pairing.pair(secondHostLabel, secondUsername, checkNotNull(password), YaServerRoute.relay(checkNotNull(relayWs), secondUsername))
            } }
        }
        val manager = runtime.connectionManager(profile.id)
        val sibling = runBlocking { manager.acquire() }
        val preferences = application.getSharedPreferences("native-tabs", android.content.Context.MODE_PRIVATE)
        val previousTabs = preferences.getString("state", null)
        preferences.edit().remove("state").commit()
        runBlocking { runtime.pairedServers.select(profile.id) }
        val intent = Intent(application, MainActivity::class.java).setAction(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        val scenario = ActivityScenario.launch<MainActivity>(intent)
        val http = OkHttpClient()
        Intents.init()
        Intents.intending(hasAction(Intent.ACTION_VIEW)).respondWith(android.app.Instrumentation.ActivityResult(android.app.Activity.RESULT_CANCELED, null))
        try {
            await(scenario, "document.body.textContent.includes('preview-project')")
            assertEquals("\"/projects\"", evaluate(scenario, "location.pathname"))
            assertEquals("false", evaluate(scenario, "location.href.includes('password') || location.pathname.includes('/login')"))
            val projects = runBlocking { sibling.request("GET", "/projects").body } as org.json.JSONObject
            val projectId = projects.getJSONArray("projects").getJSONObject(0).getString("id")
            evaluate(scenario, "location.href = '/projects/$projectId/sessions/android-preview-session'; true")
            await(scenario, "document.body.textContent.includes('Preview message 50') && !!document.querySelector('textarea[data-composer-input]')")
            await(scenario, "!document.querySelector('[data-session-title-skeleton], [data-session-page] [data-loading]') && document.fonts.status === 'loaded'")
            evaluate(scenario, "window.nativeCaptureReady = false; requestAnimationFrame(() => requestAnimationFrame(() => { window.nativeCaptureReady = true; })); true")
            await(scenario, "window.nativeCaptureReady === true")
            instrumentation.waitForIdleSync()
            assertTrue(UiDevice.getInstance(instrumentation).takeScreenshot(File(application.getExternalFilesDir(null), "native-insets.png")))
            assertSafeAreasAppliedOnce(scenario)
            val base = checkNotNull(ws).replace("ws://", "http://").replace("wss://", "https://").substringBefore("/api/ws")
            http.newCall(Request.Builder().url("$base/__probe/append").post(ByteArray(0).toRequestBody()).build()).execute().use { assertTrue(it.isSuccessful) }
            await(scenario, "document.body.textContent.includes('Live preview response')")

            // A same-origin child frame cannot act as the trusted main frame.
            evaluate(scenario, """
                (() => { const child = document.createElement('iframe'); child.hidden = true;
                  child.srcdoc = '<script>window.yaNativeTransport?.postMessage("invalid-child-command")<\/script>';
                  document.body.appendChild(child); return true; })()
            """.trimIndent())

            // Establish the real editor/input connection before starting upload.
            // Hardware key injection must not race keyboard creation and viewport
            // resizing; the subsequent frame gate still includes upload work.
            evaluate(scenario, """
                (() => { const composer = document.querySelector('textarea[data-composer-input]');
                  composer.setAttribute('autocapitalize', 'off'); return true; })();
            """.trimIndent())
            // DOM focus alone does not establish Android's input connection.
            // Run 37200938972 injected 29 characters but only the final 21
            // reached the editor after the old readiness fallback proceeded.
            val composer = UiDevice.getInstance(instrumentation).wait(
                Until.findObject(By.clazz("android.widget.EditText")), 30_000)
            assertTrue("Composer is absent from Android accessibility", composer != null)
            checkNotNull(composer).click()
            awaitInputReady(scenario)
            assertSafeAreasAppliedOnce(scenario)

            // Exercise the normal attachment editor, including credited binary upload.
            evaluate(scenario, """
                (() => { const input = document.querySelector('input[type=file]');
                  const transfer = new DataTransfer(); transfer.items.add(new File([new Uint8Array($uploadBytes)], 'native-upload.bin'));
                  input.files = transfer.files; input.dispatchEvent(new Event('change', {bubbles:true})); return true; })()
            """.trimIndent())
            await(scenario, "document.querySelector('[data-attachment-list]')?.textContent.includes('native-upload.bin') === true")
            evaluate(scenario, """
                window.nativeTypingLatencies = [];
                window.nativeTypingInputLatencies = [];
                window.nativeTypingStarts = [];
                window.nativeTypingLongTasks = [];
                window.nativeTypingLongFrames = [];
                if (PerformanceObserver.supportedEntryTypes.includes('longtask')) {
                  window.nativeTypingObserver = new PerformanceObserver(list => {
                    window.nativeTypingLongTasks.push(...list.getEntries().map(entry => ({start:entry.startTime, duration:entry.duration})));
                  });
                  window.nativeTypingObserver.observe({entryTypes:['longtask']});
                }
                if (PerformanceObserver.supportedEntryTypes.includes('long-animation-frame')) {
                  window.nativeTypingFrameObserver = new PerformanceObserver(list => {
                    window.nativeTypingLongFrames.push(...list.getEntries().map(entry => ({
                      start:entry.startTime, duration:entry.duration, renderStart:entry.renderStart,
                      layoutStart:entry.styleAndLayoutStart, scripts:entry.scripts.map(script => ({
                        source:script.sourceURL, position:script.sourceCharPosition,
                        function:script.sourceFunctionName, duration:script.duration,
                        layout:script.forcedStyleAndLayoutDuration
                      }))
                    })));
                  });
                  window.nativeTypingFrameObserver.observe({entryTypes:['long-animation-frame']});
                }
                const composer = document.querySelector('textarea[data-composer-input]');
                window.nativeTypingBaseline = composer.value;
                composer.addEventListener('keydown', () => {
                  const started = performance.now();
                  window.nativeTypingStarts.push(started);
                  composer.addEventListener('input', () => {
                    window.nativeTypingInputLatencies.push(performance.now() - started);
                    requestAnimationFrame(() => window.nativeTypingLatencies.push(performance.now() - started));
                  }, {once:true});
                }); true;
            """.trimIndent())
            val text = "native typing while uploading"
            val events = KeyCharacterMap.load(KeyCharacterMap.VIRTUAL_KEYBOARD).getEvents(text.toCharArray())
            for (event in checkNotNull(events)) { instrumentation.sendKeySync(event); Thread.sleep(20) }
            await(scenario, "document.querySelector('textarea[data-composer-input]').value === window.nativeTypingBaseline + '$text'")
            await(scenario, "window.nativeTypingLatencies.length === ${text.length}")
            val latency = evaluate(scenario, "Math.max(...window.nativeTypingLatencies)").toDouble()
            val timing = evaluate(scenario, "window.nativeTypingObserver?.disconnect(); window.nativeTypingFrameObserver?.disconnect(); JSON.stringify({samples:window.nativeTypingLatencies,inputSamples:window.nativeTypingInputLatencies,starts:window.nativeTypingStarts,longTasks:window.nativeTypingLongTasks,longFrames:window.nativeTypingLongFrames,observerTypes:PerformanceObserver.supportedEntryTypes})")
            // Every key must land everywhere (the value check above). The
            // 100 ms acknowledgement budget is a device requirement; CI's
            // software-rendered emulator measured 159 and 487 ms maxima, so
            // there 2000 ms (~4x the worst) still catches gross regressions.
            val latencyBudgetMs = if (isEmulator()) 2_000 else 100
            assertTrue("Input acknowledgement exceeded $latencyBudgetMs ms: $latency; uploadBytes=$uploadBytes; timing=$timing", latency <= latencyBudgetMs)
            assertEquals(200, runBlocking { sibling.request("GET", "/version").status })
            // Hosted run 40179442039 exceeded 120 s while still transferring.
            // Allow 3x that observed bound; input latency gates stay unchanged.
            await(scenario, "document.querySelector('[data-attachment-list]')?.textContent.includes('native-upload.bin') === true && !document.querySelector('[data-attachment-list]')?.textContent.includes('%')", 360)
            scenario.onActivity { activity ->
                val proof = activity.nativeTransportDiagnostics() ?: org.json.JSONObject()
                proof.remove("profileId")
                proof.put("uploadBytes", uploadBytes).put("typingMaxMs", latency)
                instrumentation.sendStatus(2, android.os.Bundle().apply { putString("yaNativeWebProof", proof.toString()) })
            }

            device.pressBack() // Hide the keyboard before opening native chrome.
            evaluate(scenario, "window.warmDocument = {identity: Math.random()}; window.warmComposerNode = document.querySelector('textarea[data-composer-input]'); window.warmComposer = window.warmComposerNode.value; window.warmScrollNode = document.querySelector('[data-message-list]').parentElement; window.warmScrollTarget = (window.warmScrollNode.scrollHeight - window.warmScrollNode.clientHeight) / 2; window.warmScrollNode.scrollTop = window.warmScrollTarget; true")
            await(scenario, "window.warmScrollTarget > 0 && Math.abs(window.warmScrollNode.scrollTop - window.warmScrollTarget) < 1")
            val scrollPosition = evaluate(scenario, "window.warmScrollNode.scrollTop").toDouble()
            val identity = evaluate(scenario, "JSON.stringify([performance.timeOrigin, window.warmDocument.identity])")
            device.findObject(By.desc("Tabs, 1 open")).click()
            assertTrue(device.wait(Until.hasObject(By.text("Tabs")), 5_000))
            captureTabs(device, application, "native-tabs.png")
            device.pressBack()
            assertEquals(identity, evaluate(scenario, "JSON.stringify([performance.timeOrigin, window.warmDocument.identity])"))
            scenario.moveToState(Lifecycle.State.CREATED)
            assertEquals(200, runBlocking { sibling.request("GET", "/version").status })
            scenario.moveToState(Lifecycle.State.RESUMED)
            await(scenario, "document.body.textContent.includes('Preview message 50')")
            assertEquals(identity, evaluate(scenario, "JSON.stringify([performance.timeOrigin, window.warmDocument.identity])"))
            assertEquals("true", evaluate(scenario, "document.querySelector('textarea[data-composer-input]') === window.warmComposerNode && window.warmComposerNode.value === window.warmComposer"))
            assertEquals(scrollPosition, evaluate(scenario, "window.warmScrollNode.scrollTop").toDouble(), 1.0)
            // Exercise the real launcher path, not just a lifecycle test shim.
            if (testNetwork) {
                device.executeShellCommand("svc wifi disable")
                device.executeShellCommand("svc data disable")
                await(scenario, "navigator.onLine === false && !!document.querySelector('[data-connection-status]')")
            }
            device.pressHome()
            application.startActivity(Intent(application, MainActivity::class.java).setAction(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            await(scenario, "document.visibilityState === 'visible'")
            assertEquals(identity, evaluate(scenario, "JSON.stringify([performance.timeOrigin, window.warmDocument.identity])"))
            assertEquals("true", evaluate(scenario, "document.querySelector('textarea[data-composer-input]') === window.warmComposerNode && window.warmComposerNode.value === window.warmComposer"))
            assertEquals(scrollPosition, evaluate(scenario, "window.warmScrollNode.scrollTop").toDouble(), 1.0)
            if (testNetwork) {
                assertEquals("true", evaluate(scenario, "document.body.textContent.includes('Preview message 50')"))
                if (wifiEnabled) device.executeShellCommand("svc wifi enable")
                if (dataEnabled) device.executeShellCommand("svc data enable")
                await(scenario, "navigator.onLine === true && !document.querySelector('[data-connection-status]')")
            }
            http.newCall(Request.Builder().url("$base/__probe/append").post(ByteArray(0).toRequestBody()).build()).execute().use { assertTrue(it.isSuccessful) }
            await(scenario, "document.body.textContent.includes('Live preview response 54') && !document.querySelector('[data-connection-status]')")
            scenario.onActivity { it.requestedOrientation = android.content.pm.ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE }
            await(scenario, "innerWidth > innerHeight")
            assertEquals(identity, evaluate(scenario, "JSON.stringify([performance.timeOrigin, window.warmDocument.identity])"))
            assertSafeAreasAppliedOnce(scenario)
            device.waitForIdle()
            assertTrue(device.takeScreenshot(File(application.getExternalFilesDir(null), "native-tabs-landscape.png")))
            scenario.onActivity { it.requestedOrientation = android.content.pm.ActivityInfo.SCREEN_ORIENTATION_PORTRAIT }
            await(scenario, "innerWidth < innerHeight")
            assertEquals(identity, evaluate(scenario, "JSON.stringify([performance.timeOrigin, window.warmDocument.identity])"))
            // Plus creates a distinct same-host tab. Returning restores navigation.
            device.findObject(By.desc("New tab")).click()
            device.wait(Until.findObject(By.res("android", "text1").text(hostLabel)), 5_000).click()
            await(scenario, "location.pathname === '/projects' && document.body.textContent.includes('preview-project')")
            assertTrue(device.hasObject(By.desc("Tabs, 2 open")))
            device.findObject(By.desc("Tabs, 2 open")).click()
            device.wait(Until.findObject(By.desc("Switch to tab: $hostLabel, /projects/$projectId/sessions/android-preview-session")), 5_000).click()
            await(scenario, "location.pathname.endsWith('/sessions/android-preview-session') && document.body.textContent.includes('Preview message 50')")
            evaluate(scenario, """
                (() => { const link = document.createElement('a'); link.id = 'native-tab-link';
                  link.href = '/projects?nativeTabProbe=1'; link.target = '_blank'; link.textContent = 'Native internal link';
                  link.style.cssText = 'position:fixed;top:80px;left:20px;z-index:99999;background:#222;color:white;padding:16px';
                  document.body.appendChild(link); return true; })()
            """.trimIndent())
            val beforeLink = evaluate(scenario, "performance.timeOrigin")
            awaitWebLink(device, "Native internal link").longClick()
            device.wait(Until.findObject(By.text("Open in new tab")), 5_000).click()
            assertTrue(device.wait(Until.hasObject(By.desc("Tabs, 3 open")), 5_000))
            assertEquals(beforeLink, evaluate(scenario, "performance.timeOrigin"))
            awaitWebLink(device, "Native internal link").click()
            await(scenario, "location.pathname === '/projects' && location.search === '?nativeTabProbe=1'")
            assertTrue(device.wait(Until.hasObject(By.desc("Tabs, 4 open")), 5_000))
            device.findObject(By.desc("Tabs, 4 open")).click()
            captureTabs(device, application, "native-tabs.png")
            device.wait(Until.findObject(By.desc("Switch to tab: $hostLabel, /projects/$projectId/sessions/android-preview-session")), 5_000).click()
            await(scenario, "location.pathname.endsWith('/sessions/android-preview-session') && document.body.textContent.includes('Preview message 50')")
            // External new-window URLs are handed to Android, never an app tab.
            evaluate(scenario, """
                (() => { const link = document.createElement('a'); link.href = 'https://example.com/ya-native-external';
                  link.target = '_blank'; link.textContent = 'Native external link';
                  link.setAttribute('aria-label', 'Native external link');
                  link.style.cssText = 'position:fixed;top:80px;left:20px;z-index:99999;background:#222;color:white;padding:16px';
                  document.body.appendChild(link); return true; })()
            """.trimIndent())
            val externalIdentity = evaluate(scenario, "performance.timeOrigin")
            awaitWebLink(device, "Native external link").click()
            val externalDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
            while (Intents.getIntents().none { it.action == Intent.ACTION_VIEW && it.dataString == "https://example.com/ya-native-external" } && System.nanoTime() < externalDeadline) Thread.sleep(50)
            assertTrue(Intents.getIntents().any { it.action == Intent.ACTION_VIEW && it.dataString == "https://example.com/ya-native-external" })
            assertEquals(externalIdentity, evaluate(scenario, "performance.timeOrigin"))
            assertTrue(device.hasObject(By.desc("Tabs, 4 open")))
            if (secondProfile != null) {
                device.findObject(By.desc("New tab")).click()
                device.wait(Until.findObject(By.res("android", "text1").text(secondHostLabel)), 5_000).click()
                await(scenario, "document.body.textContent.includes('preview-project')", expectedProfileId = secondProfile.id)
                scenario.onActivity { assertEquals(secondProfile.id, it.nativeTransportDiagnostics()?.getString("profileId")) }
                device.findObject(By.desc("Tabs, 5 open")).click()
                captureTabs(device, application, "native-tabs-hosts.png")
                device.wait(Until.findObject(By.desc("Switch to tab: $hostLabel, /projects/$projectId/sessions/android-preview-session")), 5_000).click()
                await(scenario, "document.body.textContent.includes('Preview message 50')", expectedProfileId = profile.id)
                scenario.onActivity { assertEquals(profile.id, it.nativeTransportDiagnostics()?.getString("profileId")) }
                // Closing the second host removes metadata and releases only its consumer.
                device.findObject(By.desc("Tabs, 5 open")).click()
                device.wait(Until.findObject(By.desc("Close tab: $secondHostLabel")), 5_000).click()
                assertTrue(device.wait(Until.gone(By.desc("Close tab: $secondHostLabel")), 5_000))
                assertTrue(device.wait(Until.hasObject(By.text("Tabs")), 5_000))
                device.waitForIdle()
                device.pressBack()
                assertTrue(device.wait(Until.hasObject(By.desc("Tabs, 4 open")), 5_000))
            }
            scenario.recreate()
            await(scenario, "location.pathname.endsWith('/sessions/android-preview-session') && document.body.textContent.includes('Preview message 50')")
            assertSafeAreasAppliedOnce(scenario)
            assertEquals(200, runBlocking { sibling.request("GET", "/version").status })
            evaluate(scenario, "if (!document.querySelector('[data-sidebar-switch-host]')) document.querySelector('[data-sidebar-toggle]')?.click(); true")
            await(scenario, "!!document.querySelector('[data-sidebar-switch-host]')")
            evaluate(scenario, "document.querySelector('[data-sidebar-switch-host]').click(); true")
            assertTrue("Switch Host did not open native management", device.wait(Until.hasObject(By.text("Servers")), 5_000))
            assertTrue(device.wait(Until.hasObject(By.text(hostLabel)), 5_000))
            scenario.close()
            assertEquals(200, runBlocking { sibling.request("GET", "/version").status })
        } catch (error: Throwable) {
            var details = ""
            scenario.onActivity { details = "native=${it.nativeTransportDiagnostics()}; manager=${manager.state.value}" }
            com.yepanywhere.mobile.UiFailureCapture.save("native-web", details)
            throw error
        } finally {
            if (testNetwork) {
                device.executeShellCommand("svc wifi ${if (wifiEnabled) "enable" else "disable"}")
                device.executeShellCommand("svc data ${if (dataEnabled) "enable" else "disable"}")
            }
            scenario.close()
            Intents.release()
            preferences.edit().apply { if (previousTabs == null) remove("state") else putString("state", previousTabs) }.commit()
            http.connectionPool.evictAll()
            http.dispatcher.executorService.shutdown()
            runBlocking {
                sibling.releaseAndAwait()
                withTimeout(5_000) { manager.state.first { it.phase == YaConnectionPhase.IDLE } }
                runtime.pairedServers.forget(profile.id)
                secondProfile?.let { runtime.pairedServers.forget(it.id) }
                if (previous != null && runtime.pairedServers.snapshot(previous) != null) runtime.pairedServers.select(previous)
            }
        }
    }

    private fun awaitWebLink(device: UiDevice, name: String): UiObject2 {
        // Run 37223303403 exposed a visible link as content-desc with empty
        // text. WebView can also expose its name on a text child. Preserve the
        // existing 5 s budget and real user gesture for either representation.
        return checkNotNull(device.wait(Condition<UiDevice, UiObject2?> { current ->
            current.findObject(By.pkg(InstrumentationRegistry.getInstrumentation().targetContext.packageName).desc(name))
                ?: current.findObject(By.pkg(InstrumentationRegistry.getInstrumentation().targetContext.packageName).text(name))
        }, 5_000)) { "Web link is absent from accessibility: $name" }
    }

    private fun captureTabs(device: UiDevice, app: YepAnywhereApplication, name: String) {
        assertTrue(device.wait(Until.hasObject(By.text("Tabs")), 5_000))
        assertTrue(device.wait(Until.hasObject(By.descStartsWith("Switch to tab:")), 5_000))
        device.waitForIdle()
        assertTrue(device.takeScreenshot(File(app.getExternalFilesDir(null), name)))
    }

    private fun assertSafeAreasAppliedOnce(scenario: ActivityScenario<out WebClientActivity>) {
        val insets = evaluate(scenario, """
            (() => {
              const probe = document.createElement('div');
              probe.style.cssText = 'position:fixed;visibility:hidden;padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)';
              document.body.appendChild(probe);
              const style = getComputedStyle(probe);
              const values = [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft].map(parseFloat);
              probe.remove(); return values;
            })()
        """.trimIndent())
        assertEquals("Native system-bar padding must not reach CSS again", "[0,0,0,0]", insets)
    }

    private fun awaitInputReady(scenario: ActivityScenario<out WebClientActivity>) {
        // Use the existing 30 s document-readiness budget. This is a setup
        // condition, never a delay or a larger per-key acknowledgement budget.
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30)
        var lastSize: Pair<Int, Int>? = null
        var stableSamples = 0
        var observed = ""
        while (System.nanoTime() < deadline) {
            var size: Pair<Int, Int>? = null
            var focused = false
            var acceptingText = false
            scenario.onActivity { activity ->
                val view = activity.findViewById<WebView>(R.id.web_client)
                focused = view.hasWindowFocus() && view.hasFocus()
                acceptingText = activity.getSystemService(InputMethodManager::class.java).isAcceptingText
                if (focused && acceptingText) size = Pair(view.width, view.height)
            }
            val editorReady = evaluate(scenario, "document.activeElement?.matches('textarea[data-composer-input]') === true && document.fonts.status === 'loaded'") == "true"
            stableSamples = if (editorReady && size != null && size == lastSize) stableSamples + 1 else 0
            observed = "viewFocused=$focused imeAcceptingText=$acceptingText editorReady=$editorReady size=$size"
            lastSize = size
            if (stableSamples >= 3) return
            Thread.sleep(100)
        }
        throw AssertionError("Composer input connection and viewport did not become ready: $observed")
    }

    private fun isEmulator(): Boolean = Build.FINGERPRINT.startsWith("generic") ||
        Build.FINGERPRINT.contains("emulator", ignoreCase = true) ||
        Build.MODEL.contains("Emulator", ignoreCase = true) ||
        Build.HARDWARE == "ranchu"

    // Initial direct 1 MiB emulator proof completed in 9.1 s; 30 s gives ~3x
    // that full-run maximum for ordinary document readiness on this testbed.
    private fun await(scenario: ActivityScenario<out WebClientActivity>, script: String, timeoutSeconds: Long = 30, expectedProfileId: String? = null) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(timeoutSeconds)
        var actual = ""
        var actualProfileId: String? = null
        while (System.nanoTime() < deadline) {
            // Reload can discard an evaluateJavascript callback sent to the
            // departing renderer. Wait for the replacement native handshake.
            var ready = false
            scenario.onActivity { activity ->
                val diagnostics = activity.nativeTransportDiagnostics()
                actualProfileId = diagnostics?.optString("profileId")
                // Both hosts serve the same fixture text. Wait for the native
                // handoff before an old document can satisfy the page predicate.
                ready = diagnostics != null && (expectedProfileId == null || actualProfileId == expectedProfileId) && activity.findViewById<WebView>(R.id.web_client)?.progress == 100
            }
            if (!ready) { Thread.sleep(100); continue }
            actual = evaluate(scenario, script)
            if (actual == "true") return
            Thread.sleep(100)
        }
        val body = evaluate(scenario, "JSON.stringify({body: document.body.textContent.slice(0, 1800), value: document.querySelector('textarea[data-composer-input]')?.value, active: document.activeElement?.outerHTML.slice(0,200), latencies: window.nativeTypingLatencies})")
        throw AssertionError("Expected $script; got $actual; nativeProfile=$actualProfileId; expectedProfile=$expectedProfileId; page=$body")
    }

    private fun evaluate(scenario: ActivityScenario<out WebClientActivity>, script: String): String {
        val result = AtomicReference<String>()
        val done = CountDownLatch(1)
        scenario.onActivity { activity ->
            activity.findViewById<WebView>(R.id.web_client).evaluateJavascript(script) { result.set(it); done.countDown() }
        }
        assertTrue("JavaScript callback timed out", done.await(5, TimeUnit.SECONDS))
        return result.get()
    }
}
